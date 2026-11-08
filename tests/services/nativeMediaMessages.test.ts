/** 新库产物对原消息的投影；不打开真实数据库或文件。 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/types/chat';
const fixture = vi.hoisted(() => ({ active: true,
  messages: [] as Array<Partial<ChatMessage> & { id: string; conversationId: string }>,
  update: vi.fn(), read: vi.fn(), exists: vi.fn(async () => true) }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ messages: fixture.messages, updateMessage: fixture.update }) } }));
vi.mock('../../src/services/projectExecutionContext', () => ({
  captureLegacyCanvasContext: () => ({ modelGeneration: 1, projectId: 'project', canvasId: 'canvas', episodeId: 'episode', projectEpoch: 2, canvasEpoch: 3 }),
  isProjectExpectedContextCurrent: () => fixture.active,
}));
vi.mock('../../src/services/indexedDb/nativeMediaTaskRepository', () => ({ listNativeMediaTasks: fixture.read }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: fixture.exists }));
vi.mock('../../src/services/fileService', () => ({ getProjectDataDir: async () => '/fixture', joinPath: (...parts: string[]) => parts.join('/') }));
vi.mock('../../src/services/fs/core', () => ({ getAssetUrlFromPath: async (path: string) => `fixture:${path}` }));
import { projectNativeMediaMessages } from '../../src/services/nativeMediaMessages';

beforeEach(() => {
  vi.clearAllMocks(); fixture.active = true; fixture.exists.mockResolvedValue(true);
  fixture.messages = [{ id: 'original-message', conversationId: 'original-conversation', agentTaskId: 'original-agent' }];
  fixture.update.mockImplementation((id: string, patch: Partial<ChatMessage>) => Object.assign(fixture.messages.find((row) => row.id === id)!, patch));
  fixture.read.mockResolvedValue([{ operationId: 'operation', ownerProjectId: 'project', canvasId: 'canvas', episodeId: 'episode',
    projectEpoch: 2, canvasEpoch: 3, status: 'delivered', resultRelativePath: 'media/result.mp4', category: 'video',
    providerConfigId: 'provider', createdAt: 5,
    origin: { conversationId: 'original-conversation', messageId: 'original-message', agentTaskId: 'original-agent', deliveryMode: 'chat' } }]);
});
it('按原消息身份补投影并幂等，不创建画布节点', async () => {
  await projectNativeMediaMessages('original-conversation');
  await projectNativeMediaMessages('original-conversation');
  expect(fixture.update).toHaveBeenCalledTimes(1);
  expect(fixture.messages[0]).toMatchObject({ mediaStatus: 'succeeded', canvasStatus: 'none',
    mediaResult: { id: 'native-media-operation', persistence: 'saved', deliveryMode: 'chat' } });
});
it('读取期间切集或当前为另一会话时不写入消息', async () => {
  fixture.exists.mockImplementationOnce(async () => { fixture.active = false; return true; });
  await projectNativeMediaMessages('original-conversation');
  expect(fixture.update).not.toHaveBeenCalled();
  fixture.active = true; await projectNativeMediaMessages('another-conversation');
  expect(fixture.update).not.toHaveBeenCalled();
});
