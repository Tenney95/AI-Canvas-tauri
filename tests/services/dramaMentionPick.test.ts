import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAMA_MENTION_MERGE_ALL,
  buildDramaMentionId,
  buildDramaActionMentionId,
  buildDramaVoiceMentionId,
  emptyDramaAssetLibrary,
  parseDramaMentionId,
} from '../../src/types/dramaAssets';
import { findDramaAsset, resolveDramaActionMediaRef, resolveDramaAssetImageRef, resolveDramaVoiceRef } from '../../src/services/dramaAssetPrompt';
import type { DramaCharacter } from '../../src/types/dramaAssets';
import { useAppStore } from '../../src/store/useAppStore';
import { collectPromptNodeMediaUrls, resolvePromptToChatContent, resolvePromptWithImageRefs, resolvePromptWithMediaRefs } from '../../src/services/ai/promptResolver';
import { resolveNodeReferences } from '../../src/services/nodeReferenceService';
import { renderPromptToNodes, serializeDOM } from '../../src/components/nodes/shared/mentionEditorDom';
import { resolveDramaMentionItems } from '../../src/components/nodes/shared/mentionEditorSources';
import { generateAudio } from '../../src/services/ai/generateAudio';
import { mediaProviderRegistry } from '../../src/services/ai/mediaProviderRegistry';

function character(): DramaCharacter {
  return {
    id: 'char_1',
    kind: 'character',
    key: 'lin',
    name: '林小满',
    createdAt: 0,
    updatedAt: 0,
    primaryReferenceImageId: 'ref-front',
    referenceImages: [
      { id: 'ref-front', kind: 'primary', imageUrl: 'front.png', createdAt: 0 },
      { id: 'ref-side', kind: 'turnaround', imageUrl: 'side.png', createdAt: 0 },
    ],
  } as DramaCharacter;
}

describe('显式全局角色引用', () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true));
  it('keeps project and global identities separate even when their raw IDs match', () => {
    const project = { ...character(), name: '项目角色' };
    const global = { ...character(), name: '全局角色' };
    const library = { ...emptyDramaAssetLibrary(), characters: [project] };
    expect(findDramaAsset(library, 'char_1', [global])?.name).toBe('项目角色');
    expect(findDramaAsset(library, 'global/char_1', [global])).toMatchObject({ id: 'global/char_1', name: '全局角色' });
    expect(findDramaAsset(library, 'global/char_1')).toBeUndefined();
    expect(findDramaAsset(emptyDramaAssetLibrary(), 'char_1', [global])).toBeUndefined();
  });
  it('resolves global appearance references through text and video prompt parsers', async () => {
    const url = 'data:image/png;base64,Z2xvYmFs';
    const global = { ...character(), referenceImages: [{ ...character().referenceImages![1], imageUrl: url }] };
    useAppStore.setState({ globalCharacters: [global] });
    const token = `@drama{${buildDramaMentionId('global/char_1', 'ref-side')}:全局角色}`;
    const chat = await resolvePromptToChatContent(token);
    expect(chat.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url', image_url: { url } })]));
    const video = await resolvePromptWithMediaRefs(token, { preserveBindings: true });
    expect(video.imageUrls).toEqual([url]);
    const binding = video.segments!.find((segment) => typeof segment !== 'string');
    expect(binding?.character?.id).toBe('global/char_1');
  });
  it('resolves a global description without leaking another project asset with the same ID', async () => {
    const global = { ...character(), referenceImages: [], imageUrl: undefined, summary: '全局人物设定' };
    useAppStore.setState({ globalCharacters: [global], dramaAssets: { ...emptyDramaAssetLibrary(), characters: [{ ...global, summary: '无关项目正文' }] } });
    const chat = await resolvePromptToChatContent('@drama{global/char_1:全局角色}');
    expect(chat.textContent).toContain('全局人物设定');
    expect(chat.textContent).not.toContain('无关项目正文');
    const workflowPrompt = resolveNodeReferences('@drama{global/char_1:全局角色}');
    expect(workflowPrompt).toContain('全局人物设定');
    expect(workflowPrompt).not.toContain('无关项目正文');
  });
});

describe('@drama 选图后缀', () => {
  it('不带后缀时保持原样', () => {
    expect(buildDramaMentionId('char_1')).toBe('char_1');
    expect(parseDramaMentionId('char_1')).toEqual({ assetId: 'char_1', mergeAll: false });
  });

  it('往返得到同一个参考图 id', () => {
    const raw = buildDramaMentionId('char_1', 'ref-side');
    expect(raw).toBe('char_1#ref-side');
    expect(parseDramaMentionId(raw)).toEqual({
      assetId: 'char_1',
      referenceImageId: 'ref-side',
      mergeAll: false,
    });
  });

  it('#all 解析为合并且不带具体参考图', () => {
    const raw = buildDramaMentionId('char_1', DRAMA_MENTION_MERGE_ALL);
    expect(parseDramaMentionId(raw)).toEqual({
      assetId: 'char_1',
      referenceImageId: undefined,
      mergeAll: true,
    });
  });
});

describe('resolveDramaAssetImageRef 指定参考图', () => {
  it('不指定时用主视觉', () => {
    expect(resolveDramaAssetImageRef(character(), [])?.imageUrl).toBe('front.png');
  });

  it('指定时用那一张', () => {
    expect(resolveDramaAssetImageRef(character(), [], 'ref-side')?.imageUrl).toBe('side.png');
  });

  it('指定的参考图不存在时回落到主视觉，而不是没有图', () => {
    expect(resolveDramaAssetImageRef(character(), [], 'ref-gone')?.imageUrl).toBe('front.png');
  });
});

const actionImage = 'data:image/png;base64,YWN0aW9u';
const actionGif = 'data:image/gif;base64,Z2lm';
const actionVideo = 'https://cdn.example/action.mp4';

function actionCharacter(): DramaCharacter {
  return {
    ...character(),
    actions: [{
      id: 'action-run', category: 'running', name: '奔跑', prompt: '抬腿前进', createdAt: 0, updatedAt: 0,
      media: [
        { id: 'pose', name: '姿态图', kind: 'image', url: actionImage, createdAt: 0, updatedAt: 0 },
        { id: 'loop', name: '循环演示', kind: 'gif', url: actionGif, createdAt: 0, updatedAt: 0 },
        { id: 'clip', name: '视频演示', kind: 'video', url: actionVideo, createdAt: 0, updatedAt: 0 },
      ],
    }],
  };
}

function actionMention(mediaId: string) {
  return `@drama{${buildDramaActionMentionId('char_1', 'action-run', mediaId)}:林小满 · 奔跑}`;
}

describe('动作素材引用', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({
      dramaAssets: { ...emptyDramaAssetLibrary(), characters: [actionCharacter()] },
    });
  });

  it('动作和素材 ID 可含分隔符，保存后仍能精确还原', () => {
    const raw = buildDramaActionMentionId('char_1', 'run/#:}', 'pose/%:}');
    expect(raw).not.toMatch(/[:}]/);
    expect(parseDramaMentionId(JSON.parse(JSON.stringify(raw)))).toEqual({
      assetId: 'char_1', actionId: 'run/#:}', actionMediaId: 'pose/%:}', mergeAll: false,
    });
  });

  it('精确取动作素材，隐藏节点的最新输出不会替换库内素材', async () => {
    useAppStore.setState({ nodes: [{
      id: 'source', type: 'source-image', position: { x: 0, y: 0 },
      data: {
        type: 'source-image', label: '来源', imageUrl: 'data:image/png;base64,bmV3', hiddenByCharacterLibrary: true,
        characterLibraryLinks: [{ scope: 'project', characterId: 'char_1', actionId: 'action-run', mediaId: 'pose' }],
      },
    }] });
    expect(resolveDramaActionMediaRef(actionCharacter(), 'action-run', 'pose')?.url).toBe(actionImage);
    expect((await resolvePromptWithImageRefs(actionMention('pose'))).imageUrls).toEqual([actionImage]);
  });

  it.each([
    ['pose', 'image', actionImage],
    ['loop', 'image', actionGif],
    ['clip', 'video', actionVideo],
  ])('没有来源节点时仍把 %s 送入正确媒体通道', async (mediaId, kind, url) => {
    const result = await resolvePromptWithMediaRefs(actionMention(mediaId));
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toMatchObject({ kind, url, origin: 'prompt' });
    expect(result.imageUrls).toEqual(kind === 'image' ? [url] : []);
    expect(result.videoUrls).toEqual(kind === 'video' ? [url] : []);
    expect(result.prompt).toBe(kind === 'image' ? '图片1' : '视频1');
  });

  it('多种动作素材按首次出现编号，重复引用不重复发送', async () => {
    const result = await resolvePromptWithMediaRefs([
      actionMention('pose'), actionMention('clip'), actionMention('loop'), actionMention('pose'), actionMention('clip'),
    ].join(' / '));
    expect(result.prompt).toBe('图片1 / 视频1 / 图片2 / 图片1 / 视频1');
    expect(result.imageUrls).toEqual([actionImage, actionGif]);
    expect(result.videoUrls).toEqual([actionVideo]);
  });

  it.each(['pose', 'loop'])('文本模型把 %s 作为图片内容，并保留动作名称', async (mediaId) => {
    const result = await resolvePromptToChatContent(actionMention(mediaId));
    expect(result.textContent).toContain('林小满 · 奔跑');
    expect(result.content).toEqual([
      { type: 'text', text: result.textContent },
      { type: 'image_url', image_url: { url: mediaId === 'pose' ? actionImage : actionGif } },
    ]);
  });

  it('文本与生图入口沿用视频 URL 文本语义，不把视频当图片', async () => {
    const chat = await resolvePromptToChatContent(actionMention('clip'));
    expect(typeof chat.content).toBe('string');
    expect(chat.textContent).toContain(actionVideo);
    expect(await resolvePromptWithImageRefs(actionMention('clip'))).toEqual({ prompt: actionVideo, imageUrls: [] });
  });

  it('工作流输入读取所选素材地址，原参考图引用仍有效', () => {
    expect(resolveNodeReferences(actionMention('pose'))).toBe(actionImage);
    expect(resolveNodeReferences(actionMention('clip'))).toBe(actionVideo);
    expect(resolveNodeReferences('@drama{char_1#ref-side:林小满}')).toBe('side.png');
  });

  it('保存后的图片、视频与音频标签恢复正确类型，并保持序列化引用', () => {
    // 仅模拟 DOM 的节点/属性存储，实际标签构造和解析仍运行生产代码。
    class ElementStub {
      nodeType = 1;
      childNodes: unknown[] = [];
      attributes = new Map<string, string>();
      className = '';
      src = '';
      tagName: string;
      constructor(tagName: string) { this.tagName = tagName; }
      setAttribute(name: string, value: string) { this.attributes.set(name, value); }
      getAttribute(name: string) { return this.attributes.get(name) ?? null; }
      hasAttribute(name: string) { return this.attributes.has(name); }
      appendChild(child: unknown) { this.childNodes.push(child); return child; }
    }
    vi.stubGlobal('Node', class { static ELEMENT_NODE = 1; static TEXT_NODE = 3; });
    vi.stubGlobal('document', {
      createElement: (name: string) => new ElementStub(name.toUpperCase()),
      createTextNode: (textContent: string) => ({ nodeType: 3, textContent }),
    });
    try {
      useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters: [voiceCharacter()] } });
      const prompt = `${actionMention('pose')} ${actionMention('clip')} ${voiceMention()}`;
      const rendered = renderPromptToNodes(prompt, new Map());
      const chips = rendered.filter((node) => node.nodeType === 1) as unknown as ElementStub[];
      expect(chips[0].getAttribute('data-drama-kind')).toBe('action-image');
      const icon = chips[0].childNodes[0] as ElementStub;
      expect((icon.childNodes[0] as ElementStub).src).toBe(actionImage);
      expect(chips[1].getAttribute('data-drama-kind')).toBe('action-video');
      expect(chips[1].className).toContain('chip-video');
      expect(chips[1].hasAttribute('data-image-ref-key')).toBe(false);
      expect(chips[2].getAttribute('data-drama-kind')).toBe('voice');
      expect(chips[2].className).toContain('chip-audio');
      expect(chips[2].hasAttribute('data-image-ref-key')).toBe(false);
      expect(serializeDOM({ childNodes: rendered } as unknown as HTMLElement)).toBe(prompt);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['action', 'media', 'character'])('已删除的 %s 引用明确失败，不误用主视觉', async (missing) => {
    const card = actionCharacter();
    if (missing === 'action') card.actions = [];
    if (missing === 'media') card.actions![0].media = [];
    useAppStore.setState({ dramaAssets: {
      ...emptyDramaAssetLibrary(), characters: missing === 'character' ? [] : [card],
    } });
    await expect(resolvePromptWithMediaRefs(actionMention('pose'))).rejects.toThrow('动作素材引用已失效');
    await expect(resolvePromptToChatContent(actionMention('pose'))).rejects.toThrow('动作素材引用已失效');
    expect(() => resolveNodeReferences(actionMention('pose'))).toThrow('动作素材引用已失效');
  });

  it.each(['action/run', 'action/%ZZ/pose', 'action//pose', 'action/run/pose/extra'])('无效动作后缀 %s 不回落到参考图', async (pick) => {
    const parsed = parseDramaMentionId(`char_1#${pick}`);
    expect(parsed.actionId).toBeDefined();
    expect(parsed.referenceImageId).toBeUndefined();
    await expect(resolvePromptWithMediaRefs(`@drama{char_1#${pick}:动作}`)).rejects.toThrow('动作素材引用已失效');
  });
});

const voiceUrl = 'https://cdn.example/primary.wav';
const otherVoiceUrl = 'data:audio/wav;base64,b3RoZXI=';

function voiceCharacter(): DramaCharacter {
  return {
    ...actionCharacter(),
    primaryVoiceClipId: 'primary',
    voiceClips: [
      { id: 'other', kind: 'line', audioUrl: otherVoiceUrl, transcript: '另一段', createdAt: 0, updatedAt: 0 },
      { id: 'primary', kind: 'timbre', label: '主音色', audioUrl: voiceUrl, transcript: '', createdAt: 0, updatedAt: 0 },
    ],
  };
}

function voiceMention(clipId = 'primary') {
  return `@drama{${buildDramaVoiceMentionId('char_1', clipId)}:林小满 · 主音色}`;
}

describe('音频节点的角色声音引用', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters: [voiceCharacter()] } });
  });

  it('音频候选只保留有可用声音的角色，只有图片、声音描述或空音频的角色不出现', () => {
    const silent = Array.from({ length: 21 }, (_, index) => ({
      ...character(), id: `silent-${index}`, voiceNotes: '温柔女声',
      voiceClips: [{ id: 'empty', kind: 'timbre' as const, audioUrl: ' ', transcript: '', createdAt: 0, updatedAt: 0 }],
    }));
    const library = { ...emptyDramaAssetLibrary(), characters: [...silent, voiceCharacter()] };
    const items = resolveDramaMentionItems(library, '', 'ai-audio');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'char_1', kind: 'character', voice: { id: 'primary', url: voiceUrl } });
    expect(resolveDramaMentionItems(library, '林小', 'ai-audio')).toHaveLength(1);
    expect(resolveDramaMentionItems(library, '不存在', 'ai-audio')).toEqual([]);
    expect(resolveDramaMentionItems(library, '', 'ai-image')).toHaveLength(22);
    expect(resolveDramaMentionItems({ ...library, characters: silent }, '', 'ai-audio')).toEqual([]);
  });

  it('场景和道具只在原来的非音频选择器中出现', () => {
    const library = {
      ...emptyDramaAssetLibrary(), characters: [voiceCharacter()],
      scenes: [{ ...character(), id: 'scene', kind: 'scene' as const }],
      props: [{ ...character(), id: 'prop', kind: 'prop' as const }],
    };
    expect(resolveDramaMentionItems(library, '', 'ai-audio').map((item) => item.id)).toEqual(['char_1']);
    expect(resolveDramaMentionItems(library, '').map((item) => item.id)).toEqual(['char_1', 'scene', 'prop']);
  });

  it('默认优先主音色，不可用时选第一段有效音频，指定片段不会回落', () => {
    const card = voiceCharacter();
    expect(resolveDramaVoiceRef(card)?.id).toBe('primary');
    card.voiceClips![1].audioUrl = ' ';
    expect(resolveDramaVoiceRef(card)?.id).toBe('other');
    expect(resolveDramaVoiceRef(card, 'primary')).toBeNull();
    expect(resolveDramaVoiceRef(card, 'missing')).toBeNull();
  });

  it('带分隔符的片段 ID 保存后仍能精确还原', () => {
    const id = buildDramaVoiceMentionId('char_1', '声音/#:%}');
    expect(id).not.toMatch(/[:}]/);
    expect(parseDramaMentionId(JSON.parse(JSON.stringify(id)))).toEqual({
      assetId: 'char_1', voiceClipId: '声音/#:%}', mergeAll: false,
    });
  });

  it('音频引用固定所选片段，不读取来源节点新输出或新主音色', () => {
    const card = voiceCharacter();
    card.voiceClips![1].sourceNodeId = 'source';
    card.primaryVoiceClipId = 'other';
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters: [card] }, nodes: [{
      id: 'source', type: 'ai-audio', position: { x: 0, y: 0 },
      data: { type: 'ai-audio', label: '已重新生成', audioUrl: 'https://cdn.example/new.wav' },
    }] });
    expect(collectPromptNodeMediaUrls(voiceMention()).audioUrls).toEqual([voiceUrl]);
    useAppStore.setState({ nodes: [] });
    expect(collectPromptNodeMediaUrls(voiceMention()).audioUrls).toEqual([voiceUrl]);
  });

  it('混合节点与角色引用保持顺序、去重并进入音频通道', async () => {
    useAppStore.setState({ nodes: [{
      id: 'audio', type: 'ai-audio', position: { x: 0, y: 0 },
      data: { type: 'ai-audio', label: '音频', audioUrl: otherVoiceUrl },
    }] });
    const prompt = `@{audio:音频} ${voiceMention()} ${voiceMention()}`;
    const collected = collectPromptNodeMediaUrls(prompt);
    expect(collected.audioUrls).toEqual([otherVoiceUrl, voiceUrl]);
    expect(collected.references).toHaveLength(2);
    const resolved = await resolvePromptWithMediaRefs(prompt);
    expect(resolved.audioUrls).toEqual([otherVoiceUrl, voiceUrl]);
    expect(resolved.imageUrls).toEqual([]);
    expect(resolved.videoUrls).toEqual([]);
    expect(resolved.prompt).toBe('音频1 音频2 音频2');
  });

  it('没有来源节点或连线时，生成入口仍把角色音频交给适配器', async () => {
    const adapterGenerate = vi.fn().mockResolvedValue({ url: 'https://cdn.example/result.wav' });
    vi.spyOn(mediaProviderRegistry, 'getAudioAdapter').mockReturnValue({
      providerId: 'apimart', capabilities: ['audio'], generateAudio: adapterGenerate,
    });
    await generateAudio({ prompt: `你好 ${voiceMention()}`, provider: 'apimart', model: 'test-audio' });
    expect(adapterGenerate).toHaveBeenCalledWith(expect.objectContaining({
      referenceAudioUrls: [voiceUrl],
      referenceMedia: [expect.objectContaining({ kind: 'audio', url: voiceUrl, role: 'reference_audio' })],
    }));
  });

  it('工作流、文本和图片入口保留音频 URL 语义，不读取角色图片', async () => {
    expect(resolveNodeReferences(voiceMention())).toBe(voiceUrl);
    expect(await resolvePromptWithImageRefs(voiceMention())).toEqual({ prompt: voiceUrl, imageUrls: [] });
    const chat = await resolvePromptToChatContent(voiceMention());
    expect(typeof chat.content).toBe('string');
    expect(chat.textContent).toContain(voiceUrl);
    expect(chat.textContent).not.toContain('front.png');
  });

  it.each(['clip', 'character', 'url'])('已删除的 %s 明确失败，不替换成图片或另一段音频', async (missing) => {
    const card = voiceCharacter();
    if (missing === 'clip') card.voiceClips = card.voiceClips!.slice(0, 1);
    if (missing === 'url') card.voiceClips![1].audioUrl = '';
    useAppStore.setState({ dramaAssets: {
      ...emptyDramaAssetLibrary(), characters: missing === 'character' ? [] : [card],
    } });
    expect(() => collectPromptNodeMediaUrls(voiceMention())).toThrow('角色音频引用已失效');
    expect(() => resolveNodeReferences(voiceMention())).toThrow('角色音频引用已失效');
    await expect(resolvePromptWithMediaRefs(voiceMention())).rejects.toThrow('角色音频引用已失效');
    await expect(resolvePromptToChatContent(voiceMention())).rejects.toThrow('角色音频引用已失效');
  });

  it.each(['voice/', 'voice/%ZZ', 'voice/primary/extra'])('损坏后缀 %s 不回落到主视觉', async (pick) => {
    expect(parseDramaMentionId(`char_1#${pick}`).voiceClipId).toBe('');
    await expect(resolvePromptWithMediaRefs(`@drama{char_1#${pick}:音频}`)).rejects.toThrow('角色音频引用已失效');
  });
});

describe('视频请求中的角色素材归属', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
  });

  it('保留交错引用的位置、角色 ID 和声音用途，不包含样本台词', async () => {
    const first = voiceCharacter();
    first.referenceImages = [{ id: 'front', kind: 'primary', imageUrl: actionImage, prompt: '', createdAt: 0, updatedAt: 0 }];
    first.primaryReferenceImageId = 'front';
    first.voiceClips![1].transcript = '这是样本原台词';
    const second: DramaCharacter = { ...first, id: 'char_2', name: '另一个角色', voiceClips: [
      { ...first.voiceClips![1], id: 'line', kind: 'line', audioUrl: otherVoiceUrl },
    ] };
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters: [first, second] } });
    const prompt = `保留手写图片1 ${voiceMention()} @drama{char_2#front:另一个角色} @drama{char_1#front:林小满} @drama{${buildDramaVoiceMentionId('char_2', 'line')}:台词}`;
    const result = await resolvePromptWithMediaRefs(prompt, { preserveBindings: true });
    const bindings = result.segments!.filter((segment) => typeof segment !== 'string');
    expect(bindings.map((segment) => segment.character)).toEqual([
      { id: 'char_1', name: '林小满', usage: 'timbre' },
      { id: 'char_2', name: '另一个角色', usage: 'appearance' },
      { id: 'char_1', name: '林小满', usage: 'appearance' },
      { id: 'char_2', name: '另一个角色', usage: 'line' },
    ]);
    expect(result.segments![0]).toBe('保留手写图片1 ');
    expect(result.imageUrls).toEqual([actionImage]);
    expect(result.prompt).not.toContain('样本原台词');
    expect(JSON.stringify(result.segments)).not.toContain('样本原台词');
  });

  it('拼图与动作各自保留所属角色，声音不会替换成主视觉', async () => {
    const card = voiceCharacter();
    card.referenceImages = [
      { id: 'a', kind: 'primary', imageUrl: actionImage, prompt: '', createdAt: 0, updatedAt: 0 },
      { id: 'b', kind: 'turnaround', imageUrl: actionGif, prompt: '', createdAt: 0, updatedAt: 0 },
    ];
    useAppStore.setState({ dramaAssets: { ...emptyDramaAssetLibrary(), characters: [card] } });
    const merger = await import('../../src/services/characterReferenceMerge');
    const merge = vi.spyOn(merger, 'mergeReferenceImages').mockResolvedValue('data:image/png;base64,bWVyZ2Vk');
    try {
      const result = await resolvePromptWithMediaRefs(`@drama{char_1#all:林小满} ${actionMention('clip')} ${voiceMention()}`, { preserveBindings: true });
      const bindings = result.segments!.filter((segment) => typeof segment !== 'string');
      expect(bindings.map((segment) => [segment.reference.kind, segment.character?.usage])).toEqual([
        ['image', 'appearance'], ['video', 'action'], ['audio', 'timbre'],
      ]);
      expect(bindings.every((segment) => segment.character?.id === 'char_1')).toBe(true);
    } finally {
      merge.mockRestore();
    }
  });
});
