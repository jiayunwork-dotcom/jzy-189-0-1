import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { EngineRegistry, DEFAULT_SETTINGS } from '../service/registry.js';
import type { Repository } from '../repo/types.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  validateExperiment,
} from '../domain/validation.js';
import { BatchValidationError } from '../domain/engine.js';
import type { Experiment, McMethod } from '../domain/types.js';

export interface AppDeps {
  repo: Repository;
  registry: EngineRegistry;
}

export function createApp(deps: AppDeps): Application {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ---- 创建试验 ----
  app.post('/experiments', asyncHandler(async (req, res) => {
    const body = req.body as { settings?: Partial<Record<string, unknown>> };
    const merged = {
      ...req.body,
      settings: { ...DEFAULT_SETTINGS, ...(body.settings ?? {}) },
    };
    const parsed = validateExperiment(merged);

    const experiment: Experiment = {
      id: parsed.id,
      startedAtUs: parsed.startedAtUs,
      sample: parsed.sample,
      settings: parsed.settings,
      status: 'running',
      createdAtUs: Date.now() * 1000,
    };
    try {
      await deps.registry.register(experiment);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictError(`试验编号 ${experiment.id} 已存在`);
      }
      throw err;
    }
    res.status(201).json({ experiment });
  }));

  // ---- 试验状态 ----
  app.get('/experiments/:id', asyncHandler(async (req, res) => {
    const exp = await deps.repo.getExperiment(req.params.id!);
    if (!exp) throw new NotFoundError('试验不存在');
    const meta = await deps.repo.loadEngineMeta(exp.id);
    res.json({ experiment: exp, engine: meta });
  }));

  // ---- 推送撞击事件（支持单条对象或数组） ----
  app.post('/experiments/:id/events', asyncHandler(async (req, res) => {
    const engine = deps.registry.require(req.params.id!);
    const raw = Array.isArray(req.body) ? req.body : [req.body];
    try {
      const counters = await deps.registry.serial(req.params.id!, () => engine.ingest(raw));
      const meta = engine.getMeta();
      res.status(202).json({
        accepted: counters.accepted,
        duplicates: counters.duplicates,
        lateDropped: counters.lateDropped,
        rejected: counters.rejected,
        finalizedWindows: counters.finalizedWindows,
        alerts: counters.alerts,
        watermarkUs: meta.watermarkUs,
      });
    } catch (err) {
      if (err instanceof BatchValidationError) {
        res.status(422).json({
          error: '部分事件字段非法（其余合法事件已接收并参与计算）',
          fieldErrors: err.fieldErrors,
          accepted: err.counters.accepted,
          duplicates: err.counters.duplicates,
          lateDropped: err.counters.lateDropped,
          finalizedWindows: err.counters.finalizedWindows,
          alerts: err.counters.alerts,
        });
        return;
      }
      throw err;
    }
  }));

  // ---- 窗口结果 ----
  app.get('/experiments/:id/windows', asyncHandler(async (req, res) => {
    await ensureExists(deps, req.params.id!);
    const windows = await deps.repo.listWindows(req.params.id!);
    res.json({ windows });
  }));

  // ---- 预警事件 ----
  app.get('/experiments/:id/alerts', asyncHandler(async (req, res) => {
    await ensureExists(deps, req.params.id!);
    const alerts = await deps.repo.listAlerts(req.params.id!);
    const meta = await deps.repo.loadEngineMeta(req.params.id!);
    res.json({ state: meta?.alertState ?? 'normal', alerts });
  }));

  // ---- 结束试验（定稿尾部窗口） ----
  app.post('/experiments/:id/stop', asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const counters = await deps.registry.serial(id, async () => {
      const engine = deps.registry.require(id);
      return engine.stop();
    });
    res.json({
      status: 'stopped',
      finalizedWindows: counters.finalizedWindows,
      alerts: counters.alerts,
    });
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, fieldErrors: err.fieldErrors });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof ConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  });

  return app;
}

async function ensureExists(deps: AppDeps, id: string): Promise<void> {
  const exp = await deps.repo.getExperiment(id);
  if (!exp) throw new NotFoundError('试验不存在');
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export type { McMethod };
