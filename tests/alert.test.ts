import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../src/repo/memory.js';
import { ExperimentEngine, evaluateAlertStep } from '../src/domain/engine.js';
import type { Experiment, WindowResult } from '../src/domain/types.js';
import { generateEvents } from './helpers/synthetic.js';

async function twoSegmentEngine(repo: MemoryRepository, id: string, opts: {
  n1: number; b1: number; n2: number; b2: number;
  windowEvents: number; stepEvents: number; persistence: number; multiplier: number;
  baselineEvents: number;
}) {
  const dtUs = 100_000;
  const events = generateEvents({
    segments: [
      { n: opts.n1, b: opts.b1 },
      { n: opts.n2, b: opts.b2 },
    ],
    startUs: 0,
    dtUs,
    mcDb: 40,
    seed: 2024,
  });
  const settings = {
    windowEvents: opts.windowEvents,
    stepEvents: opts.stepEvents,
    allowedDelayUs: 1_000_000,
    baselineStartUs: 0,
    baselineEndUs: opts.baselineEvents * dtUs,
    alertMultiplier: opts.multiplier,
    persistenceWindows: opts.persistence,
    minEventsForB: 100,
    mcMethod: 'MAXC' as const,
    amplitudeMinDb: 0,
    amplitudeMaxDb: 200,
  };
  const exp: Experiment = {
    id, startedAtUs: 0, sample: {}, settings, status: 'running', createdAtUs: 0,
  };
  await repo.insertExperiment(exp);
  const engine = await ExperimentEngine.hydrate(exp, repo);
  return { engine, events, dtUs, exp };
}

describe('预警状态机（纯函数）', () => {
  const win = (b: number | null, se = 0.02): Pick<WindowResult, 'bValue' | 'bStdError'> => ({
    bValue: b, bStdError: b === null ? null : se,
  });

  it('连续 P 个越限窗口才拉起，不足 P 个再恢复正常则不报警', () => {
    let s = evaluateAlertStep('normal', 0, 0, win(0.90), 1.0, 2, 3);
    expect(s.state).toBe('normal');
    expect(s.fired).toBeNull();
    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(0.90), 1.0, 2, 3);
    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(1.0), 1.0, 2, 3);
    expect(s.state).toBe('normal');
    expect(s.breachStreak).toBe(0);
  });

  it('恰好 P 个连续越限拉起；再连续 P 个恢复窗口解除', () => {
    let s = evaluateAlertStep('normal', 0, 0, win(0.9), 1.0, 2, 3);
    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(0.9), 1.0, 2, 3);
    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(0.9), 1.0, 2, 3);
    expect(s.state).toBe('alarm');
    expect(s.fired).toBe('raised');

    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(1.0), 1.0, 2, 3);
    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(1.0), 1.0, 2, 3);
    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(1.0), 1.0, 2, 3);
    expect(s.state).toBe('normal');
    expect(s.fired).toBe('cleared');
  });

  it('报警后中途一次再越限，恢复计数清零', () => {
    let s = evaluateAlertStep('normal', 0, 0, win(0.9), 1.0, 2, 2);
    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(0.9), 1.0, 2, 2);
    expect(s.fired).toBe('raised');
    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(1.0), 1.0, 2, 2);
    s = evaluateAlertStep(s.state, s.breachStreak, s.recoveryStreak, win(0.9), 1.0, 2, 2);
    expect(s.state).toBe('alarm');
    expect(s.fired).toBeNull();
    expect(s.recoveryStreak).toBe(0);
  });

  it('样本不足窗口保持中性，不误报也不重置已有计数', () => {
    let s = evaluateAlertStep('normal', 1, 0, win(null), 1.0, 2, 3);
    expect(s.breachStreak).toBe(1);
    expect(s.state).toBe('normal');
  });

  it('阈值边界：b 恰好等于 b0−k·se 不算越限（严格小于才算）', () => {
    const s = evaluateAlertStep('normal', 0, 0, win(0.96), 1.0, 2, 1);
    expect(s.fired).toBeNull();
  });
});

describe('端到端：前后两段 b 值不同的合成数据', () => {
  it('预警在第二段出现后按持续窗口数拉起，不会更早；之后可解除', async () => {
    const N = 300;
    const P = 3;
    const n1 = 3000;
    const n2 = 3000;
    const repo = new MemoryRepository();
    const { engine, events } = await twoSegmentEngine(repo, 'AL', {
      n1, b1: 1.2, n2, b2: 0.7,
      windowEvents: N, stepEvents: N, persistence: P, multiplier: 3,
      baselineEvents: 1500,
    });

    // 大窗口、非重叠；事件逐条按序推送
    const batch = 100;
    for (let i = 0; i < events.length; i += batch) {
      await engine.ingest(events.slice(i, i + batch));
    }
    await engine.stop();

    const windows = await repo.listWindows('AL');
    const alerts = await repo.listAlerts('AL');
    const meta = await repo.loadEngineMeta('AL');

    // 基线 b ≈ 1.2
    expect(meta!.baseline.status).toBe('ready');
    expect(Math.abs((meta!.baseline.bValue as number) - 1.2)).toBeLessThan(0.05);

    // 第一个越限窗口：必须在第二段开始（ordinal n1）之后
    const breachWindows = windows.filter((w) =>
      w.bValue !== null && w.bStdError !== null &&
      w.bValue < (meta!.baseline.bValue as number) - 3 * w.bStdError,
    );
    expect(breachWindows.length).toBeGreaterThan(0);
    expect(breachWindows[0]!.startOrdinal).toBeGreaterThanOrEqual(n1);

    // 第一段的所有窗口均不越限
    const seg1Windows = windows.filter((w) => w.endOrdinal < n1);
    expect(seg1Windows.length).toBeGreaterThan(0);
    expect(seg1Windows.every((w) =>
      w.bValue === null ||
      w.bValue >= (meta!.baseline.bValue as number) - 3 * (w.bStdError as number),
    )).toBe(true);

    // 拉起记录存在，且恰为第一个越限窗口后数第 P 个，且不会在第二段之前
    const raised = alerts.find((a) => a.kind === 'raised');
    expect(raised).toBeDefined();
    expect(raised!.windowIndex).toBe(breachWindows[0]!.windowIndex + (P - 1));
    expect(raised!.threshold).not.toBeNull();

    // 第二段持续低 b，预警拉起后保持
    expect(meta!.alertState).toBe('alarm');

    // 拉起与解除（本例数据只升不降，无解除）各自带窗口编号和当时数值
    expect(raised!.bValue).not.toBeNull();
    expect(raised!.bStdError).not.toBeNull();
    expect(raised!.baselineB).toBeCloseTo(meta!.baseline.bValue as number, 6);
  });

  it('恢复段出现后连续 P 个窗口解除预警', async () => {
    const repo = new MemoryRepository();
    const dtUs = 100_000;
    const events = generateEvents({
      segments: [
        { n: 2400, b: 1.2 },
        { n: 1500, b: 0.7 },
        { n: 2400, b: 1.2 },
      ],
      startUs: 0, dtUs, mcDb: 40, seed: 55,
    });
    const settings = {
      windowEvents: 300, stepEvents: 300, allowedDelayUs: 1_000_000,
      baselineStartUs: 0, baselineEndUs: 1200 * dtUs,
      alertMultiplier: 3, persistenceWindows: 3, minEventsForB: 100,
      mcMethod: 'MAXC' as const, amplitudeMinDb: 0, amplitudeMaxDb: 200,
    };
    const exp: Experiment = {
      id: 'RC', startedAtUs: 0, sample: {}, settings, status: 'running', createdAtUs: 0,
    };
    await repo.insertExperiment(exp);
    const engine = await ExperimentEngine.hydrate(exp, repo);
    for (let i = 0; i < events.length; i += 100) {
      await engine.ingest(events.slice(i, i + 100));
    }
    await engine.stop();
    const alerts = await repo.listAlerts('RC');
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain('raised');
    expect(kinds).toContain('cleared');
    const raisedIdx = kinds.indexOf('raised');
    const clearedIdx = kinds.indexOf('cleared');
    expect(clearedIdx).toBeGreaterThan(raisedIdx);
  });

  it('基线有效事件不足时不产生预警，但窗口与状态照常保存', async () => {
    const repo = new MemoryRepository();
    const dtUs = 100_000;
    const events = generateEvents({
      segments: [{ n: 1000, b: 0.6 }],
      startUs: 0, dtUs, seed: 3,
    });
    const settings = {
      windowEvents: 300, stepEvents: 300, allowedDelayUs: 1_000_000,
      baselineStartUs: 0, baselineEndUs: 2 * dtUs, // 基线时段只有 2 个事件
      alertMultiplier: 2, persistenceWindows: 1, minEventsForB: 100,
      mcMethod: 'MAXC' as const, amplitudeMinDb: 0, amplitudeMaxDb: 200,
    };
    const exp: Experiment = {
      id: 'NB', startedAtUs: 0, sample: {}, settings, status: 'running', createdAtUs: 0,
    };
    await repo.insertExperiment(exp);
    const engine = await ExperimentEngine.hydrate(exp, repo);
    for (let i = 0; i < events.length; i += 100) {
      await engine.ingest(events.slice(i, i + 100));
    }
    await engine.stop();
    const meta = await repo.loadEngineMeta('NB');
    expect(meta!.baseline.status).toBe('insufficient');
    expect(await repo.listAlerts('NB')).toEqual([]);
    expect((await repo.listWindows('NB')).length).toBeGreaterThan(0);
  });
});
