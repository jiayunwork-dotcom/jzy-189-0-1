/**
 * 核心领域类型定义
 *
 * 时间戳一律为 Unix 微秒整数（客户端与采集端时钟保证一致）。
 * 幅度为峰值幅度 dB；震级 m = amplitudeDb / 20，1 dB 一档 => 震级档宽 0.05。
 */

/** 完整性震级 Mc 的估计方法 */
export type McMethod = 'MAXC' | 'GFT';

/** 试验分析设置（随试验创建，全程不变） */
export interface ExperimentSettings {
  /** 滑动窗口包含的事件数（>0） */
  windowEvents: number;
  /** 窗口滑动步长（事件数，>0） */
  stepEvents: number;
  /** 允许乱序延迟（微秒，>0）；超过的迟到事件丢弃 */
  allowedDelayUs: number;
  /** 基线时段相对试验开始的起点（微秒，>=0） */
  baselineStartUs: number;
  /** 基线时段相对试验开始的终点（微秒，> baselineStartUs） */
  baselineEndUs: number;
  /** 预警倍数 k：b < b0 - k*se 判定为一次越限（>0） */
  alertMultiplier: number;
  /** 连续越限/恢复窗口数 P（>=1） */
  persistenceWindows: number;
  /** 窗口内 Mc 以上有效事件少于该数时不给 b 值（>=2） */
  minEventsForB: number;
  /** 完整性震级估计方法，默认 MAXC */
  mcMethod: McMethod;
  /** 幅度量程下限 dB（整数），低于视为非法 */
  amplitudeMinDb: number;
  /** 幅度量程上限 dB（整数），高于视为非法 */
  amplitudeMaxDb: number;
}

export interface Experiment {
  id: string;
  startedAtUs: number;
  sample: {
    name?: string;
    lithology?: string;
    /** 样品信息允许携带其他自定义字段 */
    [key: string]: unknown;
  };
  settings: ExperimentSettings;
  status: 'running' | 'stopped';
  createdAtUs: number;
  stoppedAtUs?: number;
}

/** 采集端推送的撞击事件（入参形态） */
export interface EventInput {
  eventId: string;
  /** 采集时间戳，微秒 */
  timestampUs: number;
  /** 峰值幅度 dB */
  amplitudeDb: number;
  /** 通道号（非负整数） */
  channel: number;
}

/** 已接受并入库的事件（按时间顺序的全局次序由 timestampUs,eventId 决定） */
export interface StoredEvent extends EventInput {
  experimentId: string;
  /** 晚于水印、被接受时的实际到达序号，仅用于排查，不参与窗口定义 */
  receivedSeq: number;
}

/** 被丢弃的迟到事件审计记录 */
export interface LateEventRecord {
  experimentId: string;
  eventId: string;
  timestampUs: number;
  amplitudeDb: number;
  channel: number;
  arrivedAtUs: number;
  watermarkUs: number;
}

/** 窗口 b 值结果 */
export interface WindowResult {
  experimentId: string;
  /** 从 0 开始的窗口序号 */
  windowIndex: number;
  /** 窗口起点事件在全局时间序列中的序号 */
  startOrdinal: number;
  endOrdinal: number;
  /** 窗口首/末事件时间戳（微秒） */
  windowStartUs: number;
  windowEndUs: number;
  /** 窗口内事件总数 */
  nTotal: number;
  /** 完整性震级（dB 档与震级两种表示） */
  completenessDb: number;
  completenessMagnitude: number;
  /** Mc 以上参与 MLE 的有效事件数 */
  nEffective: number;
  /** b 值及标准误差；样本不足时为 null */
  bValue: number | null;
  bStdError: number | null;
  status: 'ok' | 'insufficient';
  finalizedAtUs: number;
}

export interface AlertRecord {
  experimentId: string;
  kind: 'raised' | 'cleared';
  /** 触发该状态变化的定稿窗口序号 */
  windowIndex: number;
  bValue: number | null;
  bStdError: number | null;
  baselineB: number | null;
  threshold: number | null;
  windowEndUs: number;
  recordedAtUs: number;
}

/** 基线状态 */
export type BaselineStatus = 'pending' | 'ready' | 'insufficient';

export interface BaselineState {
  status: BaselineStatus;
  completenessDb: number | null;
  completenessMagnitude: number | null;
  bValue: number | null;
  bStdError: number | null;
  nTotal: number;
  nEffective: number;
}

/** 预警状态机当前态 */
export type AlertState = 'normal' | 'alarm';

/**
 * 引擎运行时元数据。随每个批次持久化，
 * 服务重启时用它 + 事件库回放恢复出与未中断完全一致的状态。
 */
export interface EngineMeta {
  experimentId: string;
  /** 已见事件最大时间戳 */
  maxTsUs: number | null;
  /** 当前水印 = maxTsUs - allowedDelayUs（首次事件前为 null） */
  watermarkUs: number | null;
  /** 已接受事件总数（也是下一个事件的全局序号） */
  acceptedCount: number;
  /** 收到的唯一事件数（含迟到丢弃，重发不计） */
  seenCount: number;
  duplicateCount: number;
  lateCount: number;
  /** 已定稿窗口个数（下一个窗口的 index） */
  finalizedWindows: number;
  /** 连续越限窗口计数 */
  breachStreak: number;
  /** 连续恢复窗口计数 */
  recoveryStreak: number;
  alertState: AlertState;
  baseline: BaselineState;
  /** 基线是否已经计算过（即使样本不足也只判定一次） */
  baselineEvaluated: boolean;
  stopped: boolean;
}

export interface IngestCounters {
  accepted: number;
  duplicates: number;
  lateDropped: number;
  rejected: number;
  finalizedWindows: number[];
  alerts: Array<Pick<AlertRecord, 'kind' | 'windowIndex'>>;
}
