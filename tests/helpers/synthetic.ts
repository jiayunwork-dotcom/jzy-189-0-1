/**
 * 合成声发射数据工具：
 * 按已知 b 值生成峰值幅度。G-R 关系在离散档上给出几何分布：
 *   P(k) = (1−p)·p^k，p = 10^(−b/20)，k 为相对 Mc 档的整数 dB 偏移
 * 样本足够多时，分档 MLE 应还原出真值。
 */

/** 确定性 LCG 随机源（固定种子 => 可重复） */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface GenOptions {
  n: number;
  bValue: number;
  /** Mc 档 dB */
  mcDb?: number;
  seed: number;
}

/** 生成 n 个合成幅度（dB，整数档） */
export function generateAmplitudes(opts: GenOptions): number[] {
  const { n, bValue, seed } = opts;
  const mcDb = opts.mcDb ?? 40;
  const p = Math.pow(10, -bValue / 20);
  const rng = makeRng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = rng();
    // 逆变换：floor(ln(u)/ln(p))
    const k = Math.floor(Math.log(u) / Math.log(p));
    out.push(mcDb + k);
  }
  return out;
}

export interface SynthEvent {
  eventId: string;
  timestampUs: number;
  amplitudeDb: number;
  channel: number;
}

/**
 * 生成带时间戳的事件序列（幅度可选两段不同 b 值）。
 * segment: [事件数, b 值]
 */
export function generateEvents(params: {
  segments: Array<{ n: number; b: number }>;
  startUs: number;
  dtUs: number;
  mcDb?: number;
  seed: number;
}): SynthEvent[] {
  const rng = makeRng(params.seed);
  const events: SynthEvent[] = [];
  const mcDb = params.mcDb ?? 40;
  let id = 0;
  let t = params.startUs;
  for (const seg of params.segments) {
    const p = Math.pow(10, -seg.b / 20);
    for (let i = 0; i < seg.n; i++) {
      const u = rng();
      const k = Math.floor(Math.log(u) / Math.log(p));
      events.push({
        eventId: `E${String(id).padStart(7, '0')}`,
        timestampUs: t,
        amplitudeDb: mcDb + k,
        channel: 1 + (id % 4),
      });
      id += 1;
      t += params.dtUs;
    }
  }
  return events;
}

/**
 * 在允许延迟范围内打乱：以延迟长度为块（块内打乱不会让任何事件越过水印），
 * 块之间保持顺序。结果与顺序送入等价。
 */
export function shuffleWithinDelay<T extends { timestampUs: number }>(
  events: T[],
  allowedDelayUs: number,
  rng: () => number,
): T[] {
  if (events.length === 0) return [];
  const out: T[] = [];
  let blockStart = 0;
  let blockEndTime = events[0]!.timestampUs + allowedDelayUs;
  for (let i = 0; i <= events.length; i++) {
    const atEnd = i === events.length;
    if (atEnd || events[i]!.timestampUs > blockEndTime) {
      const block = events.slice(blockStart, i);
      // Fisher–Yates
      for (let j = block.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        [block[j], block[k]] = [block[k]!, block[j]!];
      }
      out.push(...block);
      if (!atEnd) {
        blockStart = i;
        blockEndTime = events[i]!.timestampUs + allowedDelayUs;
      }
    }
  }
  return out;
}
