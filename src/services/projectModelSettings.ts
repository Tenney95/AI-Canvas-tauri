/** 新模型有效设置的纯解析；旧集固定快照不继承父级，clear明确回到应用兜底。 */
import type { ProjectModelKind, ProjectSettings } from '../types';
import type { EpisodeSettingsPolicy, ProjectSettingOverride, ProjectSettingsPatch } from '../types/project';
import {
  PROJECT_IMAGE_ASPECT_RATIOS, PROJECT_IMAGE_SIZES, PROJECT_VIDEO_ASPECT_RATIOS, PROJECT_VIDEO_RESOLUTIONS,
} from './projectSettingsService';

const kinds: readonly ProjectModelKind[] = ['text', 'image', 'video', 'audio'];
const visualKeys = ['styleId', 'styleName', 'prompt', 'locked', 'styleReference'] as const;
const generationKeys = ['imageAspectRatio', 'imageSize', 'videoAspectRatio', 'videoResolution', 'videoDuration'] as const;
const patchKeys = ['visualStyle', 'defaultModels', 'promptSuffixes', 'generation', 'visionModelId', 'modelAutoRouting'];
const fail = (): never => { throw new Error('本集设置策略无效，未应用继承或覆盖'); };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  return value as Record<string, unknown>;
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).some((key) => !keys.includes(key))) fail();
  return record;
}

/** 用于持久化写边界；未知字段/op失败关闭，母图是一个完整引用而非逐属性拼接。 */
export function assertProjectModelSettingsPolicy(policy: EpisodeSettingsPolicy): void {
  const record = object(policy);
  if (record.mode === 'legacy-pinned') {
    fields(record, ['mode', 'snapshot']); object(record.snapshot); return;
  }
  if (record.mode !== 'inherit') fail();
  fields(record, ['mode', 'overrides']);
  const patch = fields(record.overrides, patchKeys);
  const check = (value: unknown, key: string, emptySuffix = false) => {
    if (value === undefined) return;
    const override = object(value);
    if (override.op === 'inherit' || override.op === 'clear') { fields(override, ['op']); return; }
    if (override.op !== 'set' || !Object.hasOwn(override, 'value')) fail();
    fields(override, ['op', 'value']);
    if (key === 'styleReference') {
      const reference = fields(override.value, ['imageUrl', 'filePath', 'fileName', 'enabled']);
      if (!reference.imageUrl && !reference.filePath) fail();
      for (const name of ['imageUrl', 'filePath', 'fileName']) {
        if (reference[name] !== undefined && typeof reference[name] !== 'string') fail();
      }
      if (reference.enabled !== undefined && typeof reference.enabled !== 'boolean') fail();
    } else if (key === 'locked' || key === 'modelAutoRouting') {
      if (typeof override.value !== 'boolean') fail();
    } else if (key === 'videoDuration') {
      if (!Number.isInteger(override.value) || (override.value as number) < 2 || (override.value as number) > 15) fail();
    } else if (typeof override.value !== 'string' || !emptySuffix && !override.value.trim()) fail();
    const choices: Partial<Record<string, readonly string[]>> = {
      imageAspectRatio: PROJECT_IMAGE_ASPECT_RATIOS, imageSize: PROJECT_IMAGE_SIZES,
      videoAspectRatio: PROJECT_VIDEO_ASPECT_RATIOS, videoResolution: PROJECT_VIDEO_RESOLUTIONS,
    };
    if (choices[key] && !choices[key]!.includes(override.value as string)) fail();
  };
  for (const [section, keys] of [['visualStyle', visualKeys], ['generation', generationKeys],
    ['defaultModels', kinds], ['promptSuffixes', kinds]] as const) {
    if (patch[section] === undefined) continue;
    for (const [key, value] of Object.entries(fields(patch[section], keys))) check(value, key, section === 'promptSuffixes');
  }
  check(patch.visionModelId, 'visionModelId'); check(patch.modelAutoRouting, 'modelAutoRouting');
}

/** 完整项目默认值也走同一字段/枚举校验，不能set成功后在旧解析器中被静默丢弃。 */
export function assertProjectModelProjectSettings(settings: ProjectSettings): void {
  const source = fields(settings, [...patchKeys, 'promptSuffix']);
  if (source.promptSuffix !== undefined && typeof source.promptSuffix !== 'string') fail();
  const overrides: Record<string, unknown> = {};
  for (const [section, keys] of [['visualStyle', visualKeys], ['generation', generationKeys],
    ['defaultModels', kinds], ['promptSuffixes', kinds]] as const) {
    if (source[section] === undefined) continue;
    overrides[section] = Object.fromEntries(Object.entries(fields(source[section], keys))
      .filter(([, value]) => value !== undefined).map(([key, value]) => [key, { op: 'set', value }]));
  }
  for (const field of ['visionModelId', 'modelAutoRouting']) {
    if (source[field] !== undefined) overrides[field] = { op: 'set', value: source[field] };
  }
  assertProjectModelSettingsPolicy({ mode: 'inherit', overrides } as EpisodeSettingsPolicy);
}

function choose<T>(project: T | undefined, application: T | undefined, override?: ProjectSettingOverride<T>): T | undefined {
  if (override?.op === 'clear') return application === undefined ? undefined : structuredClone(application);
  if (override?.op === 'set') return structuredClone(override.value);
  const value = project === undefined ? application : project;
  return value === undefined ? undefined : structuredClone(value);
}
function suffix(settings: ProjectSettings, kind: ProjectModelKind): string | undefined {
  return settings.promptSuffixes === undefined ? settings.promptSuffix : settings.promptSuffixes[kind];
}

/** 输出可直接交给既有节点/生成默认值解析器；不会重写policy或丢失clear tombstone。 */
export function resolveProjectModelSettings(project: ProjectSettings | undefined,
  policy?: EpisodeSettingsPolicy, application: ProjectSettings = {}): ProjectSettings {
  if (policy) assertProjectModelSettingsPolicy(policy);
  const base = policy?.mode === 'legacy-pinned' ? policy.snapshot : project ?? {};
  const patch: ProjectSettingsPatch = policy?.mode === 'inherit' ? policy.overrides : {};
  const visualStyle: NonNullable<ProjectSettings['visualStyle']> = {};
  for (const key of visualKeys) {
    const value = choose(base.visualStyle?.[key], application.visualStyle?.[key],
      patch.visualStyle?.[key] as ProjectSettingOverride<NonNullable<ProjectSettings['visualStyle']>[typeof key]> | undefined);
    if (value !== undefined) Object.assign(visualStyle, { [key]: value });
  }
  const generation: NonNullable<ProjectSettings['generation']> = {};
  for (const key of generationKeys) {
    const value = choose(base.generation?.[key], application.generation?.[key],
      patch.generation?.[key] as ProjectSettingOverride<NonNullable<ProjectSettings['generation']>[typeof key]> | undefined);
    if (value !== undefined) Object.assign(generation, { [key]: value });
  }
  const defaultModels: NonNullable<ProjectSettings['defaultModels']> = {};
  const promptSuffixes: NonNullable<ProjectSettings['promptSuffixes']> = {};
  for (const kind of kinds) {
    const model = choose(base.defaultModels?.[kind], application.defaultModels?.[kind], patch.defaultModels?.[kind]);
    const prompt = choose(suffix(base, kind), suffix(application, kind), patch.promptSuffixes?.[kind]);
    if (model !== undefined) defaultModels[kind] = model;
    if (prompt !== undefined) promptSuffixes[kind] = prompt;
  }
  const visionModelId = choose(base.visionModelId, application.visionModelId, patch.visionModelId);
  const modelAutoRouting = choose(base.modelAutoRouting, application.modelAutoRouting, patch.modelAutoRouting);
  return {
    ...(Object.keys(visualStyle).length ? { visualStyle } : {}),
    ...(Object.keys(generation).length ? { generation } : {}),
    ...(Object.keys(defaultModels).length ? { defaultModels } : {}),
    // 使用类型化后缀，避免clear后又通过旧promptSuffix回退到父值。
    ...(Object.keys(promptSuffixes).length ? { promptSuffixes } : {}),
    ...(visionModelId !== undefined ? { visionModelId } : {}),
    ...(modelAutoRouting !== undefined ? { modelAutoRouting } : {}),
  };
}
