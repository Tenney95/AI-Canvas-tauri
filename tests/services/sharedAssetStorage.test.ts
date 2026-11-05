/**
 * sharedAssetStorage — 回归测试：项目 S3 连接边界。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedAssetStorageSnapshot, SharedStorageConnectionInput, SharedSyncHead } from '../../src/types/assetSync';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauriEnv: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: native.isTauriEnv }));

import {
  bindSharedStorageProject, getSharedProjectPrefix, loadSharedStorageSnapshot,
  normalizeSharedStorageConnection, parseSharedProjectCode, saveSharedStorageConnection,
  listSharedAssetHeads, previewSharedAssetDelete, applySharedAssetDelete,
} from '../../src/services/fs/sharedAssetStorage';

const connection: SharedStorageConnectionInput = {
  id: 'connection-a', name: '团队存储', endpoint: 'https://storage.example.com', region: 'region-1',
  bucket: 'project-assets', rootPrefix: 'team', pathStyle: true,
};
const snapshot = (): SharedAssetStorageSnapshot => ({
  revision: 1, connections: [{ ...connection, revision: 'revision-1', credentialsSaved: true, sessionTokenSaved: false }], bindings: [],
});

beforeEach(() => { native.invoke.mockReset(); native.isTauriEnv.mockReturnValue(true); });

describe('单项云资产删除的 IPC 绑定', () => {
  const context = { ownerId: 'owner', connectionId: 'connection', connectionRevision: 'revision-1', libraryId: 'library',
    sharedProjectId: 'project', generation: 'legacy', taskId: 'task' };
  const input = { ...context, operationId: 'delete-op', sharedAssetId: 'asset', expectedRevisionId: 'revision', expectedETag: 'etag' };
  const preview = { sharedAssetId: input.sharedAssetId, revisionId: input.expectedRevisionId, operationId: input.operationId, previewToken: 'opaque-preview' };
  const deleted: SharedSyncHead = { sharedAssetId: 'asset', kind: 'character', revisionId: 'revision',
    revisionDigest: 'a'.repeat(64), operationId: 'delete-op', updatedAt: 1, deleted: true };

  it('预览与确认都保留固定项目、资产及操作绑定', async () => {
    native.invoke.mockResolvedValueOnce(preview);
    await expect(previewSharedAssetDelete(input)).resolves.toEqual(preview);
    expect(native.invoke).toHaveBeenLastCalledWith('project_asset_storage_preview_asset_delete', { input });
    const apply = { ...context, operationId: input.operationId, sharedAssetId: input.sharedAssetId, previewToken: preview.previewToken };
    native.invoke.mockResolvedValueOnce({ status: 'deleted', sharedAssetId: input.sharedAssetId, operationId: input.operationId });
    await expect(applySharedAssetDelete(apply)).resolves.toMatchObject({ status: 'deleted' });
    expect(native.invoke).toHaveBeenLastCalledWith('project_asset_storage_apply_asset_delete', { input: apply });
  });
  it.each(['sharedAssetId', 'revisionId', 'operationId', 'previewToken'] as const)('拒绝预览回执的错误绑定或空令牌：%s', async (field) => {
    native.invoke.mockResolvedValueOnce({ ...preview, [field]: field === 'previewToken' ? '' : 'another' });
    await expect(previewSharedAssetDelete(input)).rejects.toThrow('版本无效');
  });
  it('拒绝错误确认回执，保留明确的不确定状态', async () => {
    const apply = { ...context, operationId: input.operationId, sharedAssetId: input.sharedAssetId, previewToken: preview.previewToken };
    native.invoke.mockResolvedValueOnce({ status: 'deleted', sharedAssetId: 'another', operationId: input.operationId });
    await expect(applySharedAssetDelete(apply)).rejects.toThrow('版本无效');
    native.invoke.mockResolvedValueOnce({ status: 'uncertain', sharedAssetId: input.sharedAssetId, operationId: input.operationId });
    await expect(applySharedAssetDelete(apply)).resolves.toMatchObject({ status: 'uncertain' });
  });
  it('空身份、控制字符 ETag 或空预览令牌不会发起请求', async () => {
    await expect(previewSharedAssetDelete({ ...input, sharedAssetId: undefined as unknown as string })).rejects.toThrow('参数无效');
    await expect(previewSharedAssetDelete({ ...input, expectedETag: 'etag\nheader' })).rejects.toThrow('参数无效');
    await expect(applySharedAssetDelete({ ...context, operationId: 'op', sharedAssetId: 'asset', previewToken: '' })).rejects.toThrow('参数无效');
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('删除标记单独返回，不能作为普通可下载资产或重复身份进入列表', async () => {
    native.invoke.mockResolvedValueOnce({ assets: [], deletedAssets: [deleted], complete: true });
    await expect(listSharedAssetHeads(context)).resolves.toMatchObject({ assets: [], deletedAssets: [deleted] });
    native.invoke.mockResolvedValueOnce({ assets: [], deletedAssets: [deleted, deleted], complete: true });
    await expect(listSharedAssetHeads(context)).rejects.toThrow('版本无效');
    native.invoke.mockResolvedValueOnce({ assets: [], deletedAssets: [{ ...deleted, deleted: false }], complete: true });
    await expect(listSharedAssetHeads(context)).rejects.toThrow('版本无效');
  });
  it('兼容旧运行时省略删除列表，但拒绝损坏的删除身份', async () => {
    native.invoke.mockResolvedValueOnce({ assets: [], complete: true });
    await expect(listSharedAssetHeads(context)).resolves.toMatchObject({ assets: [], deletedAssets: [] });
    native.invoke.mockResolvedValueOnce({ assets: [], deletedAssets: [{ ...deleted, operationId: undefined }], complete: true });
    await expect(listSharedAssetHeads(context)).rejects.toThrow();
  });
  it('普通 head 的删除标记不能用字符串或数字伪装', async () => {
    const revision = { format: 'ai-canvas-shared-asset', version: 1, libraryId: context.libraryId,
      sharedProjectId: context.sharedProjectId, sharedAssetId: 'asset', revisionId: 'revision', operationId: 'operation', createdAt: 1,
      payload: { kind: 'file', name: 'image.png', displayRelativePath: 'image.png', mediaId: 'image', tags: [] },
      media: [{ id: 'image', kind: 'image', extension: 'png', bytes: 1, sha256: 'a'.repeat(64) }] };
    for (const marker of ['true', 1, true]) {
      native.invoke.mockResolvedValueOnce({ assets: [{ revision, etag: 'etag',
        head: { ...deleted, kind: 'file', operationId: 'operation', deleted: marker } }], complete: true });
      await expect(listSharedAssetHeads(context)).rejects.toThrow('版本无效');
    }
    native.invoke.mockResolvedValueOnce({ assets: [{ revision, etag: 'etag',
      head: { ...deleted, kind: 'file', operationId: 'operation', deleted: false } }], complete: true });
    await expect(listSharedAssetHeads(context)).resolves.toMatchObject({ assets: [{ revision }] });
  });
});

describe('项目 S3 连接边界', () => {
  it('HTTP 与 HTTPS Endpoint 均拒绝认证信息、查询、片段及额外路径', () => {
    expect(normalizeSharedStorageConnection({ ...connection, endpoint: ' https://storage.example.com/ ' }).endpoint).toBe(connection.endpoint);
    expect(normalizeSharedStorageConnection({ ...connection, name: '汉'.repeat(70) }).name).toHaveLength(70);
    for (const endpoint of [
      'file:///tmp/data', 'ftp://storage.example.com', 'https://user:password@storage.example.com',
      'http://user:password@localhost:9000', 'http://localhost:9000/api', 'http://localhost:9000?token=hidden',
      'http://localhost:9000#secret', 'https://storage.example.com/api',
      'https://storage.example.com?token=hidden', 'https://storage.example.com#secret',
    ]) expect(() => normalizeSharedStorageConnection({ ...connection, endpoint })).toThrow();
  });

  it.each([
    [' http://localhost:9000/ ', 'http://localhost:9000'],
    ['http://192.168.1.20:9000/', 'http://192.168.1.20:9000'],
    ['http://storage.example.com:9000/', 'http://storage.example.com:9000'],
  ])('HTTP 地址归一化后可通过保存 IPC 和公开快照读取：%s', async (endpoint, normalizedEndpoint) => {
    const value = snapshot();
    value.connections[0].endpoint = normalizedEndpoint;
    native.invoke.mockResolvedValue(value);
    const result = await saveSharedStorageConnection({ connection: { ...connection, endpoint }, expectedRevision: 'revision-1' });
    expect(native.invoke).toHaveBeenLastCalledWith('project_asset_storage_save_connection', {
      input: { connection: { ...connection, endpoint: normalizedEndpoint }, expectedRevision: 'revision-1', credentials: undefined },
    });
    expect(result).toEqual(value);
    await expect(loadSharedStorageSnapshot()).resolves.toEqual(value);
  });

  it('共享身份独立于名称，前缀不能越界或接受编码后的路径分隔符', () => {
    expect(parseSharedProjectCode(' library-a/project-b ')).toEqual({ libraryId: 'library-a', sharedProjectId: 'project-b' });
    expect(getSharedProjectPrefix(connection, 'library-a', 'project-b')).toBe('team/libraries/library-a/projects/project-b');
    for (const code of ['same-name', '../project-b', 'library-a/project-b/extra', 'library-a/%2fother']) {
      expect(() => parseSharedProjectCode(code)).toThrow();
    }
    for (const rootPrefix of ['team/../other', 'team//other', 'team\\other', 'team/%2e%2e', 'team?key=x']) {
      expect(() => getSharedProjectPrefix({ rootPrefix }, 'library-a', 'project-b')).toThrow();
    }
  });

  it('凭据必须成对更新，保留、清除和替换不混用，错误时不发送 IPC', async () => {
    await expect(saveSharedStorageConnection({ connection, credentials: { accessKeyId: 'new-key' } })).rejects.toThrow();
    await expect(saveSharedStorageConnection({ connection, credentials: { clearCredentials: true, secretAccessKey: 'secret' } })).rejects.toThrow();
    await expect(saveSharedStorageConnection({ connection, credentials: { sessionToken: 'token', clearSessionToken: true } })).rejects.toThrow();
    expect(native.invoke).not.toHaveBeenCalled();
    native.invoke.mockResolvedValue(snapshot());
    await saveSharedStorageConnection({ connection, expectedRevision: 'revision-1' });
    expect(native.invoke).toHaveBeenLastCalledWith('project_asset_storage_save_connection', {
      input: { connection, expectedRevision: 'revision-1', credentials: undefined },
    });
  });

  it('只返回公开字段，IPC 意外附带的凭据不会进入共享状态', async () => {
    const value = snapshot();
    native.invoke.mockResolvedValue({ ...value, secretAccessKey: 'do-not-store', connections: [
      { ...value.connections[0], credentials: { accessKeyId: 'private-key', secretAccessKey: 'do-not-store' } },
    ] });
    const result = await loadSharedStorageSnapshot();
    expect(result).toEqual(value);
    expect(JSON.stringify(result)).not.toContain('do-not-store');
    expect(JSON.stringify(result)).not.toContain('private-key');
  });

  it('能力报告缺少条件更新证明时不能投影为可多人写入', async () => {
    native.invoke.mockResolvedValue({ snapshot: snapshot(), bound: false, report: {
      checks: [{ kind: 'readWrite', status: 'passed' }], checkedAt: 1, cleanupPending: false, multiplayerWritable: true,
    } });
    const result = await bindSharedStorageProject({
      taskId: 'task-a', ownerId: 'owner-a', ownerName: '项目', connectionId: connection.id,
      connectionRevision: 'revision-1', mode: 'create', libraryId: 'library-a', sharedProjectId: 'project-a',
    });
    expect(result.report.multiplayerWritable).toBe(false);
    expect(result.report.checks.find((check) => check.kind === 'conditionalUpdate')?.status).toBe('notChecked');
  });

  it('不向界面转发带签名或响应正文的原始异常；Web 环境不尝试连接', async () => {
    native.invoke.mockRejectedValue({ code: 'network', message: 'Authorization=secret-signature' });
    await expect(loadSharedStorageSnapshot()).rejects.toThrow('检查网络');
    await expect(loadSharedStorageSnapshot()).rejects.toMatchObject({ cause: { code: 'network' } });
    native.invoke.mockRejectedValue({ code: 'Authorization=secret-signature' });
    await expect(loadSharedStorageSnapshot()).rejects.toMatchObject({ cause: { code: 'unknown' } });
    native.invoke.mockRejectedValue('Authorization=secret-signature');
    await expect(loadSharedStorageSnapshot()).rejects.toThrow('未完成');
    native.invoke.mockClear(); native.isTauriEnv.mockReturnValue(false);
    await expect(loadSharedStorageSnapshot()).rejects.toThrow('桌面端');
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
