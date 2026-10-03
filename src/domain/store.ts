import type {
  AlertTransition,
  Experiment,
  StoredEvent,
  WindowResult
} from './types.js';

/**
 * 存储抽象。窗口与预警集合是权威结果；事件集合按 (timestampUs, eventId) 排序即得到全局秩。
 * 所有“写多文档”的方法都要求对单个文档幂等（唯一索引 + 重复忽略），
 * 这样引擎崩溃在任意一步后都能靠重放补齐，结果与无中断完全一致。MongoDB 单机版不支持事务，
 * 因此一致性靠“事件先入库、窗口/预警幂等补写、状态最后更新”的顺序保证。
 */
export interface Store {
  insertExperiment(doc: Experiment): Promise<'inserted' | 'duplicate'>;
  findExperiment(experimentId: string): Promise<Experiment | null>;
  listExperimentIds(): Promise<string[]>;

  /** 返回真正新插入的事件数（eventId 重复的忽略） */
  insertEventsIgnoreDuplicates(docs: StoredEvent[]): Promise<number>;
  hasEventIds(experimentId: string, ids: string[]): Promise<Set<string>>;
  countEventsBefore(experimentId: string, timestampExclusive: number): Promise<number>;
  /** 按 (timestampUs 升序, eventId 升序) 返回全局秩 [startRank, endRankExclusive) 的事件 */
  listEventsByRank(
    experimentId: string,
    startRank: number,
    endRankExclusive: number
  ): Promise<StoredEvent[]>;
  listEventsBefore(experimentId: string, timestampExclusive: number): Promise<StoredEvent[]>;
  /** 按时间顺序返回最早的 limit 条（调试查询用，避免全量载入） */
  listEvents(experimentId: string, limit: number): Promise<StoredEvent[]>;
  maxEventTimestamp(experimentId: string): Promise<number | null>;
  countEvents(experimentId: string): Promise<number>;

  /** 已存在（experimentId,index）时返回 duplicate，不覆盖 */
  insertWindow(doc: WindowResult): Promise<'inserted' | 'duplicate'>;
  listWindows(experimentId: string): Promise<WindowResult[]>;

  insertAlert(doc: AlertTransition): Promise<'inserted' | 'duplicate'>;
  listAlerts(experimentId: string): Promise<AlertTransition[]>;

  close?(): Promise<void>;
}

/** 引擎可变状态单独存一份；重启时以事件/窗口/预警集合为准重建，状态文档仅做加速与计数。 */
export interface StateStore {
  getState(experimentId: string): Promise<import('./types.js').EngineStateDoc | null>;
  upsertState(doc: import('./types.js').EngineStateDoc): Promise<void>;
  setClosed(experimentId: string, closed: boolean): Promise<void>;
}
