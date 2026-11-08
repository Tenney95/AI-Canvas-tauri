/**
 * comfyMediaRouting — 回归测试：ComfyUI 图片和音频输出入口的三类参考。
 */
import type { Node } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';
import { generateImage } from '../../src/services/ai/generateImage';
import { generateAudio } from '../../src/services/ai/generateAudio';
import { resolveNodeReferences } from '../../src/services/nodeReferenceService';
import { resolvePromptToChatContent } from '../../src/services/ai/promptResolver';

const mocks = vi.hoisted(() => ({ image: vi.fn(), audio: vi.fn() }));
vi.mock('../../src/services/comfyWorkflowService', () => ({ executeComfyUIGenerate: mocks.image, executeComfyUIAudioGenerate: mocks.audio }));

const urls = { i1: 'data:image/png;base64,aTE=', i2: 'data:image/png;base64,aTI=', v: 'data:video/mp4;base64,dg==', a: 'data:audio/wav;base64,YQ==' };
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  vi.clearAllMocks();
  mocks.image.mockResolvedValue({ url: 'out.png', width: 512, height: 512 });
  mocks.audio.mockResolvedValue({ url: 'out.wav' });
  const nodes = Object.entries(urls).map(([id, url]) => ({ id, position: { x: 0, y: 0 },
    type: id.startsWith('i') ? 'source-image' : id === 'v' ? 'ai-video' : 'ai-audio',
    data: { label: id, type: id.startsWith('i') ? 'source-image' : id === 'v' ? 'ai-video' : 'ai-audio',
      ...(id.startsWith('i') ? { imageUrl: url } : id === 'v' ? { videoUrl: url } : { audioUrl: url }) },
  })) as Node<BaseNodeData>[];
  useAppStore.setState({ nodes, edges: [{ id: 'edge', source: 'i1', target: 'out' }], workflows: [{ id: 'wf', name: '任意Comfy', category: 'ai-image', fileName: 'wf.json', fileContent: '{}', createdAt: 1 }] });
});

describe('ComfyUI 图片和音频输出入口的三类参考', () => {
  it('视频专用 RefMod 标记不会被图片、音频或文本入口透传', async () => {
    const prompt = '参考 @refmod{invalid-payload}';
    await expect(generateImage({ prompt, provider: 'comfyui', model: 'wf', workflowId: 'wf' })).rejects.toThrow('ComfyUI');
    await expect(generateAudio({ prompt, provider: 'comfyui', model: 'wf', workflowId: 'wf' })).rejects.toThrow('ComfyUI');
    await expect(resolvePromptToChatContent(prompt)).rejects.toThrow('ComfyUI');
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.audio).not.toHaveBeenCalled();
  });

  it('普通文本节点输出中的 RefMod 标记不能绕过工作流文本保护', () => {
    useAppStore.setState({ nodes: [{ id: 'text', type: 'ai-text', position: { x: 0, y: 0 }, data: { type: 'ai-text', label: '文本', output: '@refmod{invalid-payload}' } }] });
    expect(() => resolveNodeReferences('@{text:文本}')).toThrow('ComfyUI');
  });

  it('图片入口按提示词顺序传图并去重连线，同时传视频和音频', async () => {
    await generateImage({ prompt: '@{i2:二} @{v:视频} @{i1:一} @{a:音频}', provider: 'comfyui', model: 'wf', workflowId: 'wf', nodeId: 'out', image_urls: [urls.i1] });
    expect(mocks.image).toHaveBeenCalledWith(expect.anything(), undefined, [urls.i2, urls.i1], { videoUrls: [urls.v], audioUrls: [urls.a] }, undefined);
    expect(mocks.image.mock.calls[0][0].prompt).toContain('图片1');
  });

  it('音频入口也能引用图片、视频和音频，按同类顺序去重', async () => {
    await generateAudio({ prompt: '@{i2:二} @{a:音频} @{i1:一} @{v:视频} 台词', provider: 'comfyui', model: 'wf', workflowId: 'wf', nodeId: 'out' });
    expect(mocks.audio).toHaveBeenCalledWith(expect.anything(), undefined, [urls.a], { imageUrls: [urls.i2, urls.i1], videoUrls: [urls.v] }, undefined);
  });

  it('Comfy图片入口将项目风格母图排在直接引用后且标注正确序号', async () => {
    useAppStore.setState({ currentProjectId: 'p', projects: [{ id: 'p', name: 'test', createdAt: 1, updatedAt: 1,
      settings: { visualStyle: { styleReference: { imageUrl: urls.i1, enabled: true } } },
    }] });
    await generateImage({ prompt: '@{i2:主角}', provider: 'comfyui', model: 'wf', workflowId: 'wf' });
    expect(mocks.image.mock.calls[0][2]).toEqual([urls.i2, urls.i1]);
    expect(mocks.image.mock.calls[0][0].prompt).toContain('图片2 只用于风格');
  });
});
