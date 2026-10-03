/**
 * b 值最大似然估计与完整性震级 Mc 估计
 *
 * 震级换算：m = A_dB / 20（AE 峰值幅度 dB 到震级的常用换算），
 * 幅度按 1 dB 取整分档，故震级档宽 Δm = 1/20 = 0.05。
 *
 * 对离散档的 MLE（Aki 1965; Utsu 1966; Woessner & Wiemer 2005 式(6)）：
 *
 *   b = Δm·ln10 的倒数形式，直接用 dB 表示：
 *     d = mean(A_bin − A_c) + 0.5        （0.5 为分档修正，单位 dB）
 *     b = 20 / ( ln(10) · d )
 *
 * 标准误（Shi & Bolt 1982，Woessner & Wiemer 2005 式(9)）：
 *   se = b·ln10·sqrt( Σ(m_i−m̄)²/(n(n−1)) + Δm²/12 )
 * 化简到 dB 档偏移 X_i = A_bin−A_c（整数），记 d = X̄+0.5：
 *   se = b · sqrt( s_X² + 1/12 ) / ( d · sqrt(n) )
 * 其中 s_X 为 X 的样本标准差，1/12 是 1 dB 分档宽度的修正项。
 *
 * 这些公式只依赖相对档偏移，因此所有幅度加同一个整数常数 b 值不变。
 */
import type { McMethod } from './types.js';

export interface BEstimateResult {
  /** 完整性震级所在 dB 档（整数下界） */
  completenessDb: number;
  completenessMagnitude: number;
  /** 输入事件总数 */
  nTotal: number;
  /** Mc 及以上事件数 */
  nEffective: number;
  bValue: number | null;
  bStdError: number | null;
  status: 'ok' | 'insufficient';
}

const LN10 = Math.LN10;
const MAG_PER_DB = 1 / 20;
const BIN_WIDTH_DB = 1;
const BIN_CORRECTION = 0.5;

/** 把幅度归入 1 dB 整数档（向下取整），返回按档升序的 [档, 计数] */
export function buildHistogram(amplitudes: readonly number[]): Array<[number, number]> {
  const counts = new Map<number, number>();
  for (const a of amplitudes) {
    const bin = Math.floor(a);
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }
  return [...counts.entries()].sort((x, y) => x[0] - y[0]);
}

/**
 * MAXC：频度分布的最大曲率点，即非累积频度最高的档。
 * 多档并列时取最低档——低 Mc 保留更多事件，且并列多由小样本抖动造成，
 * 取低值不会因一次抖动就把 Mc 推高、人为缩小样本。
 */
export function maxcBin(hist: ReadonlyArray<readonly [number, number]>): number | null {
  if (hist.length === 0) return null;
  let bestBin = hist[0]![0];
  let bestCount = hist[0]![1];
  for (const [bin, count] of hist) {
    if (count > bestCount) {
      bestCount = count;
      bestBin = bin;
    }
  }
  return bestBin;
}

/** 给定完整性档 cutBin 及该档以上的档偏移（整数 dB），做分档 MLE */
function mleFromOffsets(offsets: readonly number[]): { b: number; se: number } {
  const n = offsets.length;
  let sum = 0;
  for (const x of offsets) sum += x;
  const mean = sum / n;
  // d = 平均档偏移 + 0.5 dB 分档修正
  const d = mean + BIN_CORRECTION;
  const b = BIN_WIDTH_DB / (MAG_PER_DB * LN10 * d); // = 20/(ln10·d)

  let sumSq = 0;
  for (const x of offsets) sumSq += (x - mean) * (x - mean);
  // 样本标准差 sd = sqrt(Σ(x−x̄)²/(n−1))
  const sd = n > 1 ? Math.sqrt(sumSq / (n - 1)) : 0;
  // Shi–Bolt：se = b·sqrt(s²+1/12)/(d·√n)
  const se = (b * Math.sqrt((sd * sd + 1 / 12) / n)) / d;
  return { b, se };
}

/**
 * GFT（Goodness-of-Fit Test, Wiemer & Wyss 2000）。
 *
 * 对每个候选完整性档 Mc 做 MLE 得到 b，由 G-R 模型生成合成频度：
 *   S_k = 10^(a − b·m_k)，a 取 Mc 档观测频度
 * 比较观测频度 O 与合成频度 S：
 *   R = 100% − ( Σ|O−S| / ΣO )·100%
 * 同时对非累积（每档计数）与累积（Mc 以上累加）各算一次取较小值。
 * 取第一个 R≥95% 的档；达不到则取第一个 R≥90%；都达不到回退 MAXC。
 * 事件很少时拟合几乎必然不达标，GFT 自动回退 MAXC——这正是把 MAXC
 * 作为默认的原因之一（见 docs/methods.md）。
 */
export function gftBin(
  hist: ReadonlyArray<readonly [number, number]>,
  maxc: number,
  minEvents: number,
): number {
  const nBins = hist.length;
  let first90: number | null = null;
  let first95: number | null = null;

  for (let i = 0; i < nBins; i++) {
    const cutBin = hist[i]![0];
    let n = 0;
    for (let j = i; j < nBins; j++) n += hist[j]![1];
    if (n < minEvents) continue;

    const offsets: number[] = [];
    for (let j = i; j < nBins; j++) {
      const off = hist[j]![0] - cutBin;
      const count = hist[j]![1];
      for (let k = 0; k < count; k++) offsets.push(off);
    }
    const { b } = mleFromOffsets(offsets);

    // 非累积拟合优度：以 Mc 档观测计数为 a 锚点
    let diffNon = 0;
    let sumNon = 0;
    const obsMc = hist[i]![1];
    for (let j = i; j < nBins; j++) {
      const mDiff = (hist[j]![0] - cutBin) * MAG_PER_DB;
      const synthetic = obsMc * Math.pow(10, -b * mDiff);
      diffNon += Math.abs(hist[j]![1] - synthetic);
      sumNon += hist[j]![1];
    }
    const rNon = 100 * (1 - diffNon / sumNon);

    // 累积拟合优度：观测累积 vs 合成累积
    let diffCum = 0;
    let sumCum = 0;
    let obsCum = 0;
    let synCum = 0;
    const synMc = obsMc; // 累积首项同样锚定在 Mc 档
    for (let j = i; j < nBins; j++) {
      obsCum += hist[j]![1];
      const mDiff = (hist[j]![0] - cutBin) * MAG_PER_DB;
      synCum += synMc * Math.pow(10, -b * mDiff);
      diffCum += Math.abs(obsCum - synCum);
      sumCum += obsCum;
    }
    const rCum = 100 * (1 - diffCum / sumCum);

    const r = Math.min(rNon, rCum);
    if (r >= 95 && first95 === null) first95 = cutBin;
    if (r >= 90 && first90 === null) first90 = cutBin;
  }

  if (first95 !== null) return first95;
  if (first90 !== null) return first90;
  return maxc;
}

/**
 * b 值主入口。
 * @param amplitudes 窗口内全部事件的峰值幅度（dB）
 * @param method Mc 估计方法
 * @param minEvents Mc 以上有效事件低于此数时判样本不足（至少需要 2）
 */
export function estimateB(
  amplitudes: readonly number[],
  method: McMethod,
  minEvents: number,
): BEstimateResult {
  const minN = Math.max(2, minEvents);
  const hist = buildHistogram(amplitudes);
  const nTotal = amplitudes.length;

  const maxc = maxcBin(hist);
  if (maxc === null) {
    return insufficient(0, nTotal, 0);
  }

  const cutBin =
    method === 'GFT' ? gftBin(hist, maxc, minN) : maxc;

  const offsets: number[] = [];
  let nEffective = 0;
  for (const [bin, count] of hist) {
    if (bin < cutBin) continue;
    nEffective += count;
    const off = bin - cutBin;
    for (let k = 0; k < count; k++) offsets.push(off);
  }

  if (nEffective < minN) {
    return insufficient(cutBin, nTotal, nEffective);
  }

  const { b, se } = mleFromOffsets(offsets);
  return {
    completenessDb: cutBin,
    completenessMagnitude: cutBin * MAG_PER_DB,
    nTotal,
    nEffective,
    bValue: b,
    bStdError: se,
    status: 'ok',
  };
}

function insufficient(
  cutBin: number,
  nTotal: number,
  nEffective: number,
): BEstimateResult {
  return {
    completenessDb: cutBin,
    completenessMagnitude: cutBin * MAG_PER_DB,
    nTotal,
    nEffective,
    bValue: null,
    bStdError: null,
    status: 'insufficient',
  };
}
