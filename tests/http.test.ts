import { afterAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { MemoryRepository } from '../src/repo/memory.js';
import { EngineRegistry } from '../src/service/registry.js';
import { createApp } from '../src/http/app.js';
import type { Application } from 'express';

async function buildApp(): Promise<{ app: Application; repo: MemoryRepository }> {
  const repo = new MemoryRepository();
  const registry = await EngineRegistry.create(repo);
  return { app: createApp({ repo, registry }), repo };
}

const validSettings = {
  windowEvents: 100,
  stepEvents: 100,
  allowedDelayUs: 5_000_000,
  baselineStartUs: 0,
  baselineEndUs: 5_000_000,
  alertMultiplier: 2,
  persistenceWindows: 2,
  minEventsForB: 20,
};

describe('HTTP API', () => {
  let app: Application;
  let repo: MemoryRepository;

  afterAll(async () => {
    // 让事件循环退出
    await new Promise((r) => setTimeout(r, 0));
  });

  it('健康检查', async () => {
    const built = await buildApp();
    app = built.app;
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('创建试验 -> 推送事件 -> 查询窗口 -> 结束', async () => {
    const built = await buildApp();
    app = built.app; repo = built.repo;

    const created = await supertest(app)
      .post('/experiments')
      .send({ experimentId: 'E2E-1', startedAtUs: 0, sample: { name: '砂岩' }, settings: validSettings })
      .expect(201);
    expect(created.body.experiment.settings.windowEvents).toBe(100);

    // 200 个 b≈1 事件，跨度 0..19.9ms，基线在前 5ms（约 50 个事件）
    const events = Array.from({ length: 200 }, (_, i) => ({
      eventId: `ev-${i}`,
      timestampUs: i * 100_000,
      amplitudeDb: 40 + (i % 6),
      channel: i % 3,
    }));
    const pushed = await supertest(app)
      .post('/experiments/E2E-1/events')
      .send(events)
      .expect(202);
    expect(pushed.body.accepted).toBe(200);

    const stopped = await supertest(app).post('/experiments/E2E-1/stop').expect(200);
    expect(stopped.body.finalizedWindows.length).toBeGreaterThan(0);

    const windows = await supertest(app).get('/experiments/E2E-1/windows').expect(200);
    expect(windows.body.windows[0]).toMatchObject({ nTotal: 100, status: 'ok' });
    expect(windows.body.windows[0].bValue).toBeGreaterThan(0);

    const alerts = await supertest(app).get('/experiments/E2E-1/alerts').expect(200);
    expect(alerts.body.state).toBe('normal');
    expect(Array.isArray(alerts.body.alerts)).toBe(true);
  });

  it('重复编号返回 409', async () => {
    const built = await buildApp();
    app = built.app;
    await supertest(app)
      .post('/experiments')
      .send({ experimentId: 'DUPX', startedAtUs: 0, settings: validSettings });
    const res = await supertest(app)
      .post('/experiments')
      .send({ experimentId: 'DUPX', startedAtUs: 0, settings: validSettings })
      .expect(409);
    expect(res.body.error).toContain('已存在');
  });

  it('非法设置返回 400 且字段精确', async () => {
    const built = await buildApp();
    app = built.app;
    const res = await supertest(app)
      .post('/experiments')
      .send({
        experimentId: 'BAD',
        startedAtUs: 0,
        settings: { ...validSettings, windowEvents: -1, persistenceWindows: 0 },
      })
      .expect(400);
    const fields = res.body.fieldErrors.map((f: { field: string }) => f.field);
    expect(fields).toContain('settings.windowEvents');
    expect(fields).toContain('settings.persistenceWindows');
  });

  it('事件字段错误返回 422 并指出字段；向不存在试验推送返回 409', async () => {
    const built = await buildApp();
    app = built.app;
    await supertest(app)
      .post('/experiments')
      .send({ experimentId: 'EV', startedAtUs: 1000, settings: validSettings });

    const res = await supertest(app)
      .post('/experiments/EV/events')
      .send([
        { eventId: 'ok', timestampUs: 2000, amplitudeDb: 50, channel: 1 },
        { eventId: 'bad1', timestampUs: 500, amplitudeDb: 50, channel: 1 },
        { eventId: 'bad2', timestampUs: 2000, amplitudeDb: 'nan', channel: 1 },
      ])
      .expect(422);
    const fields = res.body.fieldErrors.map((f: { field: string }) => f.field);
    expect(fields).toContain('events[1].timestampUs');
    expect(fields).toContain('events[2].amplitudeDb');
    expect(res.body.accepted).toBe(1); // 合法事件仍生效

    const gone = await supertest(app)
      .post('/experiments/NOPE/events')
      .send([{ eventId: 'x', timestampUs: 1, amplitudeDb: 50, channel: 1 }])
      .expect(409);
    expect(gone.body.error).toContain('不存在');
  });

  it('结束后再推事件返回 409', async () => {
    const built = await buildApp();
    app = built.app;
    await supertest(app)
      .post('/experiments')
      .send({ experimentId: 'STOP', startedAtUs: 0, settings: validSettings });
    await supertest(app).post('/experiments/STOP/stop').expect(200);
    await supertest(app)
      .post('/experiments/STOP/events')
      .send({ eventId: 'x', timestampUs: 100, amplitudeDb: 50, channel: 1 })
      .expect(409);
  });

  it('重发事件计数为 duplicates 且 accepted=0', async () => {
    const built = await buildApp();
    app = built.app;
    await supertest(app)
      .post('/experiments')
      .send({ experimentId: 'R', startedAtUs: 0, settings: validSettings });
    const payload = [{ eventId: 'r1', timestampUs: 100, amplitudeDb: 50, channel: 1 }];
    await supertest(app).post('/experiments/R/events').send(payload).expect(202);
    const res = await supertest(app).post('/experiments/R/events').send(payload).expect(202);
    expect(res.body.duplicates).toBe(1);
    expect(res.body.accepted).toBe(0);
  });
});
