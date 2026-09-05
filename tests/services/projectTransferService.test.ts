import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  getProjectById: vi.fn(),
  saveProject: vi.fn(),
  getProjectConversations: vi.fn(),
  getConversationMessages: vi.fn(),
  getProjectMemories: vi.fn(),
  putChatConversation: vi.fn(),
  putChatMessage: vi.fn(),
  putProjectMemory: vi.fn(),
  isTauriEnv: vi.fn(() => true),
  ensureProjectDataDir: vi.fn(),
  renameProjectDataDir: vi.fn(),
  registerProjectFolder: vi.fn(),
  deleteProjectDataDir: vi.fn(),
  notifyProjectDiskChanged: vi.fn(),
  getBaseDir: vi.fn(async () => '/data'),
  remove: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open, save: mocks.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ remove: mocks.remove }));
vi.mock('../../src/services/indexedDbService', () => ({
  getProjectById: mocks.getProjectById,
  getProjectConversations: mocks.getProjectConversations,
  getConversationMessages: mocks.getConversationMessages,
  getProjectMemories: mocks.getProjectMemories,
  putChatConversation: mocks.putChatConversation,
  putChatMessage: mocks.putChatMessage,
  putProjectMemory: mocks.putProjectMemory,
}));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: mocks.isTauriEnv,
  ensureProjectDataDir: mocks.ensureProjectDataDir,
  renameProjectDataDir: mocks.renameProjectDataDir,
  registerProjectFolder: mocks.registerProjectFolder,
  deleteProjectDataDir: mocks.deleteProjectDataDir,
  notifyProjectDiskChanged: mocks.notifyProjectDiskChanged,
  getBaseDir: mocks.getBaseDir,
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

function archiveTexts(overrides: Record<string, unknown> = {}) {
  return {
    'manifest.json': JSON.stringify({
      formatVersion: PROJECT_ARCHIVE_FORMAT_VERSION,
      exportedAt: 1,
      projectId: 'source-project',
      projectName: '分镜项目',
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
  };
}

describe('projectTransferService', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.getVersion.mockResolvedValue('0.6.13');
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
    mocks.remove.mockResolvedValue(undefined);
  });

  it('packs the project record, chat payload and asset directory', async () => {
    mocks.getProjectById.mockResolvedValue(PROJECT_RECORD);
    mocks.getProjectConversations.mockResolvedValue([{ id: 'conv-1' }]);
    mocks.getConversationMessages.mockResolvedValue({
      messages: [{ id: 'm2', sequence: 2 }, { id: 'm1', sequence: 1 }],
      total: 2,
    });
    mocks.getProjectMemories.mockResolvedValue([{ id: 'mem-1' }]);
    mocks.ensureProjectDataDir.mockResolvedValue('/data/分镜项目-source12');
    mocks.save.mockResolvedValue('/out/分镜项目.aicanvas');
    mocks.invoke.mockResolvedValue({ assetCount: 3, assetBytes: 10, archiveBytes: 8 });

    const result = await exportProjectArchive('source-project');

    expect(result).toEqual({ filePath: '/out/分镜项目.aicanvas', assetCount: 3, archiveBytes: 8 });
    const [command, args] = mocks.invoke.mock.calls[0];
    expect(command).toBe('pack_project_archive');
    expect(args.assetsDir).toBe('/data/分镜项目-source12');
    expect(args.outputPath).toBe('/out/分镜项目.aicanvas');

    const entries = args.entries as { path: string; content: string }[];
    expect(entries.map((entry) => entry.path)).toEqual(['manifest.json', 'project.json', 'chat.json']);
    const chat = JSON.parse(entries[2].content);
    // 归档内消息按 sequence 升序，保证导入后时间线顺序稳定
    expect(chat.messages.map((message: { id: string }) => message.id)).toEqual(['m1', 'm2']);
  });

  it('does not pack anything when the save dialog is cancelled', async () => {
    mocks.getProjectById.mockResolvedValue(PROJECT_RECORD);
    mocks.getProjectConversations.mockResolvedValue([]);
    mocks.getProjectMemories.mockResolvedValue([]);
    mocks.save.mockResolvedValue(null);

    await expect(exportProjectArchive('source-project')).resolves.toBeNull();
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
    expect(savedData.directorCaptureUrls).toEqual(project.nodes[0].data.directorCaptureUrls);
    expect(savedData.directorCaptureFilePaths).toEqual(project.nodes[0].data.directorCaptureFilePaths);
    expect(savedData.directorScene).toBeUndefined();
    expect(savedData.directorResultManifest).toBeUndefined();
  });

  it('duplicates a project through a temp archive and clones its episodes', async () => {
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
    mocks.getProjectConversations.mockResolvedValue([]);
    mocks.getProjectMemories.mockResolvedValue([]);
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'pack_project_archive'
        ? { assetCount: 1, assetBytes: 12, archiveBytes: 8 }
        : { texts: archiveTexts(), assetPaths: ['镜头1/a.png'], assetBytes: 12 }
    ));

    const result = await duplicateProjectArchive('source-project', '分镜项目 副本', ['episode-1']);

    expect(result.projectId).not.toBe('source-project');
    expect(result.projectName).toBe('分镜项目 副本');
    // 副本目录名跟着副本名走，不能和源项目共用同一个素材目录
    expect(result.dataFolder).toContain('分镜项目 副本');
    expect(mocks.invoke.mock.calls[0][1].outputPath).toContain('.duplicate-');
    // 临时归档无论成败都要删掉，否则数据目录里会堆积复制残留
    expect(mocks.remove).toHaveBeenCalledWith(mocks.invoke.mock.calls[0][1].outputPath);

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
    mocks.getProjectConversations.mockResolvedValue([]);
    mocks.getProjectMemories.mockResolvedValue([]);
    mocks.invoke.mockRejectedValue(new Error('磁盘已满'));

    await expect(duplicateProjectArchive('source-project', '副本')).rejects.toThrow('磁盘已满');
    expect(mocks.remove).toHaveBeenCalledTimes(1);
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
});
