import type { AnalysisSettings, IncomingEvent } from './types.js';
import {
  DEFAULT_AMPLITUDE_MAX_DB,
  DEFAULT_AMPLITUDE_MIN_DB,
  DEFAULT_MC_METHOD,
  DEFAULT_MIN_EFFECTIVE_EVENTS
} from './types.js';

export interface FieldError {
  field: string;
  reason: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldError[] };

function fail(errors: FieldError[]): ValidationResult<never> {
  return { ok: false, errors };
}

const INT32_MAX = 2_147_483_647;

/** 安全整数（微秒时间戳允许很大，放宽到 Number.MAX_SAFE_INTEGER） */
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 校验采集端事件。experimentStartedAtUs / 量程来自试验配置，由调用方传入。
 * 返回经过规范化的事件（时间戳、通道为整数）或逐字段错误。
 */
export function validateIncomingEvent(
  raw: unknown,
  experimentStartedAtUs: number,
  ampMin: number,
  ampMax: number
): ValidationResult<IncomingEvent> {
  const errors: FieldError[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return fail([{ field: '(body)', reason: 'not_object', message: '事件必须是对象' }]);
  }
  const obj = raw as Record<string, unknown>;

  // eventId
  let eventId: string | null = null;
  if (typeof obj.eventId !== 'string' || obj.eventId.length === 0) {
    errors.push({ field: 'eventId', reason: 'invalid', message: 'eventId 必须是非空字符串' });
  } else {
    eventId = obj.eventId;
  }

  // timestampUs
  let timestampUs = 0;
  if (!isInt(obj.timestampUs)) {
    errors.push({
      field: 'timestampUs',
      reason: 'invalid',
      message: 'timestampUs 必须是安全整数（微秒）'
    });
  } else if (obj.timestampUs < experimentStartedAtUs) {
    errors.push({
      field: 'timestampUs',
      reason: 'before_start',
      message: `timestampUs(${obj.timestampUs}) 早于试验开始时间(${experimentStartedAtUs})`
    });
  } else {
    timestampUs = obj.timestampUs;
  }

  // amplitudeDb
  let amplitudeDb = 0;
  if (!isFiniteNumber(obj.amplitudeDb)) {
    errors.push({
      field: 'amplitudeDb',
      reason: 'not_finite',
      message: `amplitudeDb 必须是有限数，收到 ${String(obj.amplitudeDb)}`
    });
  } else if (obj.amplitudeDb < ampMin || obj.amplitudeDb > ampMax) {
    errors.push({
      field: 'amplitudeDb',
      reason: 'out_of_range',
      message: `amplitudeDb(${obj.amplitudeDb}) 超出量程 [${ampMin}, ${ampMax}] dB`
    });
  } else {
    amplitudeDb = obj.amplitudeDb;
  }

  // channel
  let channel = 0;
  if (!isInt(obj.channel) || (obj.channel as number) < 0) {
    errors.push({ field: 'channel', reason: 'invalid', message: 'channel 必须是非负整数' });
  } else {
    channel = obj.channel;
  }

  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { eventId: eventId as string, timestampUs, amplitudeDb, channel } };
}

export interface ExperimentCreateInput {
  experimentId: string;
  startedAtUs: number;
  sample: Record<string, unknown>;
  settings: Partial<AnalysisSettings> & {
    windowEvents: number;
    step: number;
    maxDelayUs: number;
    baselineDurationUs: number;
    alertSigmaMultiple: number;
    persistWindows: number;
  };
}

/** 校验建试验请求并补全可选设置。 */
export function validateExperimentCreate(raw: unknown): ValidationResult<{
  experimentId: string;
  startedAtUs: number;
  sample: Record<string, unknown>;
  settings: AnalysisSettings;
}> {
  const errors: FieldError[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return fail([{ field: '(body)', reason: 'not_object', message: '请求体必须是对象' }]);
  }
  const obj = raw as Record<string, unknown>;

  let experimentId: string;
  if (typeof obj.experimentId !== 'string' || obj.experimentId.length === 0) {
    errors.push({ field: 'experimentId', reason: 'invalid', message: 'experimentId 必须是非空字符串' });
    experimentId = '';
  } else {
    experimentId = obj.experimentId;
  }

  let startedAtUs = 0;
  if (!isInt(obj.startedAtUs) || (obj.startedAtUs as number) <= 0) {
    errors.push({ field: 'startedAtUs', reason: 'invalid', message: 'startedAtUs 必须是正整数（微秒）' });
  } else {
    startedAtUs = obj.startedAtUs as number;
  }

  const sample: Record<string, unknown> =
    typeof obj.sample === 'object' && obj.sample !== null && !Array.isArray(obj.sample)
      ? (obj.sample as Record<string, unknown>)
      : {};

  const s = (obj.settings ?? {}) as Record<string, unknown>;

  const positiveInt = (key: string): number => {
    const v = s[key];
    if (!isInt(v) || (v as number) <= 0) {
      errors.push({ field: `settings.${key}`, reason: 'invalid', message: `settings.${key} 必须是正整数` });
      return 0;
    }
    return v;
  };
  const nonNegativeInt = (key: string): number => {
    const v = s[key];
    if (!isInt(v) || (v as number) < 0) {
      errors.push({ field: `settings.${key}`, reason: 'invalid', message: `settings.${key} 必须是非负整数` });
      return 0;
    }
    return v;
  };
  const positiveNumber = (key: string): number => {
    const v = s[key];
    if (!isFiniteNumber(v) || (v as number) <= 0) {
      errors.push({ field: `settings.${key}`, reason: 'invalid', message: `settings.${key} 必须是正数` });
      return 0;
    }
    return v;
  };

  const windowEvents = positiveInt('windowEvents');
  const step = positiveInt('step');
  const maxDelayUs = nonNegativeInt('maxDelayUs');
  const baselineDurationUs = positiveInt('baselineDurationUs');
  const alertSigmaMultiple = positiveNumber('alertSigmaMultiple');
  const persistWindows = positiveInt('persistWindows');

  let minEffectiveEvents = DEFAULT_MIN_EFFECTIVE_EVENTS;
  if (s.minEffectiveEvents !== undefined) {
    minEffectiveEvents = positiveInt('minEffectiveEvents');
  }
  let amplitudeMinDb = DEFAULT_AMPLITUDE_MIN_DB;
  if (s.amplitudeMinDb !== undefined) {
    if (!isFiniteNumber(s.amplitudeMinDb)) {
      errors.push({ field: 'settings.amplitudeMinDb', reason: 'invalid', message: 'settings.amplitudeMinDb 必须是有限数' });
    } else {
      amplitudeMinDb = s.amplitudeMinDb as number;
    }
  }
  let amplitudeMaxDb = DEFAULT_AMPLITUDE_MAX_DB;
  if (s.amplitudeMaxDb !== undefined) {
    if (!isFiniteNumber(s.amplitudeMaxDb)) {
      errors.push({ field: 'settings.amplitudeMaxDb', reason: 'invalid', message: 'settings.amplitudeMaxDb 必须是有限数' });
    } else {
      amplitudeMaxDb = s.amplitudeMaxDb as number;
    }
  }
  if (isFiniteNumber(amplitudeMinDb) && isFiniteNumber(amplitudeMaxDb) && amplitudeMinDb > amplitudeMaxDb) {
    errors.push({
      field: 'settings.amplitudeMinDb',
      reason: 'invalid_range',
      message: 'amplitudeMinDb 不能大于 amplitudeMaxDb'
    });
  }

  let mcMethod: AnalysisSettings['mcMethod'] = DEFAULT_MC_METHOD;
  if (s.mcMethod !== undefined) {
    if (s.mcMethod !== 'maxc') {
      errors.push({ field: 'settings.mcMethod', reason: 'unsupported', message: `不支持的完整性震级方法: ${String(s.mcMethod)}，当前仅支持 maxc` });
    } else {
      mcMethod = 'maxc';
    }
  }

  if (isInt(windowEvents) && windowEvents > 0 && isInt(minEffectiveEvents) && minEffectiveEvents > windowEvents) {
    errors.push({
      field: 'settings.minEffectiveEvents',
      reason: 'invalid',
      message: 'minEffectiveEvents 不能大于 windowEvents（否则永远样本不足）'
    });
  }
  if (isInt(windowEvents) && isInt(step) && step > windowEvents) {
    errors.push({
      field: 'settings.step',
      reason: 'invalid',
      message: 'step 不能大于 windowEvents（窗口不能不重叠地跳过事件）'
    });
  }
  if (isInt(maxDelayUs) && maxDelayUs > INT32_MAX * 1e6) {
    errors.push({ field: 'settings.maxDelayUs', reason: 'invalid', message: 'settings.maxDelayUs 超出合理范围' });
  }

  if (errors.length > 0) return fail(errors);

  return {
    ok: true,
    value: {
      experimentId,
      startedAtUs,
      sample,
      settings: {
        windowEvents,
        step,
        maxDelayUs,
        baselineDurationUs,
        alertSigmaMultiple,
        persistWindows,
        minEffectiveEvents,
        amplitudeMinDb,
        amplitudeMaxDb,
        mcMethod
      }
    }
  };
}
