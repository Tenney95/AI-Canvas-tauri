import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryGraphDetail, StoryGraphEdge, StoryGraphNode, StoryGraphPosition, StoryGraphSelection } from '../../src/types/storyGraph';
import StoryGraphPanel, { type StoryGraphPanelProps } from '../../src/components/storyGraph/StoryGraphPanel';
import { createEmptyStoryGraph, projectStoryGraphView } from '../../src/services/storyGraphService';

// 沿用仓库的可重入 Hook 槽；实例以组件路径和 key 区分，不依赖额外 DOM 环境。
interface HookEffect { dependencies?: readonly unknown[]; setup?: () => void | (() => void); cleanup?: () => void }
interface HookFrame { id: string; cursor: number; values: unknown[]; effects: Map<number, HookEffect> }
const hooks = vi.hoisted(() => ({ frames: new Map<string, HookFrame>(), active: new Set<string>(), current: null as HookFrame | null }));
interface FlowNode { id: string; type?: string; position: StoryGraphPosition; origin?: number[]; selected?: boolean; data: { label: string; dimmed?: boolean; presentation?: string } }
interface FlowProps {
  nodes: FlowNode[];
  edges: Array<{ id: string; selected?: boolean; data: { label: string; dimmed?: boolean; presentation?: string } }>;
  nodesDraggable: boolean;
  onInit: (instance: { fitView: (options: { padding: number; duration?: number }) => Promise<boolean> }) => void;
  onNodeClick: (event: unknown, node: { id: string }) => void;
  onEdgeClick: (event: unknown, edge: { id: string }) => void;
  onPaneClick: (event: unknown) => void;
  onNodeDragStart: (event: unknown, node: FlowNode) => void;
  onNodesChange: (changes: Array<{ id: string; type: 'position'; position: StoryGraphPosition; dragging: boolean }>) => void;
  onNodeDragStop: (event: unknown, node: FlowNode) => void;
}
const flow = vi.hoisted(() => ({ current: null as FlowProps | null, fitView: vi.fn(async () => true) }));
const animation = vi.hoisted(() => ({ nextId: 0, frames: new Map<number, FrameRequestCallback>() }));
vi.mock('react', async () => {
  const slot = <T,>(initial: T | (() => T)) => {
    const frame = hooks.current;
    if (!frame) throw new Error('Hook invoked outside the component harness');
    const index = frame.cursor++;
    if (!(index in frame.values)) frame.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return { frame, index };
  };
  return {
    ...await vi.importActual<typeof import('react')>('react'),
    useState: <T,>(initial: T | (() => T)) => {
      const { frame, index } = slot(initial);
      return [frame.values[index] as T, (next: T | ((previous: T) => T)) => {
        frame.values[index] = typeof next === 'function' ? (next as (previous: T) => T)(frame.values[index] as T) : next;
      }];
    },
    useRef: <T,>(initial: T) => {
      const { frame, index } = slot(() => ({ current: initial }));
      return frame.values[index] as { current: T };
    },
    useEffect: (setup: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const frame = hooks.current;
      if (!frame) throw new Error('Effect invoked outside the component harness');
      const index = frame.cursor++;
      const previous = frame.effects.get(index);
      if (!previous || !dependencies || !previous.dependencies || dependencies.length !== previous.dependencies.length
        || dependencies.some((value, entry) => !Object.is(value, previous.dependencies![entry]))) {
        frame.effects.set(index, { dependencies: dependencies ? [...dependencies] : undefined, cleanup: previous?.cleanup, setup });
      }
    },
    useId: () => 'graph-' + (hooks.current?.id ?? '').replace(/[^a-z0-9_-]/gi, '-'),
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock('../../src/i18n', () => ({ useT: () => (key: string, parameters?: Record<string, string | number>) => key.replace(/\{([^}]+)\}/g, (_, name: string) => String(parameters?.[name] ?? '{' + name + '}')) }));
vi.mock('framer-motion', () => ({ useReducedMotion: () => true }));
vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('../../src/hooks/useDialogFocus', () => ({ useDialogFocus: () => undefined }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? <div>{children}</div> : null }));
vi.mock('../../src/components/shared/Tabs', () => ({ default: ({ items, onChange }: { items: Array<{ value: string; label: ReactNode; disabled?: boolean }>; onChange: (value: string) => void }) => <div>{items.map((item) => <button key={item.value} disabled={item.disabled} onClick={() => onChange(item.value)}>{item.label}</button>)}</div> }));
vi.mock('../../src/components/shared/Select', () => ({ default: ({ options = [], value, onChange, id, disabled, ...rest }: {
  options?: Array<{ value: string; label: ReactNode; disabled?: boolean }>; value: string; onChange: (value: string) => void;
  id?: string; disabled?: boolean; 'aria-label'?: string;
}) => <select id={id} aria-label={rest['aria-label']} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
  {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select> }));
vi.mock('../../src/components/shared/NumberStepper', () => ({ default: ({ value, disabled, id }: { value: number; disabled?: boolean; id?: string }) => <input id={id} type="number" value={value} disabled={disabled} readOnly /> }));
vi.mock('../../src/components/nodes/shared/ModelSelector', () => ({ default: () => <span>model-control</span> }));
vi.mock('@xyflow/react', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    ReactFlowProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ReactFlow: (properties: FlowProps) => {
      const initialize = useRef(properties.onInit);
      useEffect(() => { flow.current = properties; }, [properties]);
      useEffect(() => { initialize.current({ fitView: flow.fitView }); }, [initialize]);
      const { nodes, edges, onNodeClick, onEdgeClick, onPaneClick } = properties;
      return <div><button type="button" onClick={() => onPaneClick({})}>pane:blank</button>
        {nodes.map((node) => <button key={node.id} data-graph-kind="node" data-graph-id={node.id} data-selected={!!node.selected} data-dimmed={!!node.data.dimmed}
          data-presentation={node.data.presentation} data-position-x={node.position.x} data-position-y={node.position.y} data-origin={node.origin?.join(',')} data-node-type={node.type}
          onClick={() => onNodeClick({}, node)}>{'node:' + node.data.label}</button>)}
        {edges.map((edge) => <button key={edge.id} data-graph-kind="edge" data-graph-id={edge.id} data-selected={!!edge.selected} data-dimmed={!!edge.data.dimmed}
          data-presentation={edge.data.presentation} onClick={() => onEdgeClick({}, edge)}>{'edge:' + edge.data.label}</button>)}</div>;
    },
    Background: () => null, BackgroundVariant: { Dots: 'dots' }, Handle: () => null, Position: { Left: 'left', Right: 'right' },
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

type Element = ReactElement<Record<string, unknown>>;
function expand(node: ReactNode, path: string): ReactNode {
  if (Array.isArray(node)) return node.map((child, index) => expand(child, path + '/' + index));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  let component: unknown = node.type;
  if (component && typeof component === 'object' && 'type' in component) component = component.type;
  if (typeof component === 'function') {
    const componentId = path + ':' + component.name + ':' + (node.key ?? '');
    const frame = hooks.frames.get(componentId) ?? { id: componentId, cursor: 0, values: [], effects: new Map<number, HookEffect>() };
    hooks.frames.set(componentId, frame); hooks.active.add(componentId); frame.cursor = 0;
    const previous = hooks.current; hooks.current = frame;
    let content: ReactNode;
    try { content = (component as (props: Record<string, unknown>) => ReactNode)(node.props); }
    finally { hooks.current = previous; }
    return expand(content, componentId + '/render');
  }
  if (typeof component === 'symbol') return expand(node.props.children as ReactNode, path + '/fragment');
  return cloneElement(node, undefined, expand(node.props.children as ReactNode, path + '/children'));
}
function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : '';
}
function entries(node: ReactNode, form?: Element): Array<{ element: Element; form?: Element }> {
  if (Array.isArray(node)) return node.flatMap((child) => entries(child, form));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ element: node, form }, ...entries(node.props.children as ReactNode, node.type === 'form' ? node : form)];
}
const node: StoryGraphNode = { id: 'person-a', kind: 'character', label: '人物甲', description: '完整正式说明', aliases: [],
  episodeIds: ['episode-b'], origin: 'manual', certainty: 'explicit',
  evidence: [{ episodeId: 'episode-b', part: 'script', sourceHash: 'a'.repeat(64), start: 2, end: 5, quote: '旧信件' }] };
function props(overrides: Partial<StoryGraphPanelProps> = {}): StoryGraphPanelProps {
  const graph = { ...createEmptyStoryGraph('graph-a'), nodes: [node] };
  return { view: projectStoryGraphView(graph), episodes: [{ id: 'episode-b', name: '工作台分集' }], currentEpisodeId: 'episode-b', assets: [], modelGroups: [],
    onFilterChange: vi.fn(async () => undefined), onReadDetail: vi.fn(async (): Promise<StoryGraphDetail> => ({ item: node, evidenceStatuses: ['current'] })),
    onPatch: vi.fn(async () => undefined), onLocateEvidence: vi.fn(async () => undefined), onResolveEvidence: vi.fn(async () => node.evidence[0]),
    onExtract: vi.fn(async () => undefined), onCancelExtraction: vi.fn(async () => undefined), onDiscardCandidates: vi.fn(async () => undefined),
    onAdoptCandidates: vi.fn(async () => undefined), onEditorStateChange: vi.fn(async () => undefined), onDirtyChange: vi.fn(), ...overrides };
}
const selectionTargets = [
  { kind: 'node', id: 'person-a', target: 'node:人物甲', label: '人物甲' },
  { kind: 'edge', id: 'relationship-ab', target: 'edge:相识', label: '相识' },
] as const;
function selectionProps(overrides: Partial<StoryGraphPanelProps> = {}): StoryGraphPanelProps {
  const nodes = [node, { ...node, id: 'person-b', label: '人物乙', evidence: [] }, { ...node, id: 'person-c', label: '人物丙', evidence: [] }];
  const edge: StoryGraphEdge = { id: 'relationship-ab', source: 'person-a', target: 'person-b', kind: 'related', directed: false, label: '相识', description: '',
    episodeIds: ['episode-b'], origin: 'manual', certainty: 'inferred', evidence: [] };
  const edges = [edge, { ...edge, id: 'relationship-bc', source: 'person-b', target: 'person-c', label: '同事' }];
  return props({ view: projectStoryGraphView({ ...createEmptyStoryGraph('graph-a'), nodes, edges }),
    onReadDetail: vi.fn(async (selection: StoryGraphSelection): Promise<StoryGraphDetail> => {
      const item = (selection.kind === 'node' ? nodes : edges).find((entry) => entry.id === selection.id);
      if (!item) throw new Error('Missing selected record');
      return { item, evidenceStatuses: item.evidence.map(() => 'current') };
    }), ...overrides });
}
let state: StoryGraphPanelProps;
let view: ReactNode;
function render() {
  hooks.active = new Set();
  view = expand(<StoryGraphPanel {...state} />, 'root');
  for (const [id, frame] of hooks.frames) if (!hooks.active.has(id)) {
    for (const effect of frame.effects.values()) effect.cleanup?.();
    hooks.frames.delete(id);
  }
  for (const frame of hooks.frames.values()) for (const effect of frame.effects.values()) if (effect.setup) {
    const setup = effect.setup; effect.setup = undefined;
    effect.cleanup?.();
    const cleanup = setup(); effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
  }
}
function unmount() {
  for (const frame of hooks.frames.values()) for (const effect of frame.effects.values()) effect.cleanup?.();
  hooks.frames.clear(); hooks.active.clear(); hooks.current = null; flow.current = null; view = null;
}
function button(label: string) {
  const result = entries(view).find(({ element }) => element.type === 'button' && text(element.props.children as ReactNode) === label);
  if (!result) throw new Error('Missing button ' + label);
  return result;
}
function input(value: string) {
  return entries(view).find(({ element }) => element.type === 'input' && element.props.value === value)?.element;
}
function graphItems() { return entries(view).filter(({ element }) => element.props['data-graph-id'] !== undefined).map(({ element }) => element); }
function closeDetailsButton() { return entries(view).find(({ element }) => element.type === 'button' && element.props['aria-label'] === '关闭详情')!; }
function nodePosition(label: string): StoryGraphPosition {
  const item = button('node:' + label).element;
  return { x: item.props['data-position-x'] as number, y: item.props['data-position-y'] as number };
}
function stepAnimationFrame() {
  const pending = [...animation.frames.values()]; animation.frames.clear();
  for (const callback of pending) callback(0);
}
async function dragNode(phase: 'start' | 'move' | 'stop', id: string, position: StoryGraphPosition) {
  const properties = flow.current;
  const node = properties?.nodes.find((entry) => entry.id === id);
  if (!properties?.nodesDraggable || !node) throw new Error('Node is not draggable');
  if (phase === 'start') properties.onNodeDragStart({}, node);
  else if (phase === 'move') properties.onNodesChange([{ id, type: 'position', position, dragging: true }]);
  else properties.onNodeDragStop({}, { ...node, position });
  await settle();
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
async function activate(target: ReturnType<typeof button>) {
  if (target.element.props.disabled) return;
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  if (typeof target.element.props.onClick === 'function') target.element.props.onClick(event);
  if ((target.element.props.type ?? 'submit') === 'submit' && typeof target.form?.props.onSubmit === 'function') target.form.props.onSubmit(event);
  await settle();
}
async function click(label: string) { await activate(button(label)); }
beforeEach(() => {
  hooks.frames.clear(); hooks.active.clear(); hooks.current = null; flow.current = null; flow.fitView.mockClear();
  animation.nextId = 0; animation.frames.clear();
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { const id = ++animation.nextId; animation.frames.set(id, callback); return id; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { animation.frames.delete(id); }));
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('故事关系图 UI 边界', () => {
  it('opening a bounded view never extracts, writes, reads hidden detail, or changes the parent episode', () => {
    state = props(); render();
    expect(text(view)).toContain('1 / 1 条记录');
    expect(state.onExtract).not.toHaveBeenCalled(); expect(state.onPatch).not.toHaveBeenCalled(); expect(state.onReadDetail).not.toHaveBeenCalled();
    expect(state.onFilterChange).not.toHaveBeenCalled();
    expect(state.currentEpisodeId).toBe('episode-b');
  });

  it('switches cards and dots locally without changing stored positions or starting host work', async () => {
    state = selectionProps(); render();
    const snapshot = structuredClone(state.view);
    const cardPositions = flow.current!.nodes.map((entry) => ({ id: entry.id, position: { ...entry.position } }));
    const instances = [...hooks.frames.keys()].filter((id) => id.includes(':ReactFlowProvider:') || id.includes(':ReactFlow:'));
    expect(instances).toHaveLength(2);
    expect(button('卡片').element.props['aria-pressed']).toBe(true);
    expect(button('点阵').element.props['aria-pressed']).toBe(false);
    expect(entries(view).find(({ element }) => element.props.role === 'group' && element.props['aria-label'] === '图谱显示形态')).toBeDefined();
    expect(graphItems().every((item) => item.props['data-presentation'] === 'cards')).toBe(true);
    expect(flow.current!.nodes.every((entry) => entry.origin?.join(',') === '0,0')).toBe(true);
    await click('点阵');
    expect(button('点阵').element.props['aria-pressed']).toBe(true);
    expect(graphItems().every((item) => item.props['data-presentation'] === 'dots')).toBe(true);
    expect(flow.current!.nodes.every((entry) => entry.type === 'story-record' && entry.origin?.join(',') === '0.5,0.5')).toBe(true);
    expect(flow.current!.nodes.map((entry) => ({ id: entry.id, position: entry.position }))).not.toEqual(cardPositions);
    expect(entries(view).some(({ element }) => element.type === 'section' && String(element.props.className).includes('story-graph--dots'))).toBe(true);
    await click('卡片');
    expect(flow.current!.nodes.map((entry) => ({ id: entry.id, position: entry.position }))).toEqual(cardPositions);
    expect([...hooks.frames.keys()].filter((id) => id.includes(':ReactFlowProvider:') || id.includes(':ReactFlow:'))).toEqual(instances);
    expect(state.view).toEqual(snapshot);
    expect(state.onReadDetail).not.toHaveBeenCalled(); expect(state.onPatch).not.toHaveBeenCalled(); expect(state.onExtract).not.toHaveBeenCalled();
    expect(state.onDirtyChange).not.toHaveBeenCalled(); expect(state.onEditorStateChange).not.toHaveBeenCalled();
  });

  it.each(selectionTargets)('keeps the selected $kind and its unsaved detail instance across presentation changes', async ({ target, label }) => {
    state = selectionProps(); render(); await click(target);
    const draftLabel = `未保存的${label}`;
    (input(label)!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: draftLabel } }); render();
    const editorInstance = [...hooks.frames.keys()].find((id) => id.includes(':StoryGraphDetails:'));
    expect(editorInstance).toBeDefined();
    const dirtyCalls = vi.mocked(state.onDirtyChange!).mock.calls.length;
    for (const presentation of ['点阵', '卡片']) {
      await click(presentation);
      expect(input(draftLabel)).toBeDefined();
      expect(button(target).element.props['data-selected']).toBe(true);
      expect([...hooks.frames.keys()].find((id) => id.includes(':StoryGraphDetails:'))).toBe(editorInstance);
    }
    expect(state.onReadDetail).toHaveBeenCalledTimes(1);
    expect(state.onEditorStateChange).toHaveBeenCalledTimes(1);
    expect(state.onDirtyChange).toHaveBeenCalledTimes(dirtyCalls);
    expect(state.onPatch).not.toHaveBeenCalled(); expect(state.onExtract).not.toHaveBeenCalled();
    expect(text(view)).not.toContain('保留未保存的图谱编辑');
  });

  it('keeps dot drags temporary and revision-bound while card drags retain the persistence contract', async () => {
    state = selectionProps(); render();
    const savedPositions = structuredClone(state.view.positions);
    const cardPosition = nodePosition('人物甲');
    await click('点阵');
    const initialDotPosition = nodePosition('人物甲');
    const pendingFit = [...animation.frames.keys()];
    const dotPosition = { x: 800, y: 900 };
    await dragNode('start', 'person-a', dotPosition);
    expect(button('卡片').element.props.disabled).toBe(true);
    expect(button('点阵').element.props.disabled).toBe(true);
    expect(button('列表').element.props.disabled).toBe(true);
    await click('卡片');
    expect(button('点阵').element.props['aria-pressed']).toBe(true);
    await dragNode('move', 'person-a', dotPosition); await dragNode('stop', 'person-a', dotPosition);
    expect(nodePosition('人物甲')).toEqual(dotPosition);
    expect(button('卡片').element.props.disabled).toBe(false);
    expect([...animation.frames.keys()]).toEqual(pendingFit);
    expect(state.onPatch).not.toHaveBeenCalled(); expect(state.onDirtyChange).not.toHaveBeenCalled();
    await click('卡片'); expect(nodePosition('人物甲')).toEqual(cardPosition);
    await click('点阵'); expect(nodePosition('人物甲')).toEqual(dotPosition);
    state = { ...state, view: { ...state.view, revision: state.view.revision + 1 } }; render();
    expect(nodePosition('人物甲')).toEqual(initialDotPosition);
    expect(state.view.positions).toEqual(savedPositions);
    await click('卡片');
    const movedCard = { x: -20, y: 72 };
    await dragNode('start', 'person-a', movedCard); await dragNode('move', 'person-a', movedCard);
    expect(state.onDirtyChange).toHaveBeenLastCalledWith(true);
    await dragNode('stop', 'person-a', movedCard);
    expect(state.onPatch).toHaveBeenCalledWith({ graphId: state.view.id, positions: { 'person-a': movedCard } }, state.view.revision);
    expect(state.onPatch).toHaveBeenCalledTimes(1);
    expect(state.onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(state.view.positions).toEqual(savedPositions);
    expect(state.onReadDetail).not.toHaveBeenCalled(); expect(state.onExtract).not.toHaveBeenCalled();
  });

  it('fits only after two animation frames with reduced motion', async () => {
    state = selectionProps(); render();
    expect(flow.fitView).not.toHaveBeenCalled();
    stepAnimationFrame(); expect(flow.fitView).not.toHaveBeenCalled();
    stepAnimationFrame(); expect(flow.fitView).toHaveBeenCalledExactlyOnceWith({ padding: 0.2, duration: 0 });
    await click('点阵');
    stepAnimationFrame(); expect(flow.fitView).toHaveBeenCalledTimes(1);
    stepAnimationFrame(); expect(flow.fitView).toHaveBeenCalledTimes(2);
    expect(flow.fitView).toHaveBeenLastCalledWith({ padding: 0.2, duration: 0 });
  });

  it('cancels obsolete first and second fit frames on presentation, mode, graph, and unmount changes', async () => {
    state = selectionProps(); render();
    const initialFrame = animation.frames.keys().next().value!;
    await click('点阵'); expect(animation.frames.has(initialFrame)).toBe(false);
    stepAnimationFrame();
    const dotSecondFrame = animation.frames.keys().next().value!;
    await click('卡片'); expect(animation.frames.has(dotSecondFrame)).toBe(false);
    stepAnimationFrame(); stepAnimationFrame();
    expect(flow.fitView).toHaveBeenCalledTimes(1);
    await click('点阵'); stepAnimationFrame();
    await click('列表'); expect(animation.frames.size).toBe(0);
    stepAnimationFrame(); expect(flow.fitView).toHaveBeenCalledTimes(1);
    await click('关系图'); stepAnimationFrame();
    const oldGraphFrame = animation.frames.keys().next().value!;
    state = { ...state, view: { ...state.view, id: 'graph-b' } }; render();
    expect(animation.frames.has(oldGraphFrame)).toBe(false);
    expect(animation.frames.size).toBe(1);
    unmount(); expect(animation.frames.size).toBe(0);
    stepAnimationFrame(); expect(flow.fitView).toHaveBeenCalledTimes(1);
  });

  it.each(selectionTargets.flatMap((target) => ['blank pane', 'same item', 'close details'].map((action) => ({ ...target, action }))))(
    'clears $kind selection via $action and restores the undimmed graph', async ({ kind, id, target, label, action }) => {
      state = selectionProps(); render(); await click(target);
      expect(state.onReadDetail).toHaveBeenCalledWith({ kind, id });
      expect(button(target).element.props['data-selected']).toBe(true);
      expect(button('node:人物丙').element.props['data-dimmed']).toBe(kind === 'node');
      expect(button('edge:同事').element.props['data-dimmed']).toBe(kind === 'node');
      expect(input(label)).toBeDefined();
      if (action === 'blank pane') await click('pane:blank');
      else if (action === 'same item') await click(target);
      else await activate(closeDetailsButton());
      expect(graphItems()).toHaveLength(5);
      expect(graphItems().every((item) => item.props['data-selected'] === false && item.props['data-dimmed'] === false)).toBe(true);
      expect(input(label)).toBeUndefined();
      expect(state.onEditorStateChange).toHaveBeenLastCalledWith(false);
      expect(state.onReadDetail).toHaveBeenCalledTimes(1);
      expect(state.onPatch).not.toHaveBeenCalled();
    });

  it.each(selectionTargets)('keeps the $kind selection and draft when returning to editing, then clears only after discard', async ({ kind, target, label }) => {
    state = selectionProps(); render(); await click(target);
    const draftLabel = `未保存的${label}`;
    (input(label)!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: draftLabel } }); render();
    await click('pane:blank');
    expect(text(view)).toContain('保留未保存的图谱编辑');
    expect(button(target).element.props['data-selected']).toBe(true);
    expect(input(draftLabel)).toBeDefined();
    expect(state.onEditorStateChange).not.toHaveBeenCalledWith(false);
    await click('返回编辑');
    expect(text(view)).not.toContain('保留未保存的图谱编辑');
    expect(button(target).element.props['data-selected']).toBe(true);
    expect(button('node:人物丙').element.props['data-dimmed']).toBe(kind === 'node');
    expect(input(draftLabel)).toBeDefined();
    expect(state.onDirtyChange).toHaveBeenLastCalledWith(true);
    await click('pane:blank'); await click('丢弃编辑并继续');
    expect(input(draftLabel)).toBeUndefined();
    expect(graphItems().every((item) => item.props['data-selected'] === false && item.props['data-dimmed'] === false)).toBe(true);
    expect(state.onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(state.onEditorStateChange).toHaveBeenLastCalledWith(false);
    expect(state.onReadDetail).toHaveBeenCalledTimes(1);
    expect(state.onPatch).not.toHaveBeenCalled();
  });

  it.each(selectionTargets)('preserves the $kind selection and details when the host cannot release the editor lease', async ({ kind, target, label }) => {
    let rejectRelease = true;
    state = selectionProps({ onEditorStateChange: vi.fn(async (open) => { if (!open && rejectRelease) throw new Error('宿主释放失败'); }) });
    render(); await click(target); await click('pane:blank');
    expect(text(view)).toContain('宿主释放失败');
    expect(button(target).element.props['data-selected']).toBe(true);
    expect(button('node:人物丙').element.props['data-dimmed']).toBe(kind === 'node');
    expect(input(label)).toBeDefined();
    expect(state.onReadDetail).toHaveBeenCalledTimes(1);
    expect(state.onPatch).not.toHaveBeenCalled();
    rejectRelease = false;
    await click('pane:blank');
    expect(input(label)).toBeUndefined();
    expect(graphItems().every((item) => item.props['data-selected'] === false && item.props['data-dimmed'] === false)).toBe(true);
  });

  it('saves the explicitly loaded full record, preserving evidence that is omitted from the view', async () => {
    state = props();
    expect(state.view.nodes[0].evidence).toEqual([]);
    render(); await click('node:人物甲');
    expect(state.onReadDetail).toHaveBeenCalledWith({ kind: 'node', id: 'person-a' });
    await click('保存记录');
    expect(state.onPatch).toHaveBeenCalledWith({ graphId: 'graph-a', upsertNodes: [node] }, state.view.revision);
    expect(vi.mocked(state.onPatch).mock.calls[0][0].upsertNodes?.[0]).not.toHaveProperty('evidenceCount');
  });

  it('keeps the edit form after persistence failure and marks changed source evidence', async () => {
    state = props({ onReadDetail: vi.fn(async (): Promise<StoryGraphDetail> => ({ item: node, evidenceStatuses: ['changed'] })), onPatch: vi.fn(async () => { throw new Error('保存失败'); }) });
    render(); await click('node:人物甲');
    expect(text(view)).toContain('来源已变化');
    await click('保存记录');
    expect(text(view)).toContain('保存失败');
    expect(input('人物甲')).toBeDefined();
  });

  it('keeps cancellation available after the graph context becomes read-only', async () => {
    state = props({ disabled: true, extraction: { status: 'running', completed: 1, total: 4 } });
    render();
    expect(button('新增记录').element.props.disabled).toBe(true);
    expect(button('取消提取').element.props.disabled).not.toBe(true);
    await click('取消提取');
    expect(state.onCancelExtraction).toHaveBeenCalledOnce(); expect(state.onExtract).not.toHaveBeenCalled();
  });

  it('waits for the host editor lease and keeps edited state in the same instance across fullscreen changes', async () => {
    let release!: () => void;
    state = props({ onEditorStateChange: vi.fn((open) => open ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve()) });
    render(); await click('node:人物甲');
    expect(state.onEditorStateChange).toHaveBeenCalledWith(true);
    expect(input('人物甲')).toBeUndefined();
    release(); await settle();
    const editorInput = input('人物甲')!;
    (editorInput.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '未保存的角色名称' } }); render();
    const editorInstance = [...hooks.frames.keys()].find((id) => id.includes(':StoryGraphDetails:'));
    expect(input('未保存的角色名称')).toBeDefined();
    const fullscreen = entries(view).find(({ element }) => element.type === 'button' && element.props['aria-label'] === '全屏显示图谱')!;
    await activate(fullscreen);
    expect(input('未保存的角色名称')).toBeDefined();
    expect([...hooks.frames.keys()].find((id) => id.includes(':StoryGraphDetails:'))).toBe(editorInstance);
    const exit = entries(view).find(({ element }) => element.type === 'button' && element.props['aria-label'] === '退出图谱全屏')!;
    await activate(exit);
    expect(input('未保存的角色名称')).toBeDefined();
    expect([...hooks.frames.keys()].find((id) => id.includes(':StoryGraphDetails:'))).toBe(editorInstance);
  });

  it('blocks switching records during a pending save, so its completion cannot close another editor', async () => {
    let finish!: () => void;
    const other = { ...node, id: 'person-b', label: '人物乙', evidence: [] };
    state = props({ onPatch: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
    state.view = projectStoryGraphView({ ...createEmptyStoryGraph('graph-a'), nodes: [node, other] });
    render(); await click('node:人物甲'); await click('保存记录'); await click('node:人物乙');
    await click('pane:blank'); await click('node:人物甲'); await activate(closeDetailsButton());
    expect(state.onReadDetail).toHaveBeenCalledTimes(1);
    expect(button('node:人物甲').element.props['data-selected']).toBe(true);
    expect(button('node:人物乙').element.props['data-selected']).toBe(false);
    expect(input('人物甲')).toBeDefined();
    expect(state.onEditorStateChange).not.toHaveBeenCalledWith(false);
    finish(); await settle();
    expect(state.onEditorStateChange).toHaveBeenLastCalledWith(false);
    expect(input('人物甲')).toBeUndefined();
    expect(graphItems().every((item) => item.props['data-selected'] === false && item.props['data-dimmed'] === false)).toBe(true);
  });

  it('adopts only selected candidate IDs instead of sending renderer-supplied graph objects', async () => {
    const candidateNode = { ...node, id: 'candidate-node', origin: 'ai' as const };
    state = props({ extraction: { status: 'ready', completed: 1, total: 1, candidate: {
      id: 'candidate-a', seriesId: 'series-a', sessionId: 'session-a', graphId: 'graph-a', graphRevision: 0,
      modelFingerprint: 'model-a', sourceBindings: [{ episodeId: 'episode-b', part: 'script', sourceHash: 'a'.repeat(64) }],
      nodes: [candidateNode], edges: [], callsUsed: 1, hasMore: false, totalChunks: 1,
    } } });
    render(); await click('审阅候选');
    const checkbox = entries(view).find(({ element }) => element.type === 'input' && element.props.type === 'checkbox')!.element;
    expect(checkbox).toBeDefined();
    (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } }); render();
    const candidateInstance = [...hooks.frames.keys()].find((id) => id.includes(':CandidateReview:'));
    expect(candidateInstance).toBeDefined();
    for (const presentation of ['点阵', '卡片']) {
      await click(presentation);
      expect([...hooks.frames.keys()].find((id) => id.includes(':CandidateReview:'))).toBe(candidateInstance);
      expect(entries(view).find(({ element }) => element.type === 'input' && element.props.type === 'checkbox')!.element.props.checked).toBe(true);
    }
    await click('采纳所选候选');
    expect(state.onAdoptCandidates).toHaveBeenCalledWith('candidate-a', { nodeIds: ['candidate-node'], edgeIds: [], nodeMappings: {} });
    expect(state.onPatch).not.toHaveBeenCalled(); expect(state.onExtract).not.toHaveBeenCalled(); expect(state.onReadDetail).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(view)).not.toContain('candidate-node');
  });

  it('shows unverified candidate warnings for records and relationships without selecting them automatically', async () => {
    const unknownNode: StoryGraphNode = { ...node, id: 'candidate-unknown', label: '待核实人物', origin: 'ai', certainty: 'unknown', evidence: [] };
    const verifiedNode: StoryGraphNode = { ...node, id: 'candidate-verified', label: '已定位人物', origin: 'ai' };
    state = props({ extraction: { status: 'ready', completed: 1, total: 1, candidate: {
      id: 'candidate-review', seriesId: 'series-a', sessionId: 'session-a', graphId: 'graph-a', graphRevision: 0,
      modelFingerprint: 'model-a', sourceBindings: [{ episodeId: 'episode-b', part: 'script', sourceHash: 'a'.repeat(64) }],
      nodes: [unknownNode, verifiedNode],
      edges: [{ id: 'candidate-edge', source: unknownNode.id, target: verifiedNode.id, kind: 'related', directed: false, label: '待核实关系', description: '',
        episodeIds: ['episode-b'], origin: 'ai', certainty: 'unknown', evidence: [] }],
      callsUsed: 1, hasMore: false, totalChunks: 1,
    } } });
    render(); await click('审阅候选');
    const warning = '有 2 项候选缺少可定位的原文证据，已标为待核实；请核对后再采纳。';
    expect(entries(view).find(({ element }) => element.props.role === 'status' && text(element) === warning)).toBeDefined();
    const unknownRow = entries(view).find(({ element }) => element.type === 'li' && text(element).includes('待核实人物'))!.element;
    expect(entries(unknownRow).find(({ element }) => element.type === 'span' && text(element) === '待核实')).toBeDefined();
    expect(text(unknownRow)).toContain('尚无原文证据');
    const checkboxes = entries(view).filter(({ element }) => element.type === 'input' && element.props.type === 'checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every(({ element }) => element.props.checked === false)).toBe(true);
    expect(button('采纳所选候选').element.props.disabled).toBe(true);
    await click('采纳所选候选');
    expect(state.onAdoptCandidates).not.toHaveBeenCalled();
    await click('关系');
    expect(text(view)).toContain(warning);
    const edgeRow = entries(view).find(({ element }) => element.type === 'li' && text(element).includes('待核实关系'))!.element;
    expect(entries(edgeRow).find(({ element }) => element.type === 'span' && text(element) === '待核实')).toBeDefined();
    expect(text(edgeRow)).toContain('尚无原文证据');
    const edgeCheckbox = entries(edgeRow).find(({ element }) => element.type === 'input' && element.props.type === 'checkbox')!.element;
    expect(edgeCheckbox.props.checked).toBe(false);
    expect(button('采纳所选候选').element.props.disabled).toBe(true);
    expect(state.onAdoptCandidates).not.toHaveBeenCalled();
    expect(state.onPatch).not.toHaveBeenCalled();
    expect(state.onExtract).not.toHaveBeenCalled();
  });
});
