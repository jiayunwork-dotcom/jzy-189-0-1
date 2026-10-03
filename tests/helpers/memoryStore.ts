import type {
  AlertTransition,
  EngineStateDoc,
  Experiment,
  StoredEvent,
  WindowResult
} from '../../src/domain/types.js';
import type { StateStore, Store } from '../../src/domain/store.js';

/** 与 MongoStore 语义一致的内存实现，供单元测试使用。 */
export class MemoryStore implements Store, StateStore {
  experiments = new Map<string, Experiment>();
  events = new Map<string, StoredEvent[]>();
  windows = new Map<string, WindowResult[]>();
  alerts = new Map<string, AlertTransition[]>();
  states = new Map<string, EngineStateDoc>();

  async insertExperiment(doc: Experiment): Promise<'inserted' | 'duplicate'> {
    if (this.experiments.has(doc.experimentId)) return 'duplicate';
    this.experiments.set(doc.experimentId, doc);
    return 'inserted';
  }
  async findExperiment(id: string): Promise<Experiment | null> {
    return this.experiments.get(id) ?? null;
  }
  async listExperimentIds(): Promise<string[]> {
    return [...this.experiments.keys()];
  }

  async insertEventsIgnoreDuplicates(docs: StoredEvent[]): Promise<number> {
    let inserted = 0;
    for (const d of docs) {
      const list = this.events.get(d.experimentId);
      if (list && list.some((e) => e.eventId === d.eventId)) continue;
      if (!this.events.has(d.experimentId)) this.events.set(d.experimentId, []);
      this.events.get(d.experimentId)!.push(d);
      inserted++;
    }
    return inserted;
  }
  async hasEventIds(experimentId: string, ids: string[]): Promise<Set<string>> {
    const list = this.events.get(experimentId) ?? [];
    const have = new Set(list.map((e) => e.eventId));
    return new Set(ids.filter((i) => have.has(i)));
  }
  private sorted(id: string): StoredEvent[] {
    return (this.events.get(id) ?? [])
      .slice()
      .sort((a, b) => (a.timestampUs - b.timestampUs || a.eventId.localeCompare(b.eventId)));
  }
  async countEventsBefore(id: string, tsExclusive: number): Promise<number> {
    return this.sorted(id).filter((e) => e.timestampUs < tsExclusive).length;
  }
  async listEventsByRank(id: string, start: number, endEx: number): Promise<StoredEvent[]> {
    return this.sorted(id).slice(start, endEx);
  }
  async listEventsBefore(id: string, tsExclusive: number): Promise<StoredEvent[]> {
    return this.sorted(id).filter((e) => e.timestampUs < tsExclusive);
  }
  async listEvents(id: string, limit: number): Promise<StoredEvent[]> {
    return this.sorted(id).slice(0, limit);
  }
  async maxEventTimestamp(id: string): Promise<number | null> {
    const list = this.events.get(id);
    if (!list || list.length === 0) return null;
    return list.reduce((m, e) => Math.max(m, e.timestampUs), -Infinity);
  }
  async countEvents(id: string): Promise<number> {
    return (this.events.get(id) ?? []).length;
  }

  async insertWindow(doc: WindowResult): Promise<'inserted' | 'duplicate'> {
    const list = this.windows.get(doc.experimentId) ?? [];
    if (list.some((w) => w.index === doc.index)) return 'duplicate';
    list.push(doc);
    this.windows.set(doc.experimentId, list);
    return 'inserted';
  }
  async listWindows(id: string): Promise<WindowResult[]> {
    return (this.windows.get(id) ?? []).slice().sort((a, b) => a.index - b.index);
  }

  async insertAlert(doc: AlertTransition): Promise<'inserted' | 'duplicate'> {
    const list = this.alerts.get(doc.experimentId) ?? [];
    if (list.some((a) => a.windowIndex === doc.windowIndex && a.kind === doc.kind)) return 'duplicate';
    list.push(doc);
    this.alerts.set(doc.experimentId, list);
    return 'inserted';
  }
  async listAlerts(id: string): Promise<AlertTransition[]> {
    return (this.alerts.get(id) ?? []).slice().sort((a, b) => a.windowIndex - b.windowIndex);
  }

  async getState(id: string): Promise<EngineStateDoc | null> {
    return this.states.get(id) ?? null;
  }
  async upsertState(doc: EngineStateDoc): Promise<void> {
    this.states.set(doc.experimentId, structuredClone(doc));
  }
  async setClosed(id: string, closed: boolean): Promise<void> {
    const exp = this.experiments.get(id);
    if (exp) exp.status = closed ? 'closed' : 'active';
  }
}
