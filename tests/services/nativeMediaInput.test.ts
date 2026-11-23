/** 用内存样本核对媒体输入摘要及旧回执的兼容性。 */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { AppConfig, BaseNodeData } from '../../src/types';
import { emptyDramaAssetLibrary, type DramaProp } from '../../src/types/dramaAssets';
import { matchesNativeCanvasMediaInputFingerprint, nativeCanvasMediaInputMaterial, nativeMediaInputMaterial } from '../../src/services/nativeMediaInput';

const fixture = () => ({ projects: [{ id: 'canvas', name: 'fixture', createdAt: 1, updatedAt: 1 }],
  currentProjectId: 'canvas', customStyles: [], config: { theme: 'dark', providers: { provider: { name: 'fixture', apiKey: 'fixture-only-key', baseUrl: 'https://fixture.example' } }, generalModels: [{ id: 'model', name: 'fixture', modelId: 'request-model',
    category: 'audio', providerConfigId: 'provider' }] } satisfies AppConfig });
const node = (): Node<BaseNodeData> => ({ id: 'node', type: 'ai-audio', position: { x: 0, y: 0 },
  data: { type: 'ai-audio', label: 'fixture', model: 'general/model', provider: 'general', prompt: 'fixture',
    audioVoice: 'voice-a', audioSpeed: 1, musicLyrics: 'lyrics', status: 'idle' } });
it('音色/语速/歌词/模型能力进入v2输入，产物和运行状态不进入', () => {
  const state = fixture(), original = node(), baseline = nativeMediaInputMaterial(original, state);
  expect(nativeMediaInputMaterial({ ...original, data: { ...original.data, audioUrl: 'result.wav', output: 'result.wav', status: 'success' } }, state)).toBe(baseline);
  expect(nativeMediaInputMaterial({ ...original, data: { ...original.data, audioSpeed: 1.5 } }, state)).not.toBe(baseline);
  expect(nativeMediaInputMaterial({ ...original, data: { ...original.data, musicLyrics: 'changed' } }, state)).not.toBe(baseline);
  state.config.generalModels![0] = { ...state.config.generalModels![0], modelId: 'changed-model' };
  expect(nativeMediaInputMaterial(original, state)).not.toBe(baseline);
});
it('v3引用节点的产物和工作流变更撤销旧输入，v2仍使用原算法', () => {
  const target = node(), source: Node<BaseNodeData> = { id: 'source', type: 'source-audio', position: { x: 0, y: 0 },
    data: { type: 'source-audio', label: '原音频', audioUrl: 'asset://original.wav' } };
  const state = { ...fixture(), nodes: [target, source], edges: [{ id: 'edge', source: 'source', target: target.id }], workflows: [] };
  const old = nativeMediaInputMaterial(target, state), original = nativeMediaInputMaterial(target, state, 'media-input-v3');
  const changed = { ...state, nodes: [target, { ...source, data: { ...source.data, audioUrl: 'asset://changed.wav' } }] };
  expect(nativeMediaInputMaterial(target, changed)).toBe(old);
  expect(nativeMediaInputMaterial(target, changed, 'media-input-v3')).not.toBe(original);
  expect(nativeMediaInputMaterial({ ...target, data: { ...target.data, audioUrl: 'result.wav', status: 'success' } }, state, 'media-input-v3')).toBe(original);
  expect(nativeMediaInputMaterial(target, { ...state, edges: [] }, 'media-input-v3')).not.toBe(original);
});

it('画布 v3 摘要忽略首次查看和再次查看，仍能识别道具与提示词的修改', () => {
  const target = node();
  const prop: DramaProp = { kind: 'prop', id: 'watch', key: 'watch', name: '怀表', summary: '', visualNotes: '银色',
    source: 'manual', importance: 'supporting', confirmed: true, createdAt: 1, updatedAt: 1 };
  const dramaAssets = { ...emptyDramaAssetLibrary(), props: [prop] };
  const state = { ...fixture(), nodes: [target], edges: [], workflows: [], dramaAssets };
  const scheme = 'media-input-v3';
  const material = nativeCanvasMediaInputMaterial(target, state, scheme);
  for (const lastViewedAt of [0, 20]) {
    expect(nativeCanvasMediaInputMaterial(target, { ...state, dramaAssets: { ...dramaAssets, lastViewedAt } }, scheme)).toBe(material);
  }
  const editedLibrary = { ...dramaAssets, props: [{ ...prop, visualNotes: '金色' }] };
  expect(nativeCanvasMediaInputMaterial(target, { ...state, dramaAssets: editedLibrary }, scheme)).not.toBe(material);
  expect(nativeCanvasMediaInputMaterial({ ...target, data: { ...target.data, prompt: '修改后的输入' } }, state, scheme)).not.toBe(material);
  expect(nativeCanvasMediaInputMaterial(target, state, 'media-input-v2')).toBe(nativeMediaInputMaterial(target, state, 'media-input-v2'));
});

it('兼容可完整复核的旧 v3 指纹，历史浏览时间无法还原时拒绝回填', async () => {
  const target = node(), scheme = 'media-input-v3';
  const state = { ...fixture(), nodes: [target], edges: [], workflows: [], dramaAssets: { ...emptyDramaAssetLibrary(), lastViewedAt: 0 } };
  const viewed = { ...state, dramaAssets: { ...state.dramaAssets, lastViewedAt: 20 } };
  const original = nativeMediaInputMaterial(target, state, scheme);
  const stable = nativeCanvasMediaInputMaterial(target, viewed, scheme);
  expect(original).not.toBe(stable);
  const originalDigest = createHash('sha256').update(original).digest('hex');
  const stableDigest = createHash('sha256').update(stable).digest('hex');
  await expect(matchesNativeCanvasMediaInputFingerprint(target, state, scheme, stable, originalDigest)).resolves.toBe(true);
  await expect(matchesNativeCanvasMediaInputFingerprint(target, viewed, scheme, stable, stableDigest)).resolves.toBe(true);
  await expect(matchesNativeCanvasMediaInputFingerprint(target, viewed, scheme, stable, originalDigest)).resolves.toBe(false);
});

it.each(['media-input-v2', 'media-input-v3'] as const)('%s 将独立扩图垫图作为输入，结果回填不改变输入', (scheme) => {
  const state = fixture(), target: Node<BaseNodeData> = { ...node(), type: 'ai-image', data: {
    type: 'ai-image', label: '扩图结果', prompt: '补全背景', outpaintInput: {
      url: 'asset://localhost/project/padding.png', assetId: 'padding', relativePath: 'padding.png', width: 1024, height: 768,
    },
  } };
  const baseline = nativeMediaInputMaterial(target, state, scheme);
  expect(nativeMediaInputMaterial({ ...target, data: { ...target.data, imageUrl: 'result.png', output: 'result.png', status: 'success' } }, state, scheme)).toBe(baseline);
  expect(nativeMediaInputMaterial({ ...target, data: { ...target.data, outpaintInput: { ...target.data.outpaintInput!, url: 'new-padding.png' } } }, state, scheme)).not.toBe(baseline);
  expect(nativeMediaInputMaterial({ ...target, data: { ...target.data, outpaintInput: { ...target.data.outpaintInput!, width: 2048 } } }, state, scheme)).not.toBe(baseline);
  expect(nativeMediaInputMaterial({ ...target, data: { ...target.data, outpaintInput: undefined } }, state, scheme)).not.toBe(baseline);
});
