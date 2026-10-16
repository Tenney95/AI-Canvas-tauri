import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  getAllProjects: vi.fn(),
  getProjectById: vi.fn(),
  deleteProjectFromDb: vi.fn(),
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
  getAllProjects: mocks.getAllProjects,
  getProjectById: mocks.getProjectById,
  deleteProjectFromDb: mocks.deleteProjectFromDb,
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
  mocks.invoke.mockImplementation(async (command: string, args: { entries?: { path: string; content: string }[] }) => {
    if (command === 'pack_project_archive') {
      texts = Object.fromEntries(args.entries!.map((entry) => [entry.path, entry.content]));
      return { assetCount: assetPaths.length, assetBytes: 12, archiveBytes: 8 };
    }
    return { texts, assetPaths, assetBytes: 12 };
  });
}

describe('projectTransferService', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.isTauriEnv.mockReturnValue(true);
    mocks.getVersion.mockResolvedValue('0.6.13');
    mocks.getAllProjects.mockResolvedValue([]);
    mocks.deleteProjectFromDb.mockResolvedValue(undefined);
    mocks.deleteProjectDataDir.mockResolvedValue(undefined);
    mocks.getProjectConversations.mockResolvedValue([]);
    mocks.getConversationMessages.mockResolvedValue({ messages: [], total: 0 });
    mocks.getProjectMemories.mockResolvedValue([]);
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

    expect(result).toEqual({ filePath: '/out/分镜项目.aicanvas', assetCount: 3, archiveBytes: 8, episodeCount: 0 });
    const [command, args] = mocks.invoke.mock.calls[0];
    expect(command).toBe('pack_project_archive');
    expect(args.assetsDir).toBe('/data/分镜项目-source12');
    expect(args.outputPath).toBe('/out/分镜项目.aicanvas');

    const entries = args.entries as { path: string; content: string }[];
    expect(entries.map((entry) => entry.path)).toEqual(['manifest.json', 'project.json', 'chat.json']);
    expect(JSON.parse(entries[0].content)).toMatchObject({ formatVersion: 2, episodeCount: 0 });
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

  it('exports all episodes in order with one shared asset directory, including an episode entry point', async () => {
    const second = { ...EPISODE_RECORD, id: 'episode-2', name: '第 2 集', episodeNo: 2 };
    const unrelated = { ...EPISODE_RECORD, id: 'other-episode', parentId: 'other-series' };
    const records = [SERIES_RECORD, second, unrelated, EPISODE_RECORD];
    mocks.getAllProjects.mockResolvedValue(records);
    mocks.getProjectById.mockImplementation(async (id: string) => records.find((record) => record.id === id));
    mocks.save.mockResolvedValue('/out/整部剧.aicanvas');
    mocks.invoke.mockResolvedValue({ assetCount: 1, assetBytes: 12, archiveBytes: 8 });

    const result = await exportProjectArchive(EPISODE_RECORD.id);

    expect(result!.episodeCount).toBe(2);
    expect(mocks.ensureProjectDataDir).toHaveBeenCalledExactlyOnceWith(SERIES_RECORD.id);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const entries = mocks.invoke.mock.calls[0][1].entries as { path: string; content: string }[];
    const texts = Object.fromEntries(entries.map((entry) => [entry.path, entry.content]));
    expect(JSON.parse(texts['manifest.json'])).toMatchObject({ formatVersion: 2, episodeCount: 2 });
    expect(JSON.parse(texts['episodes.json']).map((episode: { project: { id: string } }) => episode.project.id))
      .toEqual(['episode-1', 'episode-2']);
    expect(mocks.getProjectConversations.mock.calls.map(([id]) => id)).toEqual([
      SERIES_RECORD.id, 'episode-1', 'episode-2',
    ]);
  });

  it.each(['分集读取', '对话读取', '素材目录'])('fails export instead of silently omitting unavailable %s', async (stage) => {
    mocks.getProjectById.mockResolvedValue(SERIES_RECORD);
    mocks.save.mockResolvedValue('/out/整部剧.aicanvas');
    if (stage === '分集读取') {
      mocks.getAllProjects.mockResolvedValue([EPISODE_RECORD]);
      mocks.getProjectById.mockImplementation(async (id: string) => id === SERIES_RECORD.id ? SERIES_RECORD : undefined);
    } else if (stage === '对话读取') {
      mocks.getProjectConversations.mockRejectedValue(new Error('对话读取失败'));
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
    mocks.getProjectConversations.mockImplementation(async (projectId: string) => [{
      id: `conv-${projectId}`, projectId, title: projectId, messageCount: 1,
    }]);
    mocks.getConversationMessages.mockImplementation(async (conversationId: string) => ({
      messages: [{ id: `msg-${conversationId}`, conversationId, sequence: 1, content: '讨论', agentTaskId: 'old-task' }],
      total: 1,
    }));
    mocks.getProjectMemories.mockImplementation(async (projectId: string) => projectId === SERIES_RECORD.id ? [{
      id: 'series-memory', projectId, kind: 'fact', content: '记忆引用第一集讨论', enabled: true,
      source: { conversationId: `conv-${EPISODE_RECORD.id}`, messageId: `msg-conv-${EPISODE_RECORD.id}` },
      createdAt: 1, updatedAt: 1,
    }] : []);
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

  it.each(['项目保存', '对话保存'])('cleans up only newly created records when episode %s fails', async (stage) => {
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
    if (stage === '项目保存') {
      mocks.saveProject.mockImplementationOnce(async (record: { id: string }) => record.id)
        .mockRejectedValueOnce(new Error('分集保存失败'));
    } else {
      mocks.putChatMessage.mockRejectedValueOnce(new Error('对话保存失败'));
    }

    await expect(importProjectArchive()).rejects.toThrow('保存失败');
    const createdIds = mocks.saveProject.mock.calls.map(([record]) => record.id);
    expect(mocks.deleteProjectFromDb.mock.calls.map(([id]) => id)).toEqual([...createdIds].reverse());
    expect(createdIds).not.toContain(SERIES_RECORD.id);
    expect(createdIds).not.toContain(EPISODE_RECORD.id);
    expect(mocks.deleteProjectDataDir).toHaveBeenCalledExactlyOnceWith(createdIds[0]);
    expect(mocks.notifyProjectDiskChanged).not.toHaveBeenCalled();
  });

  it('retains assets and reports incomplete cleanup when database rollback fails', async () => {
    mocks.open.mockResolvedValue('/in/整部剧.aicanvas');
    mocks.invoke.mockResolvedValue({ texts: archiveTexts(), assetPaths: [], assetBytes: 0 });
    mocks.putChatMessage.mockRejectedValueOnce(new Error('保存失败'));
    mocks.deleteProjectFromDb.mockRejectedValue(new Error('清理失败'));

    await expect(importProjectArchive()).rejects.toThrow('已保留素材');
    expect(mocks.deleteProjectDataDir).not.toHaveBeenCalled();
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
    mocks.getAllProjects.mockResolvedValue([PROJECT_RECORD, EPISODE]);
    mocks.getProjectConversations.mockResolvedValue([]);
    mocks.getProjectMemories.mockResolvedValue([]);
    mockArchiveRoundTrip(['镜头1/a.png']);

    const result = await duplicateProjectArchive('source-project', '分镜项目 副本');

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
