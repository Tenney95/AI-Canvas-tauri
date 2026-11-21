import { expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../../src/types';
import { createCanvasNoteData } from '../../../src/types';
import { useAppStore } from '../../../src/store/useAppStore';

export function registerGroupLayoutTests(node: (id: string) => Node<BaseNodeData>) {
  function group(id: string, x: number, width: number, y = 100, parentId?: string): Node<BaseNodeData> {
    return {
      id, type: 'group', parentId, position: { x, y }, width, height: 600,
      style: { width, height: 600 }, measured: { width, height: 600 },
      data: { type: 'comment', label: id, groupId: id },
    };
  }
  function scene(extra: Node<BaseNodeData>[] = []) {
    const a = group('shift-a', 0, 1000);
    const b = group('shift-b', 1100, 600);
    const child = { ...node('shift-child'), parentId: b.id, position: { x: 20, y: 40 } };
    const tail = { ...node('shift-tail'), position: { x: 1800, y: 100 } };
    const nodes = [a, b, child, tail, ...extra];
    useAppStore.setState({ nodes, edges: [{ id: 'shift-edge', source: child.id, target: tail.id }],
      groups: nodes.filter((item) => item.type === 'group').map((item) => ({
        id: item.id, name: item.id, nodeIds: nodes.filter((child) => child.parentId === item.id).map((child) => child.id),
        color: '#888888', createdAt: 0,
      })) });
    return { a, b, child, tail };
  }
  const current = (id: string) => useAppStore.getState().nodes.find((item) => item.id === id)!;
  const toggle = (id: string) => useAppStore.getState().toggleGroupCollapsed(id);

  function foldedGroup(id: string, x: number, width: number, y = 100) {
    const expanded = group(id, x, width, y);
    return {
      ...expanded, width: 220, height: 152, style: { width: 220, height: 152 },
      measured: { width: 220, height: 152 },
      data: { ...expanded.data, groupCollapsed: true, groupExpandedSize: { width, height: 600 } },
    };
  }
  function foldedScene(extra: Node<BaseNodeData>[] = []) {
    const result = scene(extra);
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => {
      if (item.id === result.a.id) return foldedGroup(item.id, 0, 1000);
      if (item.id === result.b.id) return { ...item, position: { x: 320, y: 100 } };
      if (item.id === result.tail.id) return { ...item, position: { x: 1020, y: 100 } };
      return item;
    }) });
    return { a: current(result.a.id), b: current(result.b.id), child: current(result.child.id), tail: current(result.tail.id) };
  }

  function verticalScene(collapsed = true, extra: Node<BaseNodeData>[] = []) {
    const a = collapsed ? foldedGroup('vertical-a', 0, 1000) : group('vertical-a', 0, 1000);
    const b = foldedGroup('vertical-b', 0, 600, collapsed ? 520 : 968);
    const child = { ...node('vertical-child'), parentId: b.id, position: { x: 20, y: 40 } };
    const tail = { ...node('vertical-tail'), position: { x: 0, y: collapsed ? 840 : 1288 } };
    const nodes = [a, b, child, tail, ...extra];
    useAppStore.setState({ nodes, edges: [{ id: 'vertical-edge', source: child.id, target: tail.id }],
      groups: nodes.filter((item) => item.type === 'group').map((item) => ({
        id: item.id, name: item.id, nodeIds: nodes.filter((member) => member.parentId === item.id).map((member) => member.id),
        color: '#888888', createdAt: 0,
      })) });
    return { a, b, child, tail };
  }

  it('同列下方文件夹在上方展开时向下让位，保持横坐标、组内位置和连线，其他列不动', () => {
    const otherColumn = { ...node('vertical-other-column'), position: { x: 1400, y: 520 } };
    const { a, b, child, tail } = verticalScene(true, [otherColumn]);
    const edges = useAppStore.getState().edges;
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 0, y: 968 });
      expect(current(tail.id).position).toEqual({ x: 0, y: 1288 });
      expect(current(child.id).position).toEqual(child.position);
      expect(current(otherColumn.id).position).toEqual(otherColumn.position);
      expect(useAppStore.getState().edges).toBe(edges);
      toggle(a.id);
      expect(current(b.id).position).toEqual(b.position);
      expect(current(tail.id).position).toEqual(tail.position);
    }
  });

  it('正常展开分组收起后，下方同列内容按高度差靠近，再展开还原', () => {
    const { a, b, tail } = verticalScene(false);
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 0, y: 520 });
    expect(current(tail.id).position).toEqual({ x: 0, y: 840 });
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
  });

  it.each([false, true])('旧横向正让位名单中的同列下方分组改按纵向让位，往返不漂移（保存旧展开态：%s）', (savedExpanded) => {
    const nonce = process.env.GROUP_LAYOUT_VERIFY_NONCE ?? 'local';
    const b = foldedGroup(`legacy-column-b-${nonce}`, 112, 600, 312);
    const original = group(`legacy-column-a-${nonce}`, 112, 1072, -75);
    const size = savedExpanded ? { width: 1072, height: 1016 } : { width: 220, height: 152 };
    const a = { ...original, ...size, style: size, measured: size, data: { ...original.data,
      groupCollapsed: savedExpanded ? undefined : true, groupExpandedSize: { width: 1072, height: 1016 },
      groupCollapseLayout: { deltaX: -852, nodeIds: [], expandedNodeIds: [b.id] },
    } };
    const previousB = savedExpanded
      ? { ...b, position: { x: 964, y: 312 }, data: { ...b.data, groupLayoutOffsetX: 852 } } : b;
    useAppStore.setState({ nodes: [a, previousB], edges: [], groups: [] });
    const saved = JSON.parse(JSON.stringify(useAppStore.getState().nodes)) as Node<BaseNodeData>[];
    useAppStore.setState({ nodes: [] });
    useAppStore.setState({ nodes: saved });
    if (savedExpanded) {
      toggle(a.id);
      expect(current(b.id).position).toEqual(b.position);
    }
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 112, y: 1176 });
      expect(current(b.id).data.groupLayoutOffsetX ?? 0).toBe(0);
      toggle(a.id);
      expect(current(b.id).position).toEqual(b.position);
    }
    if (!savedExpanded && process.env.GROUP_LAYOUT_VERIFY_NONCE) {
      console.info('GROUP_LAYOUT_E2E=' + JSON.stringify({ nonce, id: current(b.id).id,
        position: current(b.id).position, source: current(a.id).data.label }));
    }
  });

  it('已有横向让位的目标收起后从右侧移到下方，再展开重新按纵向让位并保留手动位置', () => {
    const nonce = process.env.GROUP_LAYOUT_VERIFY_NONCE ?? 'local';
    const a = foldedGroup(`manual-axis-x-source-${nonce}`, 0, 1000);
    const b = foldedGroup(`manual-axis-x-target-${nonce}`, 320, 600);
    useAppStore.setState({ nodes: [a, b], edges: [], groups: [] });
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
    toggle(a.id);
    useAppStore.getState().onNodesChange([{ id: b.id, type: 'position', position: { x: 0, y: 520 } }]);
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 0, y: 968 });
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 0, y: 520 });
    }
  });

  it('已有纵向让位的目标收起后从下方移到右侧，再展开重新按横向让位并保留手动位置', () => {
    const nonce = process.env.GROUP_LAYOUT_VERIFY_NONCE ?? 'local';
    const a = foldedGroup(`manual-axis-y-source-${nonce}`, 0, 1000);
    const b = foldedGroup(`manual-axis-y-target-${nonce}`, 0, 600, 520);
    useAppStore.setState({ nodes: [a, b], edges: [], groups: [] });
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 0, y: 968 });
    toggle(a.id);
    useAppStore.getState().onNodesChange([{ id: b.id, type: 'position', position: { x: 320, y: 100 } }]);
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 320, y: 100 });
    }
  });

  it.each(['locked', 'hidden'] as const)('已有正向让位目标在收起后被设为%s，重复开合也保持当前位置', (blocked) => {
    const nonce = process.env.GROUP_LAYOUT_VERIFY_NONCE ?? 'local';
    const a = foldedGroup(`blocked-layout-source-${blocked}-${nonce}`, 0, 1000);
    const b = foldedGroup(`blocked-layout-target-${blocked}-${nonce}`, 320, 600);
    useAppStore.setState({ nodes: [a, b], edges: [], groups: [] });
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
    toggle(a.id);
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === b.id
      ? { ...item, ...(blocked === 'locked' ? { draggable: false } : { hidden: true }) } : item) });
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual(b.position);
      toggle(a.id);
      expect(current(b.id).position).toEqual(b.position);
    }
  });

  it.each(['locked', 'hidden'] as const)('已有正向让位目标处于活动状态时被设为%s，开合冻结可见位置，解除后仍可回到手动基线', (blocked) => {
    const nonce = process.env.GROUP_LAYOUT_VERIFY_NONCE ?? 'local';
    const a = foldedGroup(`active-blocked-source-${blocked}-${nonce}`, 0, 1000);
    const b = foldedGroup(`active-blocked-target-${blocked}-${nonce}`, 320, 600);
    useAppStore.setState({ nodes: [a, b], edges: [], groups: [] });
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === b.id
      ? { ...item, ...(blocked === 'locked' ? { draggable: false } : { hidden: true }) } : item) });
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
    }
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === b.id
      ? { ...item, ...(blocked === 'locked' ? { draggable: true } : { hidden: false }) } : item) });
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
  });

  it('旧横向名单中的同列下方分组与其同排后继一起转为纵向让位', () => {
    const nonce = process.env.GROUP_LAYOUT_VERIFY_NONCE ?? 'local';
    const b = foldedGroup(`legacy-lower-row-b-${nonce}`, 112, 600, 312);
    const c = foldedGroup(`legacy-lower-row-c-${nonce}`, 432, 500, 312);
    const source = foldedGroup(`legacy-lower-row-a-${nonce}`, 112, 1000, -75);
    const a = { ...source, data: { ...source.data, groupExpandedSize: { width: 1000, height: 1100 },
      groupCollapseLayout: { deltaX: -780, nodeIds: [], expandedNodeIds: [b.id, c.id] },
    } };
    useAppStore.setState({ nodes: [a, b, c], edges: [], groups: [] });
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 112, y: 1260 });
      expect(current(c.id).position).toEqual({ x: 432, y: 1260 });
      toggle(a.id);
      expect(current(b.id).position).toEqual(b.position);
      expect(current(c.id).position).toEqual(c.position);
    }
  });

  it.each([['a', 'b'], ['b', 'a']] as const)('L形展开布局按%s→%s收起得到相同紧凑位置，再全展开还原且不漂移', (first, second) => {
    const nonce = process.env.GROUP_LAYOUT_VERIFY_NONCE ?? 'local';
    const a = group(`l-layout-a-${nonce}`, 0, 1000, 0);
    const b = group(`l-layout-b-${nonce}`, 0, 600, 700);
    const c = { ...node(`l-layout-c-${nonce}`), position: { x: 700, y: 700 } };
    const sources = { a, b };
    useAppStore.setState({ nodes: [a, b, c], edges: [], groups: [] });
    for (let count = 0; count < 3; count++) {
      toggle(sources[first].id);
      toggle(sources[second].id);
      expect(current(b.id).position).toEqual({ x: 0, y: 252 });
      expect(current(c.id).position).toEqual({ x: 320, y: 252 });
      toggle(sources[second].id);
      toggle(sources[first].id);
      expect(current(b.id).position).toEqual(b.position);
      expect(current(c.id).position).toEqual(c.position);
    }
  });

  it('收起分组的靠拢终点会覆盖已有节点时，保守保留后继位置而不制造碰撞', () => {
    const nonce = process.env.GROUP_LAYOUT_VERIFY_NONCE ?? 'local';
    const a = group(`collapse-collision-a-${nonce}`, 0, 1000);
    const b = group(`collapse-collision-b-${nonce}`, 1100, 600);
    const obstacle = { ...node(`collapse-collision-obstacle-${nonce}`), position: { x: 500, y: 150 }, width: 100, height: 100 };
    useAppStore.setState({ nodes: [a, b, obstacle], edges: [], groups: [] });
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(obstacle.id).position).toEqual(obstacle.position);
  });

  it('收起让位后的下方分组新增同行节点，展开恢复整排纵向位置且不双推原节点', () => {
    const nonce = process.env.GROUP_LAYOUT_VERIFY_NONCE ?? 'local';
    const original = group(`mixed-phase-a-${nonce}`, 64, 1052, 28);
    const a = { ...original, height: 728, style: { width: 1052, height: 728 }, measured: { width: 1052, height: 728 } };
    const b = foldedGroup(`mixed-phase-b-${nonce}`, 64, 600, 1328);
    useAppStore.setState({ nodes: [a, b], edges: [], groups: [] });
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 64, y: 752 });
    const c = { ...node(`mixed-phase-c-${nonce}`), position: { x: 900, y: 752 } };
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes, c] });
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 64, y: 1328 });
      expect(current(c.id).position).toEqual({ x: 900, y: 1328 });
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 64, y: 752 });
      expect(current(c.id).position).toEqual(c.position);
    }
  });

  it('锁定下方同列文件夹后，它与其后段均不被展开推移', () => {
    const { a, b, tail } = verticalScene();
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === b.id
      ? { ...item, draggable: false } : item) });
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
  });

  it('右下角内容由同一分组只沿一个方向让位，收起后回到原位置', () => {
    const a = foldedGroup('diagonal-source', 0, 1000);
    const diagonal = { ...node('diagonal-follower'), position: { x: 320, y: 520 } };
    useAppStore.setState({ nodes: [a, diagonal], edges: [], groups: [] });
    toggle(a.id);
    const position = current(diagonal.id).position;
    expect([{ x: 1100, y: 520 }, { x: 320, y: 968 }]).toContainEqual(position);
    toggle(a.id);
    expect(current(diagonal.id).position).toEqual(diagonal.position);
  });

  it('下方分组与同排后继一起让位，展开下方分组后收起上方源也不重新遮挡', () => {
    const a = foldedGroup('mixed-source', 0, 1000);
    const b = foldedGroup('mixed-lower', 0, 600, 400);
    const follower = { ...node('mixed-lower-follower'), position: { x: 320, y: 400 }, width: 220 };
    useAppStore.setState({ nodes: [a, b, follower], edges: [], groups: [] });
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 0, y: 848 });
      expect(current(follower.id).position).toEqual({ x: 320, y: 848 });
      toggle(b.id);
      expect(current(follower.id).position).toEqual({ x: 700, y: 848 });
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 0, y: 400 });
      expect(current(follower.id).position).toEqual({ x: 700, y: 400 });
      expect(current(b.id).data.groupCollapsed).toBeUndefined();
      toggle(b.id);
      expect(current(follower.id).position).toEqual(follower.position);
    }
  });

  it.each([
    { open: ['column-a', 'column-b', 'column-c'], close: ['column-c', 'column-b', 'column-a'] },
    { open: ['column-c', 'column-b', 'column-a'], close: ['column-a', 'column-b', 'column-c'] },
  ])('多个竖排旧文件夹不同顺序开合，纵向让位叠加且不漂移：$open/$close', ({ open, close }) => {
    const a = foldedGroup('column-a', 0, 1000);
    const b = foldedGroup('column-b', 0, 600, 520);
    const c = foldedGroup('column-c', 0, 500, 940);
    const tail = { ...node('column-tail'), position: { x: 0, y: 1360 } };
    useAppStore.setState({ nodes: [a, b, c, tail], edges: [], groups: [] });
    for (let count = 0; count < 3; count++) {
      open.forEach(toggle);
      expect(current(b.id).position).toEqual({ x: 0, y: 968 });
      expect(current(c.id).position).toEqual({ x: 0, y: 1836 });
      expect(current(tail.id).position).toEqual({ x: 0, y: 2704 });
      close.forEach(toggle);
      for (const item of [b, c, tail]) expect(current(item.id).position).toEqual(item.position);
    }
  });

  it.each([{ delta: 50, saveCollapsed: false }, { delta: 1500, saveCollapsed: true }])(
    '纵向让位保存回载后保留手动Y增量，跨过原展开边界仍可逆：$delta/$saveCollapsed', ({ delta, saveCollapsed }) => {
      const { a, b } = verticalScene();
      toggle(a.id);
      useAppStore.getState().onNodesChange([{ id: b.id, type: 'position', position: { x: 0, y: 968 + delta } }]);
      if (saveCollapsed) toggle(a.id);
      const saved = JSON.parse(JSON.stringify({ nodes: useAppStore.getState().nodes, groups: useAppStore.getState().groups })) as
        Pick<ReturnType<typeof useAppStore.getState>, 'nodes' | 'groups'>;
      useAppStore.setState({ nodes: [], groups: [] });
      useAppStore.setState(saved);
      if (saveCollapsed) toggle(a.id);
      for (let count = 0; count < 3; count++) {
        expect(current(b.id).position).toEqual({ x: 0, y: 968 + delta });
        toggle(a.id);
        expect(current(b.id).position).toEqual({ x: 0, y: 520 + delta });
        toggle(a.id);
      }
    },
  );

  it('自动Y让位不进入历史或截断重做，手动Y移动仍可撤销重做', async () => {
    const { a, b } = verticalScene();
    const state = useAppStore.getState();
    state.commitToHistory();
    const baseline = useAppStore.getState().history;
    toggle(a.id); state.commitToHistory();
    expect(useAppStore.getState().history).toBe(baseline);
    state.onNodesChange([{ id: b.id, type: 'position', position: { x: 0, y: 1018 } }]);
    expect(await state.undo()).toBe(true);
    expect(current(b.id).position).toEqual({ x: 0, y: 968 });
    const { history, historyIndex } = useAppStore.getState();
    toggle(a.id); state.commitToHistory();
    toggle(a.id); state.commitToHistory();
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(historyIndex);
    expect(await state.redo()).toBe(true);
    expect(current(b.id).position).toEqual({ x: 0, y: 1018 });
  });

  it.each([
    { initiallyCollapsed: true, switchPhase: false }, { initiallyCollapsed: true, switchPhase: true },
    { initiallyCollapsed: false, switchPhase: false }, { initiallyCollapsed: false, switchPhase: true },
  ])('纵向让位节点换组撤销，恢复正负两相与休眠关系：$initiallyCollapsed/$switchPhase', async ({ initiallyCollapsed, switchPhase }) => {
    const target = group('vertical-undo-target', 4000, 600, 2000);
    const { a, tail } = verticalScene(initiallyCollapsed, [target]);
    toggle(a.id);
    useAppStore.getState().settleNodeGroupingOnDragStop({ ...current(tail.id), position: { x: 4050, y: 2050 } });
    expect(current(tail.id)).toMatchObject({ parentId: target.id, position: { x: 50, y: 50 } });
    expect(current(tail.id).data.groupLayoutOffsetY).toBeUndefined();
    if (switchPhase) toggle(a.id);
    expect(await useAppStore.getState().undo()).toBe(true);
    const collapsed = initiallyCollapsed ? switchPhase : !switchPhase;
    expect(current(a.id).data.groupCollapsed === true).toBe(collapsed);
    expect(current(tail.id)).toMatchObject({ parentId: undefined, position: { x: 0, y: collapsed ? 840 : 1288 } });
    if (collapsed) toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: 0, y: 1288 });
    toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: 0, y: 840 });
  });

  it('同排右侧整体平移宽差，保留间距、组内相对坐标与连线，往返还原', () => {
    const { a, b, child, tail } = scene();
    const edges = useAppStore.getState().edges;
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 320, y: 100 });
    expect(current(tail.id).position).toEqual({ x: 1020, y: 100 });
    expect(current(b.id).position.x - (current(a.id).position.x + current(a.id).width!)).toBe(100);
    expect(current(tail.id).position.x - (current(b.id).position.x + current(b.id).width!)).toBe(100);
    expect(current(child.id).position).toEqual(child.position);
    expect(current(child.id).data.groupLayoutOffsetX).toBeUndefined();
    expect(useAppStore.getState().edges).toBe(edges);
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
    expect(current(b.id).data.groupLayoutOffsetX ?? 0).toBe(0);
  });

  it('展开推开原本重叠的右侧内容及同行后继，左侧、无关行、不同父级和隐藏内容不动', () => {
    const left = { ...node('shift-left'), position: { x: -400, y: 100 } };
    const otherRow = { ...node('shift-other-row'), position: { x: 1500, y: 800 } };
    const nested = { ...node('shift-other-parent'), parentId: 'different-parent', position: { x: 1400, y: 100 } };
    const hidden = { ...node('shift-hidden'), hidden: true, position: { x: 1500, y: 100 } };
    const collected = { ...node('shift-collected'), position: { x: 1600, y: 100 },
      data: { ...node('shift-collected').data, hiddenByCharacterLibrary: true } };
    const overlap = { ...node('shift-overlap'), position: { x: 500, y: 100 } };
    const others = [left, otherRow, nested, hidden, collected];
    const { a, b, tail } = scene([...others, overlap]);
    toggle(a.id);
    for (const item of others) expect(current(item.id).position).toEqual(item.position);
    expect(current(overlap.id).position).toEqual(overlap.position);
    toggle(a.id);
    for (const item of others) expect(current(item.id).position).toEqual(item.position);
    expect(current(overlap.id).position).toEqual({ x: 1280, y: 100 });
    expect(current(b.id).position).toEqual({ x: 1880, y: 100 });
    expect(current(tail.id).position).toEqual({ x: 2580, y: 100 });
  });

  it('同一父分组内只移动同层根节点，不重写子树坐标', () => {
    const parent = group('shift-parent', 300, 3000, 400);
    const a = group('shift-nested-a', 30, 1000, 60, parent.id);
    const b = group('shift-nested-b', 1130, 600, 60, parent.id);
    const child = { ...node('shift-nested-child'), parentId: b.id, position: { x: 24, y: 38 } };
    const outside = { ...node('shift-outside'), position: { x: 1430, y: 460 } };
    useAppStore.setState({ nodes: [parent, a, b, child, outside], groups: [] });
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 350, y: 60 });
    expect(current(child.id).position).toEqual(child.position);
    expect(current(parent.id).position).toEqual(parent.position);
    expect(current(outside.id).position).toEqual(outside.position);
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
  });

  it.each([
    ['shift-a', 'shift-b', 'shift-a', 'shift-b'],
    ['shift-a', 'shift-b', 'shift-b', 'shift-a'],
    ['shift-b', 'shift-a', 'shift-a', 'shift-b'],
    ['shift-b', 'shift-a', 'shift-b', 'shift-a'],
  ])('多个分组按 %s → %s → %s → %s 开合后不累积漂移', (...sequence) => {
    const { b, tail } = scene();
    for (let count = 0; count < 3; count++) {
      sequence.forEach(toggle);
      expect(current(b.id).position).toEqual(b.position);
      expect(current(tail.id).position).toEqual(tail.position);
      expect(current(tail.id).data.groupLayoutOffsetX ?? 0).toBe(0);
    }
  });

  it('锁定同排节点作为锚点，后面一段不被拉向左侧', () => {
    const { a, b, tail } = scene();
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === b.id
      ? { ...item, draggable: false } : item) });
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
    toggle(a.id);
    expect(current(tail.id).position).toEqual(tail.position);
  });

  it('旧折叠分组没有让位账且周边空间足够时只展开尺寸', () => {
    const { a, b, tail } = scene();
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === a.id ? {
      ...item, width: 220, height: 152, style: { width: 220, height: 152 },
      data: { ...item.data, groupCollapsed: true, groupExpandedSize: { width: 1000, height: 600 } },
    } : item) });
    toggle(a.id);
    expect(current(a.id).width).toBe(1000);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
  });

  it('旧折叠分组首次展开让出空间，保留后继间距、子节点与连线，反复开合不漂移', () => {
    const { a, b, child, tail } = foldedScene();
    const edges = useAppStore.getState().edges;
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(a.id).width).toBe(1000);
      expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
      expect(current(tail.id).position).toEqual({ x: 1800, y: 100 });
      expect(current(child.id).position).toEqual(child.position);
      expect(useAppStore.getState().edges).toBe(edges);
      toggle(a.id);
      expect(current(b.id).position).toEqual(b.position);
      expect(current(tail.id).position).toEqual(tail.position);
      expect(current(b.id).data.groupLayoutOffsetX ?? 0).toBe(0);
    }
  });

  it('标题错开但实际被展开区域遮住的节点及其同行后继也让位，无相交行不动', () => {
    const a = foldedGroup('offset-source', 0, 1000);
    const overlap = { ...node('offset-overlap'), position: { x: 320, y: 250 } };
    const follower = { ...node('offset-follower'), position: { x: 1100, y: 250 } };
    const above = { ...node('offset-above'), position: { x: 400, y: -200 } };
    const below = { ...node('offset-below'), position: { x: 400, y: 800 } };
    useAppStore.setState({ nodes: [a, overlap, follower, above, below], edges: [], groups: [] });
    toggle(a.id);
    expect(current(overlap.id).position).toEqual({ x: 1100, y: 250 });
    expect(current(follower.id).position).toEqual({ x: 1880, y: 250 });
    expect(current(above.id).position).toEqual(above.position);
    expect(current(below.id).position).toEqual(below.position);
    toggle(a.id);
    expect(current(overlap.id).position).toEqual(overlap.position);
    expect(current(follower.id).position).toEqual(follower.position);
  });

  it('高分组让位时继续推动纵向相交的后继链，不遗漏超出原展开高度的节点', () => {
    const a = foldedGroup('chain-source', 0, 1000);
    const b = { ...group('chain-tall-group', 320, 600, 500), measured: { width: 220, height: 152 } };
    const c = { ...node('chain-middle'), position: { x: 1100, y: 1050 } };
    const d = { ...node('chain-end'), position: { x: 1500, y: 1180 } };
    const unrelated = { ...node('chain-unrelated'), position: { x: 1900, y: 1400 } };
    useAppStore.setState({ nodes: [a, b, c, d, unrelated], edges: [], groups: [] });
    toggle(a.id);
    expect(current(b.id).position).toEqual({ x: 1100, y: 500 });
    expect(current(c.id).position).toEqual({ x: 1880, y: 1050 });
    expect(current(d.id).position).toEqual({ x: 2280, y: 1180 });
    expect(current(unrelated.id).position).toEqual(unrelated.position);
    toggle(a.id);
    for (const item of [b, c, d, unrelated]) expect(current(item.id).position).toEqual(item.position);
  });

  it('已有正让位收起后在后继未来位置新增节点，再展开也联动让开原展开区域之外的节点', () => {
    const { a, b, tail } = foldedScene();
    toggle(a.id);
    toggle(a.id);
    const added = { ...node('added-in-shifted-follower'), position: { x: 1500, y: 500 } };
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes, added] });
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
      expect(current(tail.id).position).toEqual({ x: 1800, y: 100 });
      expect(current(added.id).position).toEqual({ x: 2280, y: 500 });
      toggle(a.id);
      expect(current(b.id).position).toEqual(b.position);
      expect(current(tail.id).position).toEqual(tail.position);
      expect(current(added.id).position).toEqual(added.position);
    }
  });

  it.each([500, 1500])('展开时保留锁定锚点，空间不足不把前方内容推到锚点上（锚点 x=%s）', (anchorX) => {
    const anchor = { ...node('expansion-anchor'), position: { x: anchorX, y: 100 }, draggable: false };
    const { a, b, tail } = foldedScene([anchor]);
    toggle(a.id);
    expect(current(anchor.id).position).toEqual(anchor.position);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
  });

  it('锁定锚点后方另有直接被展开区域遮住的节点，也不能越过锚点单独推移', () => {
    const a = foldedGroup('barrier-source', 0, 1000);
    const before = { ...node('barrier-before'), position: { x: 250, y: 100 }, width: 50 };
    const anchor = { ...node('barrier-anchor'), position: { x: 500, y: 100 }, width: 50, draggable: false };
    const after = { ...node('barrier-after'), position: { x: 750, y: 100 }, width: 50 };
    useAppStore.setState({ nodes: [a, before, anchor, after], edges: [], groups: [] });
    toggle(a.id);
    for (const item of [before, anchor, after]) expect(current(item.id).position).toEqual(item.position);
  });

  it('收起后新放入空隙的内容在展开时让位，已有收起位移只归还一次', () => {
    const { a, b, tail } = scene();
    // 原后继保持在上方独立一行，与后放入的 y=300 内容没有纵向相交。
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((item) => item.id === b.id
      ? { ...item, height: 100, style: { ...item.style, height: 100 }, measured: { width: 600, height: 100 } } : item) });
    toggle(a.id);
    const added = { ...node('added-after-collapse'), position: { x: 500, y: 300 } };
    const follower = { ...node('added-row-follower'), position: { x: 1100, y: 300 } };
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes, added, follower] });
    toggle(a.id);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
    expect(current(added.id).position).toEqual({ x: 1280, y: 300 });
    expect(current(follower.id).position).toEqual({ x: 1880, y: 300 });
    toggle(a.id);
    expect(current(added.id).position).toEqual(added.position);
    expect(current(follower.id).position).toEqual(follower.position);
    toggle(a.id);
    expect(current(added.id).position).toEqual({ x: 1280, y: 300 });
    expect(current(b.id).position).toEqual(b.position);
  });

  it('新节点插入卡片与原后继之间，展开联动让位后仍保留原后继的收起靠拢身份', () => {
    const { a, b, tail } = scene();
    toggle(a.id);
    const inserted = { ...node('inserted-between-folders'), position: { x: 250, y: 100 }, width: 50 };
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes, inserted] });
    for (let count = 0; count < 3; count++) {
      toggle(a.id);
      expect(current(inserted.id).position).toEqual({ x: 1030, y: 100 });
      expect(current(b.id).position).toEqual({ x: 1880, y: 100 });
      expect(current(tail.id).position).toEqual({ x: 2580, y: 100 });
      toggle(a.id);
      expect(current(inserted.id).position).toEqual(inserted.position);
      expect(current(b.id).position).toEqual({ x: 320, y: 100 });
      expect(current(tail.id).position).toEqual({ x: 1020, y: 100 });
    }
  });

  it.each([
    { manualDelta: 50, saveCollapsed: false },
    { manualDelta: 1500, saveCollapsed: true },
  ])('新增展开让位保存回载后保留手动增量，远距离移动也不漂移：$manualDelta/$saveCollapsed', ({ manualDelta, saveCollapsed }) => {
    const { a, b, tail } = foldedScene();
    toggle(a.id);
    useAppStore.getState().onNodesChange([{ id: b.id, type: 'position', position: { x: 1100 + manualDelta, y: 100 } }]);
    if (saveCollapsed) toggle(a.id);
    const saved = JSON.parse(JSON.stringify({ nodes: useAppStore.getState().nodes, groups: useAppStore.getState().groups })) as
      Pick<ReturnType<typeof useAppStore.getState>, 'nodes' | 'groups'>;
    useAppStore.setState({ nodes: [], groups: [] });
    useAppStore.setState(saved);
    if (saveCollapsed) toggle(a.id);
    for (let count = 0; count < 3; count++) {
      expect(current(b.id).position).toEqual({ x: 1100 + manualDelta, y: 100 });
      expect(current(tail.id).position).toEqual({ x: 1800, y: 100 });
      toggle(a.id);
      expect(current(b.id).position).toEqual({ x: 320 + manualDelta, y: 100 });
      expect(current(tail.id).position).toEqual(tail.position);
      toggle(a.id);
    }
  });

  it.each([
    { open: ['positive-a', 'positive-b', 'positive-c'], close: ['positive-a', 'positive-b', 'positive-c'] },
    { open: ['positive-a', 'positive-b', 'positive-c'], close: ['positive-c', 'positive-b', 'positive-a'] },
    { open: ['positive-c', 'positive-b', 'positive-a'], close: ['positive-b', 'positive-a', 'positive-c'] },
  ])('三个旧文件夹以不同顺序开合，新增让位叠加且回到原紧凑排列：$open/$close', ({ open, close }) => {
    const a = foldedGroup('positive-a', 0, 1000);
    const b = foldedGroup('positive-b', 320, 600);
    const c = foldedGroup('positive-c', 640, 500);
    const tail = { ...node('positive-tail'), position: { x: 960, y: 100 } };
    useAppStore.setState({ nodes: [a, b, c, tail], edges: [], groups: [] });
    for (let count = 0; count < 3; count++) {
      open.forEach(toggle);
      expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
      expect(current(c.id).position).toEqual({ x: 1800, y: 100 });
      expect(current(tail.id).position).toEqual({ x: 2400, y: 100 });
      close.forEach(toggle);
      expect(current(b.id).position).toEqual(b.position);
      expect(current(c.id).position).toEqual(c.position);
      expect(current(tail.id).position).toEqual(tail.position);
    }
  });

  it('新增展开让位不进入撤销历史或截断重做，真实移动仍按当前展开状态恢复', async () => {
    const { a, b } = foldedScene();
    const state = useAppStore.getState();
    state.commitToHistory();
    const baseline = useAppStore.getState().history;
    toggle(a.id); state.commitToHistory();
    expect(useAppStore.getState().history).toBe(baseline);
    state.onNodesChange([{ id: b.id, type: 'position', position: { x: 1150, y: 100 } }]);
    expect(await state.undo()).toBe(true);
    expect(current(a.id).data.groupCollapsed).toBeUndefined();
    expect(current(b.id).position).toEqual({ x: 1100, y: 100 });
    const { history, historyIndex } = useAppStore.getState();
    toggle(a.id); state.commitToHistory();
    toggle(a.id); state.commitToHistory();
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(historyIndex);
    expect(await state.redo()).toBe(true);
    expect(current(b.id).position).toEqual({ x: 1150, y: 100 });
  });

  it.each([false, true])('新增展开让位节点换组后撤销，恢复活动或休眠关系（撤销前已收起：%s）', async (collapseBeforeUndo) => {
    const target = group('positive-undo-target', 4000, 600, 1000);
    const { a, tail } = foldedScene([target]);
    toggle(a.id);
    useAppStore.getState().settleNodeGroupingOnDragStop({ ...current(tail.id), position: { x: 4050, y: 1050 } });
    expect(current(tail.id)).toMatchObject({ parentId: target.id, position: { x: 50, y: 50 } });
    expect(current(tail.id).data.groupLayoutOffsetX).toBeUndefined();
    if (collapseBeforeUndo) toggle(a.id);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(current(a.id).data.groupCollapsed === true).toBe(collapseBeforeUndo);
    expect(current(tail.id)).toMatchObject({ parentId: undefined,
      position: { x: collapseBeforeUndo ? 1020 : 1800, y: 100 } });
    if (collapseBeforeUndo) toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: 1800, y: 100 });
    toggle(a.id);
    expect(current(tail.id).position).toEqual(tail.position);
    toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: 1800, y: 100 });
  });

  it('折叠后的手动位移保留，序列化回载后展开仅归还自动让位', () => {
    const { a, tail } = scene();
    toggle(a.id);
    useAppStore.getState().onNodesChange([{ id: tail.id, type: 'position', position: { x: 1070, y: 100 } }]);
    const saved = JSON.parse(JSON.stringify({ nodes: useAppStore.getState().nodes, groups: useAppStore.getState().groups })) as
      Pick<ReturnType<typeof useAppStore.getState>, 'nodes' | 'groups'>;
    useAppStore.setState({ nodes: [], groups: [] });
    useAppStore.setState(saved);
    toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: tail.position.x + 50, y: tail.position.y });
  });

  it('纯开合让位不新增历史或截断重做，移动撤销仍保留当前折叠展示', async () => {
    const { a, tail } = scene();
    const state = useAppStore.getState();
    state.commitToHistory();
    const baseline = useAppStore.getState().history;
    toggle(a.id); state.commitToHistory();
    expect(useAppStore.getState().history).toBe(baseline);
    state.onNodesChange([{ id: tail.id, type: 'position', position: { x: 1070, y: 100 } }]);
    expect(await state.undo()).toBe(true);
    expect(current(a.id).data.groupCollapsed).toBe(true);
    expect(current(tail.id).position).toEqual({ x: 1020, y: 100 });
    const { history, historyIndex } = useAppStore.getState();
    toggle(a.id);
    expect(current(tail.id).position).toEqual(tail.position);
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(historyIndex);
    expect(await state.redo()).toBe(true);
    expect(current(tail.id).position).toEqual({ x: 1850, y: 100 });
    expect(current(a.id).data.groupCollapsed).toBeUndefined();
  });

  it.each([
    { groupX: -1000, followerX: 0.1 },
    { groupX: -1000.7, followerX: -0.100000123456 },
  ])('小数负坐标开合不新增历史或截断重做，真实位移仍可撤销：$followerX', async ({ groupX, followerX }) => {
    const a = group('fraction-source', groupX, 1000, -100.2);
    const follower = { ...node('fraction-follower'), position: { x: followerX, y: -100.2 } };
    useAppStore.setState({ nodes: [a, follower], edges: [], groups: [
      { id: a.id, name: a.id, nodeIds: [], color: '#888888', createdAt: 0 },
    ] });
    const state = useAppStore.getState();
    state.commitToHistory();
    const baseline = useAppStore.getState().history;
    for (let count = 0; count < 3; count++) {
      toggle(a.id); state.commitToHistory();
      expect(useAppStore.getState().history).toBe(baseline);
      toggle(a.id); state.commitToHistory();
      expect(useAppStore.getState().history).toBe(baseline);
      expect(current(follower.id).position.x).toBeCloseTo(followerX, 11);
    }
    toggle(a.id); state.commitToHistory();
    const manualDelta = 0.00123;
    state.onNodesChange([{ id: follower.id, type: 'position', position: {
      x: current(follower.id).position.x + manualDelta, y: follower.position.y,
    } }]);
    expect(await state.undo()).toBe(true);
    expect(current(follower.id).position.x).toBeCloseTo(followerX - 780, 11);
    const { history, historyIndex } = useAppStore.getState();
    toggle(a.id); toggle(a.id);
    expect(useAppStore.getState().history).toBe(history);
    expect(useAppStore.getState().historyIndex).toBe(historyIndex);
    expect(await state.redo()).toBe(true);
    expect(current(follower.id).position.x).toBeCloseTo(followerX - 780 + manualDelta, 11);
    toggle(a.id);
    expect(current(follower.id).position.x).toBeCloseTo(followerX + manualDelta, 11);
  });

  it('折叠态撤销重做分组缩放，展开使用还原后的宽度与相应让位', async () => {
    const { a, tail } = scene();
    const state = useAppStore.getState();
    state.commitToHistory();
    state.onNodesChange([{ id: a.id, type: 'dimensions', dimensions: { width: 900, height: 600 }, setAttributes: true }]);
    state.commitToHistory();
    toggle(a.id);
    expect(current(tail.id).position.x).toBe(1120);
    expect(await state.undo()).toBe(true);
    expect(current(a.id).data.groupExpandedSize?.width).toBe(1000);
    expect(current(tail.id).position.x).toBe(1020);
    expect(await state.redo()).toBe(true);
    expect(current(a.id).data.groupExpandedSize?.width).toBe(900);
    expect(current(tail.id).position.x).toBe(1120);
    toggle(a.id);
    expect(current(tail.id).position.x).toBe(tail.position.x);
  });

  it('复制节点和粘贴文件夹使用新布局身份，不继承旧偏移或操作原节点的名单', async () => {
    const { a, b, tail } = scene();
    toggle(a.id);
    const duplicateId = await useAppStore.getState().duplicateNode(tail.id);
    expect(duplicateId).toBeDefined();
    expect(current(duplicateId!).position).toEqual(current(tail.id).position);
    expect(current(duplicateId!).data.groupLayoutOffsetX).toBeUndefined();
    useAppStore.setState({ selectedNodeIds: [a.id, b.id] });
    expect(useAppStore.getState().copySelectedNodes()).toBe(true);
    const known = new Set(useAppStore.getState().nodes.map((item) => item.id));
    await useAppStore.getState().pasteNodes({ x: 300, y: 300 });
    const pasted = useAppStore.getState().nodes.filter((item) => !known.has(item.id));
    expect(pasted.length).toBeGreaterThan(0);
    for (const item of pasted) {
      expect(item.data.groupLayoutOffsetX).toBeUndefined();
      expect(item.data.groupCollapseLayout).toBeUndefined();
    }
    // 在空白区域检查身份隔离，避免真实碰撞避让被误当成继承了原分组名单。
    useAppStore.getState().onNodesChange(pasted.filter((item) => !item.parentId).map((item) => ({
      id: item.id, type: 'position' as const, position: { x: item.position.x + 10000, y: item.position.y + 10000 },
    })));
    const originalPositions = new Map([a.id, b.id, tail.id].map((id) => [id, { ...current(id).position }]));
    const pastedFolder = pasted.find((item) => item.type === 'group' && item.data.groupCollapsed)!;
    toggle(pastedFolder.id);
    for (const [id, position] of originalPositions) expect(current(id).position).toEqual(position);
  });

  it('让位节点拖入再拖出分组后保持可见坐标，不重新继承旧名单', () => {
    const target = group('shift-target', 2000, 500, 1000);
    const { a, tail } = scene([target]);
    toggle(a.id);
    const entered = { ...current(tail.id), position: { x: 2050, y: 1050 } };
    useAppStore.getState().settleNodeGroupingOnDragStop(entered);
    expect(current(tail.id)).toMatchObject({ parentId: target.id, position: { x: 50, y: 50 } });
    expect(current(tail.id).data.groupLayoutOffsetX).toBeUndefined();
    expect(current(a.id).data.groupCollapseLayout?.nodeIds).not.toContain(tail.id);
    const departed = { ...current(tail.id), position: { x: -930, y: -900 } };
    useAppStore.getState().settleNodeGroupingOnDragStop(departed);
    expect(current(tail.id)).toMatchObject({ parentId: undefined, position: { x: 1070, y: 100 } });
    toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: 1070, y: 100 });
  });

  it('笔记复制同样清除自动偏移，原笔记的让位身份保留', async () => {
    const source: Node<BaseNodeData> = { id: 'shift-note', type: 'canvas-note', position: { x: 1800, y: 100 },
      data: { type: 'canvas-note', label: '笔记', note: createCanvasNoteData('text', { text: '文字' }) } };
    const { a } = scene([source]);
    toggle(a.id);
    expect(current(source.id).data.groupLayoutOffsetX).toBe(-780);
    const id = await useAppStore.getState().duplicateCanvasNote(source.id);
    expect(id).toBeTruthy();
    expect(current(id!).data.groupLayoutOffsetX).toBeUndefined();
    expect(current(id!).data.groupCollapseLayout).toBeUndefined();
    expect(current(source.id).data.groupLayoutOffsetX).toBe(-780);
    expect(current(id!).data.note?.text).toBe('文字');
  });

  it('通过缩放吸纳让位节点时清除旧父层贡献，展开不移动新成员', () => {
    const target = { ...group('shift-capture', 900, 200, 0), height: 50,
      measured: { width: 200, height: 50 }, style: { width: 200, height: 50 } };
    const { a, tail } = scene([target]);
    const state = useAppStore.getState();
    toggle(a.id);
    state.commitToHistory();
    state.onNodesChange([{ id: target.id, type: 'dimensions', dimensions: { width: 600, height: 400 }, setAttributes: true }]);
    state.settleGroupMembersOnResizeEnd(target.id);
    expect(current(tail.id)).toMatchObject({ parentId: target.id, position: { x: 120, y: 100 } });
    expect(current(tail.id).data.groupLayoutOffsetX).toBeUndefined();
    expect(current(a.id).data.groupCollapseLayout?.nodeIds).not.toContain(tail.id);
    toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: 120, y: 100 });
  });

  it.each([false, true])('收起让位后换组再撤销，恢复原父层的活动或休眠关系（撤销前已展开：%s）', async (expandBeforeUndo) => {
    const target = group('shift-undo-target', 2000, 500, 1000);
    const { a, tail } = scene([target]);
    toggle(a.id);
    useAppStore.getState().settleNodeGroupingOnDragStop({ ...current(tail.id), position: { x: 2050, y: 1050 } });
    expect(current(tail.id).parentId).toBe(target.id);
    if (expandBeforeUndo) toggle(a.id);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(current(a.id).data.groupCollapsed === true).toBe(!expandBeforeUndo);
    expect(current(a.id).data.groupCollapseLayout?.nodeIds).toContain(tail.id);
    expect(current(tail.id)).toMatchObject({ parentId: undefined,
      position: { x: expandBeforeUndo ? 1800 : 1020, y: 100 } });
    expect(current(tail.id).data.groupLayoutOffsetX ?? 0).toBe(expandBeforeUndo ? 0 : -780);
    if (expandBeforeUndo) toggle(a.id);
    expect(current(tail.id).position).toEqual({ x: 1020, y: 100 });
  });

  it('解散折叠源后归还让位，撤销复活源时恢复收起展示', async () => {
    const { a, b, tail } = scene();
    toggle(a.id);
    useAppStore.setState({ selectedNodeIds: [a.id] });
    useAppStore.getState().ungroupSelectedNodes();
    expect(useAppStore.getState().nodes.some((item) => item.id === a.id)).toBe(false);
    expect(current(b.id).position).toEqual(b.position);
    expect(current(tail.id).position).toEqual(tail.position);
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(current(a.id).data.groupCollapsed).toBe(true);
    expect(current(b.id).position).toEqual({ x: 320, y: 100 });
    expect(current(tail.id).position).toEqual({ x: 1020, y: 100 });
  });
}
