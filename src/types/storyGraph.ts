/** 剧本关系图只保存正式领域数据，不包含窗口、模型凭据或运行时对象。 */
export const STORY_GRAPH_NODE_KINDS = ['character', 'event', 'foreshadow', 'setting', 'location', 'prop', 'organization'] as const;
export type StoryGraphNodeKind = typeof STORY_GRAPH_NODE_KINDS[number];
export const STORY_GRAPH_EDGE_KINDS = ['character_relationship', 'participates', 'located_in', 'owns', 'member_of', 'precedes', 'causes', 'plants', 'resolves', 'related'] as const;
export type StoryGraphEdgeKind = typeof STORY_GRAPH_EDGE_KINDS[number];
export type StoryGraphPart = 'outline' | 'script';
export type StoryGraphCertainty = 'explicit' | 'inferred' | 'unknown';
export type StoryGraphOrigin = 'manual' | 'ai';
export interface StoryGraphEvidence {
  episodeId: string;
  part: StoryGraphPart;
  sourceHash: string;
  /** 与 JavaScript 字符串一致的 UTF-16 偏移。 */
  start: number;
  end: number;
  quote: string;
}
export interface StoryGraphAssetReference { kind: 'character' | 'scene' | 'prop'; id: string }
export interface StoryGraphAssetOption extends StoryGraphAssetReference { label: string }
export interface StoryGraphPosition { x: number; y: number }
export interface StoryGraphNode {
  id: string;
  kind: StoryGraphNodeKind;
  label: string;
  description: string;
  aliases: string[];
  episodeIds: string[];
  evidence: StoryGraphEvidence[];
  origin: StoryGraphOrigin;
  certainty: StoryGraphCertainty;
  storyOrder?: number;
  storyTime?: string;
  foreshadowStatus?: 'planted' | 'developing' | 'resolved';
  asset?: StoryGraphAssetReference;
}
export interface StoryGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: StoryGraphEdgeKind;
  directed: boolean;
  label: string;
  description: string;
  episodeIds: string[];
  evidence: StoryGraphEvidence[];
  origin: StoryGraphOrigin;
  certainty: StoryGraphCertainty;
  fromEpisodeId?: string;
  toEpisodeId?: string;
}
export interface StoryGraph {
  schemaVersion: 1;
  id: string;
  revision: number;
  nodes: StoryGraphNode[];
  edges: StoryGraphEdge[];
  positions: Record<string, StoryGraphPosition>;
}
export type StoryGraphCanonical = Omit<StoryGraph, 'revision'>;
export interface StoryGraphPatch {
  graphId?: string;
  upsertNodes?: StoryGraphNode[];
  removeNodeIds?: string[];
  upsertEdges?: StoryGraphEdge[];
  removeEdgeIds?: string[];
  positions?: Record<string, StoryGraphPosition>;
}
export interface StoryGraphFilter {
  episodeIds?: string[];
  search?: string;
  nodeKinds?: StoryGraphNodeKind[];
  edgeKinds?: StoryGraphEdgeKind[];
  focusNodeId?: string;
  neighbors?: boolean;
  limitNodes?: number;
  limitEdges?: number;
}
export type StoryGraphSelection = { kind: 'node' | 'edge'; id: string };
export interface StoryGraphDetail { item: StoryGraphNode | StoryGraphEdge; evidenceStatuses: Array<'current' | 'changed' | 'missing'>; assetAvailable?: boolean }
export interface StoryGraphEvidenceQuery { episodeId: string; part: StoryGraphPart; quote: string }
export type StoryGraphViewNode = StoryGraphNode & { evidenceCount: number };
export type StoryGraphViewEdge = StoryGraphEdge & { evidenceCount: number };
export interface StoryGraphView {
  schemaVersion: 1;
  id: string;
  revision: number;
  nodes: StoryGraphViewNode[];
  edges: StoryGraphViewEdge[];
  positions: Record<string, StoryGraphPosition>;
  counts: { totalNodes: number; totalEdges: number; matchedNodes: number; matchedEdges: number; visibleNodes: number; visibleEdges: number; truncated: boolean };
}
export interface StoryGraphSource {
  episodeId: string;
  part: StoryGraphPart;
  sourceHash: string;
  text: string;
}
export interface StoryGraphExtractionModel { model: string; provider: string; fingerprint: string }
export interface StoryGraphExtractionRequest {
  seriesId: string;
  sessionId: string;
  graphId: string;
  graphRevision: number;
  model: StoryGraphExtractionModel;
  sources: StoryGraphSource[];
  startChunk?: number;
}
export interface StoryGraphExtractionProgress { completedCalls: number; totalCalls: number; completedSources: number; totalSources: number }
export interface StoryGraphCandidates {
  id: string;
  seriesId: string;
  sessionId: string;
  graphId: string;
  graphRevision: number;
  modelFingerprint: string;
  sourceBindings: Array<Pick<StoryGraphSource, 'episodeId' | 'part' | 'sourceHash'>>;
  nodes: StoryGraphNode[];
  edges: StoryGraphEdge[];
  callsUsed: number;
  hasMore: boolean;
  totalChunks: number;
  nextChunk?: number;
}
export interface StoryGraphCandidateSelection {
  nodeIds: string[];
  edgeIds: string[];
  /** 候选节点 ID -> 已有正式节点 ID，仅显式映射，不按同名推断。 */
  nodeMappings?: Record<string, string>;
}
export interface StoryGraphExtractRequest { episodeIds: string[]; parts: StoryGraphPart[]; modelId: string; startChunk?: number }
export interface StoryGraphCandidateAdoption { candidateId: string; selectedNodeIds: string[]; selectedEdgeIds: string[]; nodeMappings?: Record<string, string> }
export interface StoryGraphExtractionState {
  status: 'idle' | 'running' | 'ready' | 'failed' | 'cancelled';
  runId?: string;
  completed: number;
  total: number;
  candidate?: StoryGraphCandidates;
  error?: string;
  continuation?: { request: StoryGraphExtractRequest; nextChunk: number; totalChunks: number };
}
