import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { Node } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import { createShotRow } from '../../src/types/shotlist';
import type { VideoEditorTrackInput } from '../../src/types/videoEditorControl';
const mocks = vi.hoisted(() => ({
  store: { currentProjectId: 'p', nodes: [] as Node<BaseNodeData>[], getCurrentRevision: () => 1 },
  windows: vi.fn(async (): Promise<Array<{ label: string }>> => []),
  probe: vi.fn(async () => ({ duration: 8 })),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.store } }));
vi.mock('../../src/services/mcp/mcpUiRuntimeService', () => ({ listAppWindows: mocks.windows }));
vi.mock('../../src/services/videoEditorWindowService', () => ({ openVideoEditorWindow: vi.fn() }));
vi.mock('../../src/services/videoEditorInspectionService', () => ({ probeControlledNode: mocks.probe }));
import { bindVideoEditorTracks, createControlledEditor, readControlledEditor, updateControlledEditor, validateVideoEditorOutput,
  videoEditorVersion } from '../../src/services/videoEditorControlService';
import { compareAndSaveVideoEditorProject, getVideoEditorProject, saveVideoEditorProject } from '../../src/services/indexedDb/videoEditorRepository';
import { clearAgentToolRegistryForTests, getAgentTool, getAvailableAgentTools } from '../../src/services/chat/toolRegistry';
import { registerVideoEditorAgentTools } from '../../src/services/chat/tools/videoEditorTools';
import { validateAgentToolInput } from '../../src/services/chat/agentToolSchemas';
import { searchMcpToolCatalog } from '../../src/services/mcp/mcpToolCatalog';

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const context = () => ({ projectId: 'p', baseRevision: 1, signal: new AbortController().signal });
const mediaNode = (id: string, type: BaseNodeData['type'] = 'source-image'): Node<BaseNodeData> => ({ id, type,
  position: { x: 0, y: 0 }, data: { type, label: id, status: 'success', filePath: `G:/private/${id}.png`, imageUrl: `asset://private/${id}` } });
const track = (): VideoEditorTrackInput => ({ id: 'main', kind: 'video', name: '主轨', clips: [
  { id: 'c1', kind: 'image', nodeId: 'image', sourceIn: 0, sourceOut: 4, timelineStart: 0 },
] });
beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.store.currentProjectId = 'p'; mocks.store.nodes = [mediaNode('image'), mediaNode('audio', 'source-audio')];
  mocks.windows.mockReset().mockResolvedValue([]); mocks.probe.mockReset().mockResolvedValue({ duration: 8 });
});

describe('MCP 剪辑工程', () => {
  it('creates an independent image timeline and never exposes media locations', async () => {
    const first = await createControlledEditor(context(), { nodeIds: ['image'] });
    const second = await createControlledEditor(context(), { nodeIds: ['image'] });
    expect(first.editorId).not.toBe(second.editorId);
    expect(first.duration).toBe(3);
    expect(JSON.stringify(first)).not.toMatch(/private|asset:|filePath|sourceUrl/);
    expect(first.version).toMatch(/^[a-f\d]{64}$/);
  });
  it('uses real probe duration for videos and retains all-or-nothing creation on a failed probe', async () => {
    mocks.store.nodes.push(mediaNode('video', 'source-video'));
    const created = await createControlledEditor(context(), { nodeIds: ['video'] });
    expect(created.duration).toBe(8);
    mocks.probe.mockRejectedValueOnce(new Error('decode'));
    await expect(createControlledEditor(context(), { nodeIds: ['video'] })).rejects.toThrow('decode');
  });
  it('builds shot timing and optional dialogue overlays from the real shotlist type', async () => {
    const rows = [{ ...createShotRow('r1', '1'), duration: 4, content: '真实界面', dialogue: '开始创作',
      frame: { nodeId: 'image', kind: 'image' as const } }];
    const node = mediaNode('shots', 'ai-shotlist'); node.data.shotlistRows = rows;
    mocks.store.nodes.push(node);
    const created = await createControlledEditor(context(), { shotlistNodeId: 'shots', includeDialogueCaptions: true });
    expect(created.duration).toBe(4); expect(created.tracks).toHaveLength(2);
    expect(created.tracks[1].clips[0].textStyle?.content).toBe('开始创作');
  });
  it('updates cut timing, overlay text and music in one versioned write', async () => {
    const created = await createControlledEditor(context(), { nodeIds: ['image'] });
    const main = track(); main.clips.push({ ...main.clips[0], id: 'c2', timelineStart: 99, sourceOut: 20 });
    const next = await updateControlledEditor(context(), { editorId: created.editorId, expectedVersion: created.version,
      tracks: [main, { id: 'bgm', kind: 'audio', name: '音乐', clips: [
        { id: 'music', kind: 'video', nodeId: 'audio', sourceIn: 2, sourceOut: 26, timelineStart: 0, volume: 0.4,
          volumePoints: [{ t: 0, gain: 0 }, { t: 1, gain: 1 }, { t: 24, gain: 0 }] },
      ] }], output: { width: 1920, height: 1080, frameRate: 24 } });
    expect(next.duration).toBe(24); expect(next.tracks[0].clips[1].timelineStart).toBe(4);
    expect(next.version).not.toBe(created.version);
    await expect(updateControlledEditor(context(), { editorId: created.editorId, expectedVersion: created.version, name: 'stale' })).rejects.toThrow('版本');
  });
  it('CAS allows exactly one concurrent writer and rejects a stale human window save', async () => {
    const created = await createControlledEditor(context(), { nodeIds: ['image'] });
    const original = (await getVideoEditorProject(created.editorId))!;
    const next = { ...original, name: 'A', automationRevision: 2 };
    const results = await Promise.allSettled([compareAndSaveVideoEditorProject(next, original),
      compareAndSaveVideoEditorProject({ ...next, name: 'B' }, original)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(saveVideoEditorProject({ ...original, name: 'old window' })).rejects.toThrow('MCP');
    expect((await getVideoEditorProject(created.editorId))?.automationRevision).toBe(2);
    await saveVideoEditorProject({ ...(await getVideoEditorProject(created.editorId))!, name: 'fresh window' });
  });
  it('refuses foreign projects, stale canvas revisions, aborted requests and open editor windows', async () => {
    const created = await createControlledEditor(context(), { nodeIds: ['image'] });
    await expect(readControlledEditor({ ...context(), projectId: 'foreign' }, created.editorId)).rejects.toThrow('项目');
    await expect(readControlledEditor({ ...context(), baseRevision: 0 }, created.editorId)).rejects.toThrow('画布');
    const controller = new AbortController(); controller.abort();
    await expect(createControlledEditor({ ...context(), signal: controller.signal }, { nodeIds: ['image'] })).rejects.toThrow('取消');
    vi.stubGlobal('window', {}); mocks.windows.mockResolvedValue([{ label: 'video-editor' }]);
    await expect(updateControlledEditor(context(), { editorId: created.editorId, expectedVersion: created.version, name: 'x' })).rejects.toThrow('关闭');
  });
  it.each([
    (tracks: VideoEditorTrackInput[]) => { tracks[0].clips[0].sourceOut = 0; },
    (tracks: VideoEditorTrackInput[]) => { tracks[0].clips[0].sourceOut = 301; },
    (tracks: VideoEditorTrackInput[]) => { tracks[0].clips[0].nodeId = 'missing'; },
    (tracks: VideoEditorTrackInput[]) => { tracks[0].clips[0].id = 'main'; },
    (tracks: VideoEditorTrackInput[]) => { tracks[0].clips[0].volumePoints = [{ t: 1, gain: 1 }, { t: 0, gain: 1 }]; },
    (tracks: VideoEditorTrackInput[]) => { tracks[0].clips[0].transitionIn = { kind: 'fade', duration: 5 }; },
  ])('rejects invalid cuts, missing media, IDs, envelopes and transitions', (edit) => {
    const tracks = [track()]; edit(tracks); expect(() => bindVideoEditorTracks(tracks)).toThrow();
  });
  it('bounds output allocation and fingerprints all record content', async () => {
    for (const output of [{ width: 1920, height: 1920, frameRate: 30 }, { width: 1919, height: 1080, frameRate: 30 },
      { width: 1920, height: 1080, frameRate: 61 }]) expect(() => validateVideoEditorOutput(output)).toThrow();
    const created = await createControlledEditor(context(), { nodeIds: ['image'] });
    const record = (await getVideoEditorProject(created.editorId))!;
    expect(await videoEditorVersion({ ...record, name: 'changed' })).not.toBe(created.version);
  });
});

describe('MCP 剪辑工具合同', () => {
  it('discovers all ten tools only in MCP contexts, with safe effects and strict nested schemas', () => {
    clearAgentToolRegistryForTests(); const unregister = registerVideoEditorAgentTools();
    const ctx = { ...context(), taskId: 't', conversationId: 'mcp-control-p', mode: 'autonomous' as const };
    expect(getAvailableAgentTools(ctx)).toHaveLength(10);
    expect(getAvailableAgentTools({ ...ctx, conversationId: 'chat' })).toHaveLength(0);
    expect(searchMcpToolCatalog(ctx, { category: 'video' }).total).toBe(10);
    const update = getAgentTool('video_editor_update')!;
    expect(update.effect).toBe('file_write');
    expect(getAgentTool('video_editor_export')?.effect).toBe('canvas_write');
    const input = { editorId: 'editor', expectedVersion: 'a'.repeat(64), tracks: [track()] };
    expect(validateAgentToolInput(update.inputSchema, input).valid).toBe(true);
    const unsafe = structuredClone(input) as typeof input & { script?: string };
    unsafe.script = 'execute'; expect(validateAgentToolInput(update.inputSchema, unsafe).valid).toBe(false);
    Object.assign(input.tracks[0].clips[0], { sourceUrl: 'https://external.example', filePath: 'G:/secret' });
    expect(validateAgentToolInput(update.inputSchema, input).valid).toBe(false);
    for (const off of unregister) off();
  });
});
