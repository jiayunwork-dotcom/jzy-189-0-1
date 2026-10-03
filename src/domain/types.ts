/**
 * 领域类型定义。
 *
 * 时间戳单位统一为微秒（整数），幅度单位为 dB，震级 = 幅度 / 20，分档宽度 1 dB = 0.05 震级单位。
 */

export type McMethod = 'maxc';

/** 试验分析设置（创建试验时给定，运行中不可变） */
export interface AnalysisSettings {
  /** 每个窗口包含的事件数（固定事件数滑窗），正整数 */
  windowEvents: number;
  /** 窗口滑动步长（事件数），正整数 */
  step: number;
  /** 允许的乱序延迟（微秒）。ts < 最大已见时间戳 - maxDelayUs 的事件丢弃；非负整数（0 = 只接受不早于最大值的事件） */
  maxDelayUs: number;
  /** 基线时段长度（微秒），从试验开始时间起算，正整数 */
  baselineDurationUs: number;
  /** 预警倍数 k：b < 基线b - k * 基线标准误 视为越限，正数 */
  alertSigmaMultiple: number;
  /** 连续多少个窗口越限才拉起/解除预警，正整数 */
  persistWindows: number;
  /** 窗口内完整性震级以上的有效事件少于该数时不给 b 值，正整数 */
  minEffectiveEvents: number;
  /** 幅度量程下限（含，dB） */
  amplitudeMinDb: number;
  /** 幅度量程上限（含，dB） */
  amplitudeMaxDb: number;
  /** 完整性震级估计方法，目前支持 maxc（最大曲率点） */
  mcMethod: McMethod;
}

export type SampleInfo = Record<string, unknown>;

/** 采集端推送的事件（线路上的原始字段） */
export interface IncomingEvent {
  eventId: string;
  timestampUs: number;
  amplitudeDb: number;
  channel: number;
}

/** 落库的已接受事件 */
export interface StoredEvent extends IncomingEvent {
  experimentId: string;
  /** 服务接收时刻（微秒），便于审计，不参与排序 */
  receivedAtUs: number;
}

export const DEFAULT_AMPLITUDE_MIN_DB = 0;
export const DEFAULT_AMPLITUDE_MAX_DB = 100;
export const DEFAULT_MIN_EFFECTIVE_EVENTS = 50;
export const DEFAULT_MC_METHOD: McMethod = 'maxc';

/** 单个窗口的 b 值计算结果 */
export interface WindowResult {
  experimentId: string;
  /** 窗口编号，从 0 开始按步长递增 */
  index: number;
  /** 窗口覆盖的全局事件秩范围（按 (timestampUs, eventId) 升序），左闭右开 */
  startRank: number;
  endRankExclusive: number;
  /** 窗口内成员的最小/最大时间戳（微秒） */
  startTimeUs: number;
  endTimeUs: number;
  eventCount: number;
  /** 完整性震级对应的幅度档（dB 整数档） */
  mcDb: number;
  /** 完整性震级 Mc（震级单位） */
  mcMagnitude: number;
  /** Mc 及以上的有效事件数 */
  effectiveCount: number;
  /** MLE b 值；样本不足或退化时为 null */
  b: number | null;
  /** b 值标准误（Utsu: b/sqrt(N)）；无 b 值时为 null */
  sigmaB: number | null;
  /** 有效事件不足，未给出 b 值 */
  insufficient: boolean;
  /** 有效事件全部落在同一幅度档，MLE 分母退化，未给出 b 值 */
  degenerate: boolean;
  createdAtUs: number;
}

export type AlertKind = 'raised' | 'cleared';

/** 预警状态变迁（拉起/解除各一条） */
export interface AlertTransition {
  experimentId: string;
  kind: AlertKind;
  /** 触发该变迁的窗口编号 */
  windowIndex: number;
  b: number;
  sigmaB: number;
  /** 当时使用的阈值（基线b - k * 基线标准误） */
  thresholdB: number;
  baselineB: number;
  baselineSigmaB: number;
  createdAtUs: number;
}

export type ExperimentStatusValue = 'active' | 'closed';

export interface Experiment {
  experimentId: string;
  startedAtUs: number;
  sample: SampleInfo;
  settings: AnalysisSettings;
  status: ExperimentStatusValue;
  createdAtUs: number;
}

/** 基线估计结果 */
export interface BaselineResult {
  b: number;
  sigmaB: number;
  mcDb: number;
  mcMagnitude: number;
  effectiveCount: number;
  eventCount: number;
  /** ok = 有效事件足够；insufficient = 基线时段内事件太少，本场试验永不预警 */
  status: 'ok' | 'insufficient';
  /** 基线统计的时间范围（含起、不含止） */
  rangeStartUs: number;
  rangeEndUs: number;
}

export interface IngestCounters {
  accepted: number;
  duplicate: number;
  late: number;
  beforeStart: number;
  invalid: number;
}

/** 单条事件入库裁决结果（HTTP 逐条反馈用） */
export interface EventReceipt {
  eventId: string | null;
  status: 'accepted' | 'duplicate' | 'late' | 'before_start' | 'invalid';
  /** 出错字段名（invalid / before_start 时给出） */
  field?: string;
  /** 机器可读原因码 */
  reason?: string;
  message?: string;
}

export interface IngestBatchResult {
  experimentId: string;
  counters: IngestCounters;
  receipts: EventReceipt[];
  /** 本次处理中新定稿的窗口编号 */
  finalizedWindowIndexes: number[];
  /** 本次处理中新产生的预警变迁 */
  newAlerts: AlertTransition[];
  /** 当前接收到的最大事件时间戳（微秒） */
  maxTimestampUs: number;
  /** 当前定稿水位（微秒）：ts < watermark 的事件已定稿参与/不参与计算 */
  watermarkUs: number;
}

/** 引擎持久化状态（states 集合）。窗口/变迁集合本身是权威结果，状态只用于加速恢复和对外汇报。 */
export interface EngineStateDoc {
  experimentId: string;
  /** 下一个待生成的窗口编号 */
  nextWindowIndex: number;
  maxTimestampUs: number;
  /** 定稿水印（微秒，单调递增）：ts <= 水印的事件秩已定，ts < 水印的迟到事件丢弃 */
  watermarkUs: number;
  baseline: BaselineResult | null;
  baselineFinalized: boolean;
  alertState: AlertKind | null;
  /** 已喂入预警状态机的窗口数 */
  alertNextWindowIndex: number;
  /** 当前越限连续窗口数（未拉起时） */
  breachStreak: number;
  /** 当前恢复连续窗口数（拉起后） */
  clearStreak: number;
  closed: boolean;
  counters: IngestCounters;
  updatedAtUs: number;
}
