import type { Node } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import {
  annotateCharacterReferences,
  assertVideoReferenceLimits,
  buildGeneralVideoProtocolVariables,
  compileVideoReferencePrompt,
  generateVideo,
} from '../../../src/services/ai/generateVideo';
import { resolvePromptWithImageRefs, resolvePromptWithMediaRefs } from '../../../src/services/ai/promptResolver';
import { collectConnectedReferenceMedia, getMediaReferenceUrls, mergeMediaReferences } from '../../../src/services/ai/connectedReferenceMedia';
import { mediaProviderRegistry } from '../../../src/services/ai/mediaProviderRegistry';
import { useAppStore } from '../../../src/store/useAppStore';
import type { BaseNodeData } from '../../../src/types';
import { buildDramaVoiceMentionId, emptyDramaAssetLibrary, type DramaCharacter } from '../../../src/types/dramaAssets';
import * as apimartApi from '../../../src/services/ai/apimartGen';
import * as imageUtils from '../../../src/services/ai/imageUtils';
import * as uploadService from '../../../src/services/uploadService';
import * as fileService from '../../../src/services/fileService';
import { buildCharacterVideoReferences, resolveVideoParameterInputMode } from '../../../src/components/nodes/shared/VideoParamSelector';
import type { AIVideoGenParams, VideoGenerationReferenceInput, VideoReferenceItem } from '../../../src/types/aiTypes';
import { setupVideoFixture } from './videoFixture';

const comfyMocks = vi.hoisted(() => ({
  executeVideo: vi.fn(),
}));

vi.mock('../../../src/services/comfyWorkflowService', () => ({
  executeComfyUIVideoGenerate: comfyMocks.executeVideo,
}));

setupVideoFixture(comfyMocks.executeVideo);

describe('方舟参考素材优先使用本地副本', () => {
  const localUrl = (path: string) => `asset://localhost/${encodeURIComponent(path)}`;
  const mediaNode = (id: string, kind: 'image' | 'video' | 'audio'): Node<BaseNodeData> => ({
    id, type: `source-${kind}`, position: { x: 0, y: 0 }, data: {
      label: id, type: `source-${kind}`, filePath: `C:/fixture/${id}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'wav'}`,
      sourceUrl: `https://old-cdn.example/${id}`, [`${kind}Url`]: `https://old-cdn.example/${id}`,
    },
  });
  async function capture(params: Partial<AIVideoGenParams>) {
    let captured: VideoGenerationReferenceInput | undefined;
    const unregister = mediaProviderRegistry.register({ providerId: 'volcengine', capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput(); return { url: 'https://cdn.example/result.mp4' };
      },
    });
    try {
      await generateVideo({ provider: 'volcengine', model: 'volcengine/doubao-seedance-2-5-260628', prompt: '保留参考动作', ...params });
    } finally { unregister(); }
    expect(captured).toBeDefined();
    return captured!;
  }

  it('纯连线和显式参考有 filePath 时不沿用旧公共图床 URL', async () => {
    const sources = [mediaNode('image-local', 'image'), mediaNode('video-local', 'video'), mediaNode('audio-local', 'audio')];
    useAppStore.setState({ nodes: sources, edges: sources.map((node) => ({ id: `edge-${node.id}`, source: node.id, target: 'target' })) });
    const assets = vi.spyOn(fileService, 'getAssetUrlFromPath').mockImplementation(async (path) => localUrl(path));
    try {
      const input = await capture({ nodeId: 'target', referenceMedia: [{ kind: 'video', role: 'reference', origin: 'connection',
        url: 'https://old-cdn.example/video-local', sourceNodeId: 'video-local' }] });
      expect(input.imageUrls).toEqual([localUrl(sources[0].data.filePath!)]);
      expect(input.videoUrls).toEqual([localUrl(sources[1].data.filePath!)]);
      expect(input.audioUrls).toEqual([localUrl(sources[2].data.filePath!)]);
      expect(input.references).toHaveLength(3);
    } finally { assets.mockRestore(); }
  });

  it('@ 音视频本地化后同步绑定提示词片段，编号和去重保持一致', async () => {
    const video = mediaNode('video-mentioned', 'video'); const audio = mediaNode('audio-mentioned', 'audio');
    useAppStore.setState({ nodes: [video, audio], edges: [{ id: 'video-edge', source: video.id, target: 'target' }] });
    const assets = vi.spyOn(fileService, 'getAssetUrlFromPath').mockImplementation(async (path) => localUrl(path));
    try {
      const input = await capture({ nodeId: 'target', prompt: '参考 @{video-mentioned:视频} 并使用 @{audio-mentioned:声音}' });
      expect(input.videoUrls).toEqual([localUrl(video.data.filePath!)]);
      expect(input.audioUrls).toEqual([localUrl(audio.data.filePath!)]);
      expect(input.prompt).toContain('视频1'); expect(input.prompt).toContain('音频1');
      expect(input.references).toHaveLength(2);
    } finally { assets.mockRestore(); }
  });

  it('@ 图片沿用合成结果，显式裁剪的 data URL 不退回原 filePath', async () => {
    const image = mediaNode('image-overlay', 'image'); image.data.mattingMask = 'data:image/png;base64,bWFzaw==';
    useAppStore.setState({ nodes: [image], edges: [{ id: 'overlay-edge', source: image.id, target: 'target' }] });
    const assets = vi.spyOn(fileService, 'getAssetUrlFromPath').mockImplementation(async (path) => localUrl(path));
    const composited = 'data:image/png;base64,Y29tcG9zaXRlZA==';
    const overlay = vi.spyOn(imageUtils, 'mergeImageWithOverlays').mockResolvedValue(composited);
    try {
      const input = await capture({ nodeId: 'target', prompt: '参考 @{image-overlay:标注图}' });
      expect(input.imageUrls).toEqual([composited]);
      expect(overlay).toHaveBeenCalledWith(localUrl(image.data.filePath!), image.data.mattingMask, undefined);
      useAppStore.setState({ nodes: [], edges: [] }); assets.mockClear();
      const cropped = 'data:image/png;base64,Y3JvcHBlZA==';
      const explicit = await capture({ referenceMedia: [{ kind: 'image', role: 'reference', origin: 'connection', url: cropped,
        filePath: 'C:/fixture/original.png' }] });
      expect(explicit.imageUrls).toEqual([cropped]);
      expect(assets).not.toHaveBeenCalled();
    } finally { assets.mockRestore(); overlay.mockRestore(); }
  });
});

describe('角色图片与声音的最终请求对应', () => {
  const imageA = 'data:image/png;base64,YQ==';
  const imageB = 'data:image/png;base64,Yg==';
  const firstFrame = 'data:image/png;base64,Zmlyc3Q=';
  const lastFrame = 'data:image/png;base64,bGFzdA==';
  const voiceA = 'https://cdn.example/a.wav';
  const voiceB = 'https://cdn.example/b.wav';
  const voice = (id: string, clip = 'voice') => `@drama{${buildDramaVoiceMentionId(id, clip)}:旧标签}`;
  const picture = (id: string) => `@drama{${id}#portrait:旧标签}`;
  const ref = (url: string, kind: 'image' | 'audio' = 'image', role: 'reference' | 'first_frame' | 'last_frame' = 'reference') => ({
    kind, url, role: kind === 'audio' ? 'reference_audio' as const : role, origin: 'connection' as const,
  });

  function setCharacters(sameName = false) {
    const characters = ['a', 'b'].map((id, index) => ({
      id, kind: 'character', key: id, name: sameName ? '主角' : index === 0 ? '女主' : '男主',
      referenceImages: [{ id: 'portrait', kind: 'primary', imageUrl: index === 0 ? imageA : imageB, createdAt: 0 }],
      voiceClips: [{ id: 'voice', kind: index === 0 ? 'timbre' : 'emotion', audioUrl: index === 0 ? voiceA : voiceB,
        transcript: '样本对白不会自动写入', createdAt: 0, updatedAt: 0 }],
      primaryReferenceImageId: 'portrait', createdAt: 0, updatedAt: 0,
    }) as DramaCharacter);
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters } });
  }

  async function capture(prompt: string, referenceMedia: ReturnType<typeof ref>[] = []) {
    let captured: VideoGenerationReferenceInput | undefined;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-character-bindings', capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });
    try {
      await generateVideo({ prompt, provider: 'test-character-bindings', model: 'test', referenceMedia });
      return captured!;
    } finally {
      unregister();
    }
  }

  it('交错 @ 多个角色，按显式素材、去重与首尾帧排序后的数组建立对应', async () => {
    setCharacters();
    const input = await capture(`图片1是手写文字。${voice('b')} ${picture('a')} ${voice('a')} ${picture('b')} ${picture('a')}`, [
      ref(firstFrame, 'image', 'first_frame'), ref(lastFrame, 'image', 'last_frame'), ref(imageB), ref(voiceA, 'audio'),
    ]);
    expect(input.imageUrls).toEqual([firstFrame, imageB, imageA, lastFrame]);
    expect(input.audioUrls).toEqual([voiceA, voiceB]);
    expect(input.prompt).toContain('图片1是手写文字。男主〔角色1，音频2〕 女主〔角色2，图片3〕');
    expect(input.prompt).toContain('角色1「男主」：情绪参考：音频2；外观参考：图片2');
    expect(input.prompt).toContain('角色2「女主」：外观参考：图片3；音色参考：音频1');
    expect(input.prompt).not.toContain('旧标签');
    expect(input.prompt).not.toContain('样本对白不会自动写入');
    const variables = buildGeneralVideoProtocolVariables('test', { prompt: '', model: 'test', provider: 'general' }, input);
    expect(variables.prompt).toBe(input.prompt);
    expect(variables.imageUrls).toEqual(input.imageUrls);
    expect(variables.audioUrls).toEqual(input.audioUrls);
  });

  it('同名角色保持独立，重复素材去重后仍保留两份归属', async () => {
    setCharacters(true);
    const state = useAppStore.getState();
    useAppStore.setState({ dramaAssets: { ...state.dramaAssets, characters: state.dramaAssets.characters.map((character) => ({
      ...character, referenceImages: character.referenceImages!.map((image) => ({ ...image, imageUrl: imageA })),
    })) } });
    const input = await capture(`${picture('a')} ${voice('b')} ${picture('b')} ${voice('a')}`);
    expect(input.imageUrls).toEqual([imageA]);
    expect(input.prompt).toContain('角色1「主角」：外观参考：图片1；音色参考：音频2');
    expect(input.prompt).toContain('角色2「主角」：情绪参考：音频1；外观参考：图片1');
  });

  it('仅引用声音时不自动添加角色图片或其他声音', async () => {
    setCharacters();
    const input = await capture(voice('b'));
    expect(input.imageUrls).toEqual([]);
    expect(input.audioUrls).toEqual([voiceB]);
    expect(input.prompt).not.toContain('女主');
    expect(input.prompt).not.toContain('外观参考：');
  });

  it('同一角色的多张外观参考与声音合并到同一对应说明', async () => {
    setCharacters();
    const state = useAppStore.getState();
    useAppStore.setState({ dramaAssets: { ...state.dramaAssets, characters: state.dramaAssets.characters.map((character) => ({
      ...character, referenceImages: [...character.referenceImages!, {
        id: 'side', kind: 'turnaround' as const, imageUrl: imageB, prompt: '', createdAt: 0, updatedAt: 0,
      }],
    })) } });
    const input = await capture(`${picture('a')} ${voice('a')} @drama{a#side:女主侧面}`);
    expect(input.imageUrls).toEqual([imageA, imageB]);
    expect(input.prompt).toContain('角色1「女主」：外观参考：图片1、图片2；音色参考：音频1');
    expect(input.prompt).not.toContain('角色2');
  });

  it('本地媒体和同一远端来源去重时，编号按实际远端数组生成', async () => {
    const input = await resolvePromptWithMediaRefs('保留图片1', { preserveBindings: true });
    input.segments!.push({ reference: { ...ref('local-b'), sourceUrl: 'https://cdn.example/shared.png' } });
    const compiled = compileVideoReferencePrompt(input, [
      { ...ref('local-a'), sourceUrl: 'https://cdn.example/shared.png' }, { ...ref('local-b'), sourceUrl: 'https://cdn.example/shared.png' },
    ]);
    expect(compiled).toBe('保留图片1图片1');
    expect(compileVideoReferencePrompt(input, [ref('local-a'), ref('local-b')], { target: 'local' })).toBe('保留图片1图片2');
  });

  it('引用从最终请求中消失时拒绝编造编号', async () => {
    setCharacters();
    const input = await resolvePromptWithMediaRefs(picture('a'), { preserveBindings: true });
    expect(() => compileVideoReferencePrompt(input, [])).toThrow('引用素材未进入视频请求');
  });

  it('同一角色的多段声音保留独立用途，重复引用不重复添加对应说明', async () => {
    setCharacters();
    const state = useAppStore.getState();
    useAppStore.setState({ dramaAssets: { ...state.dramaAssets, characters: state.dramaAssets.characters.map((character) => ({
      ...character, voiceClips: [...character.voiceClips!, {
        id: 'line', kind: 'line' as const, audioUrl: 'https://cdn.example/line.wav', transcript: '样本里的话', createdAt: 0, updatedAt: 0,
      }],
    })) } });
    const input = await capture(`${voice('a')} ${voice('a', 'line')} ${voice('a')}`);
    expect(input.audioUrls).toEqual([voiceA, 'https://cdn.example/line.wav']);
    expect(input.prompt).toContain('角色1「女主」：音色参考：音频1；台词参考：音频2');
    expect(input.prompt.match(/音色参考：音频1/g)).toHaveLength(1);
    expect(input.prompt).not.toContain('样本里的话');
  });

  it('角色图片同时被选作独立首帧时使用字段语义而非虚构数组编号', async () => {
    setCharacters();
    const input = await resolvePromptWithMediaRefs(picture('a'), { preserveBindings: true });
    const result = compileVideoReferencePrompt(input, [ref(imageA, 'image', 'first_frame')], { imageLayout: 'frame-fields' });
    expect(result).toContain('外观参考：首帧图片');
    expect(result).not.toContain('图片1');
  });

  it('角色声音删除后在调用适配器提交前失败', async () => {
    setCharacters();
    await expect(capture(voice('a', 'removed'))).rejects.toThrow('角色音频引用已失效');
  });

  it('角色引用进入 ComfyUI 时带上对应说明，普通引用保持原行为', async () => {
    setCharacters();
    await generateVideo({ prompt: `${picture('a')} ${voice('a')}`, provider: 'comfyui', model: 'comfyui/test', workflowId: 'test' });
    expect(comfyMocks.executeVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('角色1「女主」：外观参考：图片1；音色参考：音频1') }),
      undefined, [voiceA], { imageUrls: [imageA], videoUrls: [] },
    );
  });

  it.each(['doubao-seedance-2.0', 'MiniMax-H3'])('APIMart %s 的实际适配参数与角色编号对应', async (model) => {
    setCharacters();
    const state = useAppStore.getState();
    useAppStore.setState({ config: { ...state.config, providers: { ...state.config.providers, apimart: { name: 'APIMart', apiKey: 'test-key', baseUrl: 'https://api.example' } } } });
    const submit = vi.spyOn(apimartApi, 'generateApimartVideo').mockResolvedValue({ url: 'https://cdn.example/result.mp4',
      mediaDownloadAccess: { providerConfigId: 'apimart', origin: 'https://api.example', auth: { type: 'bearer' } } });
    const uploadImages = vi.spyOn(imageUtils, 'resolveImageUrlArray').mockImplementation(async (urls) => urls);
    const uploadMedia = vi.spyOn(uploadService, 'resolveMediaReferenceUrl').mockImplementation(async (url) => url);
    try {
      await generateVideo({ prompt: `${picture('a')} ${voice('a')}`, provider: 'apimart', model: `apimart/${model}`,
        referenceMedia: [ref(firstFrame, 'image', 'first_frame'), ref(lastFrame, 'image', 'last_frame')],
      });
      const args = submit.mock.calls[0];
      expect(args).toBeDefined();
      if (model === 'MiniMax-H3') {
        expect(args[5]).toMatchObject({ firstFrameUrl: firstFrame, lastFrameUrl: lastFrame, imageUrls: [imageA], audioUrls: [voiceA] });
        expect(args[3]).toContain('外观参考：图片1；音色参考：音频1');
      } else {
        expect(args[5]?.imageWithRoles?.map((reference) => reference.url)).toEqual([firstFrame, lastFrame, imageA]);
        expect(args[3]).toContain('外观参考：图片3；音色参考：音频1');
      }
    } finally {
      submit.mockRestore(); uploadImages.mockRestore(); uploadMedia.mockRestore();
    }
  });
});

describe('video prompt media references', () => {
  it('extracts mentioned audio nodes once as reference media', async () => {
    const audioNode: Node<BaseNodeData> = {
      id: 'audio-1',
      type: 'ai-audio',
      position: { x: 0, y: 0 },
      data: {
        label: '角色台词',
        type: 'ai-audio',
        audioUrl: 'https://cdn.example/dialogue.mp3',
      },
    };
    useAppStore.setState({ nodes: [audioNode] });

    const result = await resolvePromptWithMediaRefs(
      '让 @{audio-1:角色台词} 驱动画面，并保持 @{audio-1:角色台词} 的节奏',
    );

    expect(result).toEqual({
      prompt: '让 音频1 驱动画面，并保持 音频1 的节奏',
      references: [{
        kind: 'audio',
        url: 'https://cdn.example/dialogue.mp3',
        origin: 'prompt',
        role: 'reference_audio',
        sourceNodeId: 'audio-1',
        filePath: undefined,
        sourceUrl: undefined,
      }],
      imageUrls: [],
      videoUrls: [],
      audioUrls: ['https://cdn.example/dialogue.mp3'],
    });
  });

  it('keeps the image-generation resolver compatible with inline audio URLs', async () => {
    const audioNode: Node<BaseNodeData> = {
      id: 'audio-1',
      type: 'source-audio',
      position: { x: 0, y: 0 },
      data: {
        label: '参考声音',
        type: 'source-audio',
        audioUrl: 'https://cdn.example/reference.wav',
      },
    };
    useAppStore.setState({ nodes: [audioNode] });

    await expect(resolvePromptWithImageRefs('@{audio-1:参考声音}')).resolves.toEqual({
      prompt: 'https://cdn.example/reference.wav',
      imageUrls: [],
    });
  });

  it('falls back to the persisted local image when a generated source URL has expired', async () => {
    class UnreachableImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', UnreachableImage);

    const imageNode: Node<BaseNodeData> = {
      id: 'generated-image',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        label: '生成首帧',
        type: 'ai-image',
        imageUrl: 'asset://localhost/generated.png',
        sourceUrl: 'https://expired.example/generated.png',
        filePath: '/project/data/generated.png',
      },
    };
    useAppStore.setState({ nodes: [imageNode] });

    await expect(resolvePromptWithMediaRefs('@{generated-image:生成首帧}')).resolves.toEqual({
      prompt: '图片1',
      references: [{
        kind: 'image',
        url: 'asset://localhost/generated.png',
        origin: 'prompt',
        role: 'reference',
        sourceNodeId: 'generated-image',
        filePath: '/project/data/generated.png',
        sourceUrl: undefined,
      }],
      imageUrls: ['asset://localhost/generated.png'],
      videoUrls: [],
      audioUrls: [],
    });
  });

  it('passes mentioned audio into ComfyUI audio IO and deduplicates a matching edge', async () => {
    const audioNode: Node<BaseNodeData> = {
      id: 'audio-1',
      type: 'ai-audio',
      position: { x: 0, y: 0 },
      data: {
        label: '角色台词',
        type: 'ai-audio',
        audioUrl: 'https://cdn.example/dialogue.mp3',
      },
    };
    useAppStore.setState({
      nodes: [audioNode],
      edges: [{ id: 'audio-to-video', source: 'audio-1', target: 'video-1' }],
    });

    await generateVideo({
      model: 'comfyui/lipsync',
      provider: 'comfyui',
      prompt: '按照 @{audio-1:角色台词} 对口型',
      workflowId: 'lipsync',
      nodeId: 'video-1',
    });

    expect(comfyMocks.executeVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '按照 https://cdn.example/dialogue.mp3 对口型',
      }),
      undefined,
      ['https://cdn.example/dialogue.mp3'],
      { imageUrls: [], videoUrls: [] },
    );
  });

  it('converts user-facing seconds to workflow frames before ComfyUI execution', async () => {
    await generateVideo({
      model: 'comfyui/video',
      provider: 'comfyui',
      prompt: '生成视频',
      workflowId: 'video-workflow',
      videoFps: 30,
      seedanceDuration: 8,
      videoFrames: 77,
    });

    expect(comfyMocks.executeVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        videoFps: 30,
        seedanceDuration: 8,
        videoFrames: 241,
      }),
      undefined,
      [],
      { imageUrls: [], videoUrls: [] },
    );
  });

  it('collects all three connected media kinds and uses local copies for expiring uploads', () => {
    const imageNode: Node<BaseNodeData> = {
      id: 'image-1',
      type: 'source-image',
      position: { x: 0, y: 0 },
      data: {
        label: '首帧',
        type: 'source-image',
        imageUrl: 'asset://localhost/first.png',
        sourceUrl: 'https://cdn.example/first.png',
        filePath: 'C:\\project\\first.png',
      },
    };
    const videoNode: Node<BaseNodeData> = {
      id: 'video-ref',
      type: 'source-video',
      position: { x: 0, y: 0 },
      data: {
        label: '动作参考',
        type: 'source-video',
        videoUrl: 'asset://localhost/reference.mp4',
        sourceUrl: 'https://cdn.example/reference.mp4',
        filePath: 'C:\\project\\reference.mp4',
      },
    };
    const audioNode: Node<BaseNodeData> = {
      id: 'audio-ref',
      type: 'source-audio',
      position: { x: 0, y: 0 },
      data: {
        label: '声音参考',
        type: 'source-audio',
        audioUrl: 'asset://localhost/reference.wav',
        sourceUrl: 'https://cdn.example/reference.wav',
        filePath: 'C:\\project\\reference.wav',
      },
    };
    useAppStore.setState({
      nodes: [imageNode, videoNode, audioNode],
      edges: [
        { id: 'image-edge', source: 'image-1', target: 'video-1' },
        { id: 'video-edge', source: 'video-ref', target: 'video-1' },
        { id: 'audio-edge', source: 'audio-ref', target: 'video-1' },
      ],
    });

    const media = collectConnectedReferenceMedia('video-1');

    expect(media.imageUrls).toEqual(['asset://localhost/first.png']);
    expect(media.videoUrls).toEqual(['asset://localhost/reference.mp4']);
    expect(media.audioUrls).toEqual(['asset://localhost/reference.wav']);
    expect(media.references).toMatchObject([
      { kind: 'image', sourceNodeId: 'image-1', origin: 'connection' },
      { kind: 'video', sourceNodeId: 'video-ref', origin: 'connection' },
      { kind: 'audio', sourceNodeId: 'audio-ref', origin: 'connection' },
    ]);
    expect(getMediaReferenceUrls(media.references, 'audio', 'local')).toEqual([
      'asset://localhost/reference.wav',
    ]);
  });

  it('deduplicates by media kind and local URL while preserving first-source metadata', () => {
    const first = {
      kind: 'audio' as const,
      url: 'asset://localhost/reference.wav',
      origin: 'prompt' as const,
      role: 'reference_audio' as const,
      sourceNodeId: 'prompt-audio',
    };
    const merged = mergeMediaReferences(
      [first],
      [
        { ...first, origin: 'connection', sourceNodeId: 'connected-audio' },
        { ...first, kind: 'video', role: 'reference' },
      ],
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ origin: 'prompt', sourceNodeId: 'prompt-audio' });
    expect(merged[1].kind).toBe('video');
  });
});

describe('manual frame and character references', () => {
  it('treats connected images as references until the user explicitly assigns a frame role', () => {
    expect(resolveVideoParameterInputMode([], 0, { image: 1, video: 0, audio: 0 }))
      .toBe('reference');
    expect(resolveVideoParameterInputMode([{ role: 'first_frame' }], 0, { image: 0, video: 0, audio: 0 }))
      .toBe('keyframe');
    expect(resolveVideoParameterInputMode([{ role: 'last_frame' }], 1, { image: 0, video: 0, audio: 0 }))
      .toBe('mixed');
  });

  it('reorders references by the node 首帧/尾帧 picks and keeps 参考角色 as plain references', async () => {
    const imageNode = (id: string, url: string): Node<BaseNodeData> => ({
      id,
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: { label: id, type: 'ai-image', imageUrl: url },
    });
    const videoNode: Node<BaseNodeData> = {
      id: 'video-1',
      type: 'ai-video',
      position: { x: 0, y: 0 },
      data: {
        label: '镜头',
        type: 'ai-video',
        videoReferences: [
          { id: 'image-c', kind: 'frame', role: 'first_frame', url: 'https://cdn.example/c.png', sourceNodeId: 'image-c' },
          { id: 'image-a', kind: 'frame', role: 'last_frame', url: 'https://cdn.example/a.png', sourceNodeId: 'image-a' },
          { id: 'character:hero', kind: 'character', role: 'reference', url: 'https://cdn.example/hero.png', label: '主角' },
        ],
      },
    };
    useAppStore.setState({
      nodes: [
        imageNode('image-a', 'https://cdn.example/a.png'),
        imageNode('image-b', 'https://cdn.example/b.png'),
        imageNode('image-c', 'https://cdn.example/c.png'),
        videoNode,
      ],
      edges: ['image-a', 'image-b', 'image-c'].map((source) => ({
        id: `e-${source}`,
        source,
        target: 'video-1',
      })),
    });

    let captured: VideoGenerationReferenceInput | null = null;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-frame-role-provider',
      capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });

    try {
      await generateVideo({
        prompt: '推进镜头',
        model: 'test/frame-roles',
        provider: 'test-frame-role-provider',
        nodeId: 'video-1',
      });
    } finally {
      unregister();
    }

    const referenceInput = captured as VideoGenerationReferenceInput | null;
    // 首帧 → 参考角色/中间图 → 尾帧；连线里没被挑中的图仍按原顺序留在中间
    expect(referenceInput?.imageUrls).toEqual([
      'https://cdn.example/c.png',
      'https://cdn.example/hero.png',
      'https://cdn.example/b.png',
      'https://cdn.example/a.png',
    ]);
    expect(referenceInput?.references?.map((reference) => reference.role)).toEqual([
      'first_frame',
      'reference',
      'reference',
      'last_frame',
    ]);
  });

  it('tells the model which reference image the mentioned character name refers to', async () => {
    const videoNode: Node<BaseNodeData> = {
      id: 'video-1',
      type: 'ai-video',
      position: { x: 0, y: 0 },
      data: {
        label: '镜头',
        type: 'ai-video',
        videoReferences: [
          { id: 'img-a', kind: 'frame', role: 'first_frame', url: 'https://cdn.example/room.png' },
          { id: 'character:hero', kind: 'character', role: 'reference', url: 'https://cdn.example/hero.png', label: '女主·林夏' },
          { id: 'character:extra', kind: 'character', role: 'reference', url: 'https://cdn.example/extra.png', label: '路人甲' },
        ],
      },
    };
    useAppStore.setState({ nodes: [videoNode] });

    let captured: VideoGenerationReferenceInput | null = null;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-character-provider',
      capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });

    try {
      await generateVideo({
        prompt: '林夏推开门走进房间',
        model: 'test/character',
        provider: 'test-character-provider',
        nodeId: 'video-1',
      });
    } finally {
      unregister();
    }

    // 只标注被点名的角色，图号按最终提交顺序
    expect((captured as VideoGenerationReferenceInput | null)?.prompt)
      .toBe('林夏推开门走进房间\n\n（角色参考：图2 是林夏）');
  });

  it('leaves the prompt untouched when no character name is mentioned', () => {
    const items: VideoReferenceItem[] = [
      { id: 'character:hero', kind: 'character', role: 'reference', url: 'https://cdn.example/hero.png', label: '林夏' },
    ];
    expect(annotateCharacterReferences('推开门走进房间', items, ['https://cdn.example/hero.png']))
      .toBe('推开门走进房间');
  });

  it('adds a character library primary voice to the video reference audio request', async () => {
    const character = {
      id: 'hero', kind: 'character', name: '主角', primaryVoiceClipId: 'voice-main',
      voiceClips: [
        { id: 'voice-other', kind: 'timbre', audioUrl: 'https://cdn.example/other.wav' },
        { id: 'voice-main', kind: 'timbre', label: '主音色', audioUrl: 'https://cdn.example/main.wav' },
      ],
    } as DramaCharacter;
    const references = buildCharacterVideoReferences({
      id: 'character:hero', label: '主角', url: 'https://cdn.example/hero.png', character,
    });
    expect(references).toEqual([
      expect.objectContaining({ kind: 'character', role: 'reference', url: 'https://cdn.example/hero.png' }),
      expect.objectContaining({
        id: 'character:hero:voice', kind: 'character', mediaKind: 'audio',
        role: 'reference_audio', url: 'https://cdn.example/main.wav',
      }),
    ]);
    useAppStore.setState({ nodes: [{
      id: 'video-1', type: 'ai-video', position: { x: 0, y: 0 },
      data: { type: 'ai-video', label: '镜头', videoReferences: references },
    } as Node<BaseNodeData>] });
    let captured: VideoGenerationReferenceInput | undefined;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-character-voice-provider', capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });
    try {
      await generateVideo({
        prompt: '主角走入镜头', provider: 'test-character-voice-provider',
        model: 'test/character-voice', nodeId: 'video-1',
      });
    } finally {
      unregister();
    }
    expect(captured?.imageUrls).toEqual(['https://cdn.example/hero.png']);
    expect(captured?.audioUrls).toEqual(['https://cdn.example/main.wav']);
    expect(captured?.prompt).toContain('图1 是主角');
  });

  it('only adds an explicitly selected, available primary voice', () => {
    const character = {
      id: 'hero', kind: 'character', name: '主角',
      voiceClips: [{ id: 'other', kind: 'timbre', audioUrl: 'https://cdn.example/other.wav' }],
    } as DramaCharacter;
    const option = { id: 'character:hero', label: '主角', url: 'https://cdn.example/hero.png', character };
    expect(buildCharacterVideoReferences(option)).toHaveLength(1);
    character.primaryVoiceClipId = 'missing';
    expect(buildCharacterVideoReferences(option)).toHaveLength(1);
    character.primaryVoiceClipId = 'other';
    character.volcengineBinding = { projectName: 'default', imageAssetId: 'asset-1' };
    expect(buildCharacterVideoReferences(option, 'volcengine')).toEqual([
      expect.objectContaining({ id: 'character:hero:volcengine:asset-1', url: 'asset://asset-1' }),
      expect.objectContaining({
        id: 'character:hero:volcengine:asset-1:voice', mediaKind: 'audio',
        url: 'https://cdn.example/other.wav',
      }),
    ]);
  });

  it('keeps connected and mentioned images as plain references when no frame role was picked', async () => {
    const imageNode = (id: string, url: string): Node<BaseNodeData> => ({
      id,
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: { label: id, type: 'ai-image', imageUrl: url },
    });
    useAppStore.setState({
      nodes: [
        imageNode('image-a', 'https://cdn.example/a.png'),
        imageNode('image-b', 'https://cdn.example/b.png'),
        imageNode('image-c', 'https://cdn.example/c.png'),
        { id: 'video-1', type: 'ai-video', position: { x: 0, y: 0 }, data: { label: '镜头', type: 'ai-video' } },
      ],
      edges: ['image-a', 'image-b'].map((source) => ({ id: `e-${source}`, source, target: 'video-1' })),
    });

    let captured: VideoGenerationReferenceInput | null = null;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-frame-default-provider',
      capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/result.mp4' };
      },
    });

    try {
      await generateVideo({
        prompt: '@{image-c:人物参考} 推进镜头',
        model: 'test/frame-default',
        provider: 'test-frame-default-provider',
        nodeId: 'video-1',
      });
    } finally {
      unregister();
    }

    const referenceInput = captured as VideoGenerationReferenceInput | null;
    expect(referenceInput?.imageUrls).toEqual([
      'https://cdn.example/c.png',
      'https://cdn.example/a.png',
      'https://cdn.example/b.png',
    ]);
    expect(referenceInput?.references?.map((reference) => reference.role))
      .toEqual(['reference', 'reference', 'reference']);
  });
});

describe('caller-supplied reference media', () => {
  // 剪辑窗口的 AI 转场没有画布节点可连线，只能直接把首/尾帧交给生成入口
  it('puts explicit references ahead of prompt references and keeps the frame roles', async () => {
    const imageNode: Node<BaseNodeData> = {
      id: 'image-1',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        label: '概念图',
        type: 'ai-image',
        imageUrl: 'https://cdn.example/concept.png',
      },
    };
    useAppStore.setState({ nodes: [imageNode] });

    let captured: VideoGenerationReferenceInput | null = null;
    const unregister = mediaProviderRegistry.register({
      providerId: 'test-transition-provider',
      capabilities: ['video'],
      async generateVideo({ resolveReferenceInput }) {
        captured = await resolveReferenceInput();
        return { url: 'https://cdn.example/transition.mp4' };
      },
    });

    try {
      await generateVideo({
        prompt: '穿过火光过渡 @{image-1:概念图}',
        model: 'test/transition',
        provider: 'test-transition-provider',
        referenceMedia: [
          { kind: 'image', url: 'asset://tail.png', origin: 'connection', role: 'first_frame' },
          { kind: 'image', url: 'asset://head.png', origin: 'connection', role: 'last_frame' },
        ],
      });
    } finally {
      unregister();
    }

    const referenceInput = captured as VideoGenerationReferenceInput | null;
    expect(referenceInput?.operation).toBe('image-to-video');
    expect(referenceInput?.imageUrls).toEqual([
      'asset://tail.png',
      'https://cdn.example/concept.png',
      'asset://head.png',
    ]);
    // 只有调用方明确指定的图片承担首尾帧，提示词中的图片保持普通参考。
    expect(referenceInput?.references?.[0]).toMatchObject({
      url: 'asset://tail.png',
      role: 'first_frame',
    });
    expect(referenceInput?.references?.[1]).toMatchObject({
      url: 'https://cdn.example/concept.png',
      role: 'reference',
    });
    expect(referenceInput?.references?.at(-1)).toMatchObject({
      url: 'asset://head.png',
      role: 'last_frame',
    });
  });
});

describe('video reference limits', () => {
  const input = (counts: { image?: number; video?: number; audio?: number }) => ({
    prompt: 'prompt',
    imageUrls: Array.from({ length: counts.image ?? 0 }, (_, i) => `https://cdn.example/i${i}.png`),
    videoUrls: Array.from({ length: counts.video ?? 0 }, (_, i) => `https://cdn.example/v${i}.mp4`),
    audioUrls: Array.from({ length: counts.audio ?? 0 }, (_, i) => `https://cdn.example/a${i}.mp3`),
    operation: 'image-to-video' as const,
  });

  it('rejects reference media beyond what the model declared', () => {
    const capability = { maxImageReferences: 9, maxVideoReferences: 0, maxAudioReferences: 0 };
    expect(() => assertVideoReferenceLimits(input({ image: 12 }), capability, 'Seedance 900'))
      .toThrow('模型 "Seedance 900" 最多支持 9 个参考图，当前有 12 个');
    expect(() => assertVideoReferenceLimits(input({ image: 1, video: 1 }), capability, 'Seedance 900'))
      .toThrow('不支持参考视频');
    // 正好到上限不拦
    expect(() => assertVideoReferenceLimits(input({ image: 9 }), capability, 'Seedance 900')).not.toThrow();
  });

  it('未声明上限的模型保持原有的不拦截行为', () => {
    expect(() => assertVideoReferenceLimits(input({ image: 30, video: 5 }), undefined, 'X')).not.toThrow();
    expect(() => assertVideoReferenceLimits(input({ image: 30 }), { maxDuration: 15 }, 'X')).not.toThrow();
  });
});

describe('离散时长校验', () => {
  const build = (seedanceDuration: number, capability?: { durations?: number[]; maxDuration?: number }) =>
    buildGeneralVideoProtocolVariables(
      'lec-ac-seedance-900-720p',
      { model: 'general/relay', provider: 'general', prompt: 'p', seedanceDuration },
      { prompt: 'p', imageUrls: [], videoUrls: [], audioUrls: [], operation: 'text-to-video' },
      capability,
    ).duration;

  it('拒绝不在模型允许档位内的时长，不静默改写用户请求', () => {
    expect(() => build(4, { durations: [10, 15] })).toThrow('不在模型支持的离散时长中');
    expect(() => build(13, { durations: [10, 15] })).toThrow('不在模型支持的离散时长中');
    expect(build(15, { durations: [10, 15] })).toBe(15);
    expect(() => build(4, { durations: [15] })).toThrow('不在模型支持的离散时长中');
  });

  it('没声明离散档位时保持原有的范围钳制', () => {
    expect(build(8, { maxDuration: 15 })).toBe(8);
    expect(build(8)).toBe(8);
  });
});
