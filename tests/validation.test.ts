import { describe, expect, it } from 'vitest';
import { validateExperiment, validateEvent, ValidationError } from '../src/domain/validation.js';

const goodInput = () => ({
  experimentId: 'EXP-1',
  startedAtUs: 1_000_000,
  sample: { name: '花岗岩' },
  settings: {
    windowEvents: 200,
    stepEvents: 50,
    allowedDelayUs: 5_000_000,
    baselineStartUs: 0,
    baselineEndUs: 60_000_000,
    alertMultiplier: 2,
    persistenceWindows: 3,
    minEventsForB: 50,
  },
});

describe('试验设置校验', () => {
  it('合法设置通过并填入默认 Mc 方法与量程', () => {
    const r = validateExperiment(goodInput());
    expect(r.settings.mcMethod).toBe('MAXC');
    expect(r.settings.amplitudeMinDb).toBe(0);
    expect(r.settings.amplitudeMaxDb).toBe(120);
  });

  it('窗口事件数、步长、允许延迟不为正：逐个字段指出', () => {
    const input = goodInput();
    input.settings.windowEvents = 0;
    input.settings.stepEvents = -5;
    (input.settings as unknown as Record<string, unknown>).allowedDelayUs = 1.5;
    expect(() => validateExperiment(input)).toThrow(ValidationError);
    try {
      validateExperiment(input);
    } catch (e) {
      const fields = (e as ValidationError).fieldErrors.map((f) => f.field);
      expect(fields).toContain('settings.windowEvents');
      expect(fields).toContain('settings.stepEvents');
      expect(fields).toContain('settings.allowedDelayUs');
    }
  });

  it('持续窗口数小于 1 被拒', () => {
    const input = goodInput();
    input.settings.persistenceWindows = 0;
    try {
      validateExperiment(input);
      throw new Error('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).fieldErrors[0]!.field).toBe('settings.persistenceWindows');
    }
  });

  it('预警倍数必须为正数', () => {
    const input = goodInput();
    input.settings.alertMultiplier = 0;
    expect(() => validateExperiment(input)).toThrow(ValidationError);
  });

  it('基线终点必须晚于起点', () => {
    const input = goodInput();
    input.settings.baselineStartUs = 100;
    input.settings.baselineEndUs = 100;
    try {
      validateExperiment(input);
      throw new Error('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).fieldErrors.some((f) => f.field === 'settings.baselineEndUs')).toBe(true);
    }
  });

  it('最小有效事件数不能超过窗口事件数', () => {
    const input = goodInput();
    input.settings.minEventsForB = 201;
    expect(() => validateExperiment(input)).toThrow(ValidationError);
  });

  it('试验编号与开始时间非法', () => {
    const input = goodInput();
    input.experimentId = '  ';
    input.startedAtUs = -1;
    try {
      validateExperiment(input);
      throw new Error('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const fields = (e as ValidationError).fieldErrors.map((f) => f.field);
      expect(fields).toContain('experimentId');
      expect(fields).toContain('startedAtUs');
    }
  });
});

describe('单事件校验', () => {
  it('返回解析后的事件', () => {
    const { errors, event } = validateEvent(
      { eventId: 'a', timestampUs: 5, amplitudeDb: 42.5, channel: 3 },
      0, 0, 120, 'events[0]',
    );
    expect(errors).toEqual([]);
    expect(event!.eventId).toBe('a');
  });

  it('时间戳早于试验开始', () => {
    const { errors } = validateEvent(
      { eventId: 'a', timestampUs: 9, amplitudeDb: 50, channel: 1 },
      10, 0, 120, 'events[2]',
    );
    expect(errors[0]!.field).toBe('events[2].timestampUs');
  });

  it('幅度 NaN / Infinity / 越界', () => {
    for (const a of [NaN, Infinity, -Infinity, -1, 121]) {
      const { errors } = validateEvent(
        { eventId: 'a', timestampUs: 10, amplitudeDb: a, channel: 1 },
        0, 0, 120, 'e',
      );
      expect(errors.some((f) => f.field === 'e.amplitudeDb')).toBe(true);
    }
  });
});
