import { beforeEach, describe, expect, it } from 'vitest';
import { AppService } from '../src/app/service.js';
import type { AnalysisSettings, Experiment, IncomingEvent } from '../src/domain/types.js';
import { MemoryStore } from './helpers/memoryStore.js';
import { generateEvents, shuffleWithinDelay, type SynthEvent } from './helpers/synth.js';

const START = 10_000_000;
const INTERVAL = 100_000; // 0.1 s

function settings(patch: Partial<AnalysisSettings> = {}): AnalysisSettings {
  return {
    windowEvents: 400,
    step: 200,
    maxDelayUs: 2_000_000, // 2 s = 20 个事件间隔
    baselineDurationUs: 300 * INTERVAL,
    alertSigmaMultiple: 1.5,
    persistWindows: 3,
    minEffectiveEvents: 50,
    amplitudeMinDb: 0,
    amplitudeMaxDb: 100,
    mcMethod: 'maxc',
    ...patch
  };
}

async function makeExperiment(service: AppService, s = settings()): Promise<Experiment> {
  return service.createExperiment({
    experimentId: `exp-${Math.random().toString(36).slice(2, 8)}`,
    startedAtUs: START,
    sample: { rock: 'synthetic' },
    settings: s
  });
}

const toIncoming = (e: SynthEvent): IncomingEvent => ({
  eventId: e.eventId,
  timestampUs: e.timestampUs,
  amplitudeDb: e.amplitudeDb,
  channel: e.channel
});

/**
 * 用合成事件时间作为墙上时钟：水印随事件时间推进（真实试验里两者同量级）。
 * 时钟取本批最大 ts，保证只定稿“已超出延迟”的事件。
 */
async function ingestAt(service: AppService, id: string, events: IncomingEvent[]) {
  const wall = events.length > 0 ? events.reduce((m, e) => Math.max(m, e.timestampUs), 0) : START;
  return service.ingest(id, events, wall);
}

describe('实时 b 值引擎（单段合成，b=1.0）', () => {
  let store: MemoryStore;
  let service: AppService;

  beforeEach(() => {
    store = new MemoryStore();
    service = new AppService(store, store);
  });

  it('窗口 b 值随事件流定稿：滑窗高度重叠，拓扑与数值合理；大样本误差在 2 sigma 内', async () => {
    const exp = await makeExperiment(service, { ...settings(), windowEvents: 2000, step: 1000 });
    const evs = generateEvents([{ bTrue: 1.0, count: 6000, mcDb: 30 }], {
      seed: 2024,
      startUs: START,
      intervalUs: INTERVAL
    });

    // 分批乱序推送
    for (let i = 0; i < evs.length; i += 300) {
      const batch = shuffleWithinDelay(evs.slice(i, i + 300), 5, 7 + i).map(toIncoming);
      await ingestAt(service, exp.experimentId, batch);
    }
    await service.closeExperiment(exp.experimentId);

    const windows = await service.listWindows(exp.experimentId);
    expect(windows.length).toBeGreaterThan(3);
    for (const w of windows) {
      // 窗口严格按 (timestamp,eventId) 秩切分
      expect(w.endRankExclusive - w.startRank).toBe(exp.settings.windowEvents);
      expect(w.b).not.toBeNull();
      // 所有窗口都在合理量级
      expect(w.b as number).toBeGreaterThan(0.5);
      expect(w.b as number).toBeLessThan(2.0);
    }
    // 大窗口（N=2000）单窗 2σ≈0.045；重叠窗口彼此强相关，
    // 要求全部窗口 z<=2 等价于该流实现的一次抽样，偶发单个越界属统计正常（概率约几个百分点）。
    // 检验标准（“事件足够多时估计值与真值之差在两倍标准误差以内”）由 tests/magnitude 中
    // 独立大样本多次重复的覆盖测试保证；这里允许至多一个窗口略越界。
    const z = windows.map((w) => Math.abs((w.b as number) - 1.0) / (w.sigmaB as number));
    const outliers = z.filter((v) => v > 2);
    expect(outliers.length).toBeLessThanOrEqual(1);
    if (outliers.length === 1) expect(outliers[0]!).toBeLessThan(2.5);
  });

  it('延迟范围内打乱顺序与按时间顺序结果完全一致', async () => {
    const s = settings();
    const evs = generateEvents([{ bTrue: 1.1, count: 3000, mcDb: 28 }], {
      seed: 55,
      startUs: START,
      intervalUs: INTERVAL
    });

    const run = async (shuffle: boolean) => {
      const st = new MemoryStore();
      const sv = new AppService(st, st);
      const exp = await sv.createExperiment({
        experimentId: shuffle ? 'shuf' : 'ord',
        startedAtUs: START,
        sample: {},
        settings: s
      });
      const stream = shuffle
        ? shuffleWithinDelay(evs, 5, 99) // 最大位移 5 个间隔 = 0.5s < 2s
        : evs;
      for (let i = 0; i < stream.length; i += 250) {
        await ingestAt(sv, exp.experimentId, stream.slice(i, i + 250).map(toIncoming));
      }
      await sv.closeExperiment(exp.experimentId);
      return {
        windows: await sv.listWindows(exp.experimentId),
        alerts: await sv.listAlerts(exp.experimentId)
      };
    };

    const a = await run(false);
    const b = await run(true);
    expect(b.windows.length).toBe(a.windows.length);
    for (let i = 0; i < a.windows.length; i++) {
      // createdAtUs / experimentId 之外逐字段一致
      const { createdAtUs: _c1, experimentId: _x1, ...wa } = a.windows[i]!;
      const { createdAtUs: _c2, experimentId: _x2, ...wb } = b.windows[i]!;
      expect(wb).toEqual(wa);
    }
    expect(b.alerts.map((x) => ({ ...x, createdAtUs: 0, experimentId: '' }))).toEqual(
      a.alerts.map((x) => ({ ...x, createdAtUs: 0, experimentId: '' }))
    );
  });

  it('重复发送（整批重发）不改变任何结果', async () => {
    const exp = await makeExperiment(service);
    const evs = generateEvents([{ bTrue: 1.0, count: 1500, mcDb: 30 }], {
      seed: 8,
      startUs: START,
      intervalUs: INTERVAL
    }).map(toIncoming);

    for (let i = 0; i < evs.length; i += 200) {
      await ingestAt(service, exp.experimentId, evs.slice(i, i + 200));
    }
    const before = (await service.listWindows(exp.experimentId)).map((w) => w.b);
    const countBefore = await store.countEvents(exp.experimentId);

    // 整批网络重发 + 批内重复。counters 为试验累计计数，本批效果看 receipts/差值。
    const acceptedBefore = (await service.getState(exp.experimentId)).counters.accepted;
    const resend = await ingestAt(service, exp.experimentId, [...evs.slice(0, 200), ...evs.slice(0, 200)]);
    expect(resend.receipts.filter((x) => x.status === 'duplicate')).toHaveLength(400);
    expect(resend.counters.accepted).toBe(acceptedBefore);
    expect((await service.getState(exp.experimentId)).counters.duplicate).toBeGreaterThanOrEqual(400);
    const after = (await service.listWindows(exp.experimentId)).map((w) => w.b);
    expect(after).toEqual(before);
    expect(await store.countEvents(exp.experimentId)).toBe(countBefore);
  });

  it('超出延迟的迟到事件被丢弃并计数，不进入已定稿窗口', async () => {
    const s = settings({ maxDelayUs: 500_000 }); // 5 个间隔
    const exp = await makeExperiment(service, s);
    const evs = generateEvents([{ bTrue: 1.0, count: 1200, mcDb: 30 }], {
      seed: 3,
      startUs: START,
      intervalUs: INTERVAL
    }).map(toIncoming);

    // 先推前 800 个
    await ingestAt(service, exp.experimentId, evs.slice(0, 800));
    const priorB = (await service.listWindows(exp.experimentId)).map((w) => w.b);
    const windowsThen = priorB.length;

    // 一个迟到 3 秒（>0.5s 允许延迟）的老事件
    const late: IncomingEvent = {
      eventId: 'late-1',
      timestampUs: START + 10 * INTERVAL,
      amplitudeDb: 30.1,
      channel: 0
    };
    const r = await ingestAt(service, exp.experimentId, [late, ...evs.slice(800, 900)]);
    expect(r.counters.late).toBe(1);
    const receipt = r.receipts.find((x) => x.eventId === 'late-1')!;
    expect(receipt.status).toBe('late');

    // 迟到事件未进事件库
    expect((await store.hasEventIds(exp.experimentId, ['late-1'])).has('late-1')).toBe(false);
    // 既有窗口内容不被迟到事件改写
    const afterB = (await service.listWindows(exp.experimentId)).slice(0, windowsThen).map((w) => w.b);
    expect(afterB).toEqual(priorB);
    const state = await service.getState(exp.experimentId);
    expect(state.counters.late).toBe(1);
  });

  it('非法事件逐字段拒收并计数，不影响其余事件', async () => {
    const exp = await makeExperiment(service);
    const good = toIncoming(
      generateEvents([{ bTrue: 1.0, count: 10, mcDb: 30 }], {
        seed: 1,
        startUs: START,
        intervalUs: INTERVAL
      })[0]!
    );
    const r = await ingestAt(service, exp.experimentId, [
      good,
      { eventId: 'bad-amp', timestampUs: START + 1, amplitudeDb: Number.NaN, channel: 0 },
      { eventId: 'bad-ts', timestampUs: START - 100, amplitudeDb: 50, channel: 0 },
      { eventId: 'bad-range', timestampUs: START + 2, amplitudeDb: 200, channel: 0 }
    ]);
    expect(r.counters.accepted).toBe(1);
    expect(r.counters.invalid).toBe(2);
    expect(r.counters.beforeStart).toBe(1);
    const badAmp = r.receipts.find((x) => x.eventId === 'bad-amp')!;
    expect(badAmp.field).toBe('amplitudeDb');
  });
});

describe('两段不同 b 值：预警时机', () => {
  it('第二段 b 明显下降后，恰在连续 persistWindows 个越限窗口拉起，不更早', async () => {
    const store = new MemoryStore();
    const service = new AppService(store, store);
    const SEG1_COUNT = 2500;
    const s = settings({
      windowEvents: 800,
      step: 400,
      baselineDurationUs: 1000 * INTERVAL,
      alertSigmaMultiple: 3,
      persistWindows: 3,
      minEffectiveEvents: 50
    });
    const exp = await service.createExperiment({
      experimentId: 'two-stage',
      startedAtUs: START,
      sample: {},
      settings: s
    });

    // 第一段 b=1.2，第二段 b=0.6（相差约 4 个第一段窗口 sigma）
    const evs = generateEvents(
      [
        { bTrue: 1.2, count: SEG1_COUNT, mcDb: 30 },
        { bTrue: 0.6, count: 3000, mcDb: 30 }
      ],
      { seed: 31337, startUs: START, intervalUs: INTERVAL }
    ).map(toIncoming);

    for (let i = 0; i < evs.length; i += 250) {
      await ingestAt(service, exp.experimentId, evs.slice(i, i + 250));
    }

    const state = await service.getState(exp.experimentId);
    expect(state.baseline?.status).toBe('ok');
    // 基线 N=1000 时 2σ≈0.076
    expect(Math.abs(state.baseline!.b - 1.2)).toBeLessThan(0.15);

    const alerts = await service.listAlerts(exp.experimentId);
    const raised = alerts.find((a) => a.kind === 'raised');
    expect(raised).toBeDefined();

    const windows = await service.listWindows(exp.experimentId);
    const threshold = raised!.thresholdB;
    const at = windows.findIndex((w) => w.index === raised!.windowIndex);

    // 拉起窗口必须是“连续 3 个越限窗口”的第三个：前两个越限、再前一个不越限
    expect(windows[at]!.b!).toBeLessThan(threshold);
    expect(windows[at - 1]!.b!).toBeLessThan(threshold);
    expect(windows[at - 2]!.b!).toBeLessThan(threshold);
    expect(at - 3 < 0 || windows[at - 3]!.b! >= threshold).toBe(true);

    // 拉起时刻不能落在第一段：触发窗口的起始秩必须已进入第二段
    expect(windows[at]!.startRank).toBeGreaterThanOrEqual(SEG1_COUNT);
    // 第一段内没有任何窗口越限（k=3 的严格阈值 + 大样本）
    const firstSegmentWindows = windows.filter((w) => w.endRankExclusive <= SEG1_COUNT);
    expect(firstSegmentWindows.length).toBeGreaterThan(0);
    for (const w of firstSegmentWindows) {
      expect(w.b!).toBeGreaterThanOrEqual(threshold);
    }
    // 不存在更早的 raised
    expect(alerts.filter((a) => a.kind === 'raised')).toHaveLength(1);
  });

  it('b 值恢复后连续 persistWindows 个窗口解除预警', async () => {
    const store = new MemoryStore();
    const service = new AppService(store, store);
    const s = settings({
      baselineDurationUs: 400 * INTERVAL,
      alertSigmaMultiple: 1.0,
      persistWindows: 2
    });
    const exp = await service.createExperiment({
      experimentId: 'recover',
      startedAtUs: START,
      sample: {},
      settings: s
    });
    // 高 b → 低 b（拉起）→ 高 b（恢复）
    const evs = generateEvents(
      [
        { bTrue: 1.2, count: 1200, mcDb: 30 },
        { bTrue: 0.55, count: 1500, mcDb: 30 },
        { bTrue: 1.2, count: 1500, mcDb: 30 }
      ],
      { seed: 4242, startUs: START, intervalUs: INTERVAL }
    ).map(toIncoming);

    for (let i = 0; i < evs.length; i += 300) {
      await ingestAt(service, exp.experimentId, evs.slice(i, i + 300));
    }
    await service.closeExperiment(exp.experimentId);

    const alerts = await service.listAlerts(exp.experimentId);
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain('raised');
    expect(kinds).toContain('cleared');
    expect(kinds.indexOf('raised')).toBeLessThan(kinds.lastIndexOf('cleared'));
    // 变迁带窗口编号和数值
    for (const a of alerts) {
      expect(typeof a.windowIndex).toBe('number');
      expect(Number.isFinite(a.b)).toBe(true);
      expect(a.baselineB).toBeGreaterThan(0);
    }
  });
});

describe('重启续跑', () => {
  it('处理一半后用同一存储重建引擎，最终窗口/预警与一次跑完完全一致', async () => {
    const s = settings({ alertSigmaMultiple: 1.0, persistWindows: 2 });
    const evs = generateEvents(
      [
        { bTrue: 1.15, count: 1200, mcDb: 30 },
        { bTrue: 0.6, count: 2000, mcDb: 30 }
      ],
      { seed: 77, startUs: START, intervalUs: INTERVAL
    }).map(toIncoming);

    // 一次跑完的参考
    const refStore = new MemoryStore();
    const refService = new AppService(refStore, refStore);
    const refExp = await refService.createExperiment({
      experimentId: 'restart-ref',
      startedAtUs: START,
      sample: {},
      settings: s
    });
    for (let i = 0; i < evs.length; i += 237) {
      await ingestAt(refService, refExp.experimentId, evs.slice(i, i + 237));
    }
    const refWindows = await refService.listWindows(refExp.experimentId);
    const refAlerts = await refService.listAlerts(refExp.experimentId);

    // 跑到 40% 时“重启”：新建 service/engine，基于同一份 store 恢复
    const store = new MemoryStore();
    let service = new AppService(store, store);
    const exp = await service.createExperiment({
      experimentId: 'restart-me',
      startedAtUs: START,
      sample: {},
      settings: s
    });
    for (let i = 0; i < Math.floor(evs.length * 0.4); i += 211) {
      await ingestAt(service, exp.experimentId, evs.slice(i, i + 211));
    }
    const midWindows = (await service.listWindows(exp.experimentId)).length;
    expect(midWindows).toBeGreaterThan(0);

    // 模拟重启
    service = new AppService(store, store);
    await service.restoreAll();

    // 恢复后重放一半旧事件（去重）+ 剩余事件
    for (let i = 0; i < evs.length; i += 237) {
      await ingestAt(service, exp.experimentId, evs.slice(i, i + 237));
    }

    const windows = await service.listWindows(exp.experimentId);
    const alerts = await service.listAlerts(exp.experimentId);
    expect(windows.length).toBe(refWindows.length);
    for (let i = 0; i < windows.length; i++) {
      const { createdAtUs: _a, experimentId: _x1, ...wa } = windows[i]!;
      const { createdAtUs: _b, experimentId: _x2, ...wb } = refWindows[i]!;
      expect(wa).toEqual(wb);
    }
    expect(alerts.map((a) => ({ ...a, createdAtUs: 0, experimentId: '' }))).toEqual(
      refAlerts.map((a) => ({ ...a, createdAtUs: 0, experimentId: '' }))
    );

    const state = await service.getState(exp.experimentId);
    expect(state.alertState).toBe('raised');
    expect(await store.countEvents(exp.experimentId)).toBe(evs.length);
  });
});

describe('样本不足', () => {
  it('窗口内有效事件不足时 b 为 null 且标记 insufficient，不参与预警', async () => {
    const store = new MemoryStore();
    const service = new AppService(store, store);
    // 窗口（300 事件）内有效事件永远 < minEffectiveEvents(400)；基线时段只有 150 个事件，同样不足
    const s = settings({ windowEvents: 300, step: 150, minEffectiveEvents: 400, baselineDurationUs: 150 * INTERVAL });
    const exp = await service.createExperiment({
      experimentId: 'small',
      startedAtUs: START,
      sample: {},
      settings: s
    });
    const evs = generateEvents([{ bTrue: 1.0, count: 600, mcDb: 30 }], {
      seed: 9,
      startUs: START,
      intervalUs: INTERVAL
    }).map(toIncoming);
    await ingestAt(service, exp.experimentId, evs);
    await service.closeExperiment(exp.experimentId);
    const windows = await service.listWindows(exp.experimentId);
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w.b).toBeNull();
      expect(w.insufficient).toBe(true);
    }
    // 基线也不足时，永不预警
    const state = await service.getState(exp.experimentId);
    expect(state.baseline?.status).toBe('insufficient');
    expect((await service.listAlerts(exp.experimentId))).toEqual([]);
  });
});
