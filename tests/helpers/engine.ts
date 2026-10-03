import { MemoryRepository } from '../../src/repo/memory.js';
import { ExperimentEngine } from '../../src/domain/engine.js';
import type { Experiment, ExperimentSettings } from '../../src/domain/types.js';

export function makeSettings(overrides: Partial<ExperimentSettings> = {}): ExperimentSettings {
  return {
    windowEvents: 200,
    stepEvents: 50,
    allowedDelayUs: 5_000_000,
    baselineStartUs: 0,
    baselineEndUs: 100_000_000,
    alertMultiplier: 2,
    persistenceWindows: 3,
    minEventsForB: 50,
    mcMethod: 'MAXC',
    amplitudeMinDb: 0,
    amplitudeMaxDb: 120,
    ...overrides,
  };
}

export async function makeEngine(
  repo: MemoryRepository,
  id = 'T1',
  overrides: Partial<ExperimentSettings> = {},
): Promise<ExperimentEngine> {
  const experiment: Experiment = {
    id,
    startedAtUs: 0,
    sample: { name: '砂岩试样' },
    settings: makeSettings(overrides),
    status: 'running',
    createdAtUs: 0,
  };
  await repo.insertExperiment(experiment);
  return ExperimentEngine.hydrate(experiment, repo);
}

export function asPayload(events: Array<{ eventId: string; timestampUs: number; amplitudeDb: number; channel: number }>) {
  return events;
}
