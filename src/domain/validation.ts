import type { EventInput, ExperimentSettings, McMethod } from './types.js';

export interface FieldError {
  field: string;
  message: string;
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v);

const MC_METHODS: readonly McMethod[] = ['MAXC', 'GFT'];

export interface ExperimentInput {
  experimentId?: unknown;
  startedAtUs?: unknown;
  sample?: unknown;
  settings?: unknown;
}

/**
 * 校验并归一化试验创建请求。
 * 非法时抛出带 FieldError 列表的错误，每个错误指向具体字段。
 */
export function validateExperiment(input: ExperimentInput): {
  id: string;
  startedAtUs: number;
  sample: Record<string, unknown>;
  settings: ExperimentSettings;
} {
  const errors: FieldError[] = [];

  const id = input.experimentId;
  if (typeof id !== 'string' || id.trim() === '') {
    errors.push({ field: 'experimentId', message: '试验编号必须为非空字符串' });
  }

  if (!isInt(input.startedAtUs) || (input.startedAtUs as number) < 0) {
    errors.push({ field: 'startedAtUs', message: '开始时间必须为非负整数微秒时间戳' });
  }

  let sample: Record<string, unknown> = {};
  if (input.sample !== undefined) {
    if (typeof input.sample !== 'object' || input.sample === null || Array.isArray(input.sample)) {
      errors.push({ field: 'sample', message: '样品信息必须为对象' });
    } else {
      sample = input.sample as Record<string, unknown>;
    }
  }

  const s = (input.settings ?? {}) as Record<string, unknown>;
  if (typeof input.settings !== 'object' || input.settings === null) {
    errors.push({ field: 'settings', message: '分析设置必须为对象' });
  }

  const num = (key: keyof ExperimentSettings): unknown => s[key];
  const requirePositiveInt = (key: keyof ExperimentSettings, label: string): number | null => {
    const v = num(key);
    if (!isInt(v) || (v as number) <= 0) {
      errors.push({ field: `settings.${key}`, message: `${label}必须为正整数` });
      return null;
    }
    return v as number;
  };

  const windowEvents = requirePositiveInt('windowEvents', '窗口事件数');
  const stepEvents = requirePositiveInt('stepEvents', '步长');
  const allowedDelayUs = requirePositiveInt('allowedDelayUs', '允许延迟');
  const minEventsForB = requirePositiveInt('minEventsForB', '最小有效事件数');

  const alertMultiplier = num('alertMultiplier');
  if (!isFiniteNumber(alertMultiplier) || (alertMultiplier as number) <= 0) {
    errors.push({ field: 'settings.alertMultiplier', message: '预警倍数必须为正数' });
  }

  const persistenceWindows = num('persistenceWindows');
  if (!isInt(persistenceWindows) || (persistenceWindows as number) < 1) {
    errors.push({ field: 'settings.persistenceWindows', message: '持续窗口数必须为不小于 1 的整数' });
  }

  let baselineStartUs = 0;
  const bStart = num('baselineStartUs');
  if (bStart === undefined) {
    baselineStartUs = 0;
  } else if (!isInt(bStart) || (bStart as number) < 0) {
    errors.push({ field: 'settings.baselineStartUs', message: '基线起点必须为非负整数微秒' });
  } else {
    baselineStartUs = bStart as number;
  }

  let baselineEndUs: number | null = null;
  const bEnd = num('baselineEndUs');
  if (!isInt(bEnd) || (bEnd as number) <= 0) {
    errors.push({ field: 'settings.baselineEndUs', message: '基线终点必须为正整数微秒' });
  } else {
    baselineEndUs = bEnd as number;
  }
  if (
    baselineEndUs !== null &&
    isInt(bStart) &&
    (baselineEndUs as number) <= baselineStartUs
  ) {
    errors.push({ field: 'settings.baselineEndUs', message: '基线终点必须晚于基线起点' });
  }

  let mcMethod: McMethod = 'MAXC';
  if (num('mcMethod') !== undefined) {
    if (typeof num('mcMethod') !== 'string' || !MC_METHODS.includes(num('mcMethod') as McMethod)) {
      errors.push({ field: 'settings.mcMethod', message: `完整性震级方法须为 ${MC_METHODS.join(' 或 ')}` });
    } else {
      mcMethod = num('mcMethod') as McMethod;
    }
  }

  let amplitudeMinDb = 0;
  let amplitudeMaxDb = 120;
  const aMin = num('amplitudeMinDb');
  if (aMin === undefined) {
    amplitudeMinDb = 0;
  } else if (!isInt(aMin)) {
    errors.push({ field: 'settings.amplitudeMinDb', message: '幅度量程下限必须为整数 dB' });
  } else {
    amplitudeMinDb = aMin as number;
  }
  const aMax = num('amplitudeMaxDb');
  if (aMax === undefined) {
    amplitudeMaxDb = 120;
  } else if (!isInt(aMax)) {
    errors.push({ field: 'settings.amplitudeMaxDb', message: '幅度量程上限必须为整数 dB' });
  } else {
    amplitudeMaxDb = aMax as number;
  }
  if (
    isInt(aMin) && isInt(aMax) &&
    (amplitudeMinDb as number) >= (amplitudeMaxDb as number)
  ) {
    errors.push({ field: 'settings.amplitudeMaxDb', message: '幅度量程上限必须大于下限' });
  }

  if (windowEvents !== null && minEventsForB !== null && minEventsForB > windowEvents) {
    errors.push({
      field: 'settings.minEventsForB',
      message: '最小有效事件数不能大于窗口事件数',
    });
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  return {
    id: id as string,
    startedAtUs: input.startedAtUs as number,
    sample,
    settings: {
      windowEvents: windowEvents as number,
      stepEvents: stepEvents as number,
      allowedDelayUs: allowedDelayUs as number,
      baselineStartUs,
      baselineEndUs: baselineEndUs as number,
      alertMultiplier: alertMultiplier as number,
      persistenceWindows: persistenceWindows as number,
      minEventsForB: minEventsForB as number,
      mcMethod,
      amplitudeMinDb,
      amplitudeMaxDb,
    },
  };
}

export class ValidationError extends Error {
  constructor(readonly fieldErrors: FieldError[]) {
    super('参数校验失败');
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * 校验单条撞击事件。时间戳早于试验开始、幅度非有限/超出量程、
 * 通道非法等，分别指向对应字段。
 */
export function validateEvent(
  raw: unknown,
  startedAtUs: number,
  amplitudeMinDb: number,
  amplitudeMaxDb: number,
  pathPrefix: string,
): { errors: FieldError[]; event: EventInput | null } {
  const errors: FieldError[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: [{ field: pathPrefix, message: '事件必须为对象' }], event: null };
  }
  const e = raw as Record<string, unknown>;

  if (typeof e.eventId !== 'string' || e.eventId.trim() === '') {
    errors.push({ field: `${pathPrefix}.eventId`, message: '事件编号必须为非空字符串' });
  }
  if (!isInt(e.timestampUs)) {
    errors.push({ field: `${pathPrefix}.timestampUs`, message: '时间戳必须为整数微秒' });
  } else if ((e.timestampUs as number) < startedAtUs) {
    errors.push({
      field: `${pathPrefix}.timestampUs`,
      message: `时间戳早于试验开始时间 ${startedAtUs}`,
    });
  }
  if (!isFiniteNumber(e.amplitudeDb)) {
    errors.push({
      field: `${pathPrefix}.amplitudeDb`,
      message: '幅度不是有限数（NaN/Infinity 均不接受）',
    });
  } else if ((e.amplitudeDb as number) < amplitudeMinDb || (e.amplitudeDb as number) > amplitudeMaxDb) {
    errors.push({
      field: `${pathPrefix}.amplitudeDb`,
      message: `幅度 ${e.amplitudeDb} dB 超出量程 [${amplitudeMinDb}, ${amplitudeMaxDb}]`,
    });
  }
  if (!isInt(e.channel) || (e.channel as number) < 0) {
    errors.push({ field: `${pathPrefix}.channel`, message: '通道号必须为非负整数' });
  }

  if (errors.length > 0) {
    return { errors, event: null };
  }
  return {
    errors,
    event: {
      eventId: e.eventId as string,
      timestampUs: e.timestampUs as number,
      amplitudeDb: e.amplitudeDb as number,
      channel: e.channel as number,
    },
  };
}
