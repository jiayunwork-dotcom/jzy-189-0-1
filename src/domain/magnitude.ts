/**
 * 震级频度与 b 值估计。
 *
 * Gutenberg-Richter 关系：log10 N(>=M) = a - bM。
 * 声发射峰值幅度 A(dB) 换算震级 M = A / 20（振幅型传感器常用约定），1 dB 分档对应 0.05 震级单位。
 *
 * 完整性震级 Mc 用 MAXC（Maximum Curvature）法：取频度最高的幅度档；
 * 并列时取最低档（最早达到最大频度的位置，即常见实现里的 first-maximum 约定）。
 *
 * b 值用分档数据的最大似然估计（Aki/Utsu，对连续公式做半档修正）：
 *   b = log10(e) / ( mean(M) - (Mc - dM/2) )
 * 其中 Mc 为完整性档的震级下限，dM = 0.05。用幅度表示（幅度按档下限归并，
 * 半档修正补回档内期望）：
 *   b = 20 * log10(e) / ( mean(A_bin) - Abin_c + 0.5 )
 *     = 20 / ( ln(10) * (mean(A_bin) - Abin_c + 0.5) )
 * 标准误 sigma = b / sqrt(N_eff)（Utsu 1966）。
 */

export const MAGNITUDE_PER_DB = 1 / 20;
export const BIN_WIDTH_DB = 1;
export const BIN_WIDTH_MAGNITUDE = BIN_WIDTH_DB * MAGNITUDE_PER_DB; // 0.05

/** Aki MLE 分子（幅度单位下）：20 * log10(e) = 20 / ln(10) ≈ 8.6859 */
const B_NUMERATOR_DB = 20 / Math.LN10;

export function amplitudeToMagnitude(amplitudeDb: number): number {
  return amplitudeDb * MAGNITUDE_PER_DB;
}

/** 1 dB 向下取整分档（档值为该档下限） */
export function amplitudeBin(amplitudeDb: number): number {
  return Math.floor(amplitudeDb);
}

export interface McEstimate {
  /** 完整性幅度档（dB，档下限） */
  mcDb: number;
  /** 完整性震级（该档震级下限） */
  mcMagnitude: number;
  /** 频度表：档 -> 事件数（仅非空档） */
  binCounts: Map<number, number>;
}

/**
 * MAXC 法估计完整性幅度档。
 * 调用方需保证 amplitudes 全部为有限数；空数组返回 null。
 */
export function estimateMcMaxc(amplitudes: readonly number[]): McEstimate | null {
  const binCounts = new Map<number, number>();
  for (const a of amplitudes) {
    const bin = amplitudeBin(a);
    binCounts.set(bin, (binCounts.get(bin) ?? 0) + 1);
  }
  if (binCounts.size === 0) return null;

  let bestBin = Number.POSITIVE_INFINITY;
  let bestCount = -1;
  for (const [bin, count] of binCounts) {
    // 并列取最低档（Map 迭代顺序不保证有序，显式比较）
    if (count > bestCount || (count === bestCount && bin < bestBin)) {
      bestCount = count;
      bestBin = bin;
    }
  }
  return {
    mcDb: bestBin,
    mcMagnitude: bestBin * MAGNITUDE_PER_DB,
    binCounts
  };
}

export interface BValueEstimate {
  b: number;
  sigmaB: number;
  mcDb: number;
  mcMagnitude: number;
  /** Mc 及以上事件数 */
  effectiveCount: number;
  /** 总事件数 */
  totalCount: number;
}

export type BValueFailureReason = 'empty' | 'insufficient' | 'degenerate';

export type BValueResult =
  | (BValueEstimate & { ok: true })
  | { ok: false; reason: BValueFailureReason; mcDb: number | null; mcMagnitude: number | null; effectiveCount: number; totalCount: number };

/**
 * 对一组幅度（dB）估计完整性震级与 b 值。
 *
 * @param amplitudes 窗口（或基线）内全部事件幅度，顺序无关，内部按档归并
 * @param minEffectiveEvents Mc 以上有效事件低于此数时返回 insufficient
 */
export function estimateBValue(
  amplitudes: readonly number[],
  minEffectiveEvents: number
): BValueResult {
  const totalCount = amplitudes.length;
  const mc = estimateMcMaxc(amplitudes);
  if (mc === null) {
    return { ok: false, reason: 'empty', mcDb: null, mcMagnitude: null, effectiveCount: 0, totalCount: 0 };
  }

  // 求和只遍历按档排序后的序列，保证不同送达顺序下浮点结果逐位一致。
  let sum = 0;
  let effectiveCount = 0;
  let occupiedBins = 0;
  for (const [bin, count] of [...mc.binCounts.entries()].sort((x, y) => x[0] - y[0])) {
    if (bin >= mc.mcDb) {
      sum += bin * count;
      effectiveCount += count;
      occupiedBins++;
    }
  }

  if (effectiveCount < minEffectiveEvents) {
    return {
      ok: false,
      reason: 'insufficient',
      mcDb: mc.mcDb,
      mcMagnitude: mc.mcMagnitude,
      effectiveCount,
      totalCount
    };
  }

  // Mc 以上只占一个档：MLE 分母退化（真实分布被探测阈值压扁或样本完全同质），不给 b 值
  if (occupiedBins <= 1) {
    return {
      ok: false,
      reason: 'degenerate',
      mcDb: mc.mcDb,
      mcMagnitude: mc.mcMagnitude,
      effectiveCount,
      totalCount
    };
  }

  // 档内幅度未知，取档中位作为该档幅度期望（等价于连续公式的半档修正）。
  const meanAmplitude = sum / effectiveCount;
  const denominator = meanAmplitude - mc.mcDb + BIN_WIDTH_DB / 2;
  const b = B_NUMERATOR_DB / denominator;

  if (!Number.isFinite(b) || b <= 0) {
    return {
      ok: false,
      reason: 'degenerate',
      mcDb: mc.mcDb,
      mcMagnitude: mc.mcMagnitude,
      effectiveCount,
      totalCount
    };
  }

  return {
    ok: true,
    b,
    sigmaB: b / Math.sqrt(effectiveCount),
    mcDb: mc.mcDb,
    mcMagnitude: mc.mcMagnitude,
    effectiveCount,
    totalCount
  };
}
