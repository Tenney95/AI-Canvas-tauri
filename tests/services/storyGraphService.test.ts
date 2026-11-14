import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryGraphEdge, StoryGraphNode } from '../../src/types/storyGraph';
import { applyStoryGraphPatch, createEmptyStoryGraph, hashStoryGraphSource, layoutStoryGraphConstellation, normalizeStoryGraph, projectStoryGraphView, STORY_GRAPH_LIMITS, storyGraphCanonicalSnapshot, storyGraphJsonBytes, validateStoryGraphEvidence } from '../../src/services/storyGraphService';
import { buildStoryGraphWritingContext } from '../../src/services/storyGraphWritingContext';

function node(id: string, label = id): StoryGraphNode { return { id, kind: 'character', label, description: '', aliases: [], episodeIds: ['episode-a'], evidence: [], origin: 'manual', certainty: 'unknown' }; }
function edge(id: string, source: string, target: string): StoryGraphEdge { return { id, source, target, kind: 'character_relationship', directed: true, label: '信任', description: '', episodeIds: ['episode-a'], evidence: [], origin: 'manual', certainty: 'inferred' }; }
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('图谱创作参考', () => {
  const episodes = ['episode-a', 'episode-b', 'episode-c'].map((id, index) => ({ id, name: id, episodeNo: index + 1 }));

  it('按目标分集保留关系和前序伏笔，证据提及不会把后续事件提前', () => {
    const evidence = { episodeId: episodes[0].id, part: 'script' as const, sourceHash: 'a'.repeat(64), start: 0, end: 5, quote: '证据原句。' };
    const graph = { ...createEmptyStoryGraph('writing-graph'),
      nodes: [
        { ...node('a', '林夏'), episodeIds: [] },
        { ...node('b', '周野'), episodeIds: [episodes[1].id] },
        { ...node('letter', '旧信'), kind: 'foreshadow' as const, foreshadowStatus: 'resolved' as const },
        { ...node('future', '身份揭露'), kind: 'event' as const, episodeIds: [episodes[2].id], evidence: [evidence] },
      ],
      edges: [
        { ...edge('relationship', 'a', 'b'), label: '师徒', episodeIds: [], fromEpisodeId: episodes[0].id, toEpisodeId: episodes[2].id },
        { ...edge('reveal', 'future', 'letter'), kind: 'resolves' as const, episodeIds: [episodes[2].id], certainty: 'explicit' as const },
      ],
    };
    const script = buildStoryGraphWritingContext(graph, { episodes, episodeId: episodes[1].id });
    expect(script).toContain('师徒');
    expect(script).toContain('本集有效');
    expect(script).toContain('推断');
    expect(script).toContain('旧信');
    expect(script).not.toMatch(/身份揭露|已回收|证据原句/);
    expect(buildStoryGraphWritingContext(graph, { episodes, episodeId: episodes[2].id })).toContain('已回收');
    expect(buildStoryGraphWritingContext(graph, { episodes })).toContain('身份揭露');
  });

  it('在预算内保留完整条目，消除可展开引用、路径及凭据', () => {
    const graph = { ...createEmptyStoryGraph('writing-graph'), nodes: [
      { ...node('featured', '林夏'), description: '涉及 @skill{fake|名称} /Users/author/doc.txt sk-secret123456789' },
      ...Array.from({ length: 20 }, (_, index) => ({ ...node(`other-${index}`), description: '长'.repeat(200) })),
    ] };
    const context = buildStoryGraphWritingContext(graph, { episodes, relevantText: '林夏', maxCharacters: 330 });
    expect(context).toContain('林夏');
    expect(context).toContain('＠skill');
    expect(context).not.toMatch(/@skill\{|\/Users\/|sk-secret/);
    expect(context).toMatch(/【故事关系图参考资料结束】$/);
    expect(context.length).toBeLessThanOrEqual(330);
    expect(buildStoryGraphWritingContext(graph, { episodes, episodeId: 'other-series' })).toBe('');
    expect(buildStoryGraphWritingContext(undefined, { episodes })).toBe('');
  });
});

describe('story graph domain boundaries', () => {
  it('rejects unknown fields, unsupported versions, duplicate IDs and dangling relationships', () => {
    const empty = createEmptyStoryGraph('graph-a');
    expect(() => normalizeStoryGraph({ ...empty, runtime: {} })).toThrow();
    expect(() => normalizeStoryGraph({ ...empty, schemaVersion: 2 })).toThrow();
    expect(() => normalizeStoryGraph({ ...empty, nodes: [node('a'), node('a')] })).toThrow();
    expect(() => normalizeStoryGraph({ ...empty, nodes: [node('a')], edges: [edge('relation', 'a', 'missing')] })).toThrow();
    expect(() => normalizeStoryGraph({ ...empty, nodes: [{ ...node('a'), asset: { kind: 'character', id: 'asset-a', path: 'private' } }] })).toThrow();
    expect(() => normalizeStoryGraph({ ...empty, positions: { a: { x: Number.NaN, y: 0 } } })).toThrow();
  });

  it('keeps directional relationships, parallel relationships and character cycles distinct', () => {
    const graph = normalizeStoryGraph({ ...createEmptyStoryGraph('graph-a'), nodes: [node('a'), node('b')], edges: [edge('one', 'a', 'b'), { ...edge('two', 'a', 'b'), label: '怀疑' }, edge('three', 'b', 'a')] });
    expect(graph.edges.map((entry) => entry.label)).toEqual(['信任', '怀疑', '信任']);
    expect(graph.edges[2].target).toBe('a');
  });

  it('applies an immutable conditional patch and removes incident edges and positions with a deleted node', () => {
    const original = normalizeStoryGraph({ ...createEmptyStoryGraph('graph-a'), revision: 7, nodes: [node('a'), node('b')], edges: [edge('relation', 'a', 'b')], positions: { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } } });
    expect(() => applyStoryGraphPatch(original, { graphId: 'graph-a', removeNodeIds: ['a'] }, 6)).toThrow('已变化');
    expect(() => applyStoryGraphPatch(original, { graphId: 'different' }, 7)).toThrow('已变化');
    const next = applyStoryGraphPatch(original, { graphId: 'graph-a', removeNodeIds: ['a'] }, 7);
    expect(next.revision).toBe(8);
    expect(next.nodes.map((entry) => entry.id)).toEqual(['b']);
    expect(next.edges).toEqual([]);
    expect(next.positions).toEqual({ b: { x: 30, y: 40 } });
    expect(original.nodes).toHaveLength(2);
    expect(original.edges).toHaveLength(1);
  });

  it('rejects oversized updates without truncating the original graph', () => {
    const original = createEmptyStoryGraph('graph-a');
    expect(() => normalizeStoryGraph({ ...original, nodes: Array.from({ length: 501 }, (_, index) => node(`n${index}`)) })).toThrow();
    expect(() => applyStoryGraphPatch(original, { upsertNodes: Array.from({ length: 100 }, (_, index) => ({ ...node(`n${index}`), description: '长'.repeat(1000) })) }, 0)).toThrow();
    expect(original.nodes).toEqual([]);
    expect(original.revision).toBe(0);
  });

  it('exports a canonical graph independent of local revision and collection ordering', () => {
    const first = normalizeStoryGraph({ ...createEmptyStoryGraph('graph-a'), revision: 2, nodes: [node('b'), { ...node('a'), aliases: ['乙', '甲'] }] });
    const second = { ...first, revision: 900, nodes: [{ ...first.nodes[1], aliases: ['甲', '乙'] }, first.nodes[0]] };
    expect(storyGraphCanonicalSnapshot(first)).toEqual(storyGraphCanonicalSnapshot(second));
    expect(storyGraphCanonicalSnapshot(first)).not.toHaveProperty('revision');
  });

  it('keeps initial and manually saved positions stable when filtering the visible subgraph', () => {
    const graph = normalizeStoryGraph({ ...createEmptyStoryGraph('graph-a'), nodes: [node('a', '甲'), node('b', '乙'), node('c', '丙')], positions: { b: { x: 71, y: 83 } } });
    const all = projectStoryGraphView(graph);
    expect(projectStoryGraphView(graph, { search: '甲' }).positions.a).toEqual(all.positions.a);
    expect(projectStoryGraphView(graph, { search: '乙' }).positions.b).toEqual({ x: 71, y: 83 });
  });

  it('projects bounded summaries while retaining true counts and leaving full evidence in the source graph', () => {
    const proof = { episodeId: 'episode-a', part: 'script' as const, sourceHash: 'a'.repeat(64), start: 0, end: 2, quote: '原文' };
    const nodes = Array.from({ length: 205 }, (_, index) => ({ ...node(`n${index}`), description: '长'.repeat(1000), evidence: [proof] }));
    const graph = normalizeStoryGraph({ ...createEmptyStoryGraph('graph-a'), nodes });
    const view = projectStoryGraphView(graph);
    expect(view.counts).toMatchObject({ totalNodes: 205, matchedNodes: 205, visibleNodes: 200, truncated: true });
    expect(storyGraphJsonBytes(view)).toBeLessThanOrEqual(STORY_GRAPH_LIMITS.viewBytes);
    expect(view.nodes.every((entry) => entry.evidence.length === 0 && entry.evidenceCount === 1)).toBe(true);
    expect(graph.nodes[0].description).toHaveLength(1000);
    expect(graph.nodes[0].evidence[0].quote).toBe('原文');
  });

  it('filters adjacent relationships in both directions and never invents new relationship kinds', () => {
    const graph = normalizeStoryGraph({ ...createEmptyStoryGraph('graph-a'), nodes: [node('a'), node('b'), node('c'), node('d')], edges: [edge('ab', 'a', 'b'), edge('ca', 'c', 'a'), edge('bd', 'b', 'd')] });
    const view = projectStoryGraphView(graph, { focusNodeId: 'a', neighbors: true });
    expect(view.nodes.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(view.edges.map((entry) => entry.id)).toEqual(['ab', 'ca']);
    expect(projectStoryGraphView(graph, { focusNodeId: 'a', neighbors: false }).edges).toEqual([]);
  });

  it('includes global characters needed by an in-scope episode relationship', () => {
    const graph = { ...createEmptyStoryGraph('graph-a'), nodes: [{ ...node('global'), episodeIds: [] }, node('local')], edges: [edge('participation', 'global', 'local')] };
    const view = projectStoryGraphView(graph, { episodeIds: ['episode-a'] });
    expect(view.nodes.map((entry) => entry.id)).toEqual(['global', 'local']);
    expect(view.edges).toHaveLength(1);
  });

  it('validates exact UTF-16 evidence and refuses stale hashes, changed text and wrong parts', async () => {
    const text = '前😀后';
    const source = { episodeId: 'episode-a', part: 'script' as const, text, sourceHash: await hashStoryGraphSource(text) };
    const proof = { episodeId: 'episode-a', part: 'script' as const, sourceHash: source.sourceHash, start: 1, end: 3, quote: '😀' };
    expect(validateStoryGraphEvidence(proof, source)).toBe(true);
    expect(validateStoryGraphEvidence({ ...proof, end: 2 }, source)).toBe(false);
    expect(validateStoryGraphEvidence(proof, { ...source, sourceHash: 'b'.repeat(64) })).toBe(false);
    expect(validateStoryGraphEvidence(proof, { ...source, text: '前甲乙后' })).toBe(false);
    expect(validateStoryGraphEvidence(proof, { ...source, part: 'outline' })).toBe(false);
  });
});

describe('story graph constellation layout', () => {
  it('is deterministic across node and relationship ordering without changing input or saved positions', () => {
    const graph = { ...createEmptyStoryGraph('graph-a'), nodes: [node('c'), node('a'), node('b')], edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')], positions: { a: { x: 71, y: 83 } } };
    const original = structuredClone(graph), canonical = storyGraphCanonicalSnapshot(graph);
    const first = layoutStoryGraphConstellation(graph.nodes, graph.edges);
    expect(layoutStoryGraphConstellation(graph.nodes, graph.edges)).toEqual(first);
    expect(layoutStoryGraphConstellation([...graph.nodes].reverse(), [...graph.edges].reverse())).toEqual(first);
    expect(graph).toEqual(original);
    expect(storyGraphCanonicalSnapshot(graph)).toEqual(canonical);
    expect(projectStoryGraphView(graph).positions.a).toEqual({ x: 71, y: 83 });
  });

  it('handles empty, singleton and disconnected nodes with finite separated positions', () => {
    expect(layoutStoryGraphConstellation([], [])).toEqual({});
    expect(layoutStoryGraphConstellation([{ id: 'only' }], [])).toEqual({ only: { x: 0, y: 0 } });
    const positions = Object.values(layoutStoryGraphConstellation(Array.from({ length: 20 }, (_, index) => ({ id: `n${index}` })), []));
    expect(positions).toHaveLength(20);
    positions.forEach((point, index) => {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      positions.slice(index + 1).forEach((other) => expect(Math.hypot(point.x - other.x, point.y - other.y)).toBeGreaterThanOrEqual(23.99));
    });
  });

  it('uses topology while ignoring self loops, unknown endpoints and parallel or reversed spring duplicates', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const relationship = { source: 'a', target: 'b' };
    const linked = layoutStoryGraphConstellation(nodes, [relationship]);
    expect(layoutStoryGraphConstellation(nodes, [relationship, relationship, { source: 'b', target: 'a' }, { source: 'a', target: 'a' }, { source: 'a', target: 'missing' }])).toEqual(linked);
    expect(layoutStoryGraphConstellation(nodes, [{ source: 'a', target: 'a' }])).toEqual(layoutStoryGraphConstellation(nodes, []));
    const disconnected = layoutStoryGraphConstellation(nodes, []);
    const distance = (positions: typeof linked) => Math.hypot(positions.a.x - positions.b.x, positions.a.y - positions.b.y);
    expect(distance(linked)).toBeLessThan(distance(disconnected));
  });

  it('lays out the full visible limit and rejects unbounded or ambiguous input', () => {
    const nodes = Array.from({ length: STORY_GRAPH_LIMITS.visibleNodes }, (_, index) => ({ id: `n${index}` }));
    const positions = Object.values(layoutStoryGraphConstellation(nodes, nodes.slice(1).map((entry) => ({ source: 'n0', target: entry.id }))));
    expect(positions).toHaveLength(STORY_GRAPH_LIMITS.visibleNodes);
    expect(positions.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    expect(() => layoutStoryGraphConstellation([...nodes, { id: 'overflow' }], [])).toThrow();
    expect(() => layoutStoryGraphConstellation([{ id: 'same' }, { id: 'same' }], [])).toThrow();
    expect(() => layoutStoryGraphConstellation([{ id: '__proto__' }], [])).toThrow();
    expect(() => layoutStoryGraphConstellation([], Array.from({ length: STORY_GRAPH_LIMITS.edges + 1 }, () => ({ source: 'a', target: 'b' })))).toThrow();
  });
});
