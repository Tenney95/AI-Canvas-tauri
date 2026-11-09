import { expect, it } from 'vitest';
import { captureArchiveOutputHistory, materializeArchiveOutputHistory, validateArchiveOutputHistory,
  validateNativeArchiveOutputRows } from '../../src/services/projectOutputHistoryArchive';

const files = [{ id: 'file', rootRef: 'logical-root', relativePath: 'result.png', mediaId: 'media' }];
const identities = [{ kind: 'storage-root' as const, sourceId: 'logical-root', localId: 'local-root' }];
const bindings = [{ id: 'file', rootRef: 'logical-root', relativePath: 'result.png', localRelativePath: 'imports/result.png' }];
const local = () => ({ id: 'history', projectId: 'canvas', nodeId: 'deleted-node', nodeType: 'ai-image', nodeLabel: '原节点',
  timestamp: 0, prompt: '原始输入', output: 'asset://local/result.png', mediaUrl: 'asset://local/result.png',
  filePath: '/isolated/result.png', relativePath: 'imports/result.png', storageRootRef: 'local-root', model: 'general/original', provider: 'fixture', status: 'success',
  recoveryTask: { taskId: 'never-resume' }, params: { aspectRatio: '1:1', originalTimestampUnavailable: true, originalInputUnavailable: true, apiKey: 'never-export', workflowInputs: { file: '/private' } } });

it('只导出原快照和精确文件身份，剥离本机URL/路径、任务和非白名单参数', () => {
  const row = captureArchiveOutputHistory(local(), 'a'.repeat(64), 'project', 'local-root', identities, bindings);
  expect(row).toMatchObject({ prompt: '原始输入', timestamp: 0, fileId: 'file', output: '',
    params: { aspectRatio: '1:1', originalTimestampUnavailable: true, originalInputUnavailable: true } });
  expect(row).not.toHaveProperty('recoveryTask'); expect(row).not.toHaveProperty('filePath'); expect(row).not.toHaveProperty('mediaUrl');
  expect(JSON.stringify(row)).not.toContain('never-export'); expect(JSON.stringify(row)).not.toContain('/private');
  expect(() => validateArchiveOutputHistory([row], files, 'project')).not.toThrow();
  const imported = materializeArchiveOutputHistory(row, files, identities, bindings);
  expect(imported).toMatchObject({ nodeId: 'deleted-node', relativePath: 'imports/result.png', storageRootRef: 'local-root', mediaUrl: 'imports/result.png' });
  expect(imported).not.toHaveProperty('filePath');
  expect(() => validateNativeArchiveOutputRows([{ kind: 'output', sourceNamespace: 'lineage', archiveOriginId: row.archiveOriginId,
    value: { ...imported, id: 'new-history', projectId: 'canvas' } as { id: string; projectId: string } }],
  { projectId: 'project', canvasIds: ['canvas'], rootRefs: ['local-root'], identities, bindings })).not.toThrow();
});

it.each(['receipt', 'missing-file', 'cross-project', 'absolute-output', 'private-params'] as const)('严格拒绝%s归档材料', (change) => {
  const row: Record<string, unknown> = { ...captureArchiveOutputHistory(local(), 'a'.repeat(64), 'project', 'local-root', identities, bindings) };
  if (change === 'receipt') row.recoveryTask = { taskId: 'resume' };
  if (change === 'missing-file') row.fileId = 'absent';
  if (change === 'cross-project') row.projectId = 'other';
  if (change === 'absolute-output') row.output = '/private/image.png';
  if (change === 'private-params') row.params = { apiKey: 'never-accept' };
  expect(() => validateArchiveOutputHistory([row], files, 'project')).toThrow();
});

it('本机journal拒绝跨画布和未绑定相对路径，不以普通文件名推断原产物', () => {
  const row = captureArchiveOutputHistory(local(), 'a'.repeat(64), 'project', 'local-root', identities, bindings);
  expect(() => captureArchiveOutputHistory({ ...local(), relativePath: 'unbound.png' }, row.archiveOriginId, 'project', 'local-root', identities, bindings)).toThrow();
  const imported = materializeArchiveOutputHistory(row, files, identities, bindings);
  expect(() => validateNativeArchiveOutputRows([{ kind: 'output', sourceNamespace: 'lineage', archiveOriginId: row.archiveOriginId,
    value: { ...imported, id: 'new-history', projectId: 'other-canvas' } as { id: string; projectId: string } }],
  { projectId: 'project', canvasIds: ['canvas'], rootRefs: ['local-root'], identities, bindings })).toThrow();
});
