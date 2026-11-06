// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryGraphDetail, StoryGraphNode } from '../../src/types/storyGraph';
import StoryGraphPanel, { type StoryGraphPanelProps } from '../../src/components/storyGraph/StoryGraphPanel';
import { createEmptyStoryGraph, projectStoryGraphView } from '../../src/services/storyGraphService';

vi.mock('../../src/i18n', () => ({ useT: () => (key: string, parameters?: Record<string, string | number>) => key.replace(/\{([^}]+)\}/g, (_, name: string) => String(parameters?.[name] ?? `{${name}}`)) }));
vi.mock('framer-motion', () => ({ useReducedMotion: () => true }));
vi.mock('../../src/hooks/useDialogFocus', () => ({ useDialogFocus: () => undefined }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? <div>{children}</div> : null }));
vi.mock('../../src/components/shared/Tabs', () => ({ default: ({ items, onChange }: { items: Array<{ value: string; label: ReactNode }>; onChange: (value: string) => void }) => <div>{items.map((item) => <button key={item.value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div> }));
vi.mock('../../src/components/nodes/shared/ModelSelector', () => ({ default: () => <span>model-control</span> }));
vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ReactFlow: ({ nodes, edges, onNodeClick, onEdgeClick }: {
    nodes: Array<{ id: string; data: { label: string } }>; edges: Array<{ id: string; data: { label: string } }>;
    onNodeClick: (event: unknown, node: { id: string }) => void; onEdgeClick: (event: unknown, edge: { id: string }) => void;
  }) => <div>{nodes.map((node) => <button key={node.id} onClick={() => onNodeClick({}, node)}>{`node:${node.data.label}`}</button>)}
    {edges.map((edge) => <button key={edge.id} onClick={() => onEdgeClick({}, edge)}>{`edge:${edge.data.label}`}</button>)}</div>,
  Background: () => null, BackgroundVariant: { Dots: 'dots' }, Handle: () => null, Position: { Left: 'left', Right: 'right' },
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

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
let container: HTMLDivElement;
let root: Root;
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('故事关系图 UI 边界', () => {
  it('opening a bounded view never extracts, writes, reads hidden detail, or changes the parent episode', async () => {
    const state = props();
    await act(async () => root.render(<StoryGraphPanel {...state} />));
    expect(container.textContent).toContain('1 / 1 条记录');
    expect(state.onExtract).not.toHaveBeenCalled(); expect(state.onPatch).not.toHaveBeenCalled(); expect(state.onReadDetail).not.toHaveBeenCalled();
    expect(state.onFilterChange).not.toHaveBeenCalled();
    expect(state.currentEpisodeId).toBe('episode-b');
  });

  it('saves the explicitly loaded full record, preserving evidence that is omitted from the view', async () => {
    const state = props();
    expect(state.view.nodes[0].evidence).toEqual([]);
    await act(async () => root.render(<StoryGraphPanel {...state} />));
    await act(async () => button('node:人物甲').click());
    expect(state.onReadDetail).toHaveBeenCalledWith({ kind: 'node', id: 'person-a' });
    await act(async () => button('保存记录').click());
    expect(state.onPatch).toHaveBeenCalledWith({ graphId: 'graph-a', upsertNodes: [node] }, state.view.revision);
    const patch = vi.mocked(state.onPatch).mock.calls[0][0];
    expect(patch.upsertNodes?.[0]).not.toHaveProperty('evidenceCount');
  });

  it('keeps the edit form after persistence failure and marks changed source evidence', async () => {
    const state = props({ onReadDetail: vi.fn(async (): Promise<StoryGraphDetail> => ({ item: node, evidenceStatuses: ['changed'] })), onPatch: vi.fn(async () => { throw new Error('保存失败'); }) });
    await act(async () => root.render(<StoryGraphPanel {...state} />));
    await act(async () => button('node:人物甲').click());
    expect(container.textContent).toContain('来源已变化');
    await act(async () => button('保存记录').click());
    expect(container.textContent).toContain('保存失败');
    expect(container.querySelector('input[value="人物甲"]')).not.toBeNull();
  });

  it('keeps cancellation available after the graph context becomes read-only', async () => {
    const state = props({ disabled: true, extraction: { status: 'running', completed: 1, total: 4 } });
    await act(async () => root.render(<StoryGraphPanel {...state} />));
    expect(button('新增记录').disabled).toBe(true);
    expect(button('取消提取').disabled).toBe(false);
    await act(async () => button('取消提取').click());
    expect(state.onCancelExtraction).toHaveBeenCalledOnce(); expect(state.onExtract).not.toHaveBeenCalled();
  });

  it('waits for the main-window editor lease and preserves the same form across fullscreen changes', async () => {
    let release!: () => void;
    const state = props({ onEditorStateChange: vi.fn((open) => open ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve()) });
    await act(async () => root.render(<StoryGraphPanel {...state} />));
    await act(async () => button('node:人物甲').click());
    expect(state.onEditorStateChange).toHaveBeenCalledWith(true);
    expect(container.querySelector('input[value="人物甲"]')).toBeNull();
    await act(async () => release());
    const input = container.querySelector('input[value="人物甲"]');
    expect(input).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="全屏显示图谱"]')!.click());
    expect(container.querySelector('input[value="人物甲"]')).toBe(input);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="退出图谱全屏"]')!.click());
    expect(container.querySelector('input[value="人物甲"]')).toBe(input);
  });

  it('blocks switching records during a pending save, so its completion cannot close another editor', async () => {
    let finish!: () => void;
    const other = { ...node, id: 'person-b', label: '人物乙', evidence: [] };
    const state = props({ onPatch: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
    state.view = projectStoryGraphView({ ...createEmptyStoryGraph('graph-a'), nodes: [node, other] });
    await act(async () => root.render(<StoryGraphPanel {...state} />));
    await act(async () => button('node:人物甲').click());
    await act(async () => button('保存记录').click());
    await act(async () => button('node:人物乙').click());
    expect(state.onReadDetail).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(state.onEditorStateChange).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('input[value="人物甲"]')).toBeNull();
  });

  it('adopts only selected candidate IDs instead of sending renderer-supplied graph objects', async () => {
    const candidateNode = { ...node, id: 'candidate-node', origin: 'ai' as const };
    const state = props({ extraction: { status: 'ready', completed: 1, total: 1, candidate: {
      id: 'candidate-a', seriesId: 'series-a', sessionId: 'session-a', graphId: 'graph-a', graphRevision: 0,
      modelFingerprint: 'model-a', sourceBindings: [{ episodeId: 'episode-b', part: 'script', sourceHash: 'a'.repeat(64) }],
      nodes: [candidateNode], edges: [], callsUsed: 1, hasMore: false, totalChunks: 1,
    } } });
    await act(async () => root.render(<StoryGraphPanel {...state} />));
    await act(async () => button('审阅候选').click());
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox!.click());
    await act(async () => button('采纳所选候选').click());
    expect(state.onAdoptCandidates).toHaveBeenCalledWith('candidate-a', { nodeIds: ['candidate-node'], edgeIds: [], nodeMappings: {} });
    expect(state.onPatch).not.toHaveBeenCalled(); expect(state.onExtract).not.toHaveBeenCalled();
  });
});
