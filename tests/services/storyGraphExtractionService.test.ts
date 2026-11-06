import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryGraphCandidates, StoryGraphExtractionRequest, StoryGraphNode } from '../../src/types/storyGraph';
import { generateText } from '../../src/services/ai/generateText';
import { applyStoryGraphPatch, createEmptyStoryGraph, hashStoryGraphSource } from '../../src/services/storyGraphService';
import { buildStoryGraphCandidatePatch, extractStoryGraphCandidates, splitStoryGraphSources } from '../../src/services/storyGraphExtractionService';

vi.mock('../../src/services/ai/generateText', () => ({ generateText: vi.fn() }));
const generate = vi.mocked(generateText);
function node(id: string, label = id): StoryGraphNode { return { id, kind: 'character', label, description: '', aliases: [], episodeIds: ['episode-a'], evidence: [], origin: 'ai', certainty: 'inferred' }; }
async function request(text = '甲隐瞒了真相。'): Promise<StoryGraphExtractionRequest> {
  return { seriesId: 'series-a', sessionId: 'session-a', graphId: 'graph-a', graphRevision: 0, model: { model: 'general/text-model', provider: 'general', fingerprint: 'f'.repeat(64) }, sources: [{ episodeId: 'episode-a', part: 'script', sourceHash: await hashStoryGraphSource(text), text }] };
}
const empty = () => JSON.stringify({ nodes: [], edges: [] });
function batch(): StoryGraphCandidates {
  return { id: 'batch-a', seriesId: 'series-a', sessionId: 'session-a', graphId: 'graph-a', graphRevision: 0, modelFingerprint: 'f'.repeat(64), sourceBindings: [], nodes: [node('candidate-a', '同名'), node('candidate-b', '另一个人')], edges: [{ id: 'candidate-edge', source: 'candidate-a', target: 'candidate-b', kind: 'related', directed: false, label: '相关', description: '', episodeIds: ['episode-a'], evidence: [], origin: 'ai', certainty: 'inferred' }], callsUsed: 1, hasMore: false, totalChunks: 1 };
}

beforeEach(() => { vi.stubGlobal('crypto', webcrypto); generate.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe('story graph extraction boundaries', () => {
  it('encodes all material reference markers as inert JSON without changing the decoded evidence text', async () => {
    const input = await request('原稿：@{unselected:secret} @asset{file} @drama{person:图} @image{ref|图} @refmod{secret} ![图](file:///private.png)');
    generate.mockResolvedValue(empty());
    const assertCurrent = vi.fn();
    const result = await extractStoryGraphCandidates(input, { assertCurrent });
    const params = generate.mock.calls[0][0];
    expect(params.prompt).not.toContain('@');
    expect(params.prompt).toContain('\\u0040');
    const material = JSON.parse(params.prompt.split('材料JSON：\n')[1]) as { text: string };
    expect(material.text).toBe(input.sources[0].text);
    expect(params.nodeId).toBeUndefined();
    expect(params.imageUrls).toBeUndefined();
    expect(result.callsUsed).toBe(1);
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps a maximum of eight sequential calls and exposes an explicit continuation cursor', async () => {
    const input = await request('甲'.repeat(12000 * 9));
    let active = 0, maximum = 0;
    generate.mockImplementation(async () => { active += 1; maximum = Math.max(maximum, active); await Promise.resolve(); active -= 1; return empty(); });
    const result = await extractStoryGraphCandidates(input, { assertCurrent: vi.fn() });
    expect(generate).toHaveBeenCalledTimes(8);
    expect(maximum).toBe(1);
    expect(result).toMatchObject({ hasMore: true, nextChunk: 8, totalChunks: 9 });
    generate.mockClear();
    const next = await extractStoryGraphCandidates({ ...input, startChunk: result.nextChunk }, { assertCurrent: vi.fn() });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(next).toMatchObject({ hasMore: false, totalChunks: 9 });
    expect(next.nextChunk).toBeUndefined();
  });

  it('keeps offsets exact while splitting at paragraph and surrogate-pair boundaries', async () => {
    const input = await request(`${'甲'.repeat(11999)}😀\n\n尾声`);
    const chunks = splitStoryGraphSources(input.sources);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(input.sources[0].text);
    expect(chunks.every((chunk) => chunk.text.length <= 12000)).toBe(true);
    expect(chunks[0].text).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(chunks[1].start).toBe(chunks[0].end);
  });

  it('rejects mismatched frozen source hashes before the first model call', async () => {
    const input = await request();
    input.sources[0].sourceHash = '0'.repeat(64);
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow('材料版本已变化');
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not retry paid calls or malformed responses', async () => {
    const input = await request();
    generate.mockRejectedValue(new Error('temporary network error'));
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow('temporary network error');
    expect(generate).toHaveBeenCalledTimes(1);
    generate.mockReset().mockResolvedValue('```json\n{"nodes":[],"edges":[]}\n```');
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow('候选格式');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not accept a returned candidate after cancellation or source-generation changes', async () => {
    const input = await request();
    const controller = new AbortController();
    generate.mockImplementation(async () => { controller.abort(); return empty(); });
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn(), signal: controller.signal })).rejects.toThrow();
    expect(generate.mock.calls[0][0].signal).toBe(controller.signal);
    let changed = false;
    generate.mockReset().mockImplementation(async () => { changed = true; return empty(); });
    await expect(extractStoryGraphCandidates(input, { assertCurrent: () => { if (changed) throw new Error('源文已变化'); } })).rejects.toThrow('源文已变化');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('validates exact evidence and rejects invented assets and unsupported response fields', async () => {
    const input = await request();
    const evidence = { episodeId: 'episode-a', part: 'script', sourceHash: input.sources[0].sourceHash, start: 0, end: 1, quote: '乙' };
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...node('a'), evidence: [evidence], certainty: 'explicit' }], edges: [] }));
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow();
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...node('a'), asset: { kind: 'character', id: 'invented' } }], edges: [] }));
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow();
    generate.mockResolvedValue(JSON.stringify({ nodes: [], edges: [], commands: ['untrusted'] }));
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow();
  });

  it('keeps verified source evidence and remaps every relationship to the frozen candidate node IDs', async () => {
    const input = await request('前😀后');
    const evidence = { episodeId: 'episode-a', part: 'script', sourceHash: input.sources[0].sourceHash, start: 1, end: 3, quote: '😀' };
    generate.mockResolvedValue(JSON.stringify({
      nodes: [{ ...node('a', '甲'), certainty: 'explicit', evidence: [evidence] }, node('b', '乙')],
      edges: [{ ...batch().edges[0], source: 'a', target: 'b' }],
    }));
    const result = await extractStoryGraphCandidates(input, { assertCurrent: vi.fn() });
    expect(result.nodes[0].evidence).toEqual([evidence]);
    expect(result.nodes[0].id).not.toBe('a');
    expect(result.edges[0].source).toBe(result.nodes[0].id);
    expect(result.edges[0].target).toBe(result.nodes[1].id);
  });

  it('rejects oversized candidate responses instead of returning a silently cut batch', async () => {
    generate.mockResolvedValue('x'.repeat(128 * 1024));
    await expect(extractStoryGraphCandidates(await request(), { assertCurrent: vi.fn() })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('never merges same-name people automatically or overwrites a mapped formal record', () => {
    const graph = { ...createEmptyStoryGraph('graph-a'), nodes: [{ ...node('formal', '同名'), origin: 'manual' as const, description: '人工确认的设定' }] };
    const candidates = batch();
    const automatic = applyStoryGraphPatch(graph, buildStoryGraphCandidatePatch(graph, candidates, { nodeIds: ['candidate-a'], edgeIds: [] }), 0);
    expect(automatic.nodes).toHaveLength(2);
    const mapped = buildStoryGraphCandidatePatch(graph, candidates, { nodeIds: ['candidate-a', 'candidate-b'], edgeIds: ['candidate-edge'], nodeMappings: { 'candidate-a': 'formal' } });
    const result = applyStoryGraphPatch(graph, mapped, 0);
    expect(result.nodes.find((entry) => entry.id === 'formal')?.description).toBe('人工确认的设定');
    expect(result.edges[0].source).toBe('formal');
  });

  it('refuses stale batches and relationships whose candidate endpoints were not adopted or mapped', () => {
    const graph = createEmptyStoryGraph('graph-a');
    expect(() => buildStoryGraphCandidatePatch({ ...graph, revision: 1 }, batch(), { nodeIds: [], edgeIds: ['candidate-edge'] })).toThrow('已变化');
    expect(() => buildStoryGraphCandidatePatch(graph, batch(), { nodeIds: ['candidate-a'], edgeIds: ['candidate-edge'] })).toThrow('连接的节点');
    expect(() => buildStoryGraphCandidatePatch(graph, batch(), { nodeIds: ['missing'], edgeIds: [] })).toThrow();
  });
});
