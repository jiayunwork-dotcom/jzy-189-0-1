import type {
  AlertRecord,
  EngineMeta,
  Experiment,
  LateEventRecord,
  StoredEvent,
  WindowResult,
} from '../domain/types.js';
import type { Repository } from './types.js';

/** 纯内存仓储：单测使用，语义与 MongoRepository 一一对应 */
export class MemoryRepository implements Repository {
  private experiments = new Map<string, Experiment>();
  private events = new Map<string, StoredEvent[]>();
  private late = new Map<string, Set<string>>();
  private windows = new Map<string, WindowResult[]>();
  private alerts = new Map<string, AlertRecord[]>();
  private metas = new Map<string, EngineMeta>();

  private key(exp: string, id: string): string {
    return `${exp}${id}`;
  }

  async insertExperiment(exp: Experiment): Promise<void> {
    if (this.experiments.has(exp.id)) {
      throw Object.assign(new Error('duplicate key experiment'), { code: 11000 });
    }
    this.experiments.set(exp.id, exp);
  }

  async getExperiment(id: string): Promise<Experiment | null> {
    return this.experiments.get(id) ?? null;
  }

  async listExperiments(): Promise<Experiment[]> {
    return [...this.experiments.values()];
  }

  async markExperimentStopped(id: string, stoppedAtUs: number): Promise<void> {
    const exp = this.experiments.get(id);
    if (exp) {
      exp.status = 'stopped';
      exp.stoppedAtUs = stoppedAtUs;
    }
  }

  async insertEvents(events: StoredEvent[]): Promise<StoredEvent[]> {
    const written: StoredEvent[] = [];
    for (const e of events) {
      const list = this.events.get(e.experimentId) ?? [];
      if (list.some((x) => x.eventId === e.eventId)) {
        continue; // 模拟唯一索引
      }
      if (this.late.get(e.experimentId)?.has(e.eventId)) continue;
      list.push(e);
      this.events.set(e.experimentId, list);
      written.push(e);
    }
    return written;
  }

  async existingEventIds(exp: string, eventIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    const list = this.events.get(exp);
    const lateSet = this.late.get(exp);
    for (const id of eventIds) {
      if (list?.some((x) => x.eventId === id) || lateSet?.has(id)) out.add(id);
    }
    return out;
  }

  async insertLateEvent(rec: LateEventRecord): Promise<void> {
    const set = this.late.get(rec.experimentId) ?? new Set<string>();
    set.add(rec.eventId);
    this.late.set(rec.experimentId, set);
  }

  private sorted(exp: string): StoredEvent[] {
    return (this.events.get(exp) ?? []).slice().sort(compareEvent);
  }

  async loadAllEvents(exp: string): Promise<StoredEvent[]> {
    return this.sorted(exp);
  }

  async loadEventsInRange(exp: string, fromUs: number, toUs: number): Promise<StoredEvent[]> {
    return this.sorted(exp).filter((e) => e.timestampUs >= fromUs && e.timestampUs < toUs);
  }

  async countEvents(exp: string): Promise<number> {
    return (this.events.get(exp) ?? []).length;
  }

  async upsertWindow(w: WindowResult): Promise<void> {
    const list = this.windows.get(w.experimentId) ?? [];
    const idx = list.findIndex((x) => x.windowIndex === w.windowIndex);
    if (idx >= 0) list[idx] = w;
    else list.push(w);
    list.sort((a, b) => a.windowIndex - b.windowIndex);
    this.windows.set(w.experimentId, list);
  }

  async listWindows(exp: string): Promise<WindowResult[]> {
    return (this.windows.get(exp) ?? []).slice();
  }

  async insertAlert(a: AlertRecord): Promise<void> {
    const list = this.alerts.get(a.experimentId) ?? [];
    // 与 Mongo 的 (experimentId,kind,windowIndex) 唯一索引语义一致
    if (list.some((x) => x.kind === a.kind && x.windowIndex === a.windowIndex)) return;
    list.push(a);
    this.alerts.set(a.experimentId, list);
  }

  async listAlerts(exp: string): Promise<AlertRecord[]> {
    return (this.alerts.get(exp) ?? []).slice();
  }

  async saveEngineMeta(meta: EngineMeta): Promise<void> {
    this.metas.set(meta.experimentId, structuredClone(meta));
  }

  async loadEngineMeta(exp: string): Promise<EngineMeta | null> {
    const m = this.metas.get(exp);
    return m ? structuredClone(m) : null;
  }
}

export function compareEvent(a: StoredEvent, b: StoredEvent): number {
  return a.timestampUs - b.timestampUs || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
}
