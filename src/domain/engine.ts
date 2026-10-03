import { estimateBValue } from './magnitude.js';
import type {
  AlertKind,
  AlertTransition,
  BaselineResult,
  EngineStateDoc,
  EventReceipt,
  Experiment,
  IncomingEvent,
  IngestBatchResult,
  IngestCounters,
  StoredEvent,
  WindowResult
} from './types.js';
import type { StateStore, Store } from './store.js';
import { validateIncomingEvent } from './validation.js';

export function nowUs(): number {
  return Date.now() * 1000;
}

function emptyCounters(): IngestCounters {
  return { accepted: 0, duplicate: 0, late: 0, beforeStart: 0, invalid: 0 };
}

interface AlertRuntime {
  state: AlertKind | null;
  breachStreak: number;
  clearStreak: number;
  /** 已经喂给预警状态机的窗口数（窗口按 index 从 0 连续） */
  fedWindowCount: number;
}

/**
 * 单场试验的实时处理引擎。单场试验的批次必须串行调用（由 AppService 保证）。
 *
 * 乱序、迟到与定稿用水印（watermark）统一处理（微批模型：水印随批原子推进）：
 *   新水印 = max(旧水印, min(批内最大事件时间, 墙上时钟) - maxDelayUs)
 * - 本批事件按“批前水印”裁决：ts < 批前水印 才算迟到丢弃；同批事件即便时间跨度很大，
 *   也随本批一起按时到达处理（重连后整批补洞的数据不丢）。
 * - 水印只升不降；事件时间把它往前推，墙上时钟保证没有新事件时它也持续前进，
 *   实时流里安静几秒后窗口照常定稿；离线连续灌数时随事件时间推进。
 * - 接受时 ts >= 当前水印的事件，其秩必定落在已定稿前缀之后，任何已写出窗口的秩永不改变。
 * - 重启后水印从持久化状态恢复；在途重发事件（仍是同一 eventId）先按重复过滤。
 *
 * 其它不变量：
 *  - 事件按 (timestampUs, eventId) 排序得全局秩；窗口一旦写出即不可变。
 *  - 基线由基线时段事件确定性计算；预警变迁由 基线 + 窗口序列 唯一确定，
 *    重启重放即可重建状态与瞬时连续计数。
 *
 * 重启一致性依赖事件时间戳与真实时钟同量级。恢复时若墙上时钟已越过最后事件时间，
 * 以最后事件时间为准（不把还可能重发的在途事件误判为迟到）。
 */
export class ExperimentEngine {
  private constructor(
    public readonly experiment: Experiment,
    private readonly store: Store,
    private readonly stateStore: StateStore,
    private state: EngineStateDoc
  ) {}

  /** 从已存数据恢复（试验中途重启的入口）。 */
  static async restore(
    experiment: Experiment,
    store: Store,
    stateStore: StateStore,
    clock: () => number = nowUs
  ): Promise<ExperimentEngine> {
    const id = experiment.experimentId;
    const s = experiment.settings;
    const persisted = await stateStore.getState(id);

    const maxTs = (await store.maxEventTimestamp(id)) ?? experiment.startedAtUs - 1;
    const closed = persisted?.closed ?? false;
    // 恢复时不引用墙上时钟：以已见最大事件时间为观察前沿，允许在途事件重发
    const observed = closed ? maxTs : Math.min(maxTs, clock());
    const watermark = persisted?.watermarkUs !== undefined
      ? Math.max(persisted.watermarkUs, closed ? Number.MAX_SAFE_INTEGER : observed - s.maxDelayUs)
      : observed - s.maxDelayUs;
    // 严格 ts < watermark 才算已定稿
    const settleRank = await store.countEventsBefore(id, watermark);
    const totalEvents = await store.countEvents(id);
    const rankLimit = closed ? totalEvents : settleRank;

    // 1) 事件/窗口是权威：补算所有应当定稿的窗口（幂等）。
    const existingWindows = await store.listWindows(id);
    const existingIndex = new Set(existingWindows.map((w) => w.index));
    let nextIndex = existingWindows.length > 0 ? Math.max(...existingWindows.map((w) => w.index)) + 1 : 0;
    for (let j = 0; j * s.step + s.windowEvents <= rankLimit; j++) {
      if (!existingIndex.has(j)) {
        await store.insertWindow(await computeWindow(store, experiment, j));
      }
      nextIndex = Math.max(nextIndex, j + 1);
    }

    // 2) 基线确定性重建；关闭时即使水印未到也按现存事件结算。
    let baseline: BaselineResult | null = persisted?.baseline ?? null;
    let baselineFinalized = persisted?.baselineFinalized ?? false;
    const baselineEndUs = experiment.startedAtUs + s.baselineDurationUs;
    if (!baselineFinalized && (watermark >= baselineEndUs || closed)) {
      baseline = await computeBaseline(store, experiment);
      baselineFinalized = true;
    }

    // 3) 重放窗口序列重建预警状态机（变迁幂等）。
    const runtime: AlertRuntime = { state: null, breachStreak: 0, clearStreak: 0, fedWindowCount: 0 };
    const windows = (await store.listWindows(id)).sort((a, b) => a.index - b.index);
    for (const w of windows) {
      await feedAlert(runtime, experiment, baseline, w, store, /*persist=*/ true);
    }

    const stateDoc: EngineStateDoc = {
      experimentId: id,
      nextWindowIndex: nextIndex,
      maxTimestampUs: maxTs,
      watermarkUs: watermark,
      baseline,
      baselineFinalized,
      alertState: runtime.state,
      alertNextWindowIndex: runtime.fedWindowCount,
      breachStreak: runtime.breachStreak,
      clearStreak: runtime.clearStreak,
      closed,
      counters: persisted?.counters ?? emptyCounters(),
      updatedAtUs: clock()
    };
    await stateStore.upsertState(stateDoc);

    return new ExperimentEngine(experiment, store, stateStore, stateDoc);
  }

  getSnapshot(): EngineStateDoc {
    return structuredClone(this.state);
  }

  /**
   * 处理一批事件。乱序、重复、迟到在本批内一次性裁决，
   * 因而批内任意送达顺序（只要落在允许延迟内）产出相同结果。
   */
  async processBatch(rawEvents: unknown[], wallClockUs: number = nowUs()): Promise<IngestBatchResult> {
    if (this.state.closed) throw new ExperimentClosedError(this.experiment.experimentId);
    const id = this.experiment.experimentId;
    const s = this.experiment.settings;
    const counters: IngestCounters = { ...this.state.counters };
    const receipts: EventReceipt[] = [];

    // 1) 逐字段校验
    const valid: { value: IncomingEvent; receiptIndex: number }[] = [];
    for (const raw of rawEvents) {
      const v = validateIncomingEvent(raw, this.experiment.startedAtUs, s.amplitudeMinDb, s.amplitudeMaxDb);
      if (!v.ok) {
        const beforeStart = v.errors.some((e) => e.reason === 'before_start');
        counters[beforeStart ? 'beforeStart' : 'invalid']++;
        receipts.push({
          eventId:
            typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).eventId === 'string'
              ? ((raw as Record<string, unknown>).eventId as string)
              : null,
          status: beforeStart ? 'before_start' : 'invalid',
          field: v.errors.map((e) => e.field).join(','),
          reason: v.errors.map((e) => e.reason).join(','),
          message: v.errors.map((e) => e.message).join('; ')
        });
      } else {
        const receiptIndex = receipts.length;
        valid.push({ value: v.value, receiptIndex });
        receipts.push({ eventId: v.value.eventId, status: 'accepted' });
      }
    }

    // 2) 去重：库中已有 + 批内重复（第一次出现为准，其余记 duplicate）
    const dbKnown = await this.store.hasEventIds(id, valid.map((x) => x.value.eventId));
    const batchSeen = new Set<string>();
    const candidates: { value: StoredEvent; receiptIndex: number }[] = [];
    for (const item of valid) {
      const ev = item.value;
      const r = receipts[item.receiptIndex]!;
      if (dbKnown.has(ev.eventId) || batchSeen.has(ev.eventId)) {
        counters.duplicate++;
        r.status = 'duplicate';
        r.reason = 'duplicate_event_id';
        r.message = '同一 eventId 的事件已存在，重复送达只计一次';
      } else {
        batchSeen.add(ev.eventId);
        candidates.push({ value: { ...ev, experimentId: id, receivedAtUs: nowUs() }, receiptIndex: item.receiptIndex });
      }
    }

    // 3) 推进水印。本批按“批前水印”裁决迟到；同批事件随本批原子到达，不互判迟到。
    const watermarkBefore = this.state.watermarkUs;
    const maxCandidateTs = candidates.reduce((m, c) => Math.max(m, c.value.timestampUs), this.state.maxTimestampUs);
    const observed = Math.min(maxCandidateTs, wallClockUs);
    const watermark = Math.max(watermarkBefore, observed - s.maxDelayUs);

    const toInsert: StoredEvent[] = [];
    for (const c of candidates) {
      const r = receipts[c.receiptIndex]!;
      if (c.value.timestampUs < watermarkBefore) {
        counters.late++;
        r.status = 'late';
        r.reason = 'exceeds_max_delay';
        r.message = `timestampUs(${c.value.timestampUs}) 落后水印(${watermarkBefore})超过允许延迟 ${s.maxDelayUs} us，丢弃`;
      } else {
        toInsert.push(c.value);
      }
    }

    // 4) 事件先落库（幂等）；此后崩溃可靠重放补齐
    if (toInsert.length > 0) {
      counters.accepted += await this.store.insertEventsIgnoreDuplicates(toInsert);
    }

    // 5) 按水印定稿窗口：严格 ts < watermark 的事件秩不可能再被未来事件改变
    const maxTs = (await this.store.maxEventTimestamp(id)) ?? this.state.maxTimestampUs;
    const settleRank = await this.store.countEventsBefore(id, watermark);

    const finalizedWindowIndexes: number[] = [];
    let j = this.state.nextWindowIndex;
    while (j * s.step + s.windowEvents <= settleRank) {
      const ins = await this.store.insertWindow(await computeWindow(this.store, this.experiment, j));
      if (ins === 'inserted') finalizedWindowIndexes.push(j);
      j++;
    }

    // 6) 基线定稿（水印越过基线结束时刻）
    const baselineEndUs = this.experiment.startedAtUs + s.baselineDurationUs;
    if (!this.state.baselineFinalized && watermark >= baselineEndUs) {
      this.state.baseline = await computeBaseline(this.store, this.experiment);
      this.state.baselineFinalized = true;
    }

    // 7) 预警状态机：按 index 顺序喂入尚未评估的窗口
    const runtime: AlertRuntime = {
      state: this.state.alertState,
      breachStreak: this.state.breachStreak,
      clearStreak: this.state.clearStreak,
      fedWindowCount: this.state.alertNextWindowIndex
    };
    const byIndex = new Map((await this.store.listWindows(id)).map((w) => [w.index, w]));
    const newAlerts: AlertTransition[] = [];
    while (runtime.fedWindowCount < j) {
      const w = byIndex.get(runtime.fedWindowCount);
      if (!w) break;
      newAlerts.push(...(await feedAlert(runtime, this.experiment, this.state.baseline, w, this.store, true)));
    }

    // 8) 状态最后更新
    this.state = {
      ...this.state,
      nextWindowIndex: j,
      maxTimestampUs: maxTs,
      watermarkUs: watermark,
      alertState: runtime.state,
      alertNextWindowIndex: runtime.fedWindowCount,
      breachStreak: runtime.breachStreak,
      clearStreak: runtime.clearStreak,
      counters,
      updatedAtUs: nowUs()
    };
    await this.stateStore.upsertState(this.state);

    return {
      experimentId: id,
      counters,
      receipts,
      finalizedWindowIndexes,
      newAlerts,
      maxTimestampUs: maxTs,
      watermarkUs: watermark
    };
  }

  /**
   * 结束试验：不再接收事件，用剩余事件（含水印之后的尾部）补齐窗口；
   * 基线若未定稿也按现存事件结算。
   */
  async close(): Promise<{ finalizedWindowIndexes: number[]; newAlerts: AlertTransition[] }> {
    if (this.state.closed) return { finalizedWindowIndexes: [], newAlerts: [] };

    if (!this.state.baselineFinalized) {
      this.state.baseline = await computeBaseline(this.store, this.experiment);
      this.state.baselineFinalized = true;
    }

    const totalEvents = await this.store.countEvents(this.experiment.experimentId);
    const finalizedWindowIndexes: number[] = [];
    let j = this.state.nextWindowIndex;
    while (j * this.experiment.settings.step + this.experiment.settings.windowEvents <= totalEvents) {
      const ins = await this.store.insertWindow(await computeWindow(this.store, this.experiment, j));
      if (ins === 'inserted') finalizedWindowIndexes.push(j);
      j++;
    }

    const runtime: AlertRuntime = {
      state: this.state.alertState,
      breachStreak: this.state.breachStreak,
      clearStreak: this.state.clearStreak,
      fedWindowCount: this.state.alertNextWindowIndex
    };
    const byIndex = new Map((await this.store.listWindows(this.experiment.experimentId)).map((w) => [w.index, w]));
    const newAlerts: AlertTransition[] = [];
    while (runtime.fedWindowCount < j) {
      const w = byIndex.get(runtime.fedWindowCount);
      if (!w) break;
      newAlerts.push(...(await feedAlert(runtime, this.experiment, this.state.baseline, w, this.store, true)));
    }

    this.state = {
      ...this.state,
      nextWindowIndex: j,
      alertState: runtime.state,
      alertNextWindowIndex: runtime.fedWindowCount,
      breachStreak: runtime.breachStreak,
      clearStreak: runtime.clearStreak,
      closed: true,
      updatedAtUs: nowUs()
    };
    await this.stateStore.upsertState(this.state);
    await this.stateStore.setClosed(this.experiment.experimentId, true);
    return { finalizedWindowIndexes, newAlerts };
  }
}

export class ExperimentClosedError extends Error {
  constructor(public readonly experimentId: string) {
    super(`试验 ${experimentId} 已关闭，不再接收事件`);
    this.name = 'ExperimentClosedError';
  }
}

async function computeWindow(store: Store, experiment: Experiment, index: number): Promise<WindowResult> {
  const s = experiment.settings;
  const startRank = index * s.step;
  const endRankExclusive = startRank + s.windowEvents;
  const events = await store.listEventsByRank(experiment.experimentId, startRank, endRankExclusive);
  const estimate = estimateBValue(
    events.map((e) => e.amplitudeDb),
    s.minEffectiveEvents
  );
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const common = {
    experimentId: experiment.experimentId,
    index,
    startRank,
    endRankExclusive,
    startTimeUs: first.timestampUs,
    endTimeUs: last.timestampUs,
    eventCount: events.length
  };

  if (estimate.ok) {
    return {
      ...common,
      mcDb: estimate.mcDb,
      mcMagnitude: estimate.mcMagnitude,
      effectiveCount: estimate.effectiveCount,
      b: estimate.b,
      sigmaB: estimate.sigmaB,
      insufficient: false,
      degenerate: false,
      createdAtUs: nowUs()
    };
  }
  return {
    ...common,
    mcDb: estimate.mcDb ?? Math.floor(first.amplitudeDb),
    mcMagnitude: estimate.mcMagnitude ?? Math.floor(first.amplitudeDb) / 20,
    effectiveCount: estimate.effectiveCount,
    b: null,
    sigmaB: null,
    insufficient: estimate.reason !== 'degenerate',
    degenerate: estimate.reason === 'degenerate',
    createdAtUs: nowUs()
  };
}

async function computeBaseline(store: Store, experiment: Experiment): Promise<BaselineResult> {
  const baselineEndUs = experiment.startedAtUs + experiment.settings.baselineDurationUs;
  const events = await store.listEventsBefore(experiment.experimentId, baselineEndUs);
  const estimate = estimateBValue(
    events.map((e) => e.amplitudeDb),
    experiment.settings.minEffectiveEvents
  );
  const base = {
    mcDb: estimate.mcDb ?? 0,
    mcMagnitude: estimate.mcMagnitude ?? 0,
    effectiveCount: estimate.effectiveCount,
    eventCount: events.length,
    rangeStartUs: experiment.startedAtUs,
    rangeEndUs: baselineEndUs
  };
  if (!estimate.ok) {
    return { ...base, b: 0, sigmaB: 0, status: 'insufficient' };
  }
  return { ...base, b: estimate.b, sigmaB: estimate.sigmaB, status: 'ok' };
}

/**
 * 喂入一个窗口，推进预警状态机；persist=true 时把新变迁落库（幂等）。
 *
 * 规则：b 低于 阈值（基线b - k*基线sigma）计一个越限窗口，连续 persistWindows 个拉起；
 * 拉起后 b 回到阈值及以上连续 persistWindows 个解除。样本不足的窗口中断两侧连续计数。
 */
async function feedAlert(
  rt: AlertRuntime,
  experiment: Experiment,
  baseline: BaselineResult | null,
  w: WindowResult,
  store: Store,
  persist: boolean
): Promise<AlertTransition[]> {
  rt.fedWindowCount++;
  if (!baseline || baseline.status !== 'ok') return [];
  if (!Number.isFinite(w.b) || !Number.isFinite(w.sigmaB)) {
    // 本窗口样本不足/退化：不推进越限/恢复计数
    rt.breachStreak = 0;
    rt.clearStreak = 0;
    return [];
  }

  const s = experiment.settings;
  const threshold = baseline.b - s.alertSigmaMultiple * baseline.sigmaB;
  const b = w.b as number;
  const sigmaB = w.sigmaB as number;
  const below = b < threshold;

  const transitions: AlertTransition[] = [];
  const make = (kind: AlertKind): AlertTransition => ({
    experimentId: experiment.experimentId,
    kind,
    windowIndex: w.index,
    b,
    sigmaB,
    thresholdB: threshold,
    baselineB: baseline.b,
    baselineSigmaB: baseline.sigmaB,
    createdAtUs: nowUs()
  });

  if (rt.state === null) {
    if (below) {
      rt.breachStreak++;
      rt.clearStreak = 0;
      if (rt.breachStreak >= s.persistWindows) {
        transitions.push(make('raised'));
        rt.state = 'raised';
        rt.breachStreak = 0;
      }
    } else {
      rt.breachStreak = 0;
    }
  } else if (below) {
    rt.clearStreak = 0;
  } else {
    rt.clearStreak++;
    rt.breachStreak = 0;
    if (rt.clearStreak >= s.persistWindows) {
      transitions.push(make('cleared'));
      rt.state = null;
      rt.clearStreak = 0;
    }
  }

  if (persist) {
    for (const t of transitions) await store.insertAlert(t);
  }
  return transitions;
}
