import type {
  AlertRecord,
  EngineMeta,
  Experiment,
  LateEventRecord,
  StoredEvent,
  WindowResult,
} from '../domain/types.js';

/**
 * 持久化接口。引擎只依赖此接口：
 *  - 内存实现供单元测试，零外部依赖；
 *  - MongoDB 实现供生产，二者语义完全一致，保证重启回放一致。
 */
export interface Repository {
  // ---- 试验 ----
  insertExperiment(exp: Experiment): Promise<void>;
  getExperiment(id: string): Promise<Experiment | null>;
  listExperiments(): Promise<Experiment[]>;
  markExperimentStopped(id: string, stoppedAtUs: number): Promise<void>;

  // ---- 事件 ----
  /**
   * 批量插入已接受事件。重复 (experimentId,eventId) 被数据库判定，
   * 返回真正写入的事件（保持入参顺序）。
   */
  insertEvents(events: StoredEvent[]): Promise<StoredEvent[]>;
  /** 批量查询已存在的事件编号（事件表 + 迟到审计表的并集） */
  existingEventIds(experimentId: string, eventIds: string[]): Promise<Set<string>>;
  insertLateEvent(rec: LateEventRecord): Promise<void>;
  /** 按 (timestampUs,eventId) 升序取全部已接受事件（重启回放用） */
  loadAllEvents(experimentId: string): Promise<StoredEvent[]>;
  /** 按 (timestampUs,eventId) 升序取某时间区间内事件（基线计算用，端点含首不含尾） */
  loadEventsInRange(experimentId: string, fromUs: number, toUs: number): Promise<StoredEvent[]>;
  countEvents(experimentId: string): Promise<number>;

  // ---- 窗口 ----
  upsertWindow(w: WindowResult): Promise<void>;
  listWindows(experimentId: string): Promise<WindowResult[]>;

  // ---- 预警 ----
  insertAlert(a: AlertRecord): Promise<void>;
  listAlerts(experimentId: string): Promise<AlertRecord[]>;

  // ---- 引擎元数据（每批次原子整体替换） ----
  saveEngineMeta(meta: EngineMeta): Promise<void>;
  loadEngineMeta(experimentId: string): Promise<EngineMeta | null>;
}
