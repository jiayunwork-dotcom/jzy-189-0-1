import { estimateB } from './bvalue.js';
import type {
  AlertRecord,
  AlertState,
  BaselineState,
  EngineMeta,
  EventInput,
  Experiment,
  IngestCounters,
  StoredEvent,
  WindowResult,
} from './types.js';
import { compareEvent } from '../repo/memory.js';
import type { Repository } from '../repo/types.js';
import { ConflictError, validateEvent, type FieldError } from './validation.js';

function initialMeta(experimentId: string): EngineMeta {
  return {
    experimentId,
    maxTsUs: null,
    watermarkUs: null,
    acceptedCount: 0,
    seenCount: 0,
    duplicateCount: 0,
    lateCount: 0,
    finalizedWindows: 0,
    breachStreak: 0,
    recoveryStreak: 0,
    alertState: 'normal',
    baselineEvaluated: false,
    baseline: {
      status: 'pending',
      completenessDb: null,
      completenessMagnitude: null,
      bValue: null,
      bStdError: null,
      nTotal: 0,
      nEffective: 0,
    },
    stopped: false,
  };
}

/** 把事件插入有序缓冲，保持 (timestampUs,eventId) 升序 */
function insertSorted(buf: StoredEvent[], e: StoredEvent): void {
  let lo = 0;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareEvent(buf[mid]!, e) < 0) lo = mid + 1;
    else hi = mid;
  }
  buf.splice(lo, 0, e);
}

/** 缓冲中时间戳严格小于 wm 的条数（用二分找右界） */
function countFrozen(buf: StoredEvent[], wm: number): number {
  let lo = 0;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (buf[mid]!.timestampUs < wm) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 单窗口预警判定（纯函数，便于测试） */
export function evaluateAlertStep(
  state: AlertState,
  breachStreak: number,
  recoveryStreak: number,
  window: { bValue: number | null; bStdError: number | null },
  baselineB: number,
  multiplier: number,
  persistence: number,
): { state: AlertState; breachStreak: number; recoveryStreak: number; fired: 'raised' | 'cleared' | null } {
  const sufficient = window.bValue !== null && window.bStdError !== null;
  const breach = sufficient && (window.bValue as number) < baselineB - multiplier * (window.bStdError as number);

  if (state === 'normal') {
    if (breach) {
      const s = breachStreak + 1;
      if (s >= persistence) {
        return { state: 'alarm', breachStreak: s, recoveryStreak: 0, fired: 'raised' };
      }
      return { state: 'normal', breachStreak: s, recoveryStreak: 0, fired: null };
    }
    // 样本不足的窗口保持中性，不打断已经积累的越限计数
    return { state: 'normal', breachStreak: sufficient ? 0 : breachStreak, recoveryStreak: 0, fired: null };
  }

  // alarm
  if (!breach && sufficient) {
    const s = recoveryStreak + 1;
    if (s >= persistence) {
      return { state: 'normal', breachStreak: 0, recoveryStreak: s, fired: 'cleared' };
    }
    return { state: 'alarm', breachStreak: 0, recoveryStreak: s, fired: null };
  }
  if (breach) {
    return { state: 'alarm', breachStreak: 0, recoveryStreak: 0, fired: null };
  }
  return { state: 'alarm', breachStreak: 0, recoveryStreak, fired: null };
}

export class ExperimentEngine {
  private meta: EngineMeta;
  /** 有序事件缓冲，保存从下一个待定稿窗口起点开始的事件后缀 */
  private buffer: StoredEvent[] = [];
  /** buffer[0] 对应的全局序号 */
  private bufferBase = 0;

  private constructor(
    readonly experiment: Experiment,
    private readonly repo: Repository,
  ) {
    this.meta = initialMeta(experiment.id);
  }

  getMeta(): EngineMeta {
    return structuredClone(this.meta);
  }

  static async hydrate(experiment: Experiment, repo: Repository): Promise<ExperimentEngine> {
    const eng = new ExperimentEngine(experiment, repo);
    const stored = await repo.loadEngineMeta(experiment.id);
    eng.meta = stored ?? initialMeta(experiment.id);
    // 重建有序事件后缀：已定稿窗口起点之前的事件不再需要
    const nextStart = eng.meta.finalizedWindows * experiment.settings.stepEvents;
    const all = await repo.loadAllEvents(experiment.id);
    eng.buffer = all.slice(nextStart);
    eng.bufferBase = nextStart;
    return eng;
  }

  /**
   * 接收一批事件。乱序判定按事件到达顺序逐条推进水印——
   * 但只有 ts < watermark 的事件被丢，其余全部进入有序序列，
   * 因而窗口只建立在不可再变的冻结前缀上，结果与到达顺序无关。
   */
  async ingest(rawEvents: readonly unknown[]): Promise<IngestCounters> {
    if (this.meta.stopped) {
      throw new ConflictError('试验已结束，不再接收事件');
    }
    const s = this.experiment.settings;
    const counters: IngestCounters = {
      accepted: 0,
      duplicates: 0,
      lateDropped: 0,
      rejected: 0,
      finalizedWindows: [],
      alerts: [],
    };
    const fieldErrors: FieldError[] = [];
    const valid: EventInput[] = [];
    rawEvents.forEach((raw, i) => {
      const { errors, event } = validateEvent(
        raw,
        this.experiment.startedAtUs,
        s.amplitudeMinDb,
        s.amplitudeMaxDb,
        `events[${i}]`,
      );
      if (errors.length > 0 || event === null) {
        fieldErrors.push(...errors);
        counters.rejected += 1;
      } else {
        valid.push(event);
      }
    });

    // 批量查重（重发批次正是最常见场景）：事件表与迟到审计表的并集
    const dedupeIds = valid.map((e) => e.eventId);
    const known = await this.repo.existingEventIds(this.experiment.id, dedupeIds);

    const knownInBatch = new Set<string>();
    const toInsert: StoredEvent[] = [];
    const nowUs = currentTimeUs();

    for (const e of valid) {
      if (knownInBatch.has(e.eventId) || known.has(e.eventId)) {
        counters.duplicates += 1;
        this.meta.duplicateCount += 1;
        continue;
      }
      knownInBatch.add(e.eventId);

      const wm = this.meta.maxTsUs === null ? null : this.meta.maxTsUs - s.allowedDelayUs;
      if (wm !== null && e.timestampUs < wm) {
        // 超出允许延迟的迟到事件：丢弃并计数，同时记入审计（也参与去重）。
        // 保留在已知集合中：同批内若再次出现（采集端重传），按重复处理。
        counters.lateDropped += 1;
        this.meta.lateCount += 1;
        this.meta.seenCount += 1;
        await this.repo.insertLateEvent({
          experimentId: this.experiment.id,
          eventId: e.eventId,
          timestampUs: e.timestampUs,
          amplitudeDb: e.amplitudeDb,
          channel: e.channel,
          arrivedAtUs: nowUs,
          watermarkUs: wm,
        });
        continue;
      }

      this.meta.seenCount += 1;
      toInsert.push({ ...e, experimentId: this.experiment.id, receivedSeq: this.meta.seenCount });
    }

    // 数据库唯一索引兜底：仅真正写入的事件进入有序序列，
    // 保证服务重启按库回放与本次内存状态严格一致
    const written = await this.repo.insertEvents(toInsert);
    for (const e of written) {
      insertSorted(this.buffer, e);
      counters.accepted += 1;
      this.meta.acceptedCount += 1;
      if (this.meta.maxTsUs === null || e.timestampUs > this.meta.maxTsUs) {
        this.meta.maxTsUs = e.timestampUs;
      }
    }
    // 到库时才发现的重复（并发兜底）
    const raceDup = toInsert.length - written.length;
    counters.duplicates += raceDup;
    this.meta.duplicateCount += raceDup;

    this.meta.watermarkUs =
      this.meta.maxTsUs === null ? null : this.meta.maxTsUs - s.allowedDelayUs;

    // 水印越过基线终点：基线数据已全部冻结，做池化 MLE。
    // 基线判定前不定稿任何窗口——否则"无重启"路径会跳过基线期窗口的
    // 预警判定，而重启回放路径会补跑，造成两条路径不一致。
    // 基线就绪后追赶定稿，结果与延迟无关、与是否重启无关。
    if (!this.meta.baselineEvaluated && this.meta.watermarkUs !== null) {
      const endAbs = this.experiment.startedAtUs + s.baselineEndUs;
      if (this.meta.watermarkUs >= endAbs) {
        await this.evaluateBaseline();
      }
    }

    if (this.meta.baselineEvaluated) {
      const frozenCount = this.meta.watermarkUs === null
        ? 0
        : this.bufferBase + countFrozen(this.buffer, this.meta.watermarkUs);
      await this.finalizeWindows(frozenCount, counters);
    }
    await this.repo.saveEngineMeta(this.meta);

    if (fieldErrors.length > 0) {
      // 已接受的照常落库生效，错误通过返回内容告诉调用方逐字段修正
      throw new BatchValidationError(fieldErrors, counters, written.length);
    }
    return counters;
  }

  /** 结束试验：水印推到无穷，定稿全部剩余窗口 */
  async stop(): Promise<IngestCounters> {
    if (this.meta.stopped) {
      throw new ConflictError('试验已结束');
    }
    const counters: IngestCounters = {
      accepted: 0, duplicates: 0, lateDropped: 0, rejected: 0,
      finalizedWindows: [], alerts: [],
    };
    if (!this.meta.baselineEvaluated) {
      await this.evaluateBaseline();
    }
    await this.finalizeWindows(this.meta.acceptedCount, counters);
    this.meta.stopped = true;
    this.meta.watermarkUs = null;
    await this.repo.saveEngineMeta(this.meta);
    await this.repo.markExperimentStopped(this.experiment.id, currentTimeUs());
    return counters;
  }

  private async evaluateBaseline(): Promise<void> {
    const s = this.experiment.settings;
    const fromUs = this.experiment.startedAtUs + s.baselineStartUs;
    const toUs = this.experiment.startedAtUs + s.baselineEndUs;
    const events = await this.repo.loadEventsInRange(this.experiment.id, fromUs, toUs);
    const est = estimateB(
      events.map((e) => e.amplitudeDb),
      s.mcMethod,
      s.minEventsForB,
    );
    const baseline: BaselineState = {
      status: est.status === 'ok' ? 'ready' : 'insufficient',
      completenessDb: est.nTotal > 0 ? est.completenessDb : null,
      completenessMagnitude: est.nTotal > 0 ? est.completenessMagnitude : null,
      bValue: est.bValue,
      bStdError: est.bStdError,
      nTotal: est.nTotal,
      nEffective: est.nEffective,
    };
    this.meta.baseline = baseline;
    this.meta.baselineEvaluated = true;
  }

  private async finalizeWindows(frozenCount: number, counters: IngestCounters): Promise<void> {
    const s = this.experiment.settings;
    while (true) {
      const i = this.meta.finalizedWindows;
      const start = i * s.stepEvents;
      const endExclusive = start + s.windowEvents;
      if (endExclusive > frozenCount) break;

      const sliceStart = start - this.bufferBase;
      const slice = this.buffer.slice(sliceStart, sliceStart + s.windowEvents);
      const first = slice[0]!;
      const last = slice[slice.length - 1]!;
      const est = estimateB(
        slice.map((e) => e.amplitudeDb),
        s.mcMethod,
        s.minEventsForB,
      );

      const window: WindowResult = {
        experimentId: this.experiment.id,
        windowIndex: i,
        startOrdinal: start,
        endOrdinal: endExclusive - 1,
        windowStartUs: first.timestampUs,
        windowEndUs: last.timestampUs,
        nTotal: est.nTotal,
        completenessDb: est.completenessDb,
        completenessMagnitude: est.completenessMagnitude,
        nEffective: est.nEffective,
        bValue: est.bValue,
        bStdError: est.bStdError,
        status: est.status,
        finalizedAtUs: last.timestampUs,
      };
      await this.repo.upsertWindow(window);
      counters.finalizedWindows.push(i);

      if (this.meta.baseline.status === 'ready' && this.meta.baseline.bValue !== null) {
        const result = evaluateAlertStep(
          this.meta.alertState,
          this.meta.breachStreak,
          this.meta.recoveryStreak,
          window,
          this.meta.baseline.bValue,
          s.alertMultiplier,
          s.persistenceWindows,
        );
        this.meta.alertState = result.state;
        this.meta.breachStreak = result.breachStreak;
        this.meta.recoveryStreak = result.recoveryStreak;
        if (result.fired !== null) {
          const threshold =
            window.bValue !== null && window.bStdError !== null
              ? this.meta.baseline.bValue - s.alertMultiplier * window.bStdError
              : null;
          const alert: AlertRecord = {
            experimentId: this.experiment.id,
            kind: result.fired,
            windowIndex: i,
            bValue: window.bValue,
            bStdError: window.bStdError,
            baselineB: this.meta.baseline.bValue,
            threshold,
            windowEndUs: window.windowEndUs,
            recordedAtUs: window.windowEndUs,
          };
          await this.repo.insertAlert(alert);
          counters.alerts.push({ kind: result.fired, windowIndex: i });
        }
      }

      this.meta.finalizedWindows = i + 1;
    }

    // 下一个待定稿窗口起点之前的事件可以从内存丢弃（库里仍有全量）
    const retainFrom = this.meta.finalizedWindows * s.stepEvents;
    if (retainFrom > this.bufferBase) {
      const drop = retainFrom - this.bufferBase;
      this.buffer = this.buffer.slice(drop);
      this.bufferBase = retainFrom;
    }
  }
}

export class BatchValidationError extends Error {
  constructor(
    readonly fieldErrors: FieldError[],
    readonly counters: IngestCounters,
    readonly writtenCount: number,
  ) {
    super('事件校验失败');
    this.name = 'BatchValidationError';
  }
}

/** 微秒墙钟，仅用于迟到审计的到达时间，不参与任何窗口/预警数值 */
function currentTimeUs(): number {
  return Date.now() * 1000;
}
