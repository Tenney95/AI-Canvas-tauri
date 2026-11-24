/**
 * reversePrompt — 回归测试：reversePrompt。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addReversePromptTextNode,
  addReversePromptTextNodes,
  isCompleteReversePromptResult,
  resolveVisionTextModel,
  reversePrompt,
  reversePromptDraft,
  type ReversePromptOutput,
  type ReversePromptResult,
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

describe('reversePromptDraft', () => {
  it.each<{
    format: ReversePromptOutput;
    response: string;
    instruction: string;
    expected: ReversePromptResult;
  }>([
    {
      format: 'positive',
      response: '  窗边的橘猫  ',
      instruction: '只输出正向提示词',
      expected: { prompt: '窗边的橘猫' },
    },
    {
      format: 'negative',
      response: '  水印，模糊画面  ',
      instruction: '只输出逆向提示词正文',
      expected: { negativePrompt: '水印，模糊画面' },
    },
    {
      format: 'positive-negative',
      response: '{"prompt":"窗边的橘猫","negativePrompt":"水印，模糊画面"}',
      instruction: '只输出 JSON 对象',
      expected: { prompt: '窗边的橘猫', negativePrompt: '水印，模糊画面' },
    },
  ])('$format 使用对应的提示词指令和草稿字段', async ({ format, response, instruction, expected }) => {
    setupTextModelAndNode('ai-image');
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: response } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(reversePromptDraft({
      kind: 'image',
      imageUrls: ['data:image/png;base64,Y2F0'],
      negativeRequirement: '水印',
      ...modelChoice,
    }, format)).resolves.toEqual(expected);

    const content = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).messages[0].content;
    expect(content[0].text).toContain(instruction);
    expect(content[0].text).toContain('【逆向补充要求（应排除）】水印');
  });

  it('双向协议分别约束正向描述与逆向排除，接受带围栏的 JSON', async () => {
    setupTextModelAndNode('ai-video');
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '```json\n{"prompt":" 缓慢推近 ","negativePrompt":" 镜头抖动 "}\n```' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reversePromptDraft({
      kind: 'video',
      imageUrls: ['data:image/png;base64,Y2F0'],
      ...modelChoice,
    }, 'positive-negative')).resolves.toEqual({ prompt: '缓慢推近', negativePrompt: '镜头抖动' });

    const content = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).messages[0].content;
    expect(content[0].text).toContain('以上对素材的描述约束适用于正向提示词');
    expect(content[0].text).toContain('应排除的画面瑕疵、主体运动及镜头运动偏差');
  });

  it.each(['正文', '{"prompt":"正文"}', '{"prompt":"正文","negativePrompt":"  "}', '{"prompt":1,"negativePrompt":"水印"}'])(
    '拒绝不完整的双向结果 %s', async (content) => {
      setupTextModelAndNode('ai-image');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content } }] })));
      await expect(reversePromptDraft({
        kind: 'image',
        imageUrls: ['data:image/png;base64,Y2F0'],
        ...modelChoice,
      }, 'positive-negative')).rejects.toThrow('模型未返回有效的正向和逆向提示词');
    },
  );

  it('逆向文本反推仅发送参考文本与已选补充，保留引用为文字', async () => {
    setupTextModelAndNode('ai-image');
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '水印' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reversePromptDraft({
      kind: 'text',
      imageUrls: [],
      sourceText: '窗边静物 @{node-source:参考图}',
      extraPrompt: '保留柔光',
      ...modelChoice,
    }, 'negative')).resolves.toEqual({ negativePrompt: '水印' });
    const content = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).messages[0].content;
    expect(content).toContain('只输出逆向提示词正文');
    expect(content).toContain('@\u200b{node-source:参考图}');
    expect(content).toContain('【额外要求】保留柔光');
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

describe('addReversePromptTextNodes', () => {
  it.each([false, true])('公共与逐图结果分别连接所用源节点（逐图：%s）', (individual) => {
    setupTextModelAndNode('ai-image');
    useAppStore.setState(({ nodes }) => ({ nodes: [...nodes, {
      ...nodes[0],
      id: 'node-second',
      position: { x: 550, y: 20 },
      data: { ...nodes[0].data, label: '第二张图片', displayId: 17 },
    }] }));

    const ids = addReversePromptTextNodes('images', individual ? [
      { sourceNodeIds: ['node-source'], prompt: '窗边静物' },
      { sourceNodeIds: ['node-second'], prompt: '室内植物' },
    ] : [
      { sourceNodeIds: ['node-source', 'node-second'], prompt: '室内柔光' },
    ]);

    const { nodes, edges, history } = useAppStore.getState();
    const created = nodes.slice(2);
    expect(created.map(({ data }) => data.displayId)).toEqual(individual ? [18, 19] : [18]);
    expect(created[0].position).toEqual({ x: 870, y: 20 });
    expect(edges.map(({ source, target }) => [source, target])).toEqual([
      ['node-source', ids[0]], ['node-second', individual ? ids[1] : ids[0]],
    ]);
    expect(history).toHaveLength(1);
  });

  it('只有逆向提示词时生成一个正确命名的节点并连到源图片', () => {
    setupTextModelAndNode('ai-image');

    const ids = addReversePromptTextNodes('image', [{
      sourceNodeIds: ['node-source'],
      negativePrompt: '  水印，模糊画面  ',
    }]);

    const { nodes, edges } = useAppStore.getState();
    expect(ids).toHaveLength(1);
    expect(nodes.find((node) => node.id === ids[0])).toMatchObject({
      type: 'ai-text',
      data: { label: '测试素材 · 逆向提示词', output: '水印，模糊画面' },
    });
    expect(edges[0]).toMatchObject({ source: 'node-source', target: ids[0] });
  });

  it('双向结果一次添加两个节点和两条连线，一次撤销全部', async () => {
    setupTextModelAndNode('ai-image');
    const ids = addReversePromptTextNodes('image', [{
      sourceNodeIds: ['node-source'],
      prompt: '窗边静物',
      negativePrompt: '水印',
    }]);

    const { nodes, edges, history, undo } = useAppStore.getState();
    expect(ids).toHaveLength(2);
    expect(nodes.slice(1).map((node) => [node.data.label, node.data.output, node.data.displayId])).toEqual([
      ['测试素材 · 正向提示词', '窗边静物', 10],
      ['测试素材 · 逆向提示词', '水印', 11],
    ]);
    expect(edges.map(({ source, target }) => [source, target])).toEqual(ids.map((id) => ['node-source', id]));
    expect(history).toHaveLength(1);
    expect(await undo()).toBe(true);
    expect(useAppStore.getState().nodes.map((node) => node.id)).toEqual(['node-source']);
    expect(useAppStore.getState().edges).toEqual([]);
  });

  it.each([false, true])('将反推节点登记为原分组成员并可一次回退（双向：%s）', async (dual) => {
    setupTextModelAndNode('ai-image', { parentId: 'group-1' });
    const group = { id: 'group-1', name: '分组', nodeIds: ['node-source'], color: 'blue', createdAt: 1 };
    useAppStore.setState(({ nodes }) => ({
      groups: [group],
      nodes: [{
        id: group.id, type: 'group', position: { x: 30, y: 20 },
        data: { type: 'comment', label: group.name, groupId: group.id },
      }, ...nodes],
    }));

    const ids = addReversePromptTextNodes('image', [{
      sourceNodeIds: ['node-source'], prompt: '窗边静物', ...(dual ? { negativePrompt: '水印' } : {}),
    }]);

    const { groups, nodes, history, undo } = useAppStore.getState();
    expect(ids).toHaveLength(dual ? 2 : 1);
    expect(groups[0].nodeIds).toEqual(['node-source', ...ids]);
    expect(nodes.slice(2).map((node) => node.parentId)).toEqual(ids.map(() => group.id));
    expect(history).toHaveLength(1);
    expect(await undo()).toBe(true);
    expect(useAppStore.getState().groups).toEqual([group]);
  });

  it('拒绝仅填写一半的双向草稿和缺失来源，保持画布与历史完整', () => {
    setupTextModelAndNode('ai-image');
    const initial = useAppStore.getState();
    const incomplete = { sourceNodeIds: ['node-source'], prompt: '窗边静物', negativePrompt: ' ' };
    expect(isCompleteReversePromptResult(incomplete)).toBe(false);
    expect(addReversePromptTextNodes('image', [incomplete])).toEqual([]);
    expect(addReversePromptTextNodes('images', [
      { sourceNodeIds: ['node-source'], prompt: '窗边静物' },
      { sourceNodeIds: ['missing-source'], negativePrompt: '水印' },
    ])).toEqual([]);
    const after = useAppStore.getState();
    expect(after.nodes).toBe(initial.nodes);
    expect(after.edges).toBe(initial.edges);
    expect(after.history).toBe(initial.history);
  });
});
