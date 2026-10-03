import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoStore } from '../src/infra/mongoStore.js';
import { AppService } from '../src/app/service.js';
import type { AnalysisSettings, IncomingEvent } from '../src/domain/types.js';
import { generateEvents, shuffleWithinDelay } from './helpers/synth.js';

/**
 * 真实 MongoDB 集成测试，仅在 MONGO_TEST_URL 存在时运行（CI/本地按需）：
 *   MONGO_TEST_URL=mongodb://127.0.0.1:27917 npm test -- tests/mongo.integration.test.ts
 */
const url = process.env.MONGO_TEST_URL;
const enabled = !!url;

const START = 10_000_000;
const INTERVAL = 100_000;

describe.skipIf(!enabled)('MongoStore 真实集成', () => {
  let store: MongoStore;
  const dbName = `ae_test_${Date.now()}`;

  beforeAll(async () => {
    store = new MongoStore(url!, dbName);
    await store.connect();
  });

  afterAll(async () => {
    // 结束时删掉本次测试库
    const client = (store as unknown as { client: { db: (n: string) => { dropDatabase: () => Promise<void> } } }).client;
    await client.db(dbName).dropDatabase();
    await store.close();
  });

  const settings: AnalysisSettings = {
    windowEvents: 300,
    step: 150,
    maxDelayUs: 2_000_000,
    baselineDurationUs: 400 * INTERVAL,
    alertSigmaMultiple: 3,
    persistWindows: 2,
    minEffectiveEvents: 50,
    amplitudeMinDb: 0,
    amplitudeMaxDb: 100,
    mcMethod: 'maxc'
  };

  it('乱序推送 + 整批重发 + 重启恢复：窗口/预警确定，索引生效', async () => {
    const service = new AppService(store, store);
    const expId = `mongo-it-${Date.now()}`;
    await service.createExperiment({
      experimentId: expId,
      startedAtUs: START,
      sample: { rock: 'it' },
      settings
    });

    const evs = generateEvents(
      [
        { bTrue: 1.2, count: 1000, mcDb: 30 },
        { bTrue: 0.6, count: 1200, mcDb: 30 }
      ],
      { seed: 9001, startUs: START, intervalUs: INTERVAL }
    ).map(
      (e): IncomingEvent => ({ eventId: e.eventId, timestampUs: e.timestampUs, amplitudeDb: e.amplitudeDb, channel: e.channel })
    );

    const ingestAt = async (events: IncomingEvent[]) => {
      const wall = events.reduce((m, e) => Math.max(m, e.timestampUs), START);
      return service.ingest(expId, events, wall);
    };

    for (let i = 0; i < evs.length; i += 200) {
      await ingestAt(shuffleWithinDelay(evs.slice(i, i + 200), 5, 31 + i));
    }
    // 整批重发
    const dup = await ingestAt(evs.slice(0, 200));
    expect(dup.receipts.every((r) => r.status === 'duplicate')).toBe(true);

    // 模拟重启：新建 service/引擎，基于同一 Mongo 恢复
    const service2 = new AppService(store, store);
    await service2.restoreAll();
    await service2.closeExperiment(expId);

    const windows = await store.listWindows(expId);
    const alerts = await store.listAlerts(expId);
    expect(windows.length).toBeGreaterThan(5);
    expect(windows.every((w) => w.endRankExclusive - w.startRank === settings.windowEvents)).toBe(true);
    // 低 b 段应触发预警（k=3 大样本，0.6 远低于阈值）
    expect(alerts.some((a) => a.kind === 'raised')).toBe(true);
    for (const a of alerts) {
      expect(a.experimentId).toBe(expId);
      expect(Number.isFinite(a.b)).toBe(true);
    }

    // 幂等：恢复逻辑再跑一遍不产生重复窗口/变迁
    const service3 = new AppService(store, store);
    await service3.restoreAll();
    expect((await store.listWindows(expId)).length).toBe(windows.length);
    expect((await store.listAlerts(expId)).length).toBe(alerts.length);

    // 事件总数正确（去重生效）
    expect(await store.countEvents(expId)).toBe(evs.length);

    const state = await store.getState(expId);
    expect(state!.closed).toBe(true);
    expect(state!.counters.accepted).toBe(evs.length);
  }, 60000);
});
