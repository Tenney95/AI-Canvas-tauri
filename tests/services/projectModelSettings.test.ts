/** P3 设置继承回归源；本轮未运行。 */
import { expect, it } from 'vitest';
import type { EpisodeSettingsPolicy } from '../../src/types/project';
import { assertProjectModelProjectSettings, assertProjectModelSettingsPolicy, resolveProjectModelSettings } from '../../src/services/projectModelSettings';

it('旧集缺设置继续用应用，不因父剧集更改而继承；显式false保持', () => {
  const application = { defaultModels: { image: 'app/image' }, modelAutoRouting: true };
  const project = { defaultModels: { image: 'parent/image' }, modelAutoRouting: true };
  expect(resolveProjectModelSettings(project, { mode: 'legacy-pinned', snapshot: { modelAutoRouting: false } }, application))
    .toEqual({ defaultModels: { image: 'app/image' }, modelAutoRouting: false });
});

it('inherit/set/clear逐域生效，clear母图与旧后缀不偷偷回退父值，也不改源', () => {
  const project = { defaultModels: { image: 'parent/image', text: 'parent/text' }, promptSuffix: '父旧后缀',
    visualStyle: { styleId: 'anime', styleReference: { imageUrl: 'asset:parent', fileName: 'parent.png', enabled: true } } };
  const before = structuredClone(project);
  const policy: EpisodeSettingsPolicy = { mode: 'inherit', overrides: {
    defaultModels: { image: { op: 'clear' }, text: { op: 'set', value: 'episode/text' } },
    promptSuffixes: { image: { op: 'clear' } }, visualStyle: { styleReference: { op: 'clear' } },
  } };
  expect(resolveProjectModelSettings(project, policy, { defaultModels: { image: 'app/image' } }))
    .toEqual({ defaultModels: { image: 'app/image', text: 'episode/text' }, visualStyle: { styleId: 'anime' },
      promptSuffixes: { text: '父旧后缀', video: '父旧后缀', audio: '父旧后缀' } });
  expect(project).toEqual(before); expect(policy.overrides.visualStyle?.styleReference).toEqual({ op: 'clear' });
});

it('母图set整组替换，不拼入父母图路径或启用状态；有效视图不共享对象', () => {
  const project = { visualStyle: { styleReference: { imageUrl: 'asset:parent', filePath: 'parent.png', enabled: false } } };
  const policy: EpisodeSettingsPolicy = { mode: 'inherit', overrides: { visualStyle: {
    styleReference: { op: 'set', value: { imageUrl: 'asset:episode' } },
  } } };
  const result = resolveProjectModelSettings(project, policy);
  expect(result.visualStyle?.styleReference).toEqual({ imageUrl: 'asset:episode' });
  result.visualStyle!.styleReference!.enabled = true;
  expect(policy.overrides.visualStyle?.styleReference).toEqual({ op: 'set', value: { imageUrl: 'asset:episode' } });
});

it('未知字段/非法op及带value的clear拒绝，不降成inherit', () => {
  for (const overrides of [{ unknown: {} }, { defaultModels: { image: { op: 'future' } } },
    { visionModelId: { op: 'clear', value: 'hidden' } }, { generation: { videoResolution: { op: 'set', value: 'future' } } }]) {
    expect(() => assertProjectModelSettingsPolicy({ mode: 'inherit', overrides } as unknown as EpisodeSettingsPolicy)).toThrow();
  }
});

it('显式空后缀与clear回应用不同，不在继承时丢掉空值', () => {
  const project = { promptSuffix: '父后缀' }, application = { promptSuffix: '应用后缀' };
  const resolved = resolveProjectModelSettings(project, { mode: 'inherit', overrides: {
    promptSuffixes: { image: { op: 'set', value: '' }, video: { op: 'clear' } },
  } }, application);
  expect(resolved.promptSuffixes).toMatchObject({ image: '', video: '应用后缀' });
});

it('完整项目默认设置同样拒绝错误类型和未知枚举', () => {
  expect(() => assertProjectModelProjectSettings({ defaultModels: { image: 123 } } as unknown as import('../../src/types').ProjectSettings)).toThrow();
  expect(() => assertProjectModelProjectSettings({ generation: { videoResolution: 'future' } } as unknown as import('../../src/types').ProjectSettings)).toThrow();
  expect(() => assertProjectModelProjectSettings({ modelAutoRouting: false, promptSuffixes: { image: '' } })).not.toThrow();
});
