import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryGraphCandidates, StoryGraphExtractionRequest, StoryGraphNode } from '../../src/types/storyGraph';
import { generateText } from '../../src/services/ai/generateText';
import { applyStoryGraphPatch, createEmptyStoryGraph, hashStoryGraphSource } from '../../src/services/storyGraphService';
import { buildStoryGraphCandidatePatch, extractStoryGraphCandidates, splitStoryGraphSources } from '../../src/services/storyGraphExtractionService';

vi.mock('../../src/services/ai/generateText', () => ({ generateText: vi.fn() }));
const generate = vi.mocked(generateText);
function node(id: string, label = id): StoryGraphNode { return { id, kind: 'character', label, description: '', aliases: [], episodeIds: ['episode-a'], evidence: [], origin: 'ai', certainty: 'inferred' }; }
function modelNode(id: string, label = id) { return { id, kind: 'character', label, description: '', aliases: [], evidence: [], certainty: 'inferred' }; }
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
    expect(material).toEqual({ text: input.sources[0].text });
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

  it('asks for saved source material before making a model call', async () => {
    const input = await request();
    input.sources = [];
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow('请先保存所选分集的大纲或正文');
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['source count', 'source characters'])('rejects excessive %s before making a model call', async (limit) => {
    const input = await request();
    if (limit === 'source count') {
      input.sources = Array.from({ length: 65 }, (_, index) => ({ ...input.sources[0], episodeId: `episode-${index}` }));
    } else {
      input.sources[0].text = '甲'.repeat(2000001);
    }
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow('所选图谱材料超过提取上限');
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not retry paid calls or malformed responses', async () => {
    const input = await request();
    generate.mockRejectedValue(new Error('temporary network error'));
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow('temporary network error');
    expect(generate).toHaveBeenCalledTimes(1);
    generate.mockReset().mockResolvedValue('{"nodes":[],"edges":');
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow('完整的故事图谱 JSON');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'json', 'JSON'])('accepts one complete %s JSON fence without another model call', async (language) => {
    generate.mockResolvedValue(`  \n\`\`\`${language}\n${empty()}\n\`\`\`\n  `);
    const result = await extractStoryGraphCandidates(await request(), { assertCurrent: vi.fn() });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { shape: 'leading explanation', raw: `提取结果如下：\n${empty()}` },
    { shape: 'trailing explanation', raw: `${empty()}\n以上为提取结果。` },
    { shape: 'multiple JSON objects', raw: `${empty()}\n${empty()}` },
    { shape: 'explanation around a fence', raw: `提取结果：\n\`\`\`json\n${empty()}\n\`\`\`` },
    { shape: 'multiple fences', raw: `\`\`\`json\n${empty()}\n\`\`\`\n\`\`\`json\n${empty()}\n\`\`\`` },
  ])('rejects $shape instead of selecting an arbitrary JSON fragment', async ({ raw }) => {
    generate.mockResolvedValue(raw);
    await expect(extractStoryGraphCandidates(await request(), { assertCurrent: vi.fn() })).rejects.toThrow('完整的故事图谱 JSON');
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

  it('marks unverifiable evidence unknown while rejecting invented assets and unsupported response fields', async () => {
    const input = await request();
    const evidence = { episodeId: 'episode-a', part: 'script', sourceHash: input.sources[0].sourceHash, start: 0, end: 1, quote: '乙' };
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...node('a'), evidence: [evidence], certainty: 'explicit' }], edges: [] }));
    const result = await extractStoryGraphCandidates(input, { assertCurrent: vi.fn() });
    expect(result.nodes[0].certainty).toBe('unknown');
    expect(result.nodes[0].evidence).toEqual([]);
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

  it('binds quote-only nodes and relationships to the captured source rather than model metadata', async () => {
    const input = await request('甲对乙说：“真相只有一个。”');
    input.sources[0].episodeId = 'episode-b';
    input.sources[0].part = 'outline';
    const quote = '甲对乙说：“真相只有一个。”';
    generate.mockResolvedValue(JSON.stringify({
      nodes: [{ ...modelNode('a', '甲'), certainty: 'explicit', evidence: [{ quote: '甲' }] }, modelNode('b', '乙')],
      edges: [{ id: 'e1', source: 'a', target: 'b', kind: 'related', directed: false, label: '对话', description: '', certainty: 'explicit', evidence: [{ quote }] }],
    }));
    const result = await extractStoryGraphCandidates(input, { assertCurrent: vi.fn() });
    for (const entry of [...result.nodes, ...result.edges]) {
      expect(entry.origin).toBe('ai');
      expect(entry.episodeIds).toEqual(['episode-b']);
    }
    expect(result.nodes[0].evidence).toEqual([{ episodeId: 'episode-b', part: 'outline', sourceHash: input.sources[0].sourceHash, start: 0, end: 1, quote: '甲' }]);
    expect(result.edges[0].evidence).toEqual([{ episodeId: 'episode-b', part: 'outline', sourceHash: input.sources[0].sourceHash, start: 0, end: quote.length, quote }]);
    expect(result.edges[0].source).toBe(result.nodes[0].id);
    expect(result.edges[0].target).toBe(result.nodes[1].id);
    expect(result.sourceBindings).toEqual([{ episodeId: 'episode-b', part: 'outline', sourceHash: input.sources[0].sourceHash }]);
  });

  it('derives absolute UTF-16 offsets in a later chunk without changing emoji or CRLF', async () => {
    const quote = '前😀后\r\n尾声';
    const input = await request(`${'序'.repeat(12000)}开场\r\n${quote}`);
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...modelNode('a'), certainty: 'explicit', evidence: [{ quote }] }], edges: [] }));
    const result = await extractStoryGraphCandidates({ ...input, startChunk: 1 }, { assertCurrent: vi.fn() });
    const evidence = result.nodes[0].evidence[0];
    expect(evidence).toEqual({ episodeId: 'episode-a', part: 'script', sourceHash: input.sources[0].sourceHash, start: 12004, end: 12004 + quote.length, quote });
    expect(input.sources[0].text.slice(evidence.start, evidence.end)).toBe(quote);
    expect(result.totalChunks).toBe(2);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('marks overlapping repeated quotes unknown rather than binding to the first occurrence', async () => {
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...modelNode('a'), certainty: 'explicit', evidence: [{ quote: 'aa' }] }], edges: [] }));
    const result = await extractStoryGraphCandidates(await request('aaa'), { assertCurrent: vi.fn() });
    expect(result.nodes[0].certainty).toBe('unknown');
    expect(result.nodes[0].evidence).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { failure: 'missing', source: '甲隐瞒了真相。', quote: '原文不存在的摘录' },
    { failure: 'empty', source: '甲隐瞒了真相。', quote: '' },
    { failure: 'blank', source: '甲隐瞒了真相。', quote: '  ' },
    { failure: 'too long', source: '甲'.repeat(241), quote: '甲'.repeat(241) },
    { failure: 'normalized line endings', source: '甲\r\n乙', quote: '甲\n乙' },
  ])('keeps a $failure quote as an unknown candidate without inventing evidence', async ({ source, quote }) => {
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...modelNode('a'), certainty: 'explicit', evidence: [{ quote }] }], edges: [] }));
    const result = await extractStoryGraphCandidates(await request(source), { assertCurrent: vi.fn() });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].certainty).toBe('unknown');
    expect(result.nodes[0].evidence).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('clears all evidence on one record while preserving verified records and relationship identities through adoption', async () => {
    const input = await request('甲收到了旧信。乙看见了钥匙。');
    const firstQuote = '甲收到了旧信。', secondQuote = '乙看见了钥匙。';
    generate.mockResolvedValue(JSON.stringify({
      nodes: [
        { ...modelNode('a', '甲'), description: '保留的候选说明', certainty: 'explicit', evidence: [{ quote: firstQuote }, { quote: '甲毁掉了旧信。' }] },
        { ...modelNode('b', '乙'), certainty: 'explicit', evidence: [{ quote: secondQuote }] },
      ],
      edges: [{ ...batch().edges[0], source: 'a', target: 'b', certainty: 'explicit', evidence: [{ quote: firstQuote }] }],
    }));
    const candidates = await extractStoryGraphCandidates(input, { assertCurrent: vi.fn() });
    expect(candidates.nodes).toHaveLength(2);
    expect(candidates.nodes[0]).toMatchObject({ label: '甲', description: '保留的候选说明', certainty: 'unknown', evidence: [] });
    expect(candidates.nodes[1].certainty).toBe('explicit');
    expect(candidates.nodes[1].evidence).toEqual([{ episodeId: 'episode-a', part: 'script', sourceHash: input.sources[0].sourceHash,
      start: firstQuote.length, end: input.sources[0].text.length, quote: secondQuote }]);
    expect(candidates.edges).toHaveLength(1);
    expect(candidates.edges[0]).toMatchObject({ source: candidates.nodes[0].id, target: candidates.nodes[1].id, certainty: 'explicit' });
    expect(candidates.edges[0].evidence).toEqual([{ episodeId: 'episode-a', part: 'script', sourceHash: input.sources[0].sourceHash,
      start: 0, end: firstQuote.length, quote: firstQuote }]);
    const graph = createEmptyStoryGraph('graph-a');
    const patch = buildStoryGraphCandidatePatch(graph, candidates, { nodeIds: candidates.nodes.map((entry) => entry.id), edgeIds: candidates.edges.map((entry) => entry.id) });
    const adopted = applyStoryGraphPatch(graph, patch, 0);
    expect(adopted.nodes).toEqual(candidates.nodes);
    expect(adopted.nodes[0].certainty).toBe('unknown');
    expect(adopted.nodes[0].evidence).toEqual([]);
    expect(adopted.edges).toEqual(candidates.edges);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not hide an invalid certainty when evidence would otherwise be downgraded', async () => {
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...modelNode('a'), certainty: 'proven', evidence: [{ quote: '原文不存在的摘录' }] }], edges: [] }));
    await expect(extractStoryGraphCandidates(await request(), { assertCurrent: vi.fn() })).rejects.toThrow('结构或字段无效');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('marks explicit nodes and relationships without evidence unknown while leaving inferred records unchanged', async () => {
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...modelNode('a'), certainty: 'explicit' }, modelNode('b')],
      edges: [{ ...batch().edges[0], source: 'a', target: 'b', certainty: 'explicit', evidence: [] }] }));
    const result = await extractStoryGraphCandidates(await request(), { assertCurrent: vi.fn() });
    expect(result.nodes[0]).toMatchObject({ certainty: 'unknown', evidence: [] });
    expect(result.nodes[1]).toMatchObject({ certainty: 'inferred', evidence: [] });
    expect(result.edges[0]).toMatchObject({ certainty: 'unknown', evidence: [] });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('preserves a verified legacy offset when the same quote appears more than once', async () => {
    const input = await request('甲乙甲乙');
    const evidence = { episodeId: 'episode-a', part: 'script', sourceHash: input.sources[0].sourceHash, start: 2, end: 4, quote: '甲乙' };
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...node('a'), certainty: 'explicit', evidence: [evidence] }], edges: [] }));
    const result = await extractStoryGraphCandidates(input, { assertCurrent: vi.fn() });
    expect(result.nodes[0].evidence).toEqual([evidence]);
  });

  it.each([
    { mismatch: 'hash', overrides: { sourceHash: '0'.repeat(64) } },
    { mismatch: 'episode', overrides: { episodeId: 'episode-b' } },
    { mismatch: 'part', overrides: { part: 'outline' } },
  ])('does not repair an explicit legacy $mismatch mismatch using a valid quote', async ({ overrides }) => {
    const quote = '甲隐瞒了真相。';
    const input = await request(`序章：${quote}`);
    const evidence = { episodeId: 'episode-a', part: 'script', sourceHash: input.sources[0].sourceHash, start: 3, end: 3 + quote.length, quote, ...overrides };
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...node('a'), certainty: 'explicit', evidence: [evidence] }], edges: [] }));
    await expect(extractStoryGraphCandidates(input, { assertCurrent: vi.fn() })).rejects.toThrow('模型证据来源与所选稿件不一致');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('still rejects another source identity when the quote is also unverifiable', async () => {
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...modelNode('a'), certainty: 'explicit', evidence: [{ quote: '', episodeId: 'episode-b' }] }], edges: [] }));
    await expect(extractStoryGraphCandidates(await request(), { assertCurrent: vi.fn() })).rejects.toThrow('模型证据来源与所选稿件不一致');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('marks an inaccurate legacy offset unknown without replacing it with another quote location', async () => {
    const quote = '甲隐瞒了真相。';
    const input = await request(`序章：${quote}`);
    const evidence = { episodeId: 'episode-a', part: 'script', sourceHash: input.sources[0].sourceHash, start: 0, end: quote.length, quote };
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...node('a'), certainty: 'explicit', evidence: [evidence] }], edges: [] }));
    const result = await extractStoryGraphCandidates(input, { assertCurrent: vi.fn() });
    expect(result.nodes[0]).toMatchObject({ certainty: 'unknown', evidence: [] });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([{ start: 0 }, { end: 8 }])('marks a partially supplied legacy offset %j unknown without falling back to quote matching', async (offset) => {
    const quote = '甲隐瞒了真相。';
    generate.mockResolvedValue(JSON.stringify({ nodes: [{ ...modelNode('a'), certainty: 'explicit', evidence: [{ quote, ...offset }] }], edges: [] }));
    const result = await extractStoryGraphCandidates(await request(quote), { assertCurrent: vi.fn() });
    expect(result.nodes[0]).toMatchObject({ certainty: 'unknown', evidence: [] });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('still rejects a relationship whose endpoint is absent from this candidate chunk', async () => {
    generate.mockResolvedValue(JSON.stringify({ nodes: [modelNode('a')], edges: [{ ...batch().edges[0], source: 'a', target: 'missing' }] }));
    await expect(extractStoryGraphCandidates(await request(), { assertCurrent: vi.fn() })).rejects.toThrow('结构或字段无效');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('measures response capacity as actual UTF-8 instead of a JSON-escaped string literal', async () => {
    const raw = `${'\n'.repeat(64 * 1024)}${empty()}`;
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(128 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(raw)).byteLength).toBeGreaterThan(128 * 1024);
    generate.mockResolvedValue(raw);
    const result = await extractStoryGraphCandidates(await request(), { assertCurrent: vi.fn() });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized candidate responses instead of returning a silently cut batch', async () => {
    generate.mockResolvedValue(`${empty()}${' '.repeat(128 * 1024)}`);
    await expect(extractStoryGraphCandidates(await request(), { assertCurrent: vi.fn() })).rejects.toThrow('超过容量上限');
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
