/**
 * 合成声发射事件生成（测试用）。
 *
 * Gutenberg-Richter：N(>=M) ~ 10^(-bM)，超过 Mc 后的幅度余量
 * delta = A - Ac 服从指数分布，率参数 lambda = b*ln(10)/20（dB^-1），
 * 即 delta = -ln(U)/lambda。Mc 以下加一段探测完整性台阶（本测试直接只生成 >= Mc 的干净数据）。
 */

/** 可复现的确定性 PRNG（mulberry32） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthEvent {
  eventId: string;
  timestampUs: number;
  amplitudeDb: number;
  channel: number;
  /** 生成时的真实所属段，供测试分段 */
  segment: number;
}

export interface SynthSegment {
  /** 真值 b */
  bTrue: number;
  /** 事件数 */
  count: number;
  /** 完整性幅度档（dB） */
  mcDb?: number;
  /** 通道数（循环分配） */
  channels?: number;
}

export function generateEvents(
  segments: SynthSegment[],
  opts: { seed: number; startUs: number; intervalUs?: number; amplitudeMaxDb?: number; idPrefix?: string }
): SynthEvent[] {
  const rng = mulberry32(opts.seed);
  const interval = opts.intervalUs ?? 100_000;
  const maxDb = opts.amplitudeMaxDb ?? 100;
  const prefix = opts.idPrefix ?? 'e';
  const out: SynthEvent[] = [];
  let ts = opts.startUs;
  let seq = 0;

  segments.forEach((seg, segIdx) => {
    const mcDb = seg.mcDb ?? 30;
    const lambda = (seg.bTrue * Math.LN10) / 20;
    const channels = seg.channels ?? 2;
    for (let i = 0; i < seg.count; i++) {
      // 仪器截顶：直接截断到上限（上限取在分布尾部时概率极小，不影响统计）
      const a = Math.min(maxDb, mcDb - Math.log(rng()) / lambda);
      out.push({
        eventId: `${prefix}-${String(seq).padStart(7, '0')}`,
        timestampUs: ts,
        amplitudeDb: a,
        channel: seq % channels,
        segment: segIdx
      });
      ts += interval;
      seq++;
    }
  });
  return out;
}

/**
 * 在允许延迟范围内打乱顺序：把序列切成大小 2*maxShift+1 的相邻块，
 * 块内做 Fisher-Yates 打乱、块间顺序保持不变。
 * 任意元素最终位置与原位置之差绝对值 <= 2*maxShift（严格有界），
 * 调用方把 maxShift 取允许延迟对应事件数的一半即可。
 */
export function shuffleWithinDelay<T>(events: T[], maxShift: number, seed: number): T[] {
  const rng = mulberry32(seed);
  const out = events.slice();
  const block = 2 * maxShift + 1;
  for (let base = 0; base < out.length; base += block) {
    const end = Math.min(base + block, out.length);
    for (let i = end - 1; i > base; i--) {
      const j = base + Math.floor(rng() * (i - base + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
  }
  return out;
}
