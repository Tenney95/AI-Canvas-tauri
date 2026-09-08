import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAMA_MENTION_MERGE_ALL,
  buildDramaMentionId,
  buildDramaActionMentionId,
  emptyDramaAssetLibrary,
  parseDramaMentionId,
} from '../../src/types/dramaAssets';
import { resolveDramaActionMediaRef, resolveDramaAssetImageRef } from '../../src/services/dramaAssetPrompt';
import type { DramaCharacter } from '../../src/types/dramaAssets';
import { useAppStore } from '../../src/store/useAppStore';
import { resolvePromptToChatContent, resolvePromptWithImageRefs, resolvePromptWithMediaRefs } from '../../src/services/ai/promptResolver';
import { resolveNodeReferences } from '../../src/services/nodeReferenceService';
import { renderPromptToNodes, serializeDOM } from '../../src/components/nodes/shared/mentionEditorDom';

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

  it('保存后的图片与视频标签恢复正确类型和缩略图，并保持序列化引用', () => {
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
      const prompt = `${actionMention('pose')} ${actionMention('clip')}`;
      const rendered = renderPromptToNodes(prompt, new Map());
      const chips = rendered.filter((node) => node.nodeType === 1) as unknown as ElementStub[];
      expect(chips[0].getAttribute('data-drama-kind')).toBe('action-image');
      const icon = chips[0].childNodes[0] as ElementStub;
      expect((icon.childNodes[0] as ElementStub).src).toBe(actionImage);
      expect(chips[1].getAttribute('data-drama-kind')).toBe('action-video');
      expect(chips[1].className).toContain('chip-video');
      expect(chips[1].hasAttribute('data-image-ref-key')).toBe(false);
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
