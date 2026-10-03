import { MongoClient, type Collection, type Db } from 'mongodb';
import type {
  AlertTransition,
  EngineStateDoc,
  Experiment,
  StoredEvent,
  WindowResult
} from '../domain/types.js';
import type { StateStore, Store } from '../domain/store.js';

const COLLECTIONS = {
  experiments: 'experiments',
  events: 'events',
  windows: 'windows',
  alerts: 'alerts',
  states: 'engine_states'
} as const;

export class MongoStore implements Store, StateStore {
  private client: MongoClient;
  private db: Db;
  private closed = false;

  constructor(uri: string, dbName: string) {
    this.client = new MongoClient(uri, {
      // 采集端持续推送，连接必须稳：服务端选择/心跳超时调短，便于快速感知重连
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10
    });
    this.db = this.client.db(dbName);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.initIndexes();
  }

  private col<T extends object>(name: string): Collection<T> {
    return this.db.collection<T>(name);
  }

  private async initIndexes(): Promise<void> {
    await this.col<Experiment>(COLLECTIONS.experiments).createIndex({ experimentId: 1 }, { unique: true });

    const events = this.col<StoredEvent>(COLLECTIONS.events);
    await events.createIndex({ experimentId: 1, eventId: 1 }, { unique: true });
    // 全局秩排序：(试验, ts 升序, eventId 升序)
    await events.createIndex(
      { experimentId: 1, timestampUs: 1, eventId: 1 },
      { unique: true, name: 'rank' }
    );

    await this.col<WindowResult>(COLLECTIONS.windows).createIndex(
      { experimentId: 1, index: 1 },
      { unique: true }
    );
    // 变迁幂等键：同一场试验同一窗口同一类变迁只可能有一条
    await this.col<AlertTransition>(COLLECTIONS.alerts).createIndex(
      { experimentId: 1, windowIndex: 1, kind: 1 },
      { unique: true }
    );
    await this.col<EngineStateDoc>(COLLECTIONS.states).createIndex({ experimentId: 1 }, { unique: true });
  }

  async insertExperiment(doc: Experiment): Promise<'inserted' | 'duplicate'> {
    const r = await this.col<Experiment>(COLLECTIONS.experiments).insertOne(doc);
    return r.acknowledged ? 'inserted' : 'duplicate';
  }

  async findExperiment(experimentId: string): Promise<Experiment | null> {
    return (await this.col<Experiment>(COLLECTIONS.experiments).findOne({ experimentId })) ?? null;
  }

  async listExperimentIds(): Promise<string[]> {
    const docs = await this.col<Experiment>(COLLECTIONS.experiments)
      .find({}, { projection: { _id: 0, experimentId: 1 } })
      .toArray();
    return docs.map((d) => d.experimentId);
  }

  async insertEventsIgnoreDuplicates(docs: StoredEvent[]): Promise<number> {
    if (docs.length === 0) return 0;
    // 分批，避免超大批量接近 BSON 16MB 限制
    let inserted = 0;
    const CHUNK = 2000;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const slice = docs.slice(i, i + CHUNK);
      const r = await this.col<StoredEvent>(COLLECTIONS.events).insertMany(slice, { ordered: false });
      inserted += r.insertedCount;
    }
    return inserted;
  }

  async hasEventIds(experimentId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const cur = this.col<StoredEvent>(COLLECTIONS.events).find(
      { experimentId, eventId: { $in: ids } },
      { projection: { _id: 0, eventId: 1 } }
    );
    const out = new Set<string>();
    for await (const d of cur) out.add(d.eventId);
    return out;
  }

  async countEventsBefore(experimentId: string, timestampExclusive: number): Promise<number> {
    return this.col<StoredEvent>(COLLECTIONS.events).countDocuments({
      experimentId,
      timestampUs: { $lt: timestampExclusive }
    });
  }

  async listEventsByRank(
    experimentId: string,
    startRank: number,
    endRankExclusive: number
  ): Promise<StoredEvent[]> {
    return this.col<StoredEvent>(COLLECTIONS.events)
      .find({ experimentId }, { projection: { _id: 0 } })
      .sort({ timestampUs: 1, eventId: 1 })
      .skip(startRank)
      .limit(endRankExclusive - startRank)
      .toArray();
  }

  async listEventsBefore(experimentId: string, timestampExclusive: number): Promise<StoredEvent[]> {
    return this.col<StoredEvent>(COLLECTIONS.events)
      .find({ experimentId, timestampUs: { $lt: timestampExclusive } }, { projection: { _id: 0 } })
      .sort({ timestampUs: 1, eventId: 1 })
      .toArray();
  }

  async listEvents(experimentId: string, limit: number): Promise<StoredEvent[]> {
    return this.col<StoredEvent>(COLLECTIONS.events)
      .find({ experimentId }, { projection: { _id: 0 } })
      .sort({ timestampUs: 1, eventId: 1 })
      .limit(limit)
      .toArray();
  }

  async maxEventTimestamp(experimentId: string): Promise<number | null> {
    const doc = await this.col<StoredEvent>(COLLECTIONS.events)
      .find({ experimentId }, { projection: { _id: 0, timestampUs: 1 } })
      .sort({ timestampUs: -1 })
      .limit(1)
      .next();
    return doc ? doc.timestampUs : null;
  }

  async countEvents(experimentId: string): Promise<number> {
    return this.col<StoredEvent>(COLLECTIONS.events).countDocuments({ experimentId });
  }

  async insertWindow(doc: WindowResult): Promise<'inserted' | 'duplicate'> {
    const r = await this.col<WindowResult>(COLLECTIONS.windows).updateOne(
      { experimentId: doc.experimentId, index: doc.index },
      { $setOnInsert: doc },
      { upsert: true }
    );
    return r.upsertedCount === 1 ? 'inserted' : 'duplicate';
  }

  async listWindows(experimentId: string): Promise<WindowResult[]> {
    return this.col<WindowResult>(COLLECTIONS.windows)
      .find({ experimentId }, { projection: { _id: 0 } })
      .sort({ index: 1 })
      .toArray();
  }

  async insertAlert(doc: AlertTransition): Promise<'inserted' | 'duplicate'> {
    const r = await this.col<AlertTransition>(COLLECTIONS.alerts).updateOne(
      { experimentId: doc.experimentId, windowIndex: doc.windowIndex, kind: doc.kind },
      { $setOnInsert: doc },
      { upsert: true }
    );
    return r.upsertedCount === 1 ? 'inserted' : 'duplicate';
  }

  async listAlerts(experimentId: string): Promise<AlertTransition[]> {
    return this.col<AlertTransition>(COLLECTIONS.alerts)
      .find({ experimentId }, { projection: { _id: 0 } })
      .sort({ windowIndex: 1, kind: 1 })
      .toArray();
  }

  async getState(experimentId: string): Promise<EngineStateDoc | null> {
    return (await this.col<EngineStateDoc>(COLLECTIONS.states).findOne({ experimentId }, { projection: { _id: 0 } })) ?? null;
  }

  async upsertState(doc: EngineStateDoc): Promise<void> {
    await this.col<EngineStateDoc>(COLLECTIONS.states).updateOne(
      { experimentId: doc.experimentId },
      { $set: doc },
      { upsert: true }
    );
  }

  async setClosed(experimentId: string, closed: boolean): Promise<void> {
    await this.col<Experiment>(COLLECTIONS.experiments).updateOne({ experimentId }, { $set: { status: closed ? 'closed' : 'active' } });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }
}
