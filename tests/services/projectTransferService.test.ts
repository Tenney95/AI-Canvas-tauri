/**
 * projectTransferService — 回归测试：projectTransferService。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyStoryGraph } from '../../src/services/storyGraphService';
import type { ProjectImportCommit } from '../../src/services/indexedDb/projectImportRepository';
import type { LegacyArchiveExportOperation } from '../../src/services/indexedDb/projectArchiveOperationRepository';
import { registerEpisodeEditorSession, settleEpisodeEditorSessions } from '../../src/services/episodeEditorSessionService';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  getAllProjects: vi.fn(),
  getProjectById: vi.fn(),
  deleteProjectFromDb: vi.fn(),
  saveProject: vi.fn(),
  getProjectChatForExport: vi.fn(),
  putChatConversation: vi.fn(),
  putChatMessage: vi.fn(),
  putProjectMemory: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  ensureProjectDataDir: vi.fn(),
  renameProjectDataDir: vi.fn(),
  registerProjectFolder: vi.fn(),
  registerProjectFolders: vi.fn(),
  deleteProjectDataDir: vi.fn(),
  notifyProjectDiskChanged: vi.fn(),
  getBaseDir: vi.fn(async () => '/data'),
  getDefaultBaseDir: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(async () => undefined),
  exists: vi.fn(),
  getProjectDataDir: vi.fn(),
  serializeEntries: vi.fn(),
  legacyWriteGuard: vi.fn(),
  captureArchive: vi.fn(),
  assertCaptureCurrent: vi.fn(),
  commitImport: vi.fn(),
  beginImport: vi.fn(),
  advanceImport: vi.fn(),
  readImport: vi.fn(),
  prepareExport: vi.fn(),
  advanceExport: vi.fn(),
  readExport: vi.fn(),
  saveCheckpoint: vi.fn(),
  savePrepared: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open, save: mocks.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: mocks.mkdir, remove: mocks.remove, exists: mocks.exists }));
vi.mock('../../src/services/projectArchiveSerialization', () => ({ serializeProjectArchiveEntries: mocks.serializeEntries }));
vi.mock('../../src/services/indexedDb/legacyProjectWriteGuard', () => ({ assertLegacyProjectWritesAllowed: mocks.legacyWriteGuard }));
vi.mock('../../src/services/indexedDb/schema', () => ({ openDB: async () => ({}) }));
vi.mock('../../src/services/indexedDb/projectArchiveRepository', () => ({ captureLegacyProjectArchive: mocks.captureArchive,
  assertLegacyProjectArchiveCurrent: mocks.assertCaptureCurrent }));
vi.mock('../../src/services/indexedDb/projectArchiveOperationRepository', () => ({
  prepareLegacyArchiveExport: mocks.prepareExport, advanceLegacyArchiveExport: mocks.advanceExport, readLegacyArchiveExport: mocks.readExport,
}));
vi.mock('../../src/services/indexedDb/projectImportRepository', () => ({
  beginProjectImportOperation: mocks.beginImport, advanceProjectImportOperation: mocks.advanceImport,
  commitProjectImport: mocks.commitImport, readProjectImportOperation: mocks.readImport,
  savePreparedProjectImportOperation: mocks.savePrepared,
}));
// 本文件保留旧包恢复/目录回滚的回归；v3 内核与事务在各自的专用用例覆盖。
vi.mock('../../src/services/indexedDb/projectExchangeRepository', () => ({
  loadProjectExchangeState: async () => ({ headRevisionId: 'export-head', lineageId: 'export-lineage', rootProjectId: 'export-root', identities: [] }),
  loadProjectExchangeGraph: async () => ({ revisions: [{ revisionId: 'export-head', snapshot: { lineageId: 'export-lineage', rootProjectId: 'export-root', entities: [] } }], ancestors: [] }),
  saveProjectExchangeCheckpoint: mocks.saveCheckpoint,
}));
vi.mock('../../src/services/projectExchangeDomain', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/projectExchangeDomain')>(),
  materializeExchangeSnapshot: (_snapshot: unknown, _identities: unknown, records: unknown[]) => records,
}));
vi.mock('../../src/services/projectArchiveValidation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/projectArchiveValidation')>(),
  selectArchiveAssets: () => [],
}));
vi.mock('../../src/services/projectImportService', () => ({
  prepareExchangeExportMaterial: async (records: Array<{ id: string }>) => ({
    bundle: { headRevisionId: 'export-head', revisions: [{ revisionId: 'export-head', snapshot: {} }] },
    checkpoint: { expectedState: null, state: { ownerId: records[0].id, headRevisionId: 'export-head',
      lineageId: 'export-lineage', rootProjectId: 'export-root', stateVersion: 1, identities: [] }, revisions: [], ancestors: [] },
  }),
  readProjectArchiveContents: async () => undefined,
  prepareProjectImport: async () => {
    if (!mocks.isTauriEnv()) throw new Error('项目导入仅在桌面版可用');
    const archivePath = await mocks.open(); return archivePath ? { archivePath } : null;
  },
  applyProjectImport: async (session: { archivePath: string }) => (await import('../../src/services/projectTransferService')).restoreProjectArchive(session.archivePath),
  closePreparedProjectImport: async () => undefined,
}));
vi.mock('../../src/services/indexedDbService', () => ({
  getAllProjects: mocks.getAllProjects,
  getProjectById: mocks.getProjectById,
  deleteProjectFromDb: mocks.deleteProjectFromDb,
  getProjectChatForExport: mocks.getProjectChatForExport,
  putChatConversation: mocks.putChatConversation,
  putChatMessage: mocks.putChatMessage,
  putProjectMemory: mocks.putProjectMemory,
}));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: mocks.isTauriEnv,
  ensureProjectDataDir: mocks.ensureProjectDataDir,
  getProjectDataDir: mocks.getProjectDataDir,
  renameProjectDataDir: mocks.renameProjectDataDir,
  registerProjectFolder: mocks.registerProjectFolder,
  registerProjectFolders: mocks.registerProjectFolders,
  deleteProjectDataDir: mocks.deleteProjectDataDir,
  notifyProjectDiskChanged: mocks.notifyProjectDiskChanged,
  getBaseDir: mocks.getBaseDir,
  getDefaultBaseDir: mocks.getDefaultBaseDir,
  saveProject: mocks.saveProject,
  joinPath: (...parts: string[]) => parts.join('/'),
  buildProjectFolderName: (name: string, id: string) => `${name}-${id.slice(0, 8)}`,
  sanitizeFileName: (name: string) => name,
}));

import {
  PROJECT_ARCHIVE_FORMAT_VERSION,
  duplicateProjectArchive,
  exportProjectArchive,
  importProjectArchive,
  restoreProjectArchive,
  readArchiveChat,
} from '../../src/services/projectTransferService';

const PROJECT_RECORD = {
  id: 'source-project',
  name: '分镜项目',
  createdAt: 100,
  updatedAt: 200,
  nodes: [
    { id: 'n1', data: { assetId: 'source-asset', relativePath: '镜头1/a.png', label: 'a.png' } },
    { id: 'n2', data: { assetId: 'missing-asset', relativePath: '镜头1/b.png', label: 'b.png' } },
  ],
  edges: [],
  groups: [],
  dataFolder: '分镜项目-source12',
};

const SERIES_RECORD = {
  ...PROJECT_RECORD,
  nodes: [],
  series: { script: '全剧剧本' },
  dramaAssets: { version: 2, characters: [], scenes: [], props: [] },
};

const EPISODE_RECORD = {
  ...PROJECT_RECORD,
  id: 'episode-1',
  parentId: PROJECT_RECORD.id,
  name: '第 1 集',
  episodeNo: 1,
  episodeOutline: '本集大纲',
  episodeScript: '本集剧本',
  episodeCreative: { beats: ['发现线索'] },
  snapshot: 'data:image/webp;base64,episode',
  settings: { generation: { imageAspectRatio: '16:9' } },
  nodes: [{ id: 'episode-image', type: 'ai-image', data: {
    prompt: '本集镜头', assetId: 'source-image', relativePath: '分集/a.png',
  } }, { id: 'episode-text', type: 'ai-text', data: { prompt: '分集对白' } }],
  edges: [{ id: 'episode-edge', source: 'episode-text', target: 'episode-image' }],
  groups: [{ id: 'episode-group', label: '镜头组' }],
};

const EMPTY_CHAT = { conversations: [], messages: [], memories: [] };
function mockNativePublication(counts: { assetCount: number; assetBytes: number; archiveBytes: number }) {
  mocks.invoke.mockImplementation(async (command: string, args: { operationId?: string }) => {
    if (command === 'inspect_project_archive_assets') return [];
    if (command === 'pack_project_archive') return { ...counts, operationId: args.operationId,
      publicationRef: 'native-publication', archiveSha256: 'a'.repeat(64) };
    throw new Error(`Unexpected native command: ${command}`);
  });
}

function archiveTexts(overrides: Record<string, unknown> = {}) {
  return {
    'manifest.json': JSON.stringify({
      formatVersion: PROJECT_ARCHIVE_FORMAT_VERSION,
      exportedAt: 1,
      projectId: 'source-project',
      projectName: '分镜项目',
      episodeCount: Array.isArray(overrides.episodes) ? overrides.episodes.length : 0,
      ...(overrides.manifest as object ?? {}),
    }),
    'project.json': JSON.stringify(overrides.project ?? PROJECT_RECORD),
    'chat.json': JSON.stringify(overrides.chat ?? {
      conversations: [{ id: 'conv-1', projectId: 'source-project', title: '讨论', messageCount: 1 }],
      messages: [
        { id: 'msg-1', projectId: 'source-project', conversationId: 'conv-1', sequence: 1, content: '你好', agentTaskId: 'task-1' },
        { id: 'msg-2', projectId: 'source-project', conversationId: 'conv-missing', sequence: 1, content: '孤儿消息' },
      ],
      memories: [
        { id: 'mem-1', projectId: 'source-project', kind: 'fact', content: '主角是猫', enabled: true, source: { conversationId: 'conv-1', messageId: 'msg-1' }, createdAt: 1, updatedAt: 1 },
      ],
    }),
    ...(overrides.episodes !== undefined ? { 'episodes.json': JSON.stringify(overrides.episodes) } : {}),
  };
}

/** 原生边界只模拟打包/解包，记录使用真实导出文本往返。 */
function mockArchiveRoundTrip(assetPaths: string[] = []) {
  let texts: Record<string, string> = {};
  mocks.invoke.mockImplementation(async (command: string, args: { entries?: { path: string; content: string }[]; operationId?: string }) => {
    if (command === 'inspect_project_archive_assets') return [];
    if (command === 'pack_project_archive') {
      texts = Object.fromEntries(args.entries!.map((entry) => [entry.path, entry.content]));
      return { assetCount: assetPaths.length, assetBytes: 12, archiveBytes: 8,
        operationId: args.operationId, publicationRef: 'native-publication', archiveSha256: 'a'.repeat(64) };
    }
    return { texts, assetPaths, assetBytes: 12 };
  });
}

describe('projectTransferService', () => {
  it.each([false, true])('恢复分集 TXT 引用并统计缺失的稿件文件（文件存在=%s）', async (present) => {
    const reference = { fileName: '不可信展示名.txt', relativePath: 'manuscripts/第一集.txt', digest: 'a'.repeat(64), sourceName: '第一集.txt',
      filePath: 'C:/private/第一集.txt', token: 'fixture-private' };
    mocks.invoke.mockResolvedValue({ texts: archiveTexts({ project: SERIES_RECORD, chat: EMPTY_CHAT,
      manifest: { formatVersion: 2 }, episodes: [{ project: { ...EPISODE_RECORD, nodes: [], edges: [], groups: [], episodeScriptFile: reference }, chat: EMPTY_CHAT }] }),
      assetPaths: present ? ['manuscripts/第一集.txt'] : [], assetBytes: present ? 6 : 0 });

    const result = await restoreProjectArchive('/incoming/manuscripts.aicanvas');

    expect(result.missingAssetCount).toBe(present ? 0 : 1);
    const saved = mocks.saveProject.mock.calls[1][0];
    expect(saved.episodeScript).toBe(EPISODE_RECORD.episodeScript);
    expect(saved.episodeScriptFile).toEqual({ fileName: '第一集.txt', relativePath: 'manuscripts/第一集.txt', digest: 'a'.repeat(64), sourceName: '第一集.txt' });
    expect(result.episodes[0].episodeScriptFile).toEqual(saved.episodeScriptFile);
    expect(JSON.stringify(saved.episodeScriptFile)).not.toContain('fixture-private');
  });

  it('旧包故事图的出处随分集新身份迁移，不指回原项目', async () => {
    const graph = createEmptyStoryGraph('graph');
    graph.nodes.push({ id: 'event', kind: 'event', label: '关键点', description: '', aliases: [],
      episodeIds: [EPISODE_RECORD.id], evidence: [], origin: 'manual', certainty: 'explicit' });
    mocks.invoke.mockResolvedValue({ texts: archiveTexts({
      project: { ...SERIES_RECORD, series: { ...SERIES_RECORD.series, storyGraph: graph } },
      manifest: { formatVersion: 2 }, chat: EMPTY_CHAT, episodes: [{ project: EPISODE_RECORD, chat: EMPTY_CHAT }],
    }), assetPaths: [], assetBytes: 0 });
    const result = await restoreProjectArchive('/incoming/story.aicanvas');
    const [root, episode] = mocks.saveProject.mock.calls.map(([record]) => record);
    expect(root.series.storyGraph.nodes[0].episodeIds).toEqual([episode.id]);
    expect(root.series.storyGraph.revision).toBe(1);
    expect(episode.id).not.toBe(EPISODE_RECORD.id);
    expect(result.series?.storyGraph).toEqual(root.series.storyGraph);
  });
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.legacyWriteGuard.mockResolvedValue(undefined);
    mocks.getVersion.mockResolvedValue('0.6.13');
    mocks.getAllProjects.mockResolvedValue([{ id: PROJECT_RECORD.id, name: PROJECT_RECORD.name,
      createdAt: PROJECT_RECORD.createdAt, updatedAt: PROJECT_RECORD.updatedAt }]);
    mocks.serializeEntries.mockImplementation(async (entries: Array<{ path: string; value: unknown }>) => (
      entries.map(({ path, value }) => ({ path, content: JSON.stringify(value) }))
    ));
    mocks.deleteProjectFromDb.mockResolvedValue(undefined);
    mocks.deleteProjectDataDir.mockResolvedValue(undefined);
    mocks.getProjectChatForExport.mockResolvedValue(EMPTY_CHAT);
    mocks.ensureProjectDataDir.mockResolvedValue('/data/导入中-abc');
    mocks.renameProjectDataDir.mockImplementation(async (_id: string, oldFolder: string, dataFolder: string) => ({
      oldDir: `/data/${oldFolder}`,
      newDir: `/data/${dataFolder}`,
      oldFolder,
      dataFolder,
      renamed: true,
    }));
    mocks.saveProject.mockImplementation(async (record: { id: string }) => record.id);
    mocks.putChatConversation.mockResolvedValue(undefined);
    mocks.putChatMessage.mockResolvedValue(undefined);
    mocks.putProjectMemory.mockResolvedValue(undefined);
    mocks.getBaseDir.mockResolvedValue('/data');
    mocks.getDefaultBaseDir.mockResolvedValue('/app-owned/data');
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.exists.mockResolvedValue(false);
    mocks.getProjectDataDir.mockResolvedValue('/data/导入中-abc');
    mocks.captureArchive.mockImplementation(async (requestedId: string) => {
      const summaries = await mocks.getAllProjects();
      const requested = summaries.find((record: { id: string }) => record.id === requestedId);
      const ownerId = requested?.parentId ?? requestedId;
      const owner = await mocks.getProjectById(ownerId);
      if (!owner) throw new Error('项目记录不可读取');
      const children = summaries.filter((record: { parentId?: string }) => record.parentId === ownerId)
        .sort((left: { episodeNo?: number }, right: { episodeNo?: number }) => (left.episodeNo ?? 0) - (right.episodeNo ?? 0));
      const records = [owner];
      for (const summary of children) {
        const child = await mocks.getProjectById(summary.id);
        if (!child) throw new Error('分集记录不可读取');
        records.push(child);
      }
      const chat = [];
      for (const record of records) chat.push(readArchiveChat(await mocks.getProjectChatForExport(record.id, 100_000)));
      return { records, chat, state: { headRevisionId: 'export-head', lineageId: 'export-lineage', rootProjectId: 'export-root', identities: [] },
        graph: [{ revisionId: 'export-head', snapshot: { lineageId: 'export-lineage', rootProjectId: 'export-root', entities: [] } }] };
    });
    const imports = new Map<string, { phase: string; prepared?: unknown }>();
    mocks.beginImport.mockImplementation(async (id: string) => { imports.set(id, { phase: 'prepared' }); });
    mocks.advanceImport.mockImplementation(async (id: string, phase: string) => { imports.set(id, { ...imports.get(id), phase }); });
    mocks.savePrepared.mockImplementation(async (id: string, prepared: unknown) => { imports.set(id, { phase: imports.get(id)!.phase, prepared }); });
    mocks.readImport.mockImplementation(async (id: string) => imports.get(id) ?? null);
    // 只有整事务成功后投影这些观察 spy；它们不模拟逐条持久化或逐条回滚。
    mocks.commitImport.mockImplementation(async (input: ProjectImportCommit) => {
      imports.set(input.operationId, { phase: 'db_committed' });
      for (const record of input.records) await mocks.saveProject(record);
      for (const row of input.history) {
        const observe = row.store === 'chatConversations' ? mocks.putChatConversation
          : row.store === 'chatMessages' ? mocks.putChatMessage : mocks.putProjectMemory;
        await observe(row.value);
      }
    });
    const exports = new Map<string, LegacyArchiveExportOperation>();
    mocks.prepareExport.mockImplementation(async (operationId: string, checkpoint: LegacyArchiveExportOperation['checkpoint']) => {
      const operation: LegacyArchiveExportOperation = { id: `project-export-operation:${operationId}`, operationId,
        ownerId: checkpoint.state.ownerId, checkpoint, phase: 'prepared', sequence: 1, createdAt: 1, updatedAt: 1 };
      exports.set(operationId, operation); return operation;
    });
    mocks.advanceExport.mockImplementation(async (id: string, expected: number, phase: LegacyArchiveExportOperation['phase'],
      receipt?: { publicationRef: string; archiveSha256: string }) => {
      const current = exports.get(id)!;
      if (current.sequence !== expected) throw new Error('归档阶段冲突');
      const next = { ...current, ...receipt, phase, sequence: expected + 1 }; exports.set(id, next); return next;
    });
    mocks.readExport.mockImplementation(async (id: string) => exports.get(id) ?? null);
  });

  it('rejects a legacy archive replaced after preview without saving any project', async () => {
    const texts = archiveTexts({ manifest: { formatVersion: 2 } });
    const preview = { manifest: JSON.parse(texts['manifest.json']), records: [PROJECT_RECORD],
      chat: [readArchiveChat(JSON.parse(texts['chat.json']))], assets: [{ path: '镜头1/a.png', bytes: 12, sha256: 'a'.repeat(64) }] };
    mocks.invoke.mockResolvedValue({ texts, assetPaths: ['镜头1/a.png'], assetBytes: 12,
      assets: [{ path: '镜头1/a.png', bytes: 12, sha256: 'b'.repeat(64) }] });
    await expect(restoreProjectArchive('/in/replaced.aicanvas', undefined, { appendChat: false, appendMemories: false }, preview))
      .rejects.toThrow('预览后发生变化');
    expect(mocks.saveProject).not.toHaveBeenCalled();
    expect(mocks.deleteProjectDataDir).toHaveBeenCalledOnce();
  });

  it('packs the project record, chat payload and asset directory', async () => {
    mocks.getProjectById.mockResolvedValue(PROJECT_RECORD);
    mocks.getProjectChatForExport.mockResolvedValue({
      conversations: [{ id: 'conv-1', projectId: PROJECT_RECORD.id, title: '导出讨论' }],
      messages: [
        { id: 'm1', conversationId: 'conv-1', sequence: 1, content: '第一条', agentTaskId: 'private-task' },
        { id: 'm2', conversationId: 'conv-1', sequence: 2, content: '第二条' },
      ],
      memories: [{ id: 'mem-1', projectId: PROJECT_RECORD.id, content: '项目记忆' }],
    });
    mocks.ensureProjectDataDir.mockResolvedValue('/data/分镜项目-source12');
    mocks.save.mockResolvedValue('/out/分镜项目.aicanvas');
    mockNativePublication({ assetCount: 3, assetBytes: 10, archiveBytes: 8 });

    const result = await exportProjectArchive('source-project');

    expect(result).toEqual({ filePath: '/out/分镜项目.aicanvas', assetCount: 3, archiveBytes: 8, episodeCount: 0, operationId: expect.any(String) });
    expect(mocks.captureArchive).toHaveBeenCalledExactlyOnceWith(PROJECT_RECORD.id);
    expect(mocks.saveCheckpoint).toHaveBeenCalledOnce();
    expect(mocks.advanceExport.mock.calls.map((call) => call[2])).toEqual(['packing', 'published', 'registered']);
    expect(mocks.getProjectChatForExport).toHaveBeenCalledExactlyOnceWith(PROJECT_RECORD.id, 100_000);
    const [command, args] = mocks.invoke.mock.calls.find(([name]) => name === 'pack_project_archive')!;
    expect(command).toBe('pack_project_archive');
    expect(args.assetsDir).toBe('/data/分镜项目-source12');
    expect(args.outputPath).toBe('/out/分镜项目.aicanvas');

    const entries = args.entries as { path: string; content: string }[];
    expect(entries.map((entry) => entry.path)).toEqual(['manifest.json', 'project.json', 'chat.json', 'exchange.json', 'exchange-state.json']);
    expect(JSON.parse(entries[0].content)).toMatchObject({ formatVersion: 3, episodeCount: 0 });
    const chat = JSON.parse(entries[2].content);
    // 批读服务提供的升序消息经过既有可移植边界后保持顺序。
    expect(chat.messages.map((message: { id: string }) => message.id)).toEqual(['m1', 'm2']);
    expect(chat.messages[0].content).toBe('第一条');
    expect(chat.messages[0]).not.toHaveProperty('agentTaskId');
    expect(chat.conversations[0]).toMatchObject({ id: 'conv-1', title: '导出讨论', messageCount: 2 });
    expect(chat.memories[0]).toMatchObject({ id: 'mem-1', content: '项目记忆' });
  });

  it('does not pack anything when the save dialog is cancelled', async () => {
    mocks.getProjectById.mockResolvedValue(PROJECT_RECORD);
    mocks.save.mockResolvedValue(null);

    await expect(exportProjectArchive('source-project')).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.getProjectById).not.toHaveBeenCalled();
    expect(mocks.serializeEntries).not.toHaveBeenCalled();
    expect(mocks.getProjectChatForExport).not.toHaveBeenCalled();
    expect(mocks.captureArchive).not.toHaveBeenCalled();
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
  });

  it('原生发布缺少原操作回执时不提前推进协作版本', async () => {
    mocks.getProjectById.mockResolvedValue(PROJECT_RECORD);
    mocks.save.mockResolvedValue('/out/unconfirmed.aicanvas');
    mocks.invoke.mockImplementation(async (command: string) => command === 'inspect_project_archive_assets'
      ? [] : { assetCount: 0, assetBytes: 0, archiveBytes: 8 });
    await expect(exportProjectArchive(PROJECT_RECORD.id)).rejects.toThrow('未推进协作版本');
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
    expect(mocks.advanceExport.mock.calls.map((call) => call[2])).toEqual(['packing']);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'pack_project_archive')).toHaveLength(1);
  });

  it('uses only summaries before the dialog and packs the latest complete record after confirmation', async () => {
    const latest = { ...PROJECT_RECORD, name: '确认时的新名称', updatedAt: 400,
      nodes: [{ id: 'latest-node', data: { output: '保存后的最新正文' } }] };
    mocks.save.mockImplementation(async () => {
      expect(mocks.getProjectById).not.toHaveBeenCalled();
      mocks.getProjectById.mockResolvedValue(latest);
      return '/out/latest.aicanvas';
    });
    mockNativePublication({ assetCount: 0, assetBytes: 0, archiveBytes: 8 });

    await exportProjectArchive(PROJECT_RECORD.id);

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: `${PROJECT_RECORD.name}.aicanvas` }));
    expect(mocks.getProjectById).toHaveBeenCalledExactlyOnceWith(PROJECT_RECORD.id);
    const entries = mocks.invoke.mock.calls.find(([name]) => name === 'pack_project_archive')![1].entries as Array<{ path: string; content: string }>;
    expect(JSON.parse(entries.find((entry) => entry.path === 'project.json')!.content)).toEqual(latest);
  });

  it('does not invoke native packing or write project records when background serialization fails', async () => {
    mocks.getProjectById.mockResolvedValue(PROJECT_RECORD);
    mocks.save.mockResolvedValue('/out/project.aicanvas');
    mocks.serializeEntries.mockRejectedValue(new Error('项目导出整理超时，请重试'));

    await expect(exportProjectArchive(PROJECT_RECORD.id)).rejects.toThrow('整理超时');

    expect(mocks.invoke.mock.calls.some(([name]) => name === 'pack_project_archive')).toBe(false);
    expect(mocks.saveProject).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each([
    '会话消息超过当前归档上限，请先拆分会话后重新导出',
    '对话与项目记忆读取失败',
  ])('stops export before serialization or native IO when the batch chat reader rejects: %s', async (message) => {
    const failure = new Error(message);
    mocks.getProjectById.mockResolvedValue(PROJECT_RECORD);
    mocks.getProjectChatForExport.mockRejectedValue(failure);
    mocks.save.mockResolvedValue('/out/project.aicanvas');

    await expect(exportProjectArchive(PROJECT_RECORD.id)).rejects.toBe(failure);

    expect(mocks.getProjectChatForExport).toHaveBeenCalledExactlyOnceWith(PROJECT_RECORD.id, 100_000);
    expect(mocks.serializeEntries).not.toHaveBeenCalled();
    expect(mocks.ensureProjectDataDir).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.saveProject).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('stops a series export when an episode batch chat read fails', async () => {
    const failure = new Error('分集对话读取失败');
    const records = [SERIES_RECORD, EPISODE_RECORD];
    mocks.getAllProjects.mockResolvedValue(records);
    mocks.getProjectById.mockImplementation(async (id: string) => records.find((record) => record.id === id));
    mocks.getProjectChatForExport.mockImplementation(async (id: string) => {
      if (id === EPISODE_RECORD.id) throw failure;
      return EMPTY_CHAT;
    });
    mocks.save.mockResolvedValue('/out/整部剧.aicanvas');

    await expect(exportProjectArchive(SERIES_RECORD.id)).rejects.toBe(failure);

    expect(mocks.getProjectChatForExport.mock.calls).toEqual([
      [SERIES_RECORD.id, 100_000], [EPISODE_RECORD.id, 100_000],
    ]);
    expect(mocks.serializeEntries).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.saveProject).not.toHaveBeenCalled();
  });

  it('preserves the native packing error without writing project records', async () => {
    const failure = new Error('磁盘已满');
    mocks.getProjectById.mockResolvedValue(PROJECT_RECORD);
    mocks.save.mockResolvedValue('/out/project.aicanvas');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'inspect_project_archive_assets') return [];
      if (command === 'pack_project_archive') throw failure;
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(exportProjectArchive(PROJECT_RECORD.id)).rejects.toBe(failure);

    expect(mocks.getProjectChatForExport).toHaveBeenCalledExactlyOnceWith(PROJECT_RECORD.id, 100_000);
    expect(mocks.serializeEntries).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith('pack_project_archive', expect.objectContaining({ outputPath: '/out/project.aicanvas' }));
    expect(mocks.saveProject).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('exports all episodes in order with one shared asset directory, including an episode entry point', async () => {
    const second = { ...EPISODE_RECORD, id: 'episode-2', name: '第 2 集', episodeNo: 2 };
    const unrelated = { ...EPISODE_RECORD, id: 'other-episode', parentId: 'other-series' };
    const records = [SERIES_RECORD, second, unrelated, EPISODE_RECORD];
    mocks.getAllProjects.mockResolvedValue(records);
    mocks.getProjectById.mockImplementation(async (id: string) => records.find((record) => record.id === id));
    mocks.save.mockResolvedValue('/out/整部剧.aicanvas');
    mockNativePublication({ assetCount: 1, assetBytes: 12, archiveBytes: 8 });

    const result = await exportProjectArchive(EPISODE_RECORD.id);

    expect(result!.episodeCount).toBe(2);
    expect(mocks.ensureProjectDataDir).toHaveBeenCalledExactlyOnceWith(SERIES_RECORD.id);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'pack_project_archive')).toHaveLength(1);
    const entries = mocks.invoke.mock.calls.find(([name]) => name === 'pack_project_archive')![1].entries as { path: string; content: string }[];
    const texts = Object.fromEntries(entries.map((entry) => [entry.path, entry.content]));
    expect(JSON.parse(texts['manifest.json'])).toMatchObject({ formatVersion: 3, episodeCount: 2 });
    expect(JSON.parse(texts['episodes.json']).map((episode: { project: { id: string } }) => episode.project.id))
      .toEqual(['episode-1', 'episode-2']);
    expect(mocks.getProjectChatForExport.mock.calls).toEqual([
      [SERIES_RECORD.id, 100_000], ['episode-1', 100_000], ['episode-2', 100_000],
    ]);
  });

  it('分集第二素材根非空时拒绝有损 v3 导出且不推进协作版本', async () => {
    const records = [SERIES_RECORD, EPISODE_RECORD];
    mocks.getAllProjects.mockResolvedValue(records);
    mocks.getProjectById.mockImplementation(async (id: string) => records.find((record) => record.id === id));
    mocks.save.mockResolvedValue('/out/multiple-roots.aicanvas');
    mocks.getProjectDataDir.mockResolvedValue('/data/episode-only');
    mocks.exists.mockResolvedValue(true);
    mocks.invoke.mockImplementation(async (command: string, args: { assetsDir: string }) => {
      if (command === 'inspect_project_archive_assets' && args.assetsDir === '/data/episode-only') {
        return [{ path: 'reference.png', bytes: 1, sha256: 'a'.repeat(64) }];
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
    await expect(exportProjectArchive(SERIES_RECORD.id)).rejects.toThrow('多个素材根');
    expect(mocks.invoke.mock.calls.some(([name]) => name === 'pack_project_archive')).toBe(false);
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
    expect(mocks.prepareExport).not.toHaveBeenCalled();
  });

  it('其他分集工作台的受保护脏稿阻止整部剧外发，不读取或发布旧稿', async () => {
    const records = [SERIES_RECORD, EPISODE_RECORD];
    mocks.getAllProjects.mockResolvedValue(records);
    mocks.getProjectById.mockImplementation(async (id: string) => records.find((record) => record.id === id));
    mocks.save.mockResolvedValue('/out/dirty-workbench.aicanvas');
    let dirty = true;
    const unregister = registerEpisodeEditorSession(EPISODE_RECORD.id, () => ({ dirty, saving: false }));
    try {
      await expect(exportProjectArchive(SERIES_RECORD.id)).rejects.toThrow('未保存');
      expect(mocks.invoke).not.toHaveBeenCalled();
      expect(mocks.prepareExport).not.toHaveBeenCalled();
      expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
    } finally { dirty = false; unregister(); settleEpisodeEditorSessions(EPISODE_RECORD.id); }
  });

  it.each(['分集读取', '对话读取', '素材目录'])('fails export instead of silently omitting unavailable %s', async (stage) => {
    mocks.getProjectById.mockResolvedValue(SERIES_RECORD);
    mocks.save.mockResolvedValue('/out/整部剧.aicanvas');
    if (stage === '分集读取') {
      mocks.getAllProjects.mockResolvedValue([SERIES_RECORD, EPISODE_RECORD]);
      mocks.getProjectById.mockImplementation(async (id: string) => id === SERIES_RECORD.id ? SERIES_RECORD : undefined);
    } else if (stage === '对话读取') {
      mocks.getProjectChatForExport.mockRejectedValue(new Error('对话读取失败'));
    } else {
      mocks.ensureProjectDataDir.mockRejectedValue(new Error('素材目录不可访问'));
    }

    await expect(exportProjectArchive(SERIES_RECORD.id)).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('imports under a fresh project id, remaps chat records and reports missing assets', async () => {
    mocks.open.mockResolvedValue('/in/分镜项目.aicanvas');
    mocks.invoke.mockResolvedValue({
      texts: archiveTexts(),
      assetPaths: ['镜头1/a.png'],
      assetBytes: 12,
    });

    const result = await importProjectArchive();

    expect(result).not.toBeNull();
    expect(result!.projectId).not.toBe('source-project');
    expect(result!.projectName).toBe('分镜项目');
    expect(result!.missingAssetCount).toBe(1);
    expect(result!.assetCount).toBe(1);
    expect(result!.conversationCount).toBe(1);
    expect(result!.memoryCount).toBe(1);
    expect(mocks.commitImport).toHaveBeenCalledOnce();
    expect(mocks.commitImport.mock.calls[0][0]).toMatchObject({ expectedRecords: [], expectedState: null,
      state: null, label: '旧包新建导入', records: [expect.objectContaining({ id: result!.projectId })] });
    expect(mocks.deleteProjectFromDb).not.toHaveBeenCalled();

    // 素材先解到临时目录，读到项目名后才改成正式的项目目录名
    expect(mocks.renameProjectDataDir).toHaveBeenCalledWith(
      result!.projectId,
      expect.stringContaining('导入中-'),
      result!.dataFolder,
    );

    const saved = mocks.saveProject.mock.calls[0][0];
    expect(saved.id).toBe(result!.projectId);
    expect(saved.dataFolder).toBe(result!.dataFolder);
    // 源机器的 assetId 是本机资产索引主键，导入副本不能沿用
    expect(saved.nodes[0].data.assetId).toBeUndefined();
    expect(saved.nodes[0].data.relativePath).toBe('镜头1/a.png');

    const conversation = mocks.putChatConversation.mock.calls[0][0];
    expect(conversation.id).not.toBe('conv-1');
    expect(conversation.projectId).toBe(result!.projectId);

    // 孤儿消息（会话没一起导入）被丢弃，保留的消息挂到新会话 id 上
    expect(mocks.putChatMessage).toHaveBeenCalledTimes(1);
    const message = mocks.putChatMessage.mock.calls[0][0];
    expect(message.id).not.toBe('msg-1');
    expect(message.conversationId).toBe(conversation.id);
    expect(message.agentTaskId).toBeUndefined();

    const memory = mocks.putProjectMemory.mock.calls[0][0];
    expect(memory.projectId).toBe(result!.projectId);
    expect(memory.source.conversationId).toBe(conversation.id);
    expect(memory.source.messageId).toBe(message.id);
  });

  it('round trips a series with episode canvases, scripts, settings and correctly bound conversations', async () => {
    const second = { ...EPISODE_RECORD, id: 'episode-2', name: '第 2 集', episodeNo: 2 };
    const records = [SERIES_RECORD, second, EPISODE_RECORD];
    mocks.getAllProjects.mockResolvedValue(records);
    mocks.getProjectById.mockImplementation(async (id: string) => records.find((record) => record.id === id));
    mocks.getProjectChatForExport.mockImplementation(async (projectId: string) => ({
      conversations: [{ id: `conv-${projectId}`, projectId, title: projectId, messageCount: 1,
        ...(projectId === SERIES_RECORD.id ? { workbenchTarget: { seriesId: SERIES_RECORD.id, episodeId: EPISODE_RECORD.id } } : {}) }],
      messages: [{ id: `msg-conv-${projectId}`, projectId, conversationId: `conv-${projectId}`,
        sequence: 1, content: '讨论', agentTaskId: 'old-task' }],
      memories: projectId === SERIES_RECORD.id ? [{
        id: 'series-memory', projectId, kind: 'fact', content: '记忆引用第一集讨论', enabled: true,
        source: { conversationId: `conv-${EPISODE_RECORD.id}`, messageId: `msg-conv-${EPISODE_RECORD.id}` },
        createdAt: 1, updatedAt: 1,
      }] : [],
    }));
    mocks.save.mockResolvedValue('/out/整部剧.aicanvas');
    mocks.open.mockResolvedValue('/out/整部剧.aicanvas');
    mockArchiveRoundTrip(['分集/a.png']);

    await exportProjectArchive(SERIES_RECORD.id);
    const result = (await importProjectArchive())!;

    expect(result.episodes.map((episode) => episode.episodeNo)).toEqual([1, 2]);
    expect(result.series).toEqual(SERIES_RECORD.series);
    expect(result.warnings).toEqual([]);
    expect(result.missingAssetCount).toBe(0);
    expect(result.conversationCount).toBe(3);
    expect(mocks.getProjectChatForExport.mock.calls).toEqual([
      [SERIES_RECORD.id, 100_000], [EPISODE_RECORD.id, 100_000], [second.id, 100_000],
    ]);
    expect(mocks.saveProject).toHaveBeenCalledTimes(3);
    const [root, first, next] = mocks.saveProject.mock.calls.map(([record]) => record);
    expect(root.nodes).toEqual([]);
    expect(root.series).toEqual(SERIES_RECORD.series);
    expect(first.parentId).toBe(result.projectId);
    expect(next.parentId).toBe(result.projectId);
    expect(first.dataFolder).toBe(result.dataFolder);
    expect(next.dataFolder).toBe(result.dataFolder);
    expect(first.episodeScript).toBe(EPISODE_RECORD.episodeScript);
    expect(first.episodeOutline).toBe(EPISODE_RECORD.episodeOutline);
    expect(first.episodeCreative).toEqual(EPISODE_RECORD.episodeCreative);
    expect(first.settings).toMatchObject(EPISODE_RECORD.settings);
    expect(first.snapshot).toBe(EPISODE_RECORD.snapshot);
    expect(first.edges).toEqual(EPISODE_RECORD.edges);
    expect(first.groups).toEqual(EPISODE_RECORD.groups);
    expect(first.nodes[0].data).toEqual({ prompt: '本集镜头', relativePath: '分集/a.png' });
    expect(first.dramaAssets).toBeUndefined();
    expect(root.dramaAssets).toMatchObject(SERIES_RECORD.dramaAssets);
    expect(result.episodes[0]).not.toHaveProperty('nodes');
    expect(result.episodes[0]).not.toHaveProperty('dramaAssets');
    for (const record of [root, first, next]) {
      expect(mocks.registerProjectFolder).toHaveBeenCalledWith(record.id, result.dataFolder);
    }
    const conversations = mocks.putChatConversation.mock.calls.map(([conversation]) => conversation);
    const messages = mocks.putChatMessage.mock.calls.map(([message]) => message);
    expect(conversations.map((conversation) => conversation.projectId)).toEqual([root.id, first.id, next.id]);
    expect(conversations[0].workbenchTarget).toEqual({ seriesId: root.id, episodeId: first.id });
    expect(messages.map((message) => message.conversationId)).toEqual(conversations.map((conversation) => conversation.id));
    expect(messages.map((message) => message.projectId)).toEqual([root.id, first.id, next.id]);
    expect(messages.every((message) => message.agentTaskId === undefined)).toBe(true);
    expect(result.memoryCount).toBe(1);
    expect(mocks.putProjectMemory.mock.calls[0][0]).toMatchObject({
      projectId: root.id, source: { conversationId: conversations[1].id, messageId: messages[1].id },
    });
  });

  it('detaches shared character, action, scene, prop and style media identities without losing relative paths', async () => {
    const base = {
      id: 'character', name: '主角', key: 'CHR', summary: '', visualNotes: '', identity: '',
      importance: 'main', confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual',
    };
    const reference = (relativePath: string) => ({ relativePath, assetId: 'source-asset' });
    const project = {
      ...SERIES_RECORD,
      settings: { visualStyle: { styleReference: { ...reference('style.png'), fileName: 'style.png', enabled: true } } },
      dramaAssets: {
        version: 2,
        characters: [{
          ...base, kind: 'character', ...reference('character.png'),
          referenceImages: [{ id: 'ref', kind: 'primary', ...reference('ref.png'), prompt: '', createdAt: 1, updatedAt: 1 }],
          voiceClips: [{ id: 'voice', kind: 'timbre', ...reference('voice.mp3'), transcript: '', createdAt: 1, updatedAt: 1 }],
          actions: [{ id: 'action', category: 'walking', name: '走路', prompt: '走路', createdAt: 1, updatedAt: 1,
            media: [{ id: 'action-media', kind: 'video', name: '走路视频', ...reference('action.mp4'), createdAt: 1, updatedAt: 1 }],
          }],
        }],
        scenes: [{ ...base, id: 'scene', kind: 'scene', ...reference('scene.png') }],
        props: [{ ...base, id: 'prop', kind: 'prop', ...reference('prop.png') }],
      },
    };
    mocks.open.mockResolvedValue('/in/共享资产.aicanvas');
    mocks.invoke.mockResolvedValue({ texts: archiveTexts({ project, chat: EMPTY_CHAT }), assetPaths: [], assetBytes: 0 });

    const result = (await importProjectArchive())!;

    expect(result.missingAssetCount).toBe(7);
    const saved = mocks.saveProject.mock.calls[0][0];
    const character = saved.dramaAssets.characters[0];
    const references = [
      saved.settings.visualStyle.styleReference, character, character.referenceImages[0], character.voiceClips[0],
      character.actions[0].media[0], saved.dramaAssets.scenes[0], saved.dramaAssets.props[0],
    ];
    expect(references.map((item) => item.relativePath)).toEqual([
      'style.png', 'character.png', 'ref.png', 'voice.mp3', 'action.mp4', 'scene.png', 'prop.png',
    ]);
    expect(references.every((item) => item.assetId === undefined)).toBe(true);
  });

  it.each([false, true])('按归档完整相对路径去重缺失文件，导入解除全局来源（首个文件存在=%s）', async (firstPresent) => {
    const visual = { name: '场景', key: 'scene', summary: '', visualNotes: '', importance: 'main',
      confirmed: true, source: 'manual', createdAt: 1, updatedAt: 1 };
    const project = { ...SERIES_RECORD, dramaAssets: { version: 2, characters: [], props: [], scenes: [
      { ...visual, id: 'global-scene', kind: 'scene', imageAssetId: 'same-source-id', imageRelativePath: 'left/same.png',
        referenceImages: [{ id: 'global-ref', label: '', prompt: '', assetId: 'same-source-id', assetSource: 'global',
          relativePath: 'left\\same.png', createdAt: 1, updatedAt: 1 }], primaryReferenceImageId: 'global-ref' },
      { ...visual, id: 'local-scene', kind: 'scene', assetId: 'same-source-id', relativePath: 'right/same.png' },
    ] } };
    mocks.open.mockResolvedValue('/in/共享资产.aicanvas');
    mocks.invoke.mockResolvedValue({ texts: archiveTexts({ project, chat: EMPTY_CHAT }),
      assetPaths: firstPresent ? ['left/same.png'] : [], assetBytes: firstPresent ? 1 : 0 });
    const result = (await importProjectArchive())!;
    expect(result.missingAssetCount).toBe(firstPresent ? 1 : 2);
    const saved = mocks.saveProject.mock.calls[0][0];
    const global = saved.dramaAssets.scenes[0];
    const local = saved.dramaAssets.scenes[1];
    expect(global.referenceImages[0].relativePath).toBe('left\\same.png');
    expect(global.referenceImages[0]).not.toHaveProperty('assetId');
    expect(global.referenceImages[0]).not.toHaveProperty('assetSource');
    expect(global).not.toHaveProperty('imageAssetId');
    expect(global).not.toHaveProperty('imageRelativePath');
    expect(local.relativePath).toBe('right/same.png');
    expect(local.assetId).toBeUndefined();
    expect(local.referenceImages[0].assetId).toBeUndefined();
  });

  it('导入分镜参考画面与成片快照时解除源资产身份并统计缺失视频', async () => {
    const reference = (relativePath: string) => ({ assetId: 'source-asset', relativePath });
    const project = { ...PROJECT_RECORD, nodes: [{ id: 'sheet', data: { type: 'ai-shotlist', shotlistRows: [{
      id: 'shot-1', shotNo: '1',
      frame: { nodeId: 'deleted-image', kind: 'image', ...reference('reference.png') },
      video: { nodeId: 'deleted-video', kind: 'video', ...reference('final.mp4'), sourceDuration: 5 },
    }] } }] };
    mocks.open.mockResolvedValue('/in/分镜成片.aicanvas');
    mocks.invoke.mockResolvedValue({ texts: archiveTexts({ project }), assetPaths: ['reference.png'], assetBytes: 1 });

    const result = (await importProjectArchive())!;

    expect(result.missingAssetCount).toBe(1);
    const row = mocks.saveProject.mock.calls[0][0].nodes[0].data.shotlistRows[0];
    expect(row.frame).toEqual({ nodeId: 'deleted-image', kind: 'image', relativePath: 'reference.png' });
    expect(row.video).toEqual({ nodeId: 'deleted-video', kind: 'video', relativePath: 'final.mp4', sourceDuration: 5 });
  });

  it('allocates independent project and episode ids on repeated import and includes episode missing assets', async () => {
    mocks.open.mockResolvedValue('/in/整部剧.aicanvas');
    mocks.invoke.mockResolvedValue({
      texts: archiveTexts({ project: SERIES_RECORD, episodes: [{ project: EPISODE_RECORD, chat: EMPTY_CHAT }] }),
      assetPaths: [], assetBytes: 0,
    });

    const first = (await importProjectArchive())!;
    const second = (await importProjectArchive())!;

    const ids = [first.projectId, first.episodes[0].id, second.projectId, second.episodes[0].id];
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain(SERIES_RECORD.id);
    expect(ids).not.toContain(EPISODE_RECORD.id);
    expect(first.episodes[0].parentId).toBe(first.projectId);
    expect(second.episodes[0].parentId).toBe(second.projectId);
    expect(first.dataFolder).not.toBe(second.dataFolder);
    expect(first.missingAssetCount).toBe(1);
    expect(second.missingAssetCount).toBe(1);
  });

  it.each([
    { name: '缺少分集', overrides: { manifest: { episodeCount: 1 } } },
    { name: '缺少数量', overrides: { manifest: { episodeCount: undefined } } },
    { name: '重复 ID', overrides: { episodes: [
      { project: EPISODE_RECORD, chat: EMPTY_CHAT }, { project: EPISODE_RECORD, chat: EMPTY_CHAT },
    ] } },
    { name: '错误归属', overrides: { episodes: [{ project: { ...EPISODE_RECORD, parentId: 'other-series' }, chat: EMPTY_CHAT }] } },
    { name: '损坏画布', overrides: { episodes: [{ project: { ...EPISODE_RECORD, edges: null }, chat: EMPTY_CHAT }] } },
    { name: '损坏对话', overrides: { episodes: [{ project: EPISODE_RECORD, chat: {} }] } },
    { name: '根记录仍有父级', overrides: { project: { ...SERIES_RECORD, parentId: 'source-parent' } } },
    { name: '清单 ID 不一致', overrides: { manifest: { projectId: 'wrong-id' } } },
  ])('rejects a v2 archive with $name before persisting any records', async ({ overrides }) => {
    mocks.open.mockResolvedValue('/in/损坏剧集.aicanvas');
    mocks.invoke.mockResolvedValue({ texts: archiveTexts({ project: SERIES_RECORD, ...overrides }), assetPaths: [], assetBytes: 0 });

    await expect(importProjectArchive()).rejects.toThrow();
    expect(mocks.saveProject).not.toHaveBeenCalled();
    expect(mocks.deleteProjectFromDb).not.toHaveBeenCalled();
    expect(mocks.deleteProjectDataDir).toHaveBeenCalledTimes(1);
  });

  it('整部剧及历史单事务失败时保留已冻结原操作素材，不逐条回滚或重分配身份', async () => {
    const chat = {
      ...EMPTY_CHAT,
      conversations: [{ id: 'episode-conv', projectId: EPISODE_RECORD.id }],
      messages: [{ id: 'episode-msg', conversationId: 'episode-conv', projectId: EPISODE_RECORD.id, sequence: 1 }],
    };
    mocks.open.mockResolvedValue('/in/整部剧.aicanvas');
    mocks.invoke.mockResolvedValue({
      texts: archiveTexts({ project: SERIES_RECORD, chat: EMPTY_CHAT, episodes: [{ project: EPISODE_RECORD, chat }] }),
      assetPaths: [], assetBytes: 0,
    });
    mocks.commitImport.mockRejectedValueOnce(new Error('整事务保存失败'));

    await expect(importProjectArchive()).rejects.toThrow('保存失败');
    expect(mocks.commitImport).toHaveBeenCalledOnce();
    const input = mocks.commitImport.mock.calls[0][0] as ProjectImportCommit;
    const createdIds = input.records.map((record) => record.id);
    expect(createdIds).toHaveLength(2);
    expect(input.history.map((row) => row.store)).toEqual(['chatConversations', 'chatMessages']);
    expect(mocks.saveProject).not.toHaveBeenCalled();
    expect(mocks.putChatConversation).not.toHaveBeenCalled();
    expect(mocks.putChatMessage).not.toHaveBeenCalled();
    expect(mocks.deleteProjectFromDb).not.toHaveBeenCalled();
    expect(createdIds).not.toContain(SERIES_RECORD.id);
    expect(createdIds).not.toContain(EPISODE_RECORD.id);
    expect(mocks.savePrepared).toHaveBeenCalledOnce();
    expect(mocks.savePrepared.mock.calls[0][1].commit.records.map((record: { id: string }) => record.id)).toEqual(createdIds);
    expect(mocks.deleteProjectDataDir).not.toHaveBeenCalled();
    expect(mocks.notifyProjectDiskChanged).not.toHaveBeenCalled();
  });

  it('目标分集不在归档时拒绝恢复工作台历史，不移除绑定后导入', async () => {
    mocks.invoke.mockResolvedValue({ texts: archiveTexts({ project: SERIES_RECORD, episodes: [], chat: {
      ...EMPTY_CHAT, conversations: [{ id: 'workbench', projectId: SERIES_RECORD.id,
        workbenchTarget: { seriesId: SERIES_RECORD.id, episodeId: 'missing-episode' } }],
    } }), assetPaths: [], assetBytes: 0 });
    await expect(restoreProjectArchive('/in/missing-target.aicanvas')).rejects.toThrow('无法恢复只读绑定');
    expect(mocks.putChatConversation).not.toHaveBeenCalled();
  });

  it('提交结果未知且原操作 marker 不可读时保留媒体，不推断未提交', async () => {
    mocks.open.mockResolvedValue('/in/整部剧.aicanvas');
    mocks.invoke.mockResolvedValue({ texts: archiveTexts(), assetPaths: [], assetBytes: 0 });
    mocks.commitImport.mockRejectedValueOnce(new Error('提交回执丢失'));
    mocks.readImport.mockRejectedValueOnce(new Error('marker 不可读'));

    await expect(importProjectArchive()).rejects.toMatchObject({ name: 'ProjectImportCommittedError', outcome: 'unknown',
      operationId: expect.any(String), ownerId: expect.any(String) });
    expect(mocks.commitImport).toHaveBeenCalledOnce();
    expect(mocks.deleteProjectFromDb).not.toHaveBeenCalled();
    expect(mocks.deleteProjectDataDir).not.toHaveBeenCalled();
  });

  it('原 marker 确认已提交时保留媒体，要求读取原操作而非再次导入', async () => {
    mocks.open.mockResolvedValue('/in/committed.aicanvas');
    mocks.invoke.mockResolvedValue({ texts: archiveTexts(), assetPaths: [], assetBytes: 0 });
    mocks.commitImport.mockRejectedValueOnce(new Error('提交回执丢失'));
    mocks.readImport.mockResolvedValueOnce({ phase: 'db_committed' });
    await expect(importProjectArchive()).rejects.toThrow('项目已提交');
    expect(mocks.commitImport).toHaveBeenCalledOnce();
    expect(mocks.deleteProjectFromDb).not.toHaveBeenCalled();
    expect(mocks.deleteProjectDataDir).not.toHaveBeenCalled();
    expect(mocks.notifyProjectDiskChanged).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps v1 compatibility and explains absent episode data (empty=%s)', async (empty) => {
    const project = empty ? SERIES_RECORD : PROJECT_RECORD;
    mocks.open.mockResolvedValue('/in/旧版.aicanvas');
    mocks.invoke.mockResolvedValue({
      texts: archiveTexts({ project, manifest: { formatVersion: 1, episodeCount: undefined }, chat: EMPTY_CHAT }),
      assetPaths: [], assetBytes: 0,
    });

    const result = (await importProjectArchive())!;

    expect(result.episodes).toEqual([]);
    expect(result.warnings).toHaveLength(empty ? 1 : 0);
    if (empty) expect(result.warnings[0]).toContain('请从原项目重新导出');
    expect(mocks.saveProject.mock.calls[0][0].nodes.map((node: { id: string }) => node.id))
      .toEqual(project.nodes.map((node) => node.id));
    expect(result.series).toEqual(empty ? SERIES_RECORD.series : undefined);
  });

  it('does not bind a legacy standalone episode to the source series on this machine', async () => {
    mocks.open.mockResolvedValue('/in/旧分集.aicanvas');
    mocks.invoke.mockResolvedValue({
      texts: archiveTexts({ project: EPISODE_RECORD, manifest: { formatVersion: 1, projectId: EPISODE_RECORD.id }, chat: EMPTY_CHAT }),
      assetPaths: [], assetBytes: 0,
    });

    const result = (await importProjectArchive())!;

    expect(mocks.saveProject.mock.calls[0][0].parentId).toBeUndefined();
    expect(result.warnings[0]).toContain('已作为独立项目导入');
  });

  it('counts only missing Director Scene/Result references and preserves both fields', async () => {
    const sceneRelativePath = `director/scenes/scene-main/scene-r1-${'a'.repeat(64)}.json`;
    const manifestRelativePath = `director/scenes/scene-main/results/manifest-r1-${'b'.repeat(64)}.json`;
    const project = {
      ...PROJECT_RECORD,
      nodes: [{
        id: 'director-1',
        data: {
          label: '3D 镜头台',
          type: 'ai-director',
          directorScene: {
            schemaVersion: 1,
            sceneId: 'scene-main',
            revision: 1,
            relativePath: sceneRelativePath,
            sha256: 'a'.repeat(64),
            bytes: 128,
          },
          directorResultManifest: {
            schemaVersion: 1,
            sceneId: 'scene-main',
            sceneRevision: 1,
            sceneSha256: 'a'.repeat(64),
            manifestRevision: 1,
            relativePath: manifestRelativePath,
            sha256: 'b'.repeat(64),
            bytes: 96,
          },
        },
      }],
    };
    mocks.open.mockResolvedValue('/in/director.aicanvas');
    mocks.invoke.mockResolvedValue({
      texts: archiveTexts({ project }),
      assetPaths: [sceneRelativePath],
      assetBytes: 128,
    });

    const result = await importProjectArchive();

    expect(result!.missingAssetCount).toBe(1);
    const saved = mocks.saveProject.mock.calls[0][0];
    expect(saved.nodes[0].data.directorScene).toEqual(project.nodes[0].data.directorScene);
    expect(saved.nodes[0].data.directorResultManifest).toEqual(
      project.nodes[0].data.directorResultManifest,
    );
  });

  it.each([true, false])('preserves previs references and counts absent scene files (present=%s)', async (present) => {
    const relativePath = `director/previs/${'c'.repeat(64)}.json`;
    const reference = { kind: 'project-file', relativePath, sha256: 'c'.repeat(64), bytes: 256 };
    const project = { ...PROJECT_RECORD, nodes: [{ id: 'previs-1', data: {
      type: 'ai-director', directorRuntimeKind: 'ai-threejs', directorPrevisScene: reference,
    } }] };
    mocks.open.mockResolvedValue('/in/previs.aicanvas');
    mocks.invoke.mockResolvedValue({ texts: archiveTexts({ project }), assetPaths: present ? [relativePath] : [], assetBytes: present ? 256 : 0 });
    const result = await importProjectArchive();
    expect(result!.missingAssetCount).toBe(present ? 0 : 1);
    expect(mocks.saveProject.mock.calls[0][0].nodes[0].data.directorPrevisScene).toEqual(reference);
  });

  it('does not infer new Director references from legacy capture arrays', async () => {
    const project = {
      ...PROJECT_RECORD,
      nodes: [{
        id: 'director-legacy',
        data: {
          label: '3D 导演台',
          type: 'ai-director',
          directorCaptureUrls: ['asset://localhost/frame-a.png'],
          directorCaptureFilePaths: ['C:/legacy/frame-a.png'],
        },
      }],
    };
    mocks.open.mockResolvedValue('/in/legacy-director.aicanvas');
    mocks.invoke.mockResolvedValue({
      texts: archiveTexts({ project }),
      assetPaths: [],
      assetBytes: 0,
    });

    const result = await importProjectArchive();

    expect(result!.missingAssetCount).toBe(0);
    const savedData = mocks.saveProject.mock.calls[0][0].nodes[0].data;
    expect(savedData.directorCaptureUrls).toEqual([]);
    expect(savedData.directorCaptureFilePaths).toBeUndefined();
    expect(savedData.directorScene).toBeUndefined();
    expect(savedData.directorResultManifest).toBeUndefined();
  });

  it('duplicates a project through a temp archive and clones its episodes', async () => {
    mocks.getBaseDir.mockResolvedValue('/custom-media-root');
    const EPISODE = {
      ...PROJECT_RECORD,
      id: 'episode-1',
      name: '第 1 集',
      parentId: 'source-project',
      episodeNo: 1,
    };
    mocks.getProjectById.mockImplementation(async (id: string) => (
      id === 'episode-1' ? EPISODE : PROJECT_RECORD
    ));
    mocks.getAllProjects.mockResolvedValue([PROJECT_RECORD, EPISODE]);
    mockArchiveRoundTrip(['镜头1/a.png']);

    const result = await duplicateProjectArchive('source-project', '分镜项目 副本');

    expect(result.projectId).not.toBe('source-project');
    expect(result.projectName).toBe('分镜项目 副本');
    // 副本目录名跟着副本名走，不能和源项目共用同一个素材目录
    expect(result.dataFolder).toContain('分镜项目 副本');
    expect(mocks.mkdir).toHaveBeenCalledWith('/app-owned/data', { recursive: true });
    expect(mocks.invoke.mock.calls.find(([name]) => name === 'pack_project_archive')![1].outputPath).toMatch(/^\/app-owned\/data\/duplicate-[^/]+\.aicanvas$/);
    expect(mocks.invoke.mock.calls.find(([name]) => name === 'pack_project_archive')![1].operationId).toBeUndefined();
    expect(mocks.prepareExport).not.toHaveBeenCalled();
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
    // 临时归档无论成败都要删掉，否则数据目录里会堆积复制残留
    expect(mocks.remove).toHaveBeenCalledWith(mocks.invoke.mock.calls.find(([name]) => name === 'pack_project_archive')![1].outputPath);

    expect(result.episodes).toHaveLength(1);
    const episode = result.episodes[0];
    expect(episode.id).not.toBe('episode-1');
    expect(episode.parentId).toBe(result.projectId);
    // 分集共用剧集素材目录，必须跟着副本的新目录走
    expect(episode.dataFolder).toBe(result.dataFolder);
    const savedEpisode = mocks.saveProject.mock.calls[1][0];
    expect(savedEpisode.id).toBe(episode.id);
    expect(savedEpisode.nodes[0].data.assetId).toBeUndefined();
  });

  it('removes the temp archive when packing fails', async () => {
    mocks.getProjectById.mockResolvedValue(PROJECT_RECORD);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'inspect_project_archive_assets') return [];
      if (command === 'pack_project_archive') throw new Error('磁盘已满');
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(duplicateProjectArchive('source-project', '副本')).rejects.toThrow('磁盘已满');
    expect(mocks.invoke).toHaveBeenCalledWith('pack_project_archive', expect.any(Object));
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(mocks.invoke.mock.calls.find(([name]) => name === 'pack_project_archive')![1].outputPath);
    expect(mocks.saveProject).not.toHaveBeenCalled();
  });

  it('fails before packing when the application temporary directory cannot be created', async () => {
    mocks.mkdir.mockRejectedValue(new Error('应用目录不可写'));
    await expect(duplicateProjectArchive('source-project', '副本')).rejects.toThrow('应用目录不可写');
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.saveProject).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('keeps the staging folder name when renaming the data directory fails', async () => {
    mocks.open.mockResolvedValue('/in/分镜项目.aicanvas');
    mocks.invoke.mockResolvedValue({ texts: archiveTexts(), assetPaths: [], assetBytes: 0 });
    mocks.renameProjectDataDir.mockResolvedValue(null);

    const result = await importProjectArchive();

    // 记录里的 dataFolder 必须跟磁盘上的实际目录一致，否则重启后找不到素材
    expect(result!.dataFolder).toContain('导入中-');
    expect(mocks.saveProject.mock.calls[0][0].dataFolder).toBe(result!.dataFolder);
    expect(mocks.registerProjectFolder).toHaveBeenLastCalledWith(result!.projectId, result!.dataFolder);
  });

  it('rejects archives from a newer format and cleans up the staging directory', async () => {
    mocks.open.mockResolvedValue('/in/future.aicanvas');
    mocks.invoke.mockResolvedValue({
      texts: archiveTexts({ manifest: { formatVersion: PROJECT_ARCHIVE_FORMAT_VERSION + 1 } }),
      assetPaths: [],
      assetBytes: 0,
    });
    mocks.deleteProjectDataDir.mockResolvedValue(undefined);

    await expect(importProjectArchive()).rejects.toThrow('请先升级应用');
    expect(mocks.saveProject).not.toHaveBeenCalled();
    expect(mocks.deleteProjectDataDir).toHaveBeenCalledTimes(1);
  });

  it('returns null when the import dialog is cancelled', async () => {
    mocks.open.mockResolvedValue(null);

    await expect(importProjectArchive()).resolves.toBeNull();
    expect(mocks.ensureProjectDataDir).not.toHaveBeenCalled();
  });

  it('冻结/新模型状态在导出、复制和旧恢复文件effect之前拒绝，不生成临时材料', async () => {
    mocks.legacyWriteGuard.mockRejectedValue(new Error('旧项目写入已停止'));
    await expect(exportProjectArchive('source-project')).rejects.toThrow('旧项目写入已停止');
    await expect(duplicateProjectArchive('source-project', '副本')).rejects.toThrow('旧项目写入已停止');
    await expect(restoreProjectArchive('/fixture/legacy.aicanvas')).rejects.toThrow('旧项目写入已停止');
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.registerProjectFolder).not.toHaveBeenCalled(); expect(mocks.ensureProjectDataDir).not.toHaveBeenCalled();
    expect(mocks.saveProject).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
});
