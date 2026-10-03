import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { validateExperimentCreate } from '../domain/validation.js';
import { AlreadyExistsError, AppService, ExperimentClosedError, NotFoundError } from '../app/service.js';

/**
 * 接口（前端同学对接用）：
 *
 * 试验：
 *   POST   /api/experiments                  创建试验（body 见 README）
 *   GET    /api/experiments                   试验列表
 *   GET    /api/experiments/:id               试验详情
 *   POST   /api/experiments/:id/close         结束试验（尾部窗口补算后不再收事件）
 *
 * 事件：
 *   POST   /api/experiments/:id/events        推送事件（单对象 / 数组 / {"events":[...]} 均可）
 *
 * 结果（GET 只读）：
 *   GET    /api/experiments/:id/state         运行状态（基线、预警状态、计数、水位）
 *   GET    /api/experiments/:id/windows       窗口 b 值序列
 *   GET    /api/experiments/:id/alerts        预警变迁（raised/cleared）
 *   GET    /api/experiments/:id/events?limit= 已接受事件（调试用）
 *
 *   GET    /healthz
 */
export function createApiRouter(service: AppService): Router {
  const router = Router();

  router.post('/experiments', async (req, res, next) => {
    try {
      const v = validateExperimentCreate(req.body);
      if (!v.ok) {
        res.status(400).json({ error: 'validation_failed', errors: v.errors });
        return;
      }
      const doc = await service.createExperiment(v.value);
      res.status(201).json(doc);
    } catch (e) {
      next(e);
    }
  });

  router.get('/experiments', async (_req, res, next) => {
    try {
      res.json({ experiments: await service.listExperiments() });
    } catch (e) {
      next(e);
    }
  });

  router.get('/experiments/:id', async (req, res, next) => {
    try {
      res.json(await service.getExperimentOrThrow(req.params.id!));
    } catch (e) {
      next(e);
    }
  });

  router.post('/experiments/:id/events', async (req, res, next) => {
    try {
      const rawEvents = extractEventList(req.body);
      if (rawEvents === null) {
        res.status(400).json({
          error: 'validation_failed',
          errors: [
            {
              field: '(body)',
              reason: 'invalid_shape',
              message: '请求体必须是事件对象、事件数组，或形如 {"events":[...]} 的对象'
            }
          ]
        });
        return;
      }
      const result = await service.ingest(req.params.id!, rawEvents);
      res.status(200).json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post('/experiments/:id/close', async (req, res, next) => {
    try {
      const r = await service.closeExperiment(req.params.id!);
      const state = await service.getState(req.params.id!);
      res.json({ ...r, state });
    } catch (e) {
      next(e);
    }
  });

  router.get('/experiments/:id/state', async (req, res, next) => {
    try {
      res.json(await service.getState(req.params.id!));
    } catch (e) {
      next(e);
    }
  });

  router.get('/experiments/:id/windows', async (req, res, next) => {
    try {
      await service.getExperimentOrThrow(req.params.id!);
      res.json({ windows: await service.listWindows(req.params.id!) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/experiments/:id/alerts', async (req, res, next) => {
    try {
      await service.getExperimentOrThrow(req.params.id!);
      res.json({ alerts: await service.listAlerts(req.params.id!) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/experiments/:id/events', async (req, res, next) => {
    try {
      await service.getExperimentOrThrow(req.params.id!);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 1000) || 1000, 1), 10000);
      res.json({ events: await service.listEvents(req.params.id!, limit) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

function extractEventList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.events)) return obj.events;
    // 单条事件：必须至少长得像事件
    if ('eventId' in obj || 'timestampUs' in obj) return [body];
  }
  return null;
}

export function createApp(service: AppService) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', createApiRouter(service));

  // 统一错误出口
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'not_found', message: err.message });
      return;
    }
    if (err instanceof AlreadyExistsError) {
      res.status(409).json({ error: 'already_exists', message: err.message });
      return;
    }
    if (err instanceof ExperimentClosedError) {
      res.status(409).json({ error: 'experiment_closed', message: err.message });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid_json', message: err.message });
      return;
    }
    const e = err as Error;
    res.status(500).json({ error: 'internal', message: e?.message ?? String(err) });
  });
  return app;
}
