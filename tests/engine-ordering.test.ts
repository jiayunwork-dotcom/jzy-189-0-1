import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/repo/memory.js';
import { ExperimentEngine, BatchValidationError } from '../src/domain/engine.js';
import type { Experiment } from '../src/domain/types.js';
import { makeEngine, makeSettings } from './helpers/engine.js';
import { generateEvents, makeRng, shuffleWithinDelay } from './helpers/synthetic.js';

const START = 0;
const DT = 100_000; // 每 0.1 秒一个事件

async function runSequential(engine: ExperimentEngine, events: ReturnType<typeof generateEvents>) {
  // 一次推一条，严格时间顺序
  for (const e of events) {
    await engine.ingest([e]);
  }
}

describe('乱序与去重', () => {
  it('允许延迟内打乱顺序送入，定稿窗口与按时间顺序完全一致', async () => {
    const events = generateEvents({
      segments: [{ n: 2000, b: 1.2 }],
      startUs: START,
      dtUs: DT,
      seed: 1,
    });
    const settings = makeSettings({
      windowEvents: 300,
      stepEvents: 100,
      allowedDelayUs: 5_000_000,
      baselineEndUs: 50_000_000,
      minEventsForB: 50,
      amplitudeMaxDb: 200,
    });

    const repoA = new MemoryRepository();
    const expA: Experiment = {
      id: 'A', startedAtUs: 0, sample: {}, settings, status: 'running', createdAtUs: 0,
    };
    await repoA.insertExperiment(expA);
    const engineA = await ExperimentEngine.hydrate(expA, repoA);
    await runSequential(engineA, events);
    await engineA.stop();

    const repoB = new MemoryRepository();
    const expB = { ...expA, id: 'B' };
    await repoB.insertExperiment(expB);
    const engineB = await ExperimentEngine.hydrate(expB, repoB);

    // 5 秒延迟内分块打乱，每批 200 条乱序推送
    const rng = makeRng(123);
    const shuffled = shuffleWithinDelay(events, 5_000_000, rng);
    for (let i = 0; i < shuffled.length; i += 200) {
      await engineB.ingest(shuffled.slice(i, i + 200));
    }
    await engineB.stop();

    const wa = await repoA.listWindows('A');
    const wb = await repoB.listWindows('B');
    expect(wb.length).toBe(wa.length);
    // 除试验编号外逐窗口逐字段一致
    const strip = (ws: typeof wa) => ws.map(({ experimentId: _id, ...rest }) => rest);
    expect(strip(wb)).toEqual(strip(wa));
  });

  it('重复发送（含整批重发）不改变结果，只增加 duplicate 计数', async () => {
    const events = generateEvents({
      segments: [{ n: 800, b: 1.0 }],
      startUs: START, dtUs: DT, seed: 3,
    });
    const repo = new MemoryRepository();
    const engine = await makeEngine(repo, 'DUP', {
      windowEvents: 200, stepEvents: 100, baselineEndUs: 30_000_000,
    });

    await engine.ingest(events.slice(0, 400));
    await engine.ingest(events.slice(400, 800));
    // 模拟网络重连：同一批事件重发
    const res = await engine.ingest(events.slice(300, 800));
    expect(res.duplicates).toBe(500);
    expect(res.accepted).toBe(0);

    await engine.stop();
    const windows = await repo.listWindows('DUP');
    // 每事件只算一次：库里也是 800 条
    expect(await repo.countEvents('DUP')).toBe(800);
    expect(windows.every((w) => w.nTotal === 200)).toBe(true);
  });

  it('超出允许延迟的迟到事件被丢弃并计数，且其重发仍判重复', async () => {
    const repo = new MemoryRepository();
    const engine = await makeEngine(repo, 'LATE', {
      allowedDelayUs: 2_000_000,
      baselineEndUs: 30_000_000,
    });

    // 先推进水印到约 10s
    const early = Array.from({ length: 100 }, (_, i) => ({
      eventId: `N${i}`,
      timestampUs: i * 100_000,
      amplitudeDb: 45 + (i % 8),
      channel: 1,
    }));
    await engine.ingest(early);

    // 一条时间戳在水印之前 3 秒的迟到事件
    const late = { eventId: 'OLD1', timestampUs: 5_000_000, amplitudeDb: 60, channel: 2 };
    let r = await engine.ingest([late]);
    expect(r.lateDropped).toBe(1);
    expect(r.accepted).toBe(0);

    // 迟到事件重发：算重复，不再重复计数 lateDropped
    r = await engine.ingest([late]);
    expect(r.duplicates).toBe(1);
    expect(r.lateDropped).toBe(0);

    // 延迟以内的事件仍然接受
    const ok = { eventId: 'NEW', timestampUs: 8_500_000, amplitudeDb: 55, channel: 1 };
    r = await engine.ingest([ok]);
    expect(r.accepted).toBe(1);
  });

  it('同批内迟到事件再次出现按重复处理，不重复计数', async () => {
    const repo = new MemoryRepository();
    const engine = await makeEngine(repo, 'LATE2', {
      allowedDelayUs: 2_000_000,
      baselineEndUs: 30_000_000,
    });
    const early = Array.from({ length: 100 }, (_, i) => ({
      eventId: `N${i}`,
      timestampUs: i * 100_000,
      amplitudeDb: 45 + (i % 8),
      channel: 1,
    }));
    await engine.ingest(early);

    const late = { eventId: 'OLDX', timestampUs: 5_000_000, amplitudeDb: 60, channel: 2 };
    const r = await engine.ingest([late, late]);
    expect(r.lateDropped).toBe(1);
    expect(r.duplicates).toBe(1);
  });

  it('中途重启（内存引擎+同一仓储回放）后继续接收，结果与没中断完全一致', async () => {
    const settings = makeSettings({
      windowEvents: 250, stepEvents: 100,
      allowedDelayUs: 3_000_000, baselineEndUs: 40_000_000,
      amplitudeMaxDb: 200,
    });
    const events = generateEvents({
      segments: [{ n: 1800, b: 1.1 }],
      startUs: START, dtUs: DT, seed: 8,
    });
    const rng = makeRng(77);
    const shuffled = shuffleWithinDelay(events, 3_000_000, rng);

    // 对照组：不中断
    const repoA = new MemoryRepository();
    const expA: Experiment = {
      id: 'A', startedAtUs: 0, sample: {}, settings, status: 'running', createdAtUs: 0,
    };
    await repoA.insertExperiment(expA);
    let engineA = await ExperimentEngine.hydrate(expA, repoA);
    for (let i = 0; i < shuffled.length; i += 150) {
      await engineA.ingest(shuffled.slice(i, i + 150));
    }
    await engineA.stop();

    // 试验组：每 400 条“重启”一次——丢弃引擎，按仓储重建
    const repoB = new MemoryRepository();
    const expB = { ...expA, id: 'B' };
    await repoB.insertExperiment(expB);
    let engineB = await ExperimentEngine.hydrate(expB, repoB);
    for (let i = 0; i < shuffled.length; i += 150) {
      await engineB.ingest(shuffled.slice(i, i + 150));
      if (i > 0 && i % 450 === 0) {
        engineB = await ExperimentEngine.hydrate(expB, repoB);
      }
    }
    engineB = await ExperimentEngine.hydrate(expB, repoB);
    await engineB.stop();

    const wa = await repoA.listWindows('A');
    const wb = await repoB.listWindows('B');
    const strip = (ws: typeof wa) => ws.map(({ experimentId: _id, ...rest }) => rest);
    expect(strip(wb)).toEqual(strip(wa));
    const ma = await repoA.loadEngineMeta('A');
    const mb = await repoB.loadEngineMeta('B');
    expect(mb!.acceptedCount).toBe(ma!.acceptedCount);
    expect(mb!.finalizedWindows).toBe(ma!.finalizedWindows);
    expect(mb!.alertState).toBe(ma!.alertState);
    const aa = (await repoA.listAlerts('A')).map(({ experimentId: _id, ...rest }) => rest);
    const bb = (await repoB.listAlerts('B')).map(({ experimentId: _id, ...rest }) => rest);
    expect(bb).toEqual(aa);
  });
});

describe('事件字段校验', () => {
  it('幅度非有限数、超出量程、时间戳早于开始、通道非法均指出具体字段', async () => {
    const repo = new MemoryRepository();
    const engine = await makeEngine(repo, 'V');

    const bad = [
      { eventId: 'x1', timestampUs: 1000, amplitudeDb: NaN, channel: 1 },
      { eventId: 'x2', timestampUs: 1000, amplitudeDb: Infinity, channel: 1 },
      { eventId: 'x3', timestampUs: 1000, amplitudeDb: 999, channel: 1 },
      { eventId: 'x4', timestampUs: -1, amplitudeDb: 50, channel: 1 },
      { eventId: 'x5', timestampUs: 1000, amplitudeDb: 50, channel: -2 },
      { eventId: '', timestampUs: 1000, amplitudeDb: 50, channel: 1 },
    ];
    let err: unknown = null;
    try {
      await engine.ingest(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BatchValidationError);
    const fields = (err as BatchValidationError).fieldErrors.map((f) => f.field).sort();
    expect(fields).toEqual(
      [
        'events[0].amplitudeDb',
        'events[1].amplitudeDb',
        'events[2].amplitudeDb',
        'events[3].timestampUs',
        'events[4].channel',
        'events[5].eventId',
      ].sort(),
    );
  });

  it('合法事件在同批含非法事件时仍被接收并参与计算', async () => {
    const repo = new MemoryRepository();
    const engine = await makeEngine(repo, 'V2');
    const good = { eventId: 'g', timestampUs: 1000, amplitudeDb: 55, channel: 0 };
    let err: unknown = null;
    try {
      await engine.ingest([good, { eventId: 'bad', timestampUs: -1, amplitudeDb: 1, channel: 0 }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BatchValidationError);
    expect(await repo.countEvents('V2')).toBe(1);
  });
});
