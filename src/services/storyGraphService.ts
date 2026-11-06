import { STORY_GRAPH_EDGE_KINDS, STORY_GRAPH_NODE_KINDS, type StoryGraph, type StoryGraphCanonical, type StoryGraphCertainty, type StoryGraphEdge, type StoryGraphEvidence, type StoryGraphFilter, type StoryGraphNode, type StoryGraphPatch, type StoryGraphPosition, type StoryGraphSource, type StoryGraphView } from '../types/storyGraph';

export const STORY_GRAPH_LIMITS = { nodes: 500, edges: 1500, bytes: 1024 * 1024, patchBytes: 64 * 1024, viewBytes: 256 * 1024, visibleNodes: 200, visibleEdges: 400, labelChars: 120, descriptionChars: 1000, evidencePerItem: 4, quoteChars: 240 } as const;
export const STORY_GRAPH_NODE_LABELS: Record<StoryGraphNode['kind'], string> = { character: '人物', event: '关键事件', foreshadow: '伏笔', setting: '设定', location: '地点', prop: '道具', organization: '组织' };
export const STORY_GRAPH_EDGE_LABELS: Record<StoryGraphEdge['kind'], string> = { character_relationship: '人物关系', participates: '参与', located_in: '发生于', owns: '持有', member_of: '归属', precedes: '先后', causes: '导致', plants: '埋设', resolves: '回收', related: '相关' };
export const STORY_GRAPH_CERTAINTY_LABELS: Record<StoryGraphCertainty, string> = { explicit: '原文陈述', inferred: '推断', unknown: '待核实' };

function fail(): never { throw new Error('故事关系图格式或容量无效'); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) return fail();
  return record;
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\u0000')) return fail();
  return value;
}
function id(value: unknown): string {
  const result = string(value, 180);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(result) || ['constructor', 'prototype', '__proto__'].includes(result)) return fail();
  return result;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return fail();
  return value as number;
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return fail();
  return value as T;
}
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) return fail(); return value; }
function unique<T>(values: T[]): T[] { if (new Set(values).size !== values.length) return fail(); return values; }
function ids(value: unknown, max = 256): string[] { return unique(array(value, max).map(id)); }
export function storyGraphJsonBytes(value: unknown): number { try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return fail(); } }
function bound(value: unknown, max: number): void { if (storyGraphJsonBytes(value) > max) fail(); }
function evidence(value: unknown): StoryGraphEvidence {
  const item = object(value, ['episodeId', 'part', 'sourceHash', 'start', 'end', 'quote']);
  const sourceHash = string(item.sourceHash, 64);
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) return fail();
  const quote = string(item.quote, STORY_GRAPH_LIMITS.quoteChars);
  const start = integer(item.start), end = integer(item.end);
  if (end <= start || end - start !== quote.length) return fail();
  return { episodeId: id(item.episodeId), part: enumeration(item.part, ['outline', 'script']), sourceHash, start, end, quote };
}
function common(item: Record<string, unknown>) {
  return {
    id: id(item.id), label: string(item.label, STORY_GRAPH_LIMITS.labelChars), description: string(item.description, STORY_GRAPH_LIMITS.descriptionChars, true),
    episodeIds: ids(item.episodeIds), evidence: array(item.evidence, STORY_GRAPH_LIMITS.evidencePerItem).map(evidence),
    origin: enumeration(item.origin, ['manual', 'ai']), certainty: enumeration(item.certainty, ['explicit', 'inferred', 'unknown']),
  };
}
export function normalizeStoryGraphNode(value: unknown): StoryGraphNode {
  const item = object(value, ['id', 'kind', 'label', 'description', 'aliases', 'episodeIds', 'evidence', 'origin', 'certainty', 'storyOrder', 'storyTime', 'foreshadowStatus', 'asset']);
  const result: StoryGraphNode = { ...common(item), kind: enumeration(item.kind, STORY_GRAPH_NODE_KINDS), aliases: unique(array(item.aliases, 16).map((alias) => string(alias, 120))) };
  if (item.storyOrder !== undefined) result.storyOrder = integer(item.storyOrder, 0, 1000000);
  if (item.storyTime !== undefined) result.storyTime = string(item.storyTime, 240, true);
  if (item.foreshadowStatus !== undefined) result.foreshadowStatus = enumeration(item.foreshadowStatus, ['planted', 'developing', 'resolved']);
  if (item.asset !== undefined) { const asset = object(item.asset, ['kind', 'id']); result.asset = { kind: enumeration(asset.kind, ['character', 'scene', 'prop']), id: id(asset.id) }; }
  return result;
}
export function normalizeStoryGraphEdge(value: unknown): StoryGraphEdge {
  const item = object(value, ['id', 'source', 'target', 'kind', 'directed', 'label', 'description', 'episodeIds', 'evidence', 'origin', 'certainty', 'fromEpisodeId', 'toEpisodeId']);
  if (typeof item.directed !== 'boolean') return fail();
  const result: StoryGraphEdge = { ...common(item), source: id(item.source), target: id(item.target), kind: enumeration(item.kind, STORY_GRAPH_EDGE_KINDS), directed: item.directed };
  if (item.fromEpisodeId !== undefined) result.fromEpisodeId = id(item.fromEpisodeId);
  if (item.toEpisodeId !== undefined) result.toEpisodeId = id(item.toEpisodeId);
  return result;
}
function positions(value: unknown, nodeIds: Set<string>): Record<string, StoryGraphPosition> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length > STORY_GRAPH_LIMITS.nodes) return fail();
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (!nodeIds.has(id(key))) return fail();
    const point = object(entry, ['x', 'y']);
    if (typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1000000 || Math.abs(point.y) > 1000000) return fail();
    return [key, { x: point.x, y: point.y }];
  }));
}
export function createEmptyStoryGraph(graphId: string = crypto.randomUUID()): StoryGraph { return { schemaVersion: 1, id: id(graphId), revision: 0, nodes: [], edges: [], positions: {} }; }
export function normalizeStoryGraph(value: unknown): StoryGraph {
  bound(value, STORY_GRAPH_LIMITS.bytes);
  const item = object(value, ['schemaVersion', 'id', 'revision', 'nodes', 'edges', 'positions']);
  if (item.schemaVersion !== 1) return fail();
  const nodes = array(item.nodes, STORY_GRAPH_LIMITS.nodes).map(normalizeStoryGraphNode);
  const edges = array(item.edges, STORY_GRAPH_LIMITS.edges).map(normalizeStoryGraphEdge);
  const nodeIds = new Set(unique(nodes.map((node) => node.id)));
  unique(edges.map((edge) => edge.id));
  if (edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) return fail();
  return { schemaVersion: 1, id: id(item.id), revision: integer(item.revision), nodes, edges, positions: positions(item.positions, nodeIds) };
}
export function applyStoryGraphPatch(graph: StoryGraph | undefined, patch: StoryGraphPatch, expectedRevision: number): StoryGraph {
  bound(patch, STORY_GRAPH_LIMITS.patchBytes);
  integer(expectedRevision);
  const item = object(patch, ['graphId', 'upsertNodes', 'removeNodeIds', 'upsertEdges', 'removeEdgeIds', 'positions']);
  const current = graph ? normalizeStoryGraph(graph) : normalizeStoryGraph(createEmptyStoryGraph(item.graphId === undefined ? undefined : id(item.graphId)));
  if (current.revision !== expectedRevision || (item.graphId !== undefined && id(item.graphId) !== current.id)) throw new Error('故事关系图已变化，请重新比较后保存');
  if (current.revision >= Number.MAX_SAFE_INTEGER) return fail();
  const upsertNodes = item.upsertNodes === undefined ? [] : array(item.upsertNodes, STORY_GRAPH_LIMITS.nodes).map(normalizeStoryGraphNode);
  const upsertEdges = item.upsertEdges === undefined ? [] : array(item.upsertEdges, STORY_GRAPH_LIMITS.edges).map(normalizeStoryGraphEdge);
  const removedNodes = new Set(item.removeNodeIds === undefined ? [] : ids(item.removeNodeIds, STORY_GRAPH_LIMITS.nodes));
  const removedEdges = new Set(item.removeEdgeIds === undefined ? [] : ids(item.removeEdgeIds, STORY_GRAPH_LIMITS.edges));
  unique(upsertNodes.map((node) => node.id)); unique(upsertEdges.map((edge) => edge.id));
  if (upsertNodes.some((node) => removedNodes.has(node.id)) || upsertEdges.some((edge) => removedEdges.has(edge.id))) return fail();
  const nodes = new Map(current.nodes.filter((node) => !removedNodes.has(node.id)).map((node) => [node.id, node]));
  const edges = new Map(current.edges.filter((edge) => !removedEdges.has(edge.id) && !removedNodes.has(edge.source) && !removedNodes.has(edge.target)).map((edge) => [edge.id, edge]));
  upsertNodes.forEach((node) => nodes.set(node.id, node)); upsertEdges.forEach((edge) => edges.set(edge.id, edge));
  const previousPositions = Object.fromEntries(Object.entries(current.positions).filter(([key]) => nodes.has(key)));
  const nextPositions = item.positions === undefined ? previousPositions : { ...previousPositions, ...positions(item.positions, new Set(nodes.keys())) };
  return normalizeStoryGraph({ ...current, revision: current.revision + 1, nodes: [...nodes.values()], edges: [...edges.values()], positions: nextPositions });
}
export function storyGraphCanonicalSnapshot(graph: StoryGraph): StoryGraphCanonical {
  const current = normalizeStoryGraph(graph);
  const sortedCommon = <T extends StoryGraphNode | StoryGraphEdge>(entry: T): T => ({ ...entry, episodeIds: [...entry.episodeIds].sort(), evidence: [...entry.evidence].sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))) });
  return {
    schemaVersion: 1, id: current.id,
    nodes: current.nodes.map((node) => ({ ...sortedCommon(node), aliases: [...node.aliases].sort() })).sort((a, b) => compareText(a.id, b.id)),
    edges: current.edges.map(sortedCommon).sort((a, b) => compareText(a.id, b.id)),
    positions: Object.fromEntries(Object.entries(current.positions).sort(([a], [b]) => compareText(a, b))),
  };
}
export function layoutStoryGraphNodes(nodes: readonly StoryGraphNode[], saved: Record<string, StoryGraphPosition> = {}): Record<string, StoryGraphPosition> {
  const result: Record<string, StoryGraphPosition> = {};
  for (const [kindIndex, kind] of STORY_GRAPH_NODE_KINDS.entries()) {
    const members = nodes.filter((node) => node.kind === kind).sort((a, b) => compareText(a.id, b.id));
    members.forEach((node, index) => {
      const angle = 2 * Math.PI * index / Math.max(1, members.length);
      const radius = members.length === 1 ? 0 : Math.max(100, Math.sqrt(members.length) * 35);
      result[node.id] = saved[node.id] ? { ...saved[node.id] } : { x: kindIndex % 3 * 400 + Math.cos(angle) * radius, y: Math.floor(kindIndex / 3) * 400 + Math.sin(angle) * radius };
    });
  }
  return result;
}
export function projectStoryGraphView(graph: StoryGraph, filter: StoryGraphFilter = {}): StoryGraphView {
  const current = normalizeStoryGraph(graph);
  const query = object(filter, ['episodeIds', 'search', 'nodeKinds', 'edgeKinds', 'focusNodeId', 'neighbors', 'limitNodes', 'limitEdges']);
  const episodes = query.episodeIds === undefined ? [] : ids(query.episodeIds);
  const search = query.search === undefined ? '' : string(query.search, 120, true).trim().toLowerCase();
  const nodeKinds = query.nodeKinds === undefined ? [] : unique(array(query.nodeKinds, 7).map((kind) => enumeration(kind, STORY_GRAPH_NODE_KINDS)));
  const edgeKinds = query.edgeKinds === undefined ? [] : unique(array(query.edgeKinds, 10).map((kind) => enumeration(kind, STORY_GRAPH_EDGE_KINDS)));
  const limitNodes = query.limitNodes === undefined ? STORY_GRAPH_LIMITS.visibleNodes : integer(query.limitNodes, 1, STORY_GRAPH_LIMITS.visibleNodes);
  const limitEdges = query.limitEdges === undefined ? STORY_GRAPH_LIMITS.visibleEdges : integer(query.limitEdges, 0, STORY_GRAPH_LIMITS.visibleEdges);
  if (query.neighbors !== undefined && typeof query.neighbors !== 'boolean') return fail();
  const allowedEpisodes = (item: StoryGraphNode | StoryGraphEdge) => !episodes.length || item.episodeIds.some((episode) => episodes.includes(episode)) || item.evidence.some((entry) => episodes.includes(entry.episodeId));
  const candidateEdges = current.edges.filter((edge) => (!edgeKinds.length || edgeKinds.includes(edge.kind)) && allowedEpisodes(edge));
  const connectedInScope = new Set(episodes.length ? candidateEdges.flatMap((edge) => [edge.source, edge.target]) : []);
  const focusIds = query.focusNodeId === undefined ? undefined : new Set([id(query.focusNodeId)]);
  if (focusIds && query.neighbors !== false) for (const edge of candidateEdges) { if (edge.source === query.focusNodeId) focusIds.add(edge.target); if (edge.target === query.focusNodeId) focusIds.add(edge.source); }
  const matchedNodes = current.nodes.filter((node) => (allowedEpisodes(node) || connectedInScope.has(node.id)) && (!nodeKinds.length || nodeKinds.includes(node.kind)) && (!focusIds || focusIds.has(node.id)) && (!search || [node.label, node.description, ...node.aliases].join('\n').toLowerCase().includes(search)));
  const matchedIds = new Set(matchedNodes.map((node) => node.id));
  const matchedEdges = candidateEdges.filter((edge) => matchedIds.has(edge.source) && matchedIds.has(edge.target));
  const view: StoryGraphView = {
    schemaVersion: 1, id: current.id, revision: current.revision,
    nodes: matchedNodes.slice(0, limitNodes).map((node) => ({ ...node, description: node.description.slice(0, 160), evidence: [], evidenceCount: node.evidence.length })),
    edges: [], positions: {}, counts: { totalNodes: current.nodes.length, totalEdges: current.edges.length, matchedNodes: matchedNodes.length, matchedEdges: matchedEdges.length, visibleNodes: 0, visibleEdges: 0, truncated: false },
  };
  const visibleIds = new Set(view.nodes.map((node) => node.id));
  view.edges = matchedEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).slice(0, limitEdges).map((edge) => ({ ...edge, description: edge.description.slice(0, 160), evidence: [], evidenceCount: edge.evidence.length }));
  view.positions = Object.fromEntries(Object.entries(layoutStoryGraphNodes(current.nodes, current.positions)).filter(([nodeId]) => visibleIds.has(nodeId)));
  const refreshCounts = () => { view.counts.visibleNodes = view.nodes.length; view.counts.visibleEdges = view.edges.length; view.counts.truncated = view.nodes.length < matchedNodes.length || view.edges.length < matchedEdges.length; };
  refreshCounts();
  while (storyGraphJsonBytes(view) > STORY_GRAPH_LIMITS.viewBytes) {
    if (view.edges.length) view.edges.pop();
    else {
      const removed = view.nodes.pop();
      if (!removed) return fail();
      delete view.positions[removed.id];
    }
    refreshCounts();
  }
  return view;
}
export function validateStoryGraphEvidence(entry: StoryGraphEvidence, source: StoryGraphSource): boolean {
  try { const checked = evidence(entry); return checked.episodeId === source.episodeId && checked.part === source.part && checked.sourceHash === source.sourceHash && checked.end <= source.text.length && source.text.slice(checked.start, checked.end) === checked.quote; } catch { return false; }
}
export async function hashStoryGraphSource(text: string): Promise<string> { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
