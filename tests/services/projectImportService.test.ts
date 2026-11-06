/** 真实快照、合并和还原链路中的历史归属；只隔离文件 IO 与仓储提交。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSaveData } from '../../src/services/storageService';
import { createEmptyStoryGraph } from '../../src/services/storyGraphService';
import type { ProjectArchiveChatPayload } from '../../src/services/projectTransferService';
import type { ProjectExchangeRevision, ProjectExchangeState } from '../../src/types/projectExchange';
import type { ProjectImportCommit } from '../../src/services/indexedDb/projectImportRepository';
import { captureExchangeSnapshot } from '../../src/services/projectExchangeDomain';
import { createProjectExchangeRevision } from '../../src/services/projectExchangeFormat';
import { buildProjectMergePlan } from '../../src/services/projectMergeService';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), read: vi.fn(), state: vi.fn(), graph: vi.fn(), commit: vi.fn(), delete: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (value: string) => value }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: () => true, buildProjectFolderName: (name: string, id: string) => `${name}-${id}`,
  registerProjectFolder: vi.fn(), registerProjectFolders: vi.fn(), ensureProjectDataDir: async () => '/projects/recipient',
  deleteProjectDataDir: mocks.delete, notifyProjectDiskChanged: vi.fn(),
}));
vi.mock('../../src/services/indexedDb/projectExchangeRepository', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/indexedDb/projectExchangeRepository')>(),
  loadProjectExchangeState: mocks.state, loadProjectExchangeGraph: mocks.graph,
}));
vi.mock('../../src/services/indexedDb/projectImportRepository', () => ({
  readProjectImportScope: mocks.read, beginProjectImportOperation: vi.fn(async () => undefined), commitProjectImport: mocks.commit,
}));
vi.mock('../../src/services/projectMergeWorkerClient', () => ({
  captureProjectSnapshot: (...args: Parameters<typeof captureExchangeSnapshot>) => captureExchangeSnapshot(...args),
  compareProjectSnapshots: (...args: Parameters<typeof buildProjectMergePlan>) => buildProjectMergePlan(...args),
}));
import { applyProjectImport, closePreparedProjectImport, prepareProjectImport, previewProjectImport,
  type PreparedProjectImport } from '../../src/services/projectImportService';

const sessions: PreparedProjectImport[] = [];
const project = (id: string, parentId?: string): ProjectSaveData => ({
  id, parentId, name: id, nodes: [], edges: [], groups: [], dataFolder: 'recipient', createdAt: 1, updatedAt: 2,
});
const emptyChat = (): ProjectArchiveChatPayload => ({ conversations: [], messages: [], memories: [] });
function chat(projectId: string, conversationId: string): ProjectArchiveChatPayload {
  return { conversations: [{ id: conversationId, projectId, title: conversationId, titleSource: 'user', pinned: false,
    archived: false, agentMode: 'plan', messageCount: 1, createdAt: 1, updatedAt: 2 }],
  messages: [{ id: `${conversationId}-message`, projectId, conversationId, sequence: 0, role: 'user', content: conversationId,
    status: 'done', createdAt: 1, updatedAt: 2 }], memories: [] };
}
function memory(projectId: string, conversationId: string, unavailable = false): ProjectArchiveChatPayload['memories'][number] {
  return { id: `${projectId}-memory`, projectId, kind: 'fact', content: `${projectId}的记忆`, enabled: true,
    source: { conversationId, messageId: `${conversationId}-message`, unavailable }, createdAt: 1, updatedAt: 2 };
}
async function prepareArchive(records: ProjectSaveData[], payloads: ProjectArchiveChatPayload[], version: 2 | 3 = 3,
  previous?: { state: ProjectExchangeState; revisions: ProjectExchangeRevision[] }): Promise<PreparedProjectImport> {
  const manifest = { formatVersion: version, projectId: records[0].id, projectName: records[0].name, exportedAt: 1, episodeCount: records.length - 1 };
  const texts: Record<string, string> = { 'manifest.json': JSON.stringify(manifest), 'project.json': JSON.stringify(records[0]),
    'chat.json': JSON.stringify(payloads[0]), 'episodes.json': JSON.stringify(records.slice(1).map((record, index) => ({ project: record, chat: payloads[index + 1] }))) };
  if (version === 3) {
    const captured = captureExchangeSnapshot(records, [], previous?.state ?? null);
    const head = await createProjectExchangeRevision(captured.snapshot, previous ? [previous.state.headRevisionId] : []);
    const state: ProjectExchangeState = { ownerId: records[0].id, lineageId: captured.snapshot.lineageId,
      rootProjectId: captured.snapshot.rootProjectId, headRevisionId: head.revisionId, stateVersion: (previous?.state.stateVersion ?? 0) + 1,
      identities: captured.identities };
    texts['exchange-state.json'] = JSON.stringify(state);
    texts['exchange.json'] = JSON.stringify({ format: 'ai-canvas-project-exchange', version: 1, packageId: 'package',
      lineageId: state.lineageId, headRevisionId: head.revisionId, revisions: [...(previous?.revisions ?? []), head], ancestors: [], files: [] });
  }
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'unpack_project_archive') return { texts, assets: [] };
    if (command === 'inspect_project_archive_assets') return [];
    if (command === 'publish_project_import_assets') return undefined;
    throw new Error(`Unexpected native command: ${command}`);
  });
  const session = await prepareProjectImport();
  if (!session) throw new Error('项目包未准备完成');
  sessions.push(session); return session;
}
const committed = (): ProjectImportCommit => mocks.commit.mock.calls[0][0] as ProjectImportCommit;

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto);
  mocks.open.mockResolvedValue('/incoming/project.aicanvas');
  mocks.state.mockResolvedValue(null); mocks.graph.mockResolvedValue({ revisions: [], ancestors: [] });
  mocks.commit.mockResolvedValue(undefined); mocks.delete.mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(closePreparedProjectImport));
  vi.unstubAllGlobals();
});

describe('项目导入历史追加编排', () => {
  it('新版历史追加把工作台会话目标映射到接收端剧集和分集', async () => {
    const source = project('source'), episode = project('episode', source.id);
    const payload = chat(source.id, 'workbench');
    payload.conversations[0].workbenchTarget = { seriesId: source.id, episodeId: episode.id };
    const session = await prepareArchive([source, episode], [payload, emptyChat()]);
    await applyProjectImport(session, null, {}, { appendChat: true, appendMemories: false });
    const { records, history } = committed(), owner = records.find((record) => !record.parentId)!;
    const importedEpisode = records.find((record) => record.parentId === owner.id)!;
    expect(history.find((row) => row.store === 'chatConversations')!.value.workbenchTarget)
      .toEqual({ seriesId: owner.id, episodeId: importedEpisode.id });
  });

  it('新版无法映射工作台历史目标时拒绝追加，不提交失去限制的会话', async () => {
    const source = project('source'), payload = chat(source.id, 'workbench');
    payload.conversations[0].workbenchTarget = { seriesId: source.id, episodeId: 'missing-episode' };
    const session = await prepareArchive([source], [payload]);
    await expect(applyProjectImport(session, null, {}, { appendChat: true, appendMemories: false }))
      .rejects.toThrow('无法恢复只读绑定');
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('新版接收端重建故事图本机版本，证据绑定接收端分集', async () => {
    const source = project('source'), episode = project('episode', source.id), graph = createEmptyStoryGraph('graph');
    graph.revision = 90;
    graph.nodes.push({ id: 'event', kind: 'event', label: '揭露', description: '', aliases: [], episodeIds: [episode.id],
      evidence: [], origin: 'manual', certainty: 'explicit' });
    source.series = { storyGraph: graph };
    const session = await prepareArchive([source, episode], [emptyChat(), emptyChat()]);
    await applyProjectImport(session, null, {}, { appendChat: false, appendMemories: false });
    const { records } = committed();
    expect(records[0].series!.storyGraph!.revision).toBe(1);
    expect(records[0].series!.storyGraph!.nodes[0].episodeIds).toEqual([records[1].id]);
    expect(records[1].id).not.toBe(episode.id);
  });
  it('关闭预览立即失效，物理清理失败后重试仍会删除，成功后不再重复删除', async () => {
    const source = project('source'), session = await prepareArchive([source], [emptyChat()]);
    mocks.delete.mockRejectedValueOnce(new Error('文件被占用'));
    await expect(closePreparedProjectImport(session)).rejects.toThrow('文件被占用');
    expect(session.disposed).toBe(true);
    await expect(applyProjectImport(session, null, {}, { appendChat: false, appendMemories: false })).rejects.toThrow('预览已关闭');
    await closePreparedProjectImport(session);
    await closePreparedProjectImport(session);
    expect(mocks.delete).toHaveBeenCalledTimes(2);
    expect(mocks.delete).toHaveBeenLastCalledWith(session.stagingProjectId, { throwOnError: true });
  });

  it('同时关闭同一预览共用一次清理，失败后两次调用均可再次重试', async () => {
    const session = await prepareArchive([project('source')], [emptyChat()]);
    let rejectCleanup!: (error: Error) => void;
    mocks.delete.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectCleanup = reject; }));
    const first = closePreparedProjectImport(session), second = closePreparedProjectImport(session);
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    const rejected = Promise.allSettled([first, second]); rejectCleanup(new Error('暂存目录占用'));
    expect((await rejected).every((result) => result.status === 'rejected')).toBe(true);
    await Promise.all([closePreparedProjectImport(session), closePreparedProjectImport(session)]);
    expect(mocks.delete).toHaveBeenCalledTimes(2);
  });

  it('已有协作来源缺少当前完整快照时不以墓碑映射扫描预览', async () => {
    const source = project('source'), session = await prepareArchive([source], [emptyChat()]);
    mocks.read.mockResolvedValue([source]); mocks.state.mockResolvedValue(session.sourceState);
    mocks.graph.mockResolvedValue({ revisions: [], ancestors: [] });
    await expect(previewProjectImport(session, source.id)).rejects.toThrow('缺少完整快照');
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['unpack_project_archive']);
  });

  it('不追加历史时跨分集重复历史 ID 不影响业务导入', async () => {
    const source = project('source'), episode = project('episode', source.id);
    const session = await prepareArchive([source, episode], [chat(source.id, 'shared-conversation'), chat(episode.id, 'shared-conversation')]);
    await applyProjectImport(session, null, {}, { appendChat: false, appendMemories: false });
    const { records, history } = committed();
    expect(records).toHaveLength(2);
    expect(records[1].parentId).toBe(records[0].id);
    expect(history).toEqual([]);
  });

  it('旧包新增分集的聊天与记忆归属新本机分集 ID', async () => {
    const local = project('recipient'), source = project('source'), episode = project('new-episode', source.id);
    const episodeChat = chat(episode.id, 'episode-conversation');
    episodeChat.memories.push(memory(episode.id, 'episode-conversation'));
    mocks.read.mockResolvedValue([local]);
    const session = await prepareArchive([source, episode], [emptyChat(), episodeChat], 2);
    const preview = await previewProjectImport(session, local.id);
    await applyProjectImport(session, preview, Object.fromEntries(preview.plan.changes.map((change) => [change.id, 'incoming'])),
      { appendChat: true, appendMemories: true });
    const { records, history } = committed(), importedEpisode = records.find((record) => record.parentId === local.id)!;
    expect(importedEpisode.id).not.toBe(episode.id);
    expect(history).toHaveLength(3);
    expect(history.every((row) => row.value.projectId === importedEpisode.id)).toBe(true);
    const conversation = history.find((row) => row.store === 'chatConversations')!, message = history.find((row) => row.store === 'chatMessages')!;
    expect(history.find((row) => row.store === 'projectMemories')!.value.source).toEqual({
      conversationId: conversation.value.id, messageId: message.value.id, unavailable: false,
    });
  });

  it('合并保留分集删除时不向墓碑映射追加历史，依赖该集的记忆标记不可回溯', async () => {
    const source = project('source'), episode = project('episode', source.id);
    const base = await prepareArchive([source, episode], [emptyChat(), emptyChat()]);
    const ownerChat = emptyChat(); ownerChat.memories.push(memory(source.id, 'deleted-conversation'));
    const incoming = await prepareArchive([source, { ...episode, episodeScript: '对方修改' }], [ownerChat, chat(episode.id, 'deleted-conversation')], 3,
      { state: base.sourceState!, revisions: base.bundle!.revisions });
    const local = project('recipient');
    const localState: ProjectExchangeState = { ...base.sourceState!, ownerId: local.id,
      identities: base.sourceState!.identities.map((identity) => ({ ...identity,
        localId: identity.id === source.id ? local.id : 'removed-local-episode' })) };
    mocks.read.mockResolvedValue([local]); mocks.state.mockResolvedValue(localState);
    mocks.graph.mockResolvedValue({ revisions: base.bundle!.revisions, ancestors: [] });
    const preview = await previewProjectImport(incoming, local.id);
    expect(preview.plan.alreadyApplied).toBe(false);
    await applyProjectImport(incoming, preview, Object.fromEntries(preview.plan.changes.map((change) => [change.id, 'local'])),
      { appendChat: true, appendMemories: true });
    const { records, history } = committed();
    expect(records.map((record) => record.id)).toEqual([local.id]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ store: 'projectMemories', value: { projectId: local.id,
      source: { conversationId: '', messageId: undefined, unavailable: true } } });
  });

  it('整剧预建会话与消息映射，双向跨分集记忆来源均可回溯', async () => {
    const source = project('source'), episode = project('episode', source.id);
    const ownerChat = chat(source.id, 'owner-conversation'), episodeChat = chat(episode.id, 'episode-conversation');
    ownerChat.memories.push(memory(source.id, 'episode-conversation'));
    episodeChat.memories.push(memory(episode.id, 'owner-conversation'));
    const session = await prepareArchive([source, episode], [ownerChat, episodeChat]);
    await applyProjectImport(session, null, {}, { appendChat: true, appendMemories: true });
    const { records, history } = committed();
    expect(records.map((record) => record.id)).not.toContain(source.id);
    expect(records.map((record) => record.id)).not.toContain(episode.id);
    expect(history).toHaveLength(6);
    for (const [index, conversationTitle] of ['episode-conversation', 'owner-conversation'].entries()) {
      const conversation = history.find((row) => row.store === 'chatConversations' && row.value.title === conversationTitle)!;
      const message = history.find((row) => row.store === 'chatMessages' && row.value.conversationId === conversation.value.id)!;
      expect(history.find((row) => row.store === 'projectMemories' && row.value.projectId === records[index].id)!.value.source).toEqual({
        conversationId: conversation.value.id, messageId: message.value.id, unavailable: false,
      });
    }
  });

  it.each([
    { appendChat: true, sourceId: 'conversation', unavailable: true, linked: true },
    { appendChat: true, sourceId: 'missing-conversation', unavailable: false, linked: false },
    { appendChat: false, sourceId: 'conversation', unavailable: false, linked: false },
  ])('保留原不可回溯状态并处理未导入来源（%j）', async ({ appendChat, sourceId, unavailable, linked }) => {
    const source = project('source'), payload = chat(source.id, 'conversation');
    payload.memories.push(memory(source.id, sourceId, unavailable));
    const session = await prepareArchive([source], [payload]);
    await applyProjectImport(session, null, {}, { appendChat, appendMemories: true });
    const { history } = committed(), memoryRow = history.find((row) => row.store === 'projectMemories')!;
    const conversation = history.find((row) => row.store === 'chatConversations'), message = history.find((row) => row.store === 'chatMessages');
    expect(history).toHaveLength(appendChat ? 3 : 1);
    expect(memoryRow.value.source).toEqual({ conversationId: linked ? conversation!.value.id : '',
      messageId: linked ? message!.value.id : undefined, unavailable: true });
  });
});
