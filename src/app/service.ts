import { ExperimentEngine, ExperimentClosedError } from '../domain/engine.js';
import type {
  AlertTransition,
  EngineStateDoc,
  Experiment,
  IngestBatchResult,
  StoredEvent,
  WindowResult
} from '../domain/types.js';
import { emptyStateFor } from '../domain/initState.js';
import type { StateStore, Store } from '../domain/store.js';

export { ExperimentClosedError };

export class NotFoundError extends Error {
  constructor(public readonly resource: string, public readonly id: string) {
    super(`${resource} 不存在: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class AlreadyExistsError extends Error {
  constructor(public readonly experimentId: string) {
    super(`试验 ${experimentId} 已存在`);
    this.name = 'AlreadyExistsError';
  }
}

/**
 * 管理所有试验引擎：懒恢复 + 单场试验串行处理。
 * 串行是必要的：窗口定稿依赖“当前最大时间戳”，并发批次会产生竞态。
 */
export class AppService {
  private engines = new Map<string, ExperimentEngine>();
  /** 每场试验一条处理链，保证批次 FIFO 串行 */
  private chains = new Map<string, Promise<unknown>>();

  constructor(private readonly store: Store, private readonly stateStore: StateStore) {}

  async createExperiment(input: {
    experimentId: string;
    startedAtUs: number;
    sample: Record<string, unknown>;
    settings: Experiment['settings'];
  }): Promise<Experiment> {
    const doc: Experiment = {
      experimentId: input.experimentId,
      startedAtUs: input.startedAtUs,
      sample: input.sample,
      settings: input.settings,
      status: 'active',
      createdAtUs: Date.now() * 1000
    };
    try {
      const result = await this.store.insertExperiment(doc);
      if (result === 'duplicate') throw new AlreadyExistsError(input.experimentId);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new AlreadyExistsError(input.experimentId);
      throw e;
    }
    await this.stateStore.upsertState(emptyStateFor(doc));
    return doc;
  }

  async getExperimentOrThrow(id: string): Promise<Experiment> {
    const cached = this.engines.get(id)?.experiment;
    if (cached) return cached;
    const doc = await this.store.findExperiment(id);
    if (!doc) throw new NotFoundError('试验', id);
    return doc;
  }

  async listExperiments() {
    const ids = await this.store.listExperimentIds();
    return Promise.all(ids.map((id) => this.store.findExperiment(id)));
  }

  private async getEngine(id: string): Promise<ExperimentEngine> {
    const cached = this.engines.get(id);
    if (cached) return cached;
    const experiment = await this.store.findExperiment(id);
    if (!experiment) throw new NotFoundError('试验', id);
    const engine = await ExperimentEngine.restore(experiment, this.store, this.stateStore);
    this.engines.set(id, engine);
    return engine;
  }

  /** 进程启动时恢复所有试验（查询接口在首条事件到达前也能看到最新状态） */
  async restoreAll(): Promise<void> {
    const ids = await this.store.listExperimentIds();
    await Promise.all(ids.map((id) => this.getEngine(id)));
  }

  /** 将任务排到该试验的串行链上 */
  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(
      id,
      next.catch(() => {})
    );
    return next;
  }

  /**
   * 推送一批事件。wallClockUs 为观察到这批数据时的墙上时钟（微秒），
   * 用于在事件流安静时持续推进定稿水印；默认取当前系统时间。
   * 乱序、重复、迟到在批内一次性裁决，调用方无需保证批内有序。
   */
  ingest(experimentId: string, rawEvents: unknown[], wallClockUs?: number): Promise<IngestBatchResult> {
    return this.enqueue(experimentId, async () => {
      const engine = await this.getEngine(experimentId);
      return engine.processBatch(rawEvents, wallClockUs);
    });
  }

  async closeExperiment(experimentId: string) {
    // 整个操作（含恢复）都在串行链内，避免与批次并发恢复
    return this.enqueue(experimentId, async () => {
      const engine = await this.getEngine(experimentId);
      return engine.close();
    });
  }

  listWindows(experimentId: string): Promise<WindowResult[]> {
    return this.store.listWindows(experimentId);
  }

  listAlerts(experimentId: string): Promise<AlertTransition[]> {
    return this.store.listAlerts(experimentId);
  }

  listEvents(experimentId: string, limit: number): Promise<StoredEvent[]> {
    // 查询接口走 store，不依赖引擎是否在内存
    return this.store.listEvents(experimentId, limit);
  }

  async getState(experimentId: string): Promise<EngineStateDoc> {
    const engine = this.engines.get(experimentId);
    if (engine) return engine.getSnapshot();
    const s = await this.stateStore.getState(experimentId);
    if (!s) throw new NotFoundError('试验状态', experimentId);
    return s;
  }
}
