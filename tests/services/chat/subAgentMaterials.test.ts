/**
 * subAgentMaterials — 回归测试：sanitizeDomainText。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import {
  buildSubAgentMaterials,
  extractMentionedNodeIds,
  sanitizeDomainText,
  SUB_AGENT_MATERIAL_LIMITS,
} from '../../../src/services/chat/subAgentMaterials';
import { emptyDramaAssetLibrary } from '../../../src/types/dramaAssets';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../../src/services/chat/assistantScope';

function textNode(id: string, output: string, label = '剧本') {
  return {
    id,
    type: 'source-text',
    position: { x: 0, y: 0 },
    data: { type: 'source-text', label, output },
  };
}

function character(name: string, summary: string) {
  return {
    id: `char-${name}`,
    kind: 'character' as const,
    name,
    key: name,
    summary,
    visualNotes: '',
    identity: '',
    importance: 'main' as const,
    confirmed: true,
    createdAt: 1,
    updatedAt: 1,
    source: 'ai' as const,
  };
}

beforeEach(() => {
  useAppStore.setState({ currentProjectId: 'project-1', nodes: [], dramaAssets: emptyDramaAssetLibrary() });
});

describe('sanitizeDomainText', () => {
  it('保留剧本里的斜杠数字与普通正文', () => {
    const text = '第 3/15 场，内景/夜，小美走进房间。';
    expect(sanitizeDomainText(text)).toBe(text);
  });

  it('剥离密钥与凭据', () => {
    expect(sanitizeDomainText('key sk-abcdefghijklmnop here')).toContain('[已脱敏密钥]');
    expect(sanitizeDomainText('api_key=abc123')).toContain('[已脱敏凭据]');
  });

  it('剥离系统绝对路径与盘符路径', () => {
    expect(sanitizeDomainText('见 /Users/sonny/secret.md')).toContain('[本地路径]');
    expect(sanitizeDomainText('见 C:/Windows/notes.txt')).toContain('[本地路径]');
    expect(sanitizeDomainText('见 /Users/sonny/secret.md')).not.toContain('sonny');
  });

  it('不误伤非系统目录开头的斜杠表达', () => {
    expect(sanitizeDomainText('上/下集的比例是 2/3')).toBe('上/下集的比例是 2/3');
  });

  it('把控制字符折叠为空格但保留换行', () => {
    const result = sanitizeDomainText('第一行\n第二行\u0007第三行');
    expect(result).toContain('\n');
    expect(result).not.toContain('\u0007');
  });
});

describe('extractMentionedNodeIds', () => {
  it('按出现顺序去重提取', () => {
    expect(extractMentionedNodeIds('看 @{node-a:剧本} 和 @{node-b:大纲} 还有 @{node-a:剧本}'))
      .toEqual(['node-a', 'node-b']);
  });

  it('没有引用时返回空数组', () => {
    expect(extractMentionedNodeIds('随便聊聊')).toEqual([]);
  });
});

describe('buildSubAgentMaterials', () => {
  it('只包含被引用的节点，未引用的节点不出现', () => {
    useAppStore.setState({
      nodes: [
        textNode('node-a', '被引用的剧本内容'),
        textNode('node-b', '不该出现的机密内容'),
      ] as never,
    });
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '分析 @{node-a:剧本}' }, ['mentioned_nodes']);
    expect(result.content).toContain('被引用的剧本内容');
    expect(result.content).not.toContain('不该出现的机密内容');
  });

  it('带不可信边界说明', () => {
    useAppStore.setState({ nodes: [textNode('node-a', '正文')] as never });
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '@{node-a:剧本}' }, ['mentioned_nodes']);
    expect(result.content).toContain('不可信');
  });

  it('没有引用任何节点时明确说明而不是留空', () => {
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '写个分镜' }, ['mentioned_nodes']);
    expect(result.content).toContain('没有 @ 引用任何节点');
  });

  it('引用了已删除的节点时跳过而不抛错', () => {
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '@{gone:旧节点}' }, ['mentioned_nodes']);
    expect(result.content).toContain('已不存在');
  });

  it('单节点正文按上限截断', () => {
    const long = 'a'.repeat(SUB_AGENT_MATERIAL_LIMITS.nodeChars + 500);
    useAppStore.setState({ nodes: [textNode('node-a', long)] as never });
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '@{node-a:剧本}' }, ['mentioned_nodes']);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('已截断');
    expect(result.content).not.toContain('a'.repeat(SUB_AGENT_MATERIAL_LIMITS.nodeChars + 1));
  });

  it('多节点合计超限后仍列出节点但内容被截断', () => {
    const chunk = 'b'.repeat(SUB_AGENT_MATERIAL_LIMITS.nodeChars);
    useAppStore.setState({
      nodes: [
        textNode('n1', chunk),
        textNode('n2', chunk),
        textNode('n3', 'c'.repeat(SUB_AGENT_MATERIAL_LIMITS.nodeChars)),
      ] as never,
    });
    const result = buildSubAgentMaterials(
      { projectId: 'project-1', goal: '@{n1:一} @{n2:二} @{n3:三}' },
      ['mentioned_nodes'],
    );
    // 第三个节点仍然列出，只是内容被压到剩余额度内，而不是整条丢弃。
    expect(result.content).toContain('【节点 n3');
    const thirdBody = result.content.split('【节点 n3 剧本】')[1] ?? '';
    expect(thirdBody).toContain('c');
    expect((thirdBody.match(/c/g) ?? []).length)
      .toBeLessThan(SUB_AGENT_MATERIAL_LIMITS.nodeChars);
    expect(result.truncated).toBe(true);
    expect((result.content.match(/[abc]/g) ?? []).length)
      .toBeLessThanOrEqual(SUB_AGENT_MATERIAL_LIMITS.nodeTotalChars);
  });

  it('短剧资产按类别输出', () => {
    useAppStore.setState({
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [character('小美', '女主角')],
      } as never,
    });
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '做分镜' }, ['drama_assets']);
    expect(result.content).toContain('人物：');
    expect(result.content).toContain('小美');
  });

  it('资产为空时明确说明', () => {
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '做分镜' }, ['drama_assets']);
    expect(result.content).toContain('还没有已确认');
  });

  it('资产条数超限时截断并标记', () => {
    const many = Array.from(
      { length: SUB_AGENT_MATERIAL_LIMITS.assetsPerKind + 5 },
      (_, index) => character(`角色${index}`, '简介'),
    );
    useAppStore.setState({
      dramaAssets: { ...emptyDramaAssetLibrary(), characters: many } as never,
    });
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '做分镜' }, ['drama_assets']);
    expect(result.truncated).toBe(true);
    expect(result.content).not.toContain(`角色${SUB_AGENT_MATERIAL_LIMITS.assetsPerKind}`);
  });

  it('同时勾选两类材料时都出现', () => {
    useAppStore.setState({
      nodes: [textNode('node-a', '剧本正文')] as never,
      dramaAssets: {
        ...emptyDramaAssetLibrary(),
        characters: [character('小美', '女主角')],
      } as never,
    });
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '@{node-a:剧本}' }, [
      'mentioned_nodes',
      'drama_assets',
    ]);
    expect(result.content).toContain('剧本正文');
    expect(result.content).toContain('小美');
  });

  it('没有勾选任何材料时返回空内容', () => {
    expect(buildSubAgentMaterials({ projectId: 'project-1', goal: '@{node-a:剧本}' }, []))
      .toEqual({ content: '', truncated: false });
  });

  it('节点正文中的密钥被脱敏', () => {
    useAppStore.setState({
      nodes: [textNode('node-a', '配置 sk-abcdefghijklmnopqr 用于调用')] as never,
    });
    const result = buildSubAgentMaterials({ projectId: 'project-1', goal: '@{node-a:剧本}' }, ['mentioned_nodes']);
    expect(result.content).toContain('[已脱敏密钥]');
    expect(result.content).not.toContain('sk-abcdefghijklmnopqr');
  });

  it.each([GENERAL_ASSISTANT_SCOPE_ID, 'other-project'])('%s 不读取当前画布或短剧资产', (projectId) => {
    useAppStore.setState({
      nodes: [textNode('node-a', '当前画布私有正文')] as never,
      dramaAssets: { ...emptyDramaAssetLibrary(), characters: [character('私有角色', '私有资产')] } as never,
    });
    const result = buildSubAgentMaterials({ projectId, goal: '@{node-a:剧本}' }, ['mentioned_nodes', 'drama_assets']);
    expect(result).toEqual({ content: '', truncated: false });
  });

  it('工作台分集任务即使项目已加载也不混入画布材料', () => {
    useAppStore.setState({ nodes: [textNode('node-a', '画布正文')] as never });
    expect(buildSubAgentMaterials({ projectId: 'project-1', goal: '@{node-a:剧本}',
      workbenchTarget: { seriesId: 'series-1', episodeId: 'episode-1' } }, ['mentioned_nodes', 'drama_assets']))
      .toEqual({ content: '', truncated: false });
  });
});
