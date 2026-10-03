import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/http/app.js';
import { AppService } from '../src/app/service.js';
import { MemoryStore } from './helpers/memoryStore.js';

const START = 10_000_000;

async function postJson(server: Server, path: string, body: unknown) {
  const port = (server.address() as { port: number }).port;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
async function getJson(server: Server, path: string) {
  const port = (server.address() as { port: number }).port;
  return (await fetch(`http://127.0.0.1:${port}${path}`)).json();
}

describe('HTTP 接口契约', () => {
  let server: Server;
  let service: AppService;

  beforeAll(async () => {
    const store = new MemoryStore();
    service = new AppService(store, store);
    server = createApp(service).listen(0);
    await new Promise((r) => server.once('listening', r));
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const validBody = () => ({
    experimentId: 'http-1',
    startedAtUs: START,
    sample: { rock: 'sandstone' },
    settings: {
      windowEvents: 200,
      step: 100,
      maxDelayUs: 5_000_000,
      baselineDurationUs: 100_000_000,
      alertSigmaMultiple: 2,
      persistWindows: 3
    }
  });

  it('创建试验、推送合法/非法事件、查询状态/窗口', async () => {
    const created = await postJson(server, '/api/experiments', validBody());
    expect(created.status).toBe(201);

    // 重复创建 409
    expect((await postJson(server, '/api/experiments', validBody())).status).toBe(409);

    const events = Array.from({ length: 300 }, (_, i) => {
      const lambda = (1.0 * Math.LN10) / 20;
      // 简单指数幅度（确定性弱随机即可，这里用固定序列）
      const u = ((i * 2654435761) % 100000) / 100000 || 0.0001;
      return {
        eventId: `h-${i}`,
        timestampUs: START + i * 100_000,
        amplitudeDb: Math.min(99, 30 - Math.log(u) / lambda),
        channel: i % 3
      };
    });
    const ok = await postJson(server, '/api/experiments/http-1/events', { events });
    expect(ok.status).toBe(200);

    // 非法事件逐字段反馈
    const bad = await postJson(server, '/api/experiments/http-1/events', {
      events: [
        { eventId: 'b1', timestampUs: START, amplitudeDb: Number.POSITIVE_INFINITY, channel: 0 },
        { eventId: 'b2', timestampUs: START - 1, amplitudeDb: 50, channel: 0 },
        { eventId: 'b3', timestampUs: START, amplitudeDb: 500, channel: 0 },
        { eventId: '', timestampUs: 0, amplitudeDb: 'x' }
      ]
    });
    const body = await bad.json();
    expect(bad.status).toBe(200);
    const receipts = body.receipts as { field?: string; status: string }[];
    expect(receipts[0]!.status).toBe('invalid');
    expect(receipts[0]!.field).toContain('amplitudeDb');
    expect(receipts[1]!.status).toBe('before_start');
    expect(receipts[2]!.field).toContain('amplitudeDb');
    expect(receipts[3]!.field).toContain('eventId');
    expect(body.counters.invalid).toBe(2); // b1（Infinity）、b3（超量程）
    expect(body.counters.beforeStart).toBe(2); // b2，以及第 4 条（ts=0 早于开始，before_start 优先）

    // 建试验参数错误 400 且带字段
    const badCreate = await postJson(server, '/api/experiments', {
      experimentId: 'x',
      startedAtUs: START,
      settings: { windowEvents: -1, step: 0, maxDelayUs: 1, baselineDurationUs: 1, alertSigmaMultiple: 1, persistWindows: 0 }
    });
    expect(badCreate.status).toBe(400);
    const errBody = await badCreate.json();
    const fields = (errBody.errors as { field: string }[]).map((e) => e.field);
    expect(fields).toContain('settings.windowEvents');
    expect(fields).toContain('settings.step');
    expect(fields).toContain('settings.persistWindows');

    // 不存在的试验 404
    const res404 = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/experiments/nope/state`);
    expect(res404.status).toBe(404);

    // healthz 挂在根路径（不在 /api 下）
    const port = (server.address() as { port: number }).port;
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    expect(health).toEqual({ ok: true });
  });
});
