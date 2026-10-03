import { describe, expect, it } from 'vitest';
import {
  amplitudeBin,
  amplitudeToMagnitude,
  estimateBValue,
  estimateMcMaxc
} from '../src/domain/magnitude.js';
import { mulberry32 } from './helpers/synth.js';

function synthAmplitudes(n: number, bTrue: number, mcDb: number, seed: number, maxDb = 99): number[] {
  const rng = mulberry32(seed);
  const lambda = (bTrue * Math.LN10) / 20;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let a = mcDb - Math.log(rng()) / lambda;
    while (a > maxDb) a = mcDb - Math.log(rng()) / lambda;
    out.push(a);
  }
  return out;
}

describe('震级换算与分档', () => {
  it('M = A/20，1dB 一档', () => {
    expect(amplitudeToMagnitude(60)).toBeCloseTo(3, 12);
    expect(amplitudeBin(42.9)).toBe(42);
    expect(amplitudeBin(43)).toBe(43);
  });
});

describe('MAXC 完整性震级', () => {
  it('取频度最高档', () => {
    const amps = [30, 30, 30.5, 31, 31.2, 40];
    const mc = estimateMcMaxc(amps)!;
    expect(mc.mcDb).toBe(30);
    expect(mc.mcMagnitude).toBeCloseTo(1.5, 12);
  });

  it('频度并列时取最低档', () => {
    const amps = [30, 30, 31, 31, 45];
    expect(estimateMcMaxc(amps)!.mcDb).toBe(30);
  });

  it('空输入返回 null', () => {
    expect(estimateMcMaxc([])).toBeNull();
  });
});

describe('b 值最大似然', () => {
  it.each([123, 456, 789])('合成数据 b=1.0 时 |估计-真值| < 2*sigma（seed=%i）', (seed) => {
    const amps = synthAmplitudes(3000, 1.0, 30, seed);
    const r = estimateBValue(amps, 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.b - 1.0)).toBeLessThan(2 * r.sigmaB);
    expect(r.effectiveCount).toBe(3000);
  });

  it('大量独立窗口重复估计：2 sigma 经验覆盖率约 95%（无系统偏差）', () => {
    // 2000 个独立 N=400 窗口；bhat 服从 gamma 型抽样分布，2σ 覆盖应在 ~0.95 附近
    let covered = 0;
    const trials = 2000;
    for (let t = 0; t < trials; t++) {
      const amps = synthAmplitudes(400, 1.0, 30, 60000 + t);
      const r = estimateBValue(amps, 50);
      if (r.ok && Math.abs(r.b - 1.0) <= 2 * r.sigmaB) covered++;
    }
    const coverage = covered / trials;
    expect(coverage).toBeGreaterThan(0.93);
    expect(coverage).toBeLessThan(0.98);
  });

  it.each([123, 999])('合成数据 b=1.5 时 |估计-真值| < 2*sigma（seed=%i）', (seed) => {
    const amps = synthAmplitudes(4000, 1.5, 25, seed);
    const r = estimateBValue(amps, 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.b - 1.5)).toBeLessThan(2 * r.sigmaB);
  });

  it('幅度整体加整数常数 b 值不变（震级平移不变性）', () => {
    // 整数 dB 平移只平移各档本身，频度分布形状不变、MAXC 模式档一一对应；
    // 非整数平移会让事件在档边界处重新归并，MAXC 模式档可能切到相邻档，
    // 那是分档估计的固有离散效应，不属于估计器偏差。
    const amps = synthAmplitudes(3000, 1.2, 30, 42);
    const shifted = amps.map((a) => a + 17);
    const r1 = estimateBValue(amps, 50);
    const r2 = estimateBValue(shifted, 50);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.b).toBe(r2.b);
    expect(r1.sigmaB).toBe(r2.sigmaB);
    expect(r2.mcDb).toBe(r1.mcDb + 17);
  });

  it('与输入顺序无关（逐位一致）', () => {
    const amps = synthAmplitudes(2000, 1.0, 30, 7);
    const shuffled = mulberry32(1);
    const a2 = amps.slice();
    for (let i = a2.length - 1; i > 0; i--) {
      const j = Math.floor(shuffled() * (i + 1));
      [a2[i], a2[j]] = [a2[j]!, a2[i]!];
    }
    const r1 = estimateBValue(amps, 50);
    const r2 = estimateBValue(a2, 50);
    expect(r1).toEqual(r2);
  });

  it('sigma = b/sqrt(N)', () => {
    const amps = synthAmplitudes(1000, 1.0, 30, 5);
    const r = estimateBValue(amps, 50);
    if (!r.ok) throw new Error('expected ok');
    expect(r.sigmaB).toBeCloseTo(r.b / Math.sqrt(r.effectiveCount), 12);
  });

  it('有效事件不足标记 insufficient', () => {
    const amps = synthAmplitudes(30, 1.0, 30, 5);
    const r = estimateBValue(amps, 50);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('insufficient');
    expect(r.mcDb).not.toBeNull();
  });

  it('所有幅度同档时标记 degenerate', () => {
    const amps = new Array(60).fill(42.3);
    const r = estimateBValue(amps, 50);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('degenerate');
  });

  it('空数组标记 empty', () => {
    const r = estimateBValue([], 50);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('empty');
  });

  it('MAXC 在事件很少时也能给出结果（不拟合、不迭代）', () => {
    // 5 个事件即可估计 Mc；少于 minEffectiveEvents 只是不给 b 值
    const r = estimateBValue([30, 30.1, 31, 30.4, 32], 50);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mcDb).toBe(30);
  });
});
