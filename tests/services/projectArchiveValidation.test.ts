/** 归档隐私与旧包输入边界；使用真实可移植适配器。 */
import { describe, expect, it } from 'vitest';
import { portableArchiveChat, sanitizeLegacyArchiveProject, selectArchiveAssets, selectArchiveImportPaths } from '../../src/services/projectArchiveValidation';
import { captureExchangeSnapshot } from '../../src/services/projectExchangeDomain';
import type { ProjectSaveData } from '../../src/services/storageService';
import type { ProjectArchiveChatPayload } from '../../src/services/projectTransferService';
import type { ProjectExchangeState } from '../../src/types/projectExchange';

const project = (data: Record<string, unknown> = {}): ProjectSaveData => ({ id: 'root', name: '项目',
  nodes: [{ id: 'node', type: 'source-image', position: { x: 0, y: 0 }, data }], edges: [], groups: [], createdAt: 1, updatedAt: 1 });

describe('项目归档输入与导出边界', () => {
  it('扫描范围采用活身份和当前引用，排除恢复点、失败残留及删除墓碑', () => {
    const files = ['imports/old/附件.txt', 'imports/deleted/旧图.png'].map((path) => ({ path, bytes: 1, sha256: 'a'.repeat(64) }));
    const baseline = captureExchangeSnapshot([project()], files.map((file) => ({ ...file, path: file.path.replace('imports/', '原稿/') })), null);
    const identities = baseline.identities.map((identity) => identity.kind === 'file'
      ? { ...identity, localId: identity.localId.replace('原稿/', 'imports/') } : identity);
    const removed = identities.find((identity) => identity.kind === 'file' && identity.localId.includes('deleted'))!;
    const head = { ...baseline.snapshot, entities: baseline.snapshot.entities.filter((entity) => entity.id !== removed.id) };
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: head.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities };
    const current = project({ relativePath: 'imports/current/当前.png', filePath: '/project/imports/stale/旧投影.png',
      videoReferences: [{ relativePath: 'imports/reference/参考.png' }], directorCaptureRelativePaths: ['imports/capture/摄影机.png'],
      other: { filePath: '/project/imports/native/原生.png' }, prompt: 'imports/prompt/这不是引用.txt' });
    expect(selectArchiveImportPaths([current], state, head, '/project')).toEqual([
      'imports/capture/摄影机.png', 'imports/current/当前.png', 'imports/native/原生.png', 'imports/old/附件.txt', 'imports/reference/参考.png',
    ]);
  });

  it('首次建立来源也只选择记录中明确引用的内部文件，并兼容 Windows 原生与相对路径', () => {
    const current = project({ filePath: 'C:\\Project\\imports\\current\\原图.png', nested: { filePath: 'imports/relative/附件.txt' },
      outside: { filePath: 'D:\\Other\\imports\\外部.png' }, directorCaptureRelativePaths: ['C:\\Project\\imports\\capture\\截图.png'] });
    expect(selectArchiveImportPaths([current], null, undefined, 'c:/project/')).toEqual([
      'imports/capture/截图.png', 'imports/current/原图.png', 'imports/relative/附件.txt',
    ]);
    expect(selectArchiveImportPaths([project({ relativePath: '附件/普通文件.md' })], null, undefined, '/project')).toEqual([]);
  });

  it.each(['Imports', 'IMPORTS'])('%s 首段按内部目录选择且保留真实相对路径拼写', (directory) => {
    const path = `${directory}/current/当前.png`;
    const current = project({ relativePath: path, nested: { filePath: `C:/Project/${directory}/reference/参考.png` } });
    expect(selectArchiveImportPaths([current], null, undefined, 'C:/Project')).toEqual([
      path, `${directory}/reference/参考.png`,
    ]);
    const captured = captureExchangeSnapshot([project({ relativePath: path })], [{ path, bytes: 1, sha256: 'a'.repeat(64) }], null);
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    expect(selectArchiveImportPaths([project()], state, captured.snapshot, 'C:/Project')).toEqual([path]);
  });

  it('主媒体仅有原生路径时，不因同时存在封面相对路径而漏扫主媒体', () => {
    const current = project({ filePath: 'C:/Project/imports/current/video.mp4', imageRelativePath: 'imports/cover/preview.png' });
    const paths = selectArchiveImportPaths([current], null, undefined, 'C:/Project');
    expect(paths).toEqual(['imports/cover/preview.png', 'imports/current/video.mp4']);
    const assets = paths.map((path, index) => ({ path, bytes: 1, sha256: String(index + 1).repeat(64) }));
    const captured = captureExchangeSnapshot([current], assets, null, undefined, 'C:/Project');
    expect([...captured.files.values()].sort()).toEqual(paths);
  });

  it('有协作状态却缺少匹配快照时停止扫描，不按墓碑猜测当前文件', () => {
    const captured = captureExchangeSnapshot([project()], [], null);
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'a'.repeat(64), stateVersion: 1, identities: captured.identities };
    expect(() => selectArchiveImportPaths([project()], state, undefined, '/project')).toThrow('当前协作快照');
    expect(() => selectArchiveImportPaths([project()], state, { ...captured.snapshot, lineageId: 'another' }, '/project')).toThrow('当前协作快照');
    expect(() => selectArchiveImportPaths([project({ relativePath: 'imports/../private.png' })], null, undefined, '/project')).toThrow('不安全');
  });

  it.each(['../private.png', '/private.png', 'C:/private.png', 'a/../../private.png', 'a/NUL.png'])('旧包拒绝越界素材引用 %s', (relativePath) => {
    expect(() => sanitizeLegacyArchiveProject(project({ nested: { relativePath } }))).toThrow();
  });
  it('旧包保留正常相对路径，移除本机文件、任务与凭据投影', () => {
    const source = project({ relativePath: '图像/人物.png', filePath: 'C:/private.png', imageUrl: 'asset://localhost/private.png',
      api_key: 'secret', taskId: 'running', status: 'loading', prompt: '人物' });
    const result = sanitizeLegacyArchiveProject(source);
    expect((result.nodes as unknown[])[0]).toMatchObject({ data: { relativePath: '图像/人物.png', status: 'idle', prompt: '人物' } });
    expect(JSON.stringify(result)).not.toMatch(/secret|private\.png|running/);
    expect(() => sanitizeLegacyArchiveProject(project(JSON.parse('{"__proto__":{"polluted":true}}')))).toThrow();
  });
  it('聊天只保留文本和来源，不导出运行工具、文件授权和模型配置', () => {
    const raw = { conversations: [{ id: 'c', title: '讨论', agentMode: 'c', systemPrompt: 'private', modelConfig: { apiKey: 'secret' } }],
      messages: [{ id: 'm', conversationId: 'c', sequence: 1, content: '正文', role: 'assistant', status: 'streaming',
        toolCalls: [{ arguments: { grantId: 'grant', filePath: 'C:/private' } }], agentTaskId: 'task' }],
      memories: [{ id: 'memory', content: '保留事实', kind: 'fact', enabled: true, source: { conversationId: 'c', messageId: 'm', taskId: 'task' } }],
    } as unknown as ProjectArchiveChatPayload;
    const result = portableArchiveChat(raw);
    expect(result.messages[0]).toMatchObject({ content: '正文', status: 'done' });
    expect(result.conversations[0]).toMatchObject({ agentMode: 'plan', messageCount: 1 });
    expect(result.memories[0].source).toMatchObject({ conversationId: 'c', messageId: 'm' });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|grant|toolCalls|taskId|agentTaskId/);
    expect(() => portableArchiveChat({ ...raw, messages: [raw.messages[0], raw.messages[0]] })).toThrow();
  });
  it('恢复点和删除文件留在本机，当前快照的独立同内容文件均可导出', () => {
    const a = { path: '图片/a.png', bytes: 1, sha256: 'a'.repeat(64) }, b = { ...a, path: '图片/b.png' };
    const captured = captureExchangeSnapshot([project({ relativePath: a.path })], [a, b], null);
    const state: ProjectExchangeState = { ownerId: 'root', rootProjectId: 'root', lineageId: captured.snapshot.lineageId,
      headRevisionId: 'b'.repeat(64), stateVersion: 1, identities: captured.identities };
    const recovery = { ...a, path: 'imports/recovery/旧稿.png' }, removed = { ...a, path: 'imports/failed/未提交.png' };
    expect(selectArchiveAssets(captured.snapshot, state, [a, b, recovery, removed]).sort((left, right) => left.path.localeCompare(right.path))).toEqual([a, b]);
    expect(() => selectArchiveAssets(captured.snapshot, state, [a])).toThrow();
    expect(() => selectArchiveAssets(captured.snapshot, state, [{ ...a, sha256: 'c'.repeat(64) }, b])).toThrow();
  });
});
