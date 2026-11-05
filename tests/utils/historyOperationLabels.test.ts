/**
 * historyOperationLabels — 回归测试：从快照差异推断操作名。
 */
import { describe, expect, it } from 'vitest';
import {
  describeCanvasChange,
  type HistorySnapshotLike,
} from '../../src/utils/historyOperationLabels';
import type { BaseNodeData, NodeGroup } from '../../src/types';
import { getLocale, setLocale } from '../../src/i18n';

function node(
  id: string,
  type = 'ai-image',
  position = { x: 0, y: 0 },
  data: Partial<BaseNodeData> = {},
): HistorySnapshotLike['nodes'][number] {
  return { id, type, position, data: { type, label: id, ...data } as BaseNodeData };
}

function group(id: string, nodeIds: string[], name = '分组'): NodeGroup {
  return { id, name, nodeIds, color: '#6366f1', createdAt: 1 };
}

function snapshot(partial: Partial<HistorySnapshotLike> = {}): HistorySnapshotLike {
  return { nodes: [], edges: [], groups: [], ...partial };
}

describe('从快照差异推断操作名', () => {
  it('translates dynamic node counts and connection counts', () => {
    const previousLocale = getLocale();
    try {
      setLocale('en-US');
      expect(describeCanvasChange(snapshot(), snapshot({ nodes: [node('a'), node('b')] })).title)
        .toBe('Added 2 Generate Image nodes');
      expect(describeCanvasChange(snapshot(), snapshot({ edges: [{ id: 'a' }, { id: 'b' }] })).title)
        .toBe('Added 2 connections');
    } finally {
      setLocale(previousLocale);
    }
  });

  it('单个新增节点用节点类型命名', () => {
    const result = describeCanvasChange(
      snapshot(),
      snapshot({ nodes: [node('n1', 'ai-image')] }),
    );
    expect(result.title).toBe('新增 生成图像');
  });

  it('同类型批量新增合并计数', () => {
    const result = describeCanvasChange(
      snapshot(),
      snapshot({ nodes: [node('n1', 'ai-video'), node('n2', 'ai-video')] }),
    );
    expect(result.title).toBe('新增 2 个生成视频');
  });

  it('混合类型批量新增退回通用计数', () => {
    const result = describeCanvasChange(
      snapshot(),
      snapshot({ nodes: [node('n1', 'ai-video'), node('n2', 'ai-text')] }),
    );
    expect(result.title).toBe('新增 2 个节点');
  });

  it('识别删除', () => {
    const result = describeCanvasChange(
      snapshot({ nodes: [node('n1'), node('n2')] }),
      snapshot({ nodes: [node('n1')] }),
    );
    expect(result.title).toBe('删除 生成图像');
  });

  it('识别连线的新增与断开', () => {
    const before = snapshot({ nodes: [node('n1'), node('n2')] });
    const after = snapshot({ nodes: [node('n1'), node('n2')], edges: [{ id: 'e1' }] });

    expect(describeCanvasChange(before, after).title).toBe('连接节点');
    expect(describeCanvasChange(after, before).title).toBe('断开连线');
  });

  it('识别分组的新建、解散与成员调整', () => {
    const base = snapshot({ nodes: [node('n1'), node('n2')] });
    const grouped = snapshot({ nodes: base.nodes, groups: [group('g1', ['n1'])] });
    const regrouped = snapshot({ nodes: base.nodes, groups: [group('g1', ['n1', 'n2'])] });

    expect(describeCanvasChange(base, grouped).title).toBe('新建分组');
    expect(describeCanvasChange(grouped, base).title).toBe('解散分组');
    expect(describeCanvasChange(grouped, regrouped).title).toBe('调整分组');
  });

  it('内容编辑优先于位置变化', () => {
    const before = snapshot({ nodes: [node('n1', 'ai-text', { x: 0, y: 0 }, { prompt: '旧' })] });
    const after = snapshot({ nodes: [node('n1', 'ai-text', { x: 50, y: 0 }, { prompt: '新' })] });

    expect(describeCanvasChange(before, after).title).toBe('编辑 生成文本');
  });

  it('只有位置变化时报告移动', () => {
    const before = snapshot({ nodes: [node('n1', 'ai-image', { x: 0, y: 0 })] });
    const after = snapshot({ nodes: [node('n1', 'ai-image', { x: 40, y: 10 })] });

    expect(describeCanvasChange(before, after).title).toBe('移动节点位置');
  });

  it('只有尺寸变化时报告调整尺寸，且不算作内容编辑', () => {
    const before = snapshot({ nodes: [node('n1', 'ai-image', { x: 0, y: 0 }, { nodeWidth: 280 })] });
    const after = snapshot({ nodes: [node('n1', 'ai-image', { x: 0, y: 0 }, { nodeWidth: 360 })] });

    expect(describeCanvasChange(before, after).title).toBe('调整节点大小');
  });

  it('识别 React Flow 样式尺寸变化', () => {
    const beforeNode = { ...node('group', 'group'), style: { width: 320, height: 200 } };
    const afterNode = { ...node('group', 'group'), style: { width: 480, height: 300 } };

    expect(describeCanvasChange(
      snapshot({ nodes: [beforeNode] }),
      snapshot({ nodes: [afterNode] }),
    ).title).toBe('调整节点大小');
  });

  it.each([
    { dimensions: { width: 1000, height: 700, style: { width: 300, height: 200 }, measured: { width: 900, height: 600 } },
      expandedSize: { width: 1000, height: 700 } },
    { dimensions: { style: { width: 300, height: 240 }, measured: { width: 900, height: 600 } },
      expandedSize: { width: 300, height: 240 } },
    { dimensions: { measured: { width: 900, height: 600 } }, expandedSize: { width: 900, height: 600 } },
    { dimensions: {}, expandedSize: { width: 320, height: 200 } },
  ])('分组开合按展开尺寸比较，不误报内容或尺寸变化：$expandedSize', ({ dimensions, expandedSize }) => {
    const expanded = { ...node('g1', 'group', { x: 0, y: 0 }, {
      type: 'comment', groupId: 'g1', groupExpandedSize: { width: 500, height: 350 },
    }), ...dimensions };
    const collapsed = { ...expanded, width: 220, height: 152, measured: { width: 220, height: 152 },
      style: { width: 220, height: 152 },
      data: { ...expanded.data, groupCollapsed: true, groupExpandedSize: expandedSize },
    };
    const before = snapshot({ nodes: [expanded], groups: [group('g1', [])] });
    const after = snapshot({ nodes: [collapsed], groups: before.groups });

    expect(describeCanvasChange(before, after).title).toBe('画布修改');
    expect(describeCanvasChange(after, before).title).toBe('画布修改');
  });

  it.each([false, true])('仍能识别分组实际缩放，含收起时的展开尺寸变化（原先收起：%s）', (initiallyCollapsed) => {
    const original = node('g1', 'group', { x: 0, y: 0 }, { type: 'comment', groupId: 'g1' });
    const beforeNode = { ...original,
      width: initiallyCollapsed ? 220 : 1000,
      height: initiallyCollapsed ? 152 : 700,
      style: { width: initiallyCollapsed ? 220 : 1000, height: initiallyCollapsed ? 152 : 700 },
      data: { ...original.data, groupCollapsed: initiallyCollapsed || undefined,
        groupExpandedSize: { width: 1000, height: 700 } },
    };
    const afterNode = { ...beforeNode, width: 220, height: 152, style: { width: 220, height: 152 },
      data: { ...original.data, groupCollapsed: true, groupExpandedSize: { width: 1200, height: 900 } },
    };
    const before = snapshot({ nodes: [beforeNode], groups: [group('g1', [])] });
    const after = snapshot({ nodes: [afterNode], groups: before.groups });

    expect(describeCanvasChange(before, after).title).toBe('调整节点大小');
    expect(describeCanvasChange(after, before).title).toBe('调整节点大小');
  });

  it('完全相同的快照退回通用描述', () => {
    const same = snapshot({ nodes: [node('n1')], edges: [{ id: 'e1' }], groups: [group('g1', ['n1'])] });

    expect(describeCanvasChange(same, same).title).toBe('画布修改');
  });

  it('嵌套对象内容变化能被发现（引用不同但值相同不算变化）', () => {
    const before = snapshot({
      nodes: [node('n1', 'ai-storyboard', { x: 0, y: 0 }, { storyboardOverrides: [null, null] })],
    });
    const sameValue = snapshot({
      nodes: [node('n1', 'ai-storyboard', { x: 0, y: 0 }, { storyboardOverrides: [null, null] })],
    });
    const changed = snapshot({
      nodes: [node('n1', 'ai-storyboard', { x: 0, y: 0 }, {
        storyboardOverrides: [{ url: 'a.png' }, null],
      } as Partial<BaseNodeData>)],
    });

    expect(describeCanvasChange(before, sameValue).title).toBe('画布修改');
    expect(describeCanvasChange(before, changed).title).toBe('编辑 宫格分镜');
  });
});
