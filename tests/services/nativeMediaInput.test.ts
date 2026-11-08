/** v2摘要的输入/产物边界；只构造内存样本。 */
import { expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { AppConfig, BaseNodeData } from '../../src/types';
import { nativeMediaInputMaterial } from '../../src/services/nativeMediaInput';

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
