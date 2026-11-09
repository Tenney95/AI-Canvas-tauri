/**
 * reversePrompt — 回归测试：reversePrompt。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addReversePromptTextNode,
  resolveVisionTextModel,
  reversePrompt,
} from '../../src/services/ai/reversePrompt';
import { useAppStore } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';
import { saveModelPreference } from '../../src/services/modelPreferenceService';

const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

function setupTextModelAndNode(
  nodeType: 'ai-image' | 'ai-video',
  node: { position?: { x: number; y: number }; parentId?: string } = {},
) {
  useAppStore.setState((state) => ({
    config: {
      ...state.config,
      providers: {
        ...state.config.providers,
        'vision-provider': {
          name: '视觉连接',
          apiKey: 'secret',
          baseUrl: 'https://gateway.example',
          catalogId: 'custom-openai',
        },
      },
      generalModels: [{
        id: 'vision-text',
        name: '视觉文本',
        modelId: 'vendor-vision',
        category: 'text',
        providerConfigId: 'vision-provider',
      }],
    },
    nodes: [{
      id: 'node-source',
      type: nodeType,
      position: node.position ?? { x: 100, y: 40 },
      ...(node.parentId ? { parentId: node.parentId } : {}),
      data: {
        label: '测试素材',
        type: nodeType,
        nodeWidth: 280,
      } as BaseNodeData,
    }],
    edges: [],
  }));
}

const modelChoice = { model: 'general/vision-text', provider: 'general' };

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('reversePrompt', () => {
  it('把图片接在指令后面发给文本模型，并去掉结果首尾空白', async () => {
    setupTextModelAndNode('ai-image');
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '  一只橘猫坐在窗台，逆光，浅景深  ' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await reversePrompt({
      kind: 'image',
      imageUrls: ['data:image/png;base64,Y2F0'],
      ...modelChoice,
    });

    expect(result).toBe('一只橘猫坐在窗台，逆光，浅景深');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('vendor-vision');
    expect(body.messages[0].content[0].text).toContain('反推出一段能重新生成它的提示词');
    expect(body.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,Y2F0' },
    });
  });

  it('视频按顺序带上多张关键帧，并把补充要求拼进指令', async () => {
    setupTextModelAndNode('ai-video');
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '镜头缓慢推近' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const frames = [
      'data:image/png;base64,ZjE=',
      'data:image/png;base64,ZjI=',
      'data:image/png;base64,ZjM=',
    ];
    await reversePrompt({ kind: 'video', imageUrls: frames, extraPrompt: '输出英文', ...modelChoice });

    const content = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).messages[0].content;
    expect(content[0].text).toContain('按时间顺序抽的关键帧');
    expect(content[0].text).toContain('【额外要求】输出英文');
    expect(content.slice(1).map((part: { image_url: { url: string } }) => part.image_url.url)).toEqual(frames);
  });

  it('接口拒收图片时，报错里带上换模型的提示', async () => {
    setupTextModelAndNode('ai-image');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: 'messages[0]: unknown variant `image_url`, expected `text`' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(reversePrompt({
      kind: 'image',
      imageUrls: ['data:image/png;base64,Y2F0'],
      ...modelChoice,
    })).rejects.toThrow(/不接受图片输入[\s\S]*unknown variant/);
  });

  it('没有素材时不发请求', async () => {
    setupTextModelAndNode('ai-image');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(reversePrompt({ kind: 'image', imageUrls: [], ...modelChoice })).rejects.toThrow('没有可反推的图片');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveVisionTextModel', () => {
  it('Muse 显式声明看图时保留用户偏好，不按名称误切到其它厂商', () => {
    setupTextModelAndNode('ai-image');
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, muse: { name: 'Muse', apiKey: '', catalogId: 'muse', selectedModels: [
        { id: 'muse-chat', name: 'Muse 对话', category: 'text', provider: 'muse', inputModalities: ['text', 'image'] },
      ] } },
      generalModels: [...(state.config.generalModels ?? []), { id: 'vision-4o', name: '其它看图模型',
        modelId: 'gpt-4o', category: 'text', providerConfigId: 'vision-provider' }],
    } }));
    saveModelPreference('ai-text', 'muse/muse-chat');
    expect(resolveVisionTextModel()).toEqual({ model: 'muse/muse-chat', provider: 'muse' });
  });

  it('偏好模型读不了图时，改挑已配置的视觉模型', () => {
    setupTextModelAndNode('ai-image');
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        generalModels: [
          ...(state.config.generalModels ?? []),
          {
            id: 'vision-4o',
            name: '看图模型',
            modelId: 'gpt-4o',
            category: 'text',
            providerConfigId: 'vision-provider',
          },
        ],
      },
    }));

    expect(resolveVisionTextModel()).toEqual({ model: 'general/vision-4o', provider: 'general' });
  });
});

describe('addReversePromptTextNode', () => {
  it('文本节点落在源节点右侧并连线', () => {
    setupTextModelAndNode('ai-image', { position: { x: 100, y: 40 } });

    addReversePromptTextNode('node-source', 'image', '一段提示词');

    const { nodes, edges } = useAppStore.getState();
    const created = nodes.find((node) => node.id !== 'node-source');
    expect(created?.type).toBe('ai-text');
    expect(created?.data.label).toBe('测试素材 反推提示词');
    expect(created?.data.output).toBe('一段提示词');
    // 源节点 x=100、宽 280、间距 40
    expect(created?.position).toEqual({ x: 420, y: 40 });
    expect(edges[0]).toMatchObject({ source: 'node-source', target: created?.id });
  });

  it('源节点在分组里时继承 parentId，否则相对坐标会把节点甩飞', () => {
    setupTextModelAndNode('ai-image', { position: { x: 20, y: 10 }, parentId: 'group-1' });

    addReversePromptTextNode('node-source', 'image', '一段提示词');

    const created = useAppStore.getState().nodes.find((node) => node.id !== 'node-source');
    expect(created?.parentId).toBe('group-1');
    expect(created?.position).toEqual({ x: 340, y: 10 });
  });
});
