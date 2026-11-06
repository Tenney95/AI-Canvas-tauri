import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryGraphDetail, StoryGraphNode } from '../../src/types/storyGraph';
import StoryGraphPanel, { type StoryGraphPanelProps } from '../../src/components/storyGraph/StoryGraphPanel';
import { createEmptyStoryGraph, projectStoryGraphView } from '../../src/services/storyGraphService';

// 沿用仓库的可重入 Hook 槽；实例以组件路径和 key 区分，不依赖额外 DOM 环境。
interface HookFrame { id: string; cursor: number; values: unknown[] }
const hooks = vi.hoisted(() => ({ frames: new Map<string, HookFrame>(), active: new Set<string>(), current: null as HookFrame | null }));
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
    useId: () => 'graph-' + (hooks.current?.id ?? '').replace(/[^a-z0-9_-]/gi, '-'),
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock('../../src/i18n', () => ({ useT: () => (key: string, parameters?: Record<string, string | number>) => key.replace(/\{([^}]+)\}/g, (_, name: string) => String(parameters?.[name] ?? '{' + name + '}')) }));
vi.mock('framer-motion', () => ({ useReducedMotion: () => true }));
vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('../../src/hooks/useDialogFocus', () => ({ useDialogFocus: () => undefined }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? <div>{children}</div> : null }));
vi.mock('../../src/components/shared/Tabs', () => ({ default: ({ items, onChange }: { items: Array<{ value: string; label: ReactNode }>; onChange: (value: string) => void }) => <div>{items.map((item) => <button key={item.value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div> }));
vi.mock('../../src/components/shared/Select', () => ({ default: ({ options = [], value, onChange, id, disabled, ...rest }: {
  options?: Array<{ value: string; label: ReactNode; disabled?: boolean }>; value: string; onChange: (value: string) => void;
  id?: string; disabled?: boolean; 'aria-label'?: string;
}) => <select id={id} aria-label={rest['aria-label']} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
  {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select> }));
vi.mock('../../src/components/shared/NumberStepper', () => ({ default: ({ value, disabled, id }: { value: number; disabled?: boolean; id?: string }) => <input id={id} type="number" value={value} disabled={disabled} readOnly /> }));
vi.mock('../../src/components/nodes/shared/ModelSelector', () => ({ default: () => <span>model-control</span> }));
vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ReactFlow: ({ nodes, edges, onNodeClick, onEdgeClick }: {
    nodes: Array<{ id: string; data: { label: string } }>; edges: Array<{ id: string; data: { label: string } }>;
    onNodeClick: (event: unknown, node: { id: string }) => void; onEdgeClick: (event: unknown, edge: { id: string }) => void;
  }) => <div>{nodes.map((node) => <button key={node.id} onClick={() => onNodeClick({}, node)}>{'node:' + node.data.label}</button>)}
    {edges.map((edge) => <button key={edge.id} onClick={() => onEdgeClick({}, edge)}>{'edge:' + edge.data.label}</button>)}</div>,
  Background: () => null, BackgroundVariant: { Dots: 'dots' }, Handle: () => null, Position: { Left: 'left', Right: 'right' },
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

type Element = ReactElement<Record<string, unknown>>;
function expand(node: ReactNode, path: string): ReactNode {
  if (Array.isArray(node)) return node.map((child, index) => expand(child, path + '/' + index));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  let component: unknown = node.type;
  if (component && typeof component === 'object' && 'type' in component) component = component.type;
  if (typeof component === 'function') {
    const componentId = path + ':' + component.name + ':' + (node.key ?? '');
    const frame = hooks.frames.get(componentId) ?? { id: componentId, cursor: 0, values: [] };
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
let state: StoryGraphPanelProps;
let view: ReactNode;
function render() {
  hooks.active = new Set();
  view = expand(<StoryGraphPanel {...state} />, 'root');
  for (const id of hooks.frames.keys()) if (!hooks.active.has(id)) hooks.frames.delete(id);
}
function button(label: string) {
  const result = entries(view).find(({ element }) => element.type === 'button' && text(element.props.children as ReactNode) === label);
  if (!result) throw new Error('Missing button ' + label);
  return result;
}
function input(value: string) {
  return entries(view).find(({ element }) => element.type === 'input' && element.props.value === value)?.element;
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
beforeEach(() => { hooks.frames.clear(); hooks.active.clear(); hooks.current = null; });

describe('故事关系图 UI 边界', () => {
  it('opening a bounded view never extracts, writes, reads hidden detail, or changes the parent episode', () => {
    state = props(); render();
    expect(text(view)).toContain('1 / 1 条记录');
    expect(state.onExtract).not.toHaveBeenCalled(); expect(state.onPatch).not.toHaveBeenCalled(); expect(state.onReadDetail).not.toHaveBeenCalled();
    expect(state.onFilterChange).not.toHaveBeenCalled();
    expect(state.currentEpisodeId).toBe('episode-b');
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
    expect(state.onReadDetail).toHaveBeenCalledTimes(1);
    finish(); await settle();
    expect(state.onEditorStateChange).toHaveBeenLastCalledWith(false);
    expect(input('人物甲')).toBeUndefined();
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
    await click('采纳所选候选');
    expect(state.onAdoptCandidates).toHaveBeenCalledWith('candidate-a', { nodeIds: ['candidate-node'], edgeIds: [], nodeMappings: {} });
    expect(state.onPatch).not.toHaveBeenCalled(); expect(state.onExtract).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(view)).not.toContain('candidate-node');
  });
});
