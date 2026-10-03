import { ExperimentEngine } from '../domain/engine.js';
import type { Experiment, ExperimentSettings } from '../domain/types.js';
import type { Repository } from '../repo/types.js';
import { ConflictError } from '../domain/validation.js';

/** 试验默认分析设置 */
export const DEFAULT_SETTINGS: Omit<ExperimentSettings, never> = {
  windowEvents: 200,
  stepEvents: 50,
  allowedDelayUs: 5_000_000,
  baselineStartUs: 0,
  baselineEndUs: 600_000_000,
  alertMultiplier: 2,
  persistenceWindows: 3,
  minEventsForB: 50,
  mcMethod: 'MAXC',
  amplitudeMinDb: 0,
  amplitudeMaxDb: 120,
};

/**
 * 每个运行中试验持有一个引擎，按试验串行处理（同一试验的乱序语义
 * 依赖事件到达顺序，不能并发交错）。
 */
export class EngineRegistry {
  private readonly engines = new Map<string, ExperimentEngine>();
  private readonly chains = new Map<string, Promise<unknown>>();

  private constructor(private readonly repo: Repository) {}

  static async create(repo: Repository): Promise<EngineRegistry> {
    const reg = new EngineRegistry(repo);
    await reg.restore();
    return reg;
  }

  /** 服务启动：从库中恢复所有未结束试验，继续接收结果与未中断完全一致 */
  private async restore(): Promise<void> {
    const experiments = await this.repo.listExperiments();
    await Promise.all(
      experiments.map(async (exp) => {
        if (exp.status === 'running') {
          this.engines.set(exp.id, await ExperimentEngine.hydrate(exp, this.repo));
        }
      }),
    );
  }

  async register(experiment: Experiment): Promise<ExperimentEngine> {
    if (this.engines.has(experiment.id)) {
      throw new ConflictError('试验已存在且正在运行');
    }
    await this.repo.insertExperiment(experiment);
    const engine = await ExperimentEngine.hydrate(experiment, this.repo);
    this.engines.set(experiment.id, engine);
    return engine;
  }

  require(id: string): ExperimentEngine {
    const e = this.engines.get(id);
    if (!e) throw new ConflictError('试验不存在或已结束');
    return e;
  }

  async getExperiment(id: string) {
    return this.repo.getExperiment(id);
  }

  async stop(id: string): Promise<void> {
    const engine = this.require(id);
    await this.serial(id, () => engine.stop());
    this.engines.delete(id);
  }

  /** 同一试验的操作排队串行化 */
  serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(
      id,
      next.then(() => undefined, () => undefined),
    );
    return next;
  }
}
