import type { EngineStateDoc, Experiment } from './types.js';

export function emptyStateFor(experiment: Experiment): EngineStateDoc {
  return {
    experimentId: experiment.experimentId,
    nextWindowIndex: 0,
    maxTimestampUs: experiment.startedAtUs - 1,
    watermarkUs: experiment.startedAtUs - 1,
    baseline: null,
    baselineFinalized: false,
    alertState: null,
    alertNextWindowIndex: 0,
    breachStreak: 0,
    clearStreak: 0,
    closed: false,
    counters: { accepted: 0, duplicate: 0, late: 0, beforeStart: 0, invalid: 0 },
    updatedAtUs: Date.now() * 1000
  };
}
