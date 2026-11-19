/** 新库产物对原消息的投影；不打开真实数据库或文件。 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/types/chat';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';

const op = '11111111-1111-4111-8111-111111111111';
const anotherOp = '22222222-2222-4222-8222-222222222222';
const fixture = vi.hoisted(() => ({
  active: true,
  messages: [] as ChatMessage[],
  conversations: [] as Array<{ id: string; projectId: string; messageCount: number }>,
  update: vi.fn(), read: vi.fn(), readProjection: vi.fn(), projectBatch: vi.fn(),
  setMessages: vi.fn(), lstat: vi.fn<(path: string) => Promise<{ isDirectory: boolean; isFile: boolean; isSymlink: boolean; size: number }>>(),
  root: vi.fn(async () => '/fixture'), subroot: vi.fn(async () => '/original-subroot'),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({
  messages: fixture.messages, conversations: fixture.conversations, updateMessage: fixture.update, setMessages: fixture.setMessages,
}) } }));
vi.mock('../../src/services/projectExecutionContext', () => ({
  captureLegacyCanvasContext: () => ({ modelGeneration: 1, projectId: 'project', canvasId: 'canvas', episodeId: 'episode', projectEpoch: 2, canvasEpoch: 3 }),
  isProjectExpectedContextCurrent: () => fixture.active,
}));
vi.mock('../../src/services/indexedDb/nativeMediaTaskRepository', () => ({ readNativeMediaMessageTasks: fixture.read }));
vi.mock('../../src/services/chat/chatHistoryService', () => ({
  loadNativeMediaMessageProjection: fixture.readProjection, projectNativeMediaMessageBatch: fixture.projectBatch,
}));
vi.mock('../../src/services/chat/conversationProjectScope', () => ({
  isRegisteredNativeConversationAlias: (project: string, id: string) => project === 'project' && id === 'retired-canvas',
}));
vi.mock('@tauri-apps/plugin-fs', () => ({ lstat: fixture.lstat }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.subroot }));
vi.mock('../../src/services/fileService', () => ({ getProjectDataDir: fixture.root, joinPath: (...parts: string[]) => parts.join('/') }));
vi.mock('../../src/services/fs/core', () => ({ getAssetUrlFromPath: async (path: string) => `fixture:${path}`,
  joinPath: (...parts: string[]) => parts.join('/') }));
import { projectNativeMediaMessages } from '../../src/services/nativeMediaMessages';

const root: ChatMessage = { id: 'original-message', conversationId: 'original-conversation', role: 'assistant',
  agentTaskId: 'original-agent', content: '', timestamp: 5, status: 'done' };
const receipt = (overrides: Partial<NativeMediaTaskRecord> = {}) => ({
  operationId: op, ownerProjectId: 'project', canvasId: 'canvas', episodeId: 'episode', projectEpoch: 2, canvasEpoch: 3,
  status: 'delivered', resultRelativePath: 'media/result.mp4', category: 'video', providerConfigId: 'provider', createdAt: 5,
  origin: { conversationId: 'original-conversation', messageId: 'original-message', agentTaskId: 'original-agent', deliveryMode: 'chat' },
  ...overrides,
}) as NativeMediaTaskRecord;
const saved = (id: string, sourceUrl: string, operationId = op, ordinal = 0): ChatMessage => ({
  ...root, id, mediaStatus: 'succeeded',
  mediaResult: { id: `native-media-${operationId}${ordinal ? `-${ordinal}` : ''}`, kind: 'video', deliveryMode: 'chat',
    url: sourceUrl, sourceUrl, persistence: 'saved', prompt: '', modelId: 'model', provider: 'provider', createdAt: 5 },
});
const stats = (path: string) => ({ isDirectory: path.endsWith('/media'), isFile: !path.endsWith('/media'), isSymlink: false, size: 5 });

beforeEach(() => {
  vi.clearAllMocks(); fixture.active = true; fixture.lstat.mockReset(); fixture.lstat.mockImplementation(async (path) => stats(path));
  fixture.messages = [{ ...root }];
  fixture.conversations = [{ id: root.conversationId, projectId: 'project', messageCount: 1 }];
  fixture.setMessages.mockImplementation((messages: ChatMessage[]) => { fixture.messages = messages; });
  fixture.update.mockImplementation((id: string, patch: Partial<ChatMessage>) => Object.assign(fixture.messages.find((row) => row.id === id)!, patch));
  fixture.read.mockResolvedValue({ records: [receipt()] });
  fixture.readProjection.mockReset();
  fixture.projectBatch.mockReset();
});
it('按原消息身份补投影并幂等，不创建画布节点', async () => {
  await projectNativeMediaMessages('original-conversation');
  await projectNativeMediaMessages('original-conversation');
  expect(fixture.update).toHaveBeenCalledTimes(1);
  expect(fixture.messages[0]).toMatchObject({ mediaStatus: 'succeeded', canvasStatus: 'none',
    mediaResult: { id: `native-media-${op}`, persistence: 'saved', deliveryMode: 'chat' } });
});
it('读取期间切集或当前为另一会话时不写入消息', async () => {
  fixture.lstat.mockImplementationOnce(async (path) => { fixture.active = false; return stats(path); });
  await projectNativeMediaMessages('original-conversation');
  expect(fixture.update).not.toHaveBeenCalled();
  fixture.active = true; await projectNativeMediaMessages('another-conversation');
  expect(fixture.update).not.toHaveBeenCalled();
});
it('从原分集根水化已交付消息，包括已登记的退役画布会话，且不改持久消息', async () => {
  const originalRootRef = 'r2-33333333-3333-4333-8333-333333333333';
  fixture.conversations[0].projectId = 'retired-canvas';
  fixture.messages = [saved(root.id, 'media/result.mp4')];
  fixture.read.mockResolvedValue({ records: [receipt({ canvasId: 'another-canvas', episodeId: 'another-episode', resultRootRef: originalRootRef })],
    project: { id: 'project', storageRootRef: 'r2-44444444-4444-4444-8444-444444444444', storageBindings: [{ rootRef: originalRootRef }] } });
  await projectNativeMediaMessages(root.conversationId);
  expect(fixture.subroot).toHaveBeenCalledWith('resolve_native_project_media_subroot',
    { projectId: 'project', rootRef: originalRootRef, create: false });
  expect(fixture.read).toHaveBeenCalledWith('project', 'canvas',
    [{ conversationId: root.conversationId, messageId: root.id, artifactId: `native-media-${op}` }]);
  expect(fixture.messages[0].mediaResult).toMatchObject({ url: 'fixture:/original-subroot/media/result.mp4', sourceUrl: 'media/result.mp4' });
  expect(fixture.update).not.toHaveBeenCalled();
});
it('另一集的缺失旧候选不会挡住同批及后续媒体，也不会补投影旧消息', async () => {
  const surviving = `media-output-native-media-${op}-1`;
  const paths = ['a', 'b'].map((letter) => `media/${letter.repeat(64)}.mp4`);
  const old = [saved(root.id, paths[0]), saved(surviving, paths[1], op, 1)];
  fixture.messages = [...old, saved('new-message', 'media/result.mp4', anotherOp)];
  fixture.read.mockResolvedValue({ records: [
    receipt({ canvasId: 'another-canvas', episodeId: 'another-episode', resultRelativePath: paths[0],
      localResults: paths.map((relativePath, index) => ({ category: 'video', relativePath, bytes: 5, sha256: (index ? 'b' : 'a').repeat(64) })) }),
    receipt({ operationId: anotherOp, origin: { ...receipt().origin!, messageId: 'new-message' } }),
  ] });
  fixture.readProjection.mockResolvedValue(old);
  fixture.lstat.mockImplementation(async (path) => { if (path.endsWith(paths[0])) throw new Error('missing'); return stats(path); });
  await projectNativeMediaMessages(root.conversationId);
  expect(fixture.messages.map((message) => message.mediaResult?.url)).toEqual([
    paths[0], `fixture:/fixture/${paths[1]}`, 'fixture:/fixture/media/result.mp4',
  ]);
  expect(fixture.projectBatch).not.toHaveBeenCalled();
  expect(fixture.update).not.toHaveBeenCalled();
});
