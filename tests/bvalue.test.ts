import { describe, expect, it } from 'vitest';
import { buildHistogram, estimateB, gftBin, maxcBin } from '../src/domain/bvalue.js';
import { generateAmplitudes } from './helpers/synthetic.js';

describe('b 值最大似然估计', () => {
  it('事件足够多时，估计值与真值之差在两倍标准误差以内（固定种子）', () => {
    const n = 3000;
    for (const bTrue of [0.8, 1.0, 1.5, 2.0]) {
      const amps = generateAmplitudes({ n, bValue: bTrue, seed: 42 });
      const r = estimateB(amps, 'MAXC', 50);
      expect(r.status).toBe('ok');
      expect(r.nEffective).toBe(n);
      expect(Math.abs((r.bValue as number) - bTrue)).toBeLessThanOrEqual(
        2 * (r.bStdError as number),
      );
    }
  });

  it('所有幅度加同一个整数常数，b 值与标准误完全不变', () => {
    const amps = generateAmplitudes({ n: 2000, bValue: 1.2, seed: 7 });
    const base = estimateB(amps, 'MAXC', 50);
    for (const c of [1, 3, 10, -25, 40]) {
      const shifted = estimateB(amps.map((a) => a + c), 'MAXC', 50);
      expect(shifted.bValue).toBe(base.bValue);
      expect(shifted.bStdError).toBe(base.bStdError);
      expect(shifted.completenessDb).toBe((base.completenessDb as number) + c);
    }
  });

  it('Mc 以上有效事件不足时标记 insufficient 且不给 b 值', () => {
    const amps = [40, 40, 41, 42];
    const r = estimateB(amps, 'MAXC', 50);
    expect(r.status).toBe('insufficient');
    expect(r.bValue).toBeNull();
    expect(r.bStdError).toBeNull();
    expect(r.nTotal).toBe(4);
  });

  it('空窗口判样本不足', () => {
    const r = estimateB([], 'MAXC', 50);
    expect(r.status).toBe('insufficient');
    expect(r.completenessDb).toBe(0);
  });

  it('b 值恒正；典型 b≈1 时标准误量级符合 1/√n', () => {
    const amps = generateAmplitudes({ n: 1000, bValue: 1.0, seed: 99 });
    const r = estimateB(amps, 'MAXC', 50);
    expect(r.bValue).toBeGreaterThan(0);
    expect(r.bStdError as number).toBeGreaterThan(0);
    // 1/sqrt(1000) ≈ 0.032 量级（含分档修正）
    expect(r.bStdError as number).toBeGreaterThan(0.01);
    expect(r.bStdError as number).toBeLessThan(0.08);
  });
});

describe('完整性震级 Mc', () => {
  it('MAXC 取频度最高档；并列时取最低档', () => {
    const hist: Array<[number, number]> = [
      [38, 2],
      [40, 9],
      [41, 9],
      [42, 4],
    ];
    expect(maxcBin(hist)).toBe(40);
  });

  it('幅度向下取整到 1 dB 档', () => {
    const hist = buildHistogram([40.0, 40.9, 40.1, 42.5]);
    const map = new Map(hist);
    expect(map.get(40)).toBe(3);
    expect(map.get(42)).toBe(1);
  });

  it('合成纯净数据下 GFT 恢复出真实 Mc', () => {
    // Mc=40 以上完整（b=1），再注入低档缺失检测噪声
    const good = generateAmplitudes({ n: 1500, bValue: 1.0, mcDb: 40, seed: 5 });
    const noisy = [35, 35, 36, 37, 38, 33]; // 低档检测不全
    const hist = buildHistogram([...noisy, ...good]);
    const maxc = maxcBin(hist) as number;
    const mc = gftBin(hist, maxc, 50);
    expect(mc).toBe(40);
  });

  it('事件太少时 GFT 不达标，回退 MAXC', () => {
    const hist: Array<[number, number]> = [
      [40, 3],
      [41, 2],
    ];
    const maxc = maxcBin(hist) as number;
    expect(gftBin(hist, maxc, 50)).toBe(maxc);
  });

  it('含大量亚 Mc 噪声时 MLE 仍能恢复真值（MAXC 自动剔除低档）', () => {
    const good = generateAmplitudes({ n: 1200, bValue: 1.3, mcDb: 45, seed: 11 });
    const underReported: number[] = [];
    for (let i = 0; i < 300; i++) underReported.push(30 + (i % 10));
    const r = estimateB([...underReported, ...good], 'MAXC', 50);
    expect(r.completenessDb).toBe(45);
    expect(Math.abs((r.bValue as number) - 1.3)).toBeLessThanOrEqual(
      2 * (r.bStdError as number),
    );
  });
});
