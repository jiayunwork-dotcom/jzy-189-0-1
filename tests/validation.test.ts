import { describe, expect, it } from 'vitest';
import { validateExperimentCreate, validateIncomingEvent } from '../src/domain/validation.js';

const START = 1_000_000;

describe('事件校验', () => {
  it('合法事件通过', () => {
    const r = validateIncomingEvent(
      { eventId: 'a', timestampUs: START + 5, amplitudeDb: 55.2, channel: 1 },
      START,
      0,
      100
    );
    expect(r.ok).toBe(true);
  });

  it('非有限幅度指出字段', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = validateIncomingEvent(
        { eventId: 'a', timestampUs: START + 5, amplitudeDb: bad, channel: 1 },
        START,
        0,
        100
      );
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.errors[0]!.field).toBe('amplitudeDb');
      expect(r.errors[0]!.reason).toBe('not_finite');
    }
  });

  it('超量程幅度指出范围', () => {
    const r = validateIncomingEvent(
      { eventId: 'a', timestampUs: START + 5, amplitudeDb: 101, channel: 1 },
      START,
      0,
      100
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.field === 'amplitudeDb' && e.reason === 'out_of_range')).toBe(true);
  });

  it('时间戳早于试验开始指出 timestampUs', () => {
    const r = validateIncomingEvent(
      { eventId: 'a', timestampUs: START - 1, amplitudeDb: 50, channel: 0 },
      START,
      0,
      100
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.field).toBe('timestampUs');
    expect(r.errors[0]!.reason).toBe('before_start');
  });

  it('时间戳等于开始时间合法', () => {
    const r = validateIncomingEvent(
      { eventId: 'a', timestampUs: START, amplitudeDb: 50, channel: 0 },
      START,
      0,
      100
    );
    expect(r.ok).toBe(true);
  });

  it('多字段错误全部列出', () => {
    const r = validateIncomingEvent({ eventId: '', timestampUs: 1.5, amplitudeDb: 'x' }, START, 0, 100);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field).sort()).toEqual(['amplitudeDb', 'channel', 'eventId', 'timestampUs']);
  });
});

describe('试验设置校验', () => {
  const goodSettings = {
    windowEvents: 200,
    step: 100,
    maxDelayUs: 5_000_000,
    baselineDurationUs: 100_000_000,
    alertSigmaMultiple: 1.5,
    persistWindows: 3
  };

  const body = (patch: Record<string, unknown> = {}) => ({
    experimentId: 't1',
    startedAtUs: START,
    sample: { rock: 'granite' },
    settings: { ...goodSettings, ...patch }
  });

  it('合法设置通过并补默认值', () => {
    const r = validateExperimentCreate(body());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.settings.minEffectiveEvents).toBe(50);
    expect(r.value.settings.mcMethod).toBe('maxc');
  });

  it('窗口参数不为正逐字段指出', () => {
    const r = validateExperimentCreate(body({ windowEvents: 0, step: -1, baselineDurationUs: 0 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field)).toEqual([
      'settings.windowEvents',
      'settings.step',
      'settings.baselineDurationUs'
    ]);
  });

  it('持续窗口数小于 1 指出', () => {
    const r = validateExperimentCreate(body({ persistWindows: 0 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.field).toBe('settings.persistWindows');
  });

  it('maxDelayUs 允许 0（只接受不早于最大值的事件）', () => {
    const r = validateExperimentCreate(body({ maxDelayUs: 0 }));
    expect(r.ok).toBe(true);
  });

  it('预警倍数必须为正', () => {
    const r = validateExperimentCreate(body({ alertSigmaMultiple: 0 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.field).toBe('settings.alertSigmaMultiple');
  });

  it('step 大于 windowEvents 报错', () => {
    const r = validateExperimentCreate(body({ windowEvents: 100, step: 200 }));
    expect(r.ok).toBe(false);
  });
});
