/** v2摘要的输入/产物边界；只构造内存样本。 */
import { expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { AppConfig, BaseNodeData } from '../../src/types';
import { nativeMediaInputMaterial } from '../../src/services/nativeMediaInput';

const fixture = () => ({ projects: [{ id: 'canvas', name: 'fixture', createdAt: 1, updatedAt: 1 }],
  currentProjectId: 'canvas', customStyles: [], config: { generalModels: [{ id: 'model', name: 'fixture', modelId: 'request-model',
    category: 'audio', providerConfigId: 'provider' }] } as AppConfig });
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
