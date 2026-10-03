import type { Collection, Db } from 'mongodb';
import type {
  AlertRecord,
  EngineMeta,
  Experiment,
  LateEventRecord,
  StoredEvent,
  WindowResult,
} from '../domain/types.js';
import type { Repository } from './types.js';
import { compareEvent } from './memory.js';

const DUPLICATE_KEY = 11000;

/** MongoDB 7 持久化实现。所有幂等性依赖唯一索引，重启可安全回放。 */
export class MongoRepository implements Repository {
  private readonly experiments: Collection<Experiment>;
  private readonly events: Collection<StoredEvent>;
  private readonly lateEvents: Collection<LateEventRecord>;
  private readonly windows: Collection<WindowResult>;
  private readonly alerts: Collection<AlertRecord>;
  private readonly meta: Collection<EngineMeta>;

  constructor(db: Db) {
    this.experiments = db.collection('experiments');
    this.events = db.collection('events');
    this.lateEvents = db.collection('late_events');
    this.windows = db.collection('windows');
    this.alerts = db.collection('alerts');
    this.meta = db.collection('engine_meta');
  }

  async ensureIndexes(): Promise<void> {
    await this.experiments.createIndex({ id: 1 }, { unique: true });

    // 重发去重的核心约束
    await this.events.createIndex({ experimentId: 1, eventId: 1 }, { unique: true });
    // 时间序列查询：全局次序、区间取数、冻结计数
    await this.events.createIndex(
      { experimentId: 1, timestampUs: 1, eventId: 1 },
      { unique: false },
    );

    await this.lateEvents.createIndex({ experimentId: 1, eventId: 1 }, { unique: true });

    await this.windows.createIndex(
      { experimentId: 1, windowIndex: 1 },
      { unique: true },
    );
    // 同一状态变化（窗口）不得因任何路径重复落库
    await this.alerts.createIndex(
      { experimentId: 1, kind: 1, windowIndex: 1 },
      { unique: true },
    );
    await this.meta.createIndex({ experimentId: 1 }, { unique: true });
  }

  async insertExperiment(exp: Experiment): Promise<void> {
    try {
      await this.experiments.insertOne(exp);
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) {
        throw Object.assign(new Error('试验编号已存在'), { code: DUPLICATE_KEY });
      }
      throw err;
    }
  }

  async getExperiment(id: string): Promise<Experiment | null> {
    return this.experiments.findOne({ id });
  }

  async listExperiments(): Promise<Experiment[]> {
    return this.experiments.find().sort({ createdAtUs: 1 }).toArray();
  }

  async markExperimentStopped(id: string, stoppedAtUs: number): Promise<void> {
    await this.experiments.updateOne(
      { id },
      { $set: { status: 'stopped', stoppedAtUs } },
    );
  }

  async insertEvents(events: StoredEvent[]): Promise<StoredEvent[]> {
    if (events.length === 0) return [];
    // 无序批量插入：重发撞唯一索引时只丢那一条，其余照常写入
    const ops = events.map((e) => ({ insertOne: { document: e } }));
    let result;
    try {
      result = await this.events.bulkWrite(ops, { ordered: false });
    } catch (err) {
      const bulkErr = err as { code?: number; writeErrors?: Array<{ code?: number }> };
      const allDup =
        bulkErr.writeErrors?.every((we) => we.code === DUPLICATE_KEY) ?? false;
      if (bulkErr.code !== DUPLICATE_KEY || !allDup) throw err;
    }
    const insertedIds = result?.insertedIds;
    const insertedIndexes: number[] = insertedIds instanceof Map
      ? [...insertedIds.keys()]
      : Object.keys(insertedIds ?? {}).map(Number);
    const insertedSet = new Set(insertedIndexes);
    return events.filter((_, i) => insertedSet.has(i));
  }

  async existingEventIds(experimentId: string, eventIds: string[]): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();
    const out = new Set<string>();
    const [evs, lates] = await Promise.all([
      this.events
        .find({ experimentId, eventId: { $in: eventIds } }, { projection: { eventId: 1 } })
        .toArray(),
      this.lateEvents
        .find({ experimentId, eventId: { $in: eventIds } }, { projection: { eventId: 1 } })
        .toArray(),
    ]);
    for (const d of evs) out.add(d.eventId);
    for (const d of lates) out.add(d.eventId);
    return out;
  }

  async insertLateEvent(rec: LateEventRecord): Promise<void> {
    try {
      await this.lateEvents.insertOne(rec);
    } catch (err) {
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
    }
  }

  private async loadSorted(filter: Record<string, unknown>): Promise<StoredEvent[]> {
    const docs = await this.events.find(filter).toArray();
    return docs.sort(compareEvent);
  }

  async loadAllEvents(experimentId: string): Promise<StoredEvent[]> {
    return this.loadSorted({ experimentId });
  }

  async loadEventsInRange(experimentId: string, fromUs: number, toUs: number): Promise<StoredEvent[]> {
    return this.loadSorted({
      experimentId,
      timestampUs: { $gte: fromUs, $lt: toUs },
    });
  }

  async countEvents(experimentId: string): Promise<number> {
    return this.events.countDocuments({ experimentId });
  }

  async upsertWindow(w: WindowResult): Promise<void> {
    await this.windows.updateOne(
      { experimentId: w.experimentId, windowIndex: w.windowIndex },
      { $set: w },
      { upsert: true },
    );
  }

  async listWindows(experimentId: string): Promise<WindowResult[]> {
    return this.windows
      .find({ experimentId })
      .sort({ windowIndex: 1 })
      .toArray();
  }

  async insertAlert(a: AlertRecord): Promise<void> {
    try {
      await this.alerts.insertOne(a);
    } catch (err) {
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
    }
  }

  async listAlerts(experimentId: string): Promise<AlertRecord[]> {
    return this.alerts
      .find({ experimentId })
      .sort({ windowEndUs: 1, windowIndex: 1 })
      .toArray();
  }

  async saveEngineMeta(meta: EngineMeta): Promise<void> {
    await this.meta.updateOne(
      { experimentId: meta.experimentId },
      { $set: meta },
      { upsert: true },
    );
  }

  async loadEngineMeta(experimentId: string): Promise<EngineMeta | null> {
    return this.meta.findOne({ experimentId });
  }
}
