/** 备份类型往返、完整性与完成标记边界；本阶段只编写，不自动运行。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectModelBackup,
  readVerifiedProjectModelBackup,
  writeVerifiedProjectModelBackup,
  type ProjectModelBackupPort,
  type ProjectModelBackupSource,
} from '../../src/services/projectModelBackup';
import { sha256BytesHex } from '../../src/services/mediaDataUrl';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

function source(value: unknown = { id: 'legacy-canvas', name: '旧分集', episodeScript: '保留中文稿件', nodes: [], edges: [] }): ProjectModelBackupSource {
  return { databaseName: 'ai-canvas-db', schemaVersion: 27, databaseStoreNames: ['projects', 'metadata', 'config'],
    stores: [{ name: 'projects', keyPath: 'id', autoIncrement: false,
      indexes: [{ name: 'updatedAt', keyPath: 'updatedAt', unique: false, multiEntry: false }], records: [{ key: 'legacy-canvas', value }] },
    { name: 'metadata', keyPath: 'id', autoIncrement: false, indexes: [], records: [{ key: 'last-active-project', value: { id: 'last-active-project', value: 'legacy-canvas' } }] }],
    localStorage: [{ key: 'ai_canvas_pending_tasks', value: '[{"id":"submitted-task","phase":"submit_unknown"}]' }] };
}
function memoryPort() {
  const files = new Map<string, Uint8Array>(), order: string[] = [];
  const port: ProjectModelBackupPort = {
    writeExclusive: async (path, bytes) => { if (files.has(path)) throw new Error('existing'); order.push(path); files.set(path, Uint8Array.from(bytes)); },
    read: async (path, maxBytes) => { const bytes = files.get(path); if (!bytes || bytes.byteLength > maxBytes) throw new Error('read failed'); return Uint8Array.from(bytes); },
    publishComplete: async (path, bytes) => { if (files.has(path)) throw new Error('existing completion'); order.push(path); files.set(path, Uint8Array.from(bytes)); },
  };
  return { files, order, port };
}

describe('项目模型本地备份', () => {
  it('保留旧稿件、schema、原始媒体队列且完成标记最后发布', async () => {
    const original = source(), bundle = await createProjectModelBackup(original, { operationId: 'backup-a', createdAt: 10 });
    const memory = memoryPort();
    expect(await writeVerifiedProjectModelBackup(bundle, memory.port)).toMatchObject({ status: 'verified', source: original });
    expect(memory.order.at(-1)).toBe('complete.json');
    expect((await readVerifiedProjectModelBackup(memory.port)).source).toEqual(original);
    expect(original.stores[0].records[0].value).toMatchObject({ episodeScript: '保留中文稿件' });
  });

  it('保留undefined、稀疏数组、非有限数、日期、共享buffer/view和Blob', async () => {
    const buffer = new Uint8Array([10, 20, 30, 40]).buffer, child = { chinese: '原文' };
    const sparse = new Array(3); sparse[1] = undefined;
    const original = { id: 'legacy-canvas', absentValue: undefined, sparse, minusZero: -0, nan: NaN, positive: Infinity, negative: -Infinity,
      date: new Date(5), invalidDate: new Date(NaN), amount: 17n, buffer, view: new Uint16Array(buffer, 0, 2),
      dataView: new DataView(buffer, 1, 2), blob: new Blob(['中文正文'], { type: 'text/plain' }), child, sameChild: child,
      map: new Map([['value', child]]), set: new Set([child]) };
    const memory = memoryPort(), bundle = await createProjectModelBackup(source(original), { operationId: 'types' });
    const verified = await writeVerifiedProjectModelBackup(bundle, memory.port);
    const restored = verified.source.stores[0].records[0].value as typeof original;
    expect(restored).toEqual(original);
    expect(0 in restored.sparse).toBe(false); expect(1 in restored.sparse).toBe(true);
    expect(restored.child).toBe(restored.sameChild);
    expect(restored.view.buffer).toBe(restored.buffer); expect(restored.dataView.buffer).toBe(restored.buffer);
    expect(await restored.blob.text()).toBe('中文正文');
  });

  it('拒绝循环、未知store/metadata、未覆盖store与明文凭据，保留原对象', async () => {
    const cyclic: Record<string, unknown> = { id: 'legacy-canvas' }; cyclic.self = cyclic;
    await expect(createProjectModelBackup(source(cyclic), { operationId: 'cycle' })).rejects.toThrow('cyclic_value');
    const unknown = source(); unknown.databaseStoreNames.push('unknown-project-data');
    await expect(createProjectModelBackup(unknown, { operationId: 'unknown' })).rejects.toThrow('unknown_store_coverage');
    const omitted = source(); omitted.stores.pop();
    await expect(createProjectModelBackup(omitted, { operationId: 'omitted' })).rejects.toThrow('incomplete_store_coverage');
    const metadata = source(); metadata.stores[1].records[0] = { key: 'unclassified-key', value: { id: 'unclassified-key' } };
    await expect(createProjectModelBackup(metadata, { operationId: 'meta' })).rejects.toThrow('unsupported_metadata');
    const credential = { id: 'legacy-canvas', provider: { apiKey: 'fixture-private-value' } };
    await expect(createProjectModelBackup(source(credential), { operationId: 'secret' })).rejects.toThrow('plaintext_credential_field');
    expect(credential.provider.apiKey).toBe('fixture-private-value');
    await expect(createProjectModelBackup(source({ id: 'legacy-canvas', extra: new Map([['apiKey', 'fixture-private-value']]) }),
      { operationId: 'map-secret' })).rejects.toThrow('plaintext_credential_field');
    const auto = source(); auto.stores[0].autoIncrement = true;
    await expect(createProjectModelBackup(auto, { operationId: 'generator' })).rejects.toThrow('unsupported_auto_increment');
  });

  it('拒绝游标key与内联key不一致以及队列里的凭据/损坏JSON，不改原串', async () => {
    await expect(createProjectModelBackup(source({ id: 'other' }), { operationId: 'inline-key' })).rejects.toThrow('inline_key_mismatch');
    const secret = source(); secret.localStorage[0].value = '[{"request":{"authorization":"fixture-secret"}}]';
    await expect(createProjectModelBackup(secret, { operationId: 'queue-secret' })).rejects.toThrow('plaintext_credential_field');
    expect(secret.localStorage[0].value).toContain('fixture-secret');
    const broken = source(); broken.localStorage[0].value = '[broken';
    await expect(createProjectModelBackup(broken, { operationId: 'queue-broken' })).rejects.toThrow('pending_queue_invalid_json');
    expect(broken.localStorage[0].value).toBe('[broken');
  });

  it('IDB语义等价的binary主键重复必须拒绝', async () => {
    const original = source();
    original.stores[0].keyPath = null;
    original.stores[0].records = [{ key: new Uint8Array([1, 2]), value: 'first' }, { key: new Uint8Array([1, 2]).buffer, value: 'second' }];
    await expect(createProjectModelBackup(original, { operationId: 'keys' })).rejects.toThrow('duplicate_record_key');
  });

  it('读回失败不能发布完成标记，缺少完成标记不能读成有效备份', async () => {
    const bundle = await createProjectModelBackup(source(), { operationId: 'read-fails' }), memory = memoryPort();
    const broken: ProjectModelBackupPort = { ...memory.port, read: async () => { throw new Error('disk unavailable'); } };
    await expect(writeVerifiedProjectModelBackup(bundle, broken)).rejects.toThrow('disk unavailable');
    expect(memory.files.has('complete.json')).toBe(false);
    await expect(readVerifiedProjectModelBackup(memory.port)).rejects.toThrow();
  });

  it('写回读回期间取消时拒绝完成，已完成材料读回中取消也不报告成功', async () => {
    const bundle = await createProjectModelBackup(source(), { operationId: 'cancel-reading' }), memory = memoryPort();
    const controller = new AbortController();
    const cancelled: ProjectModelBackupPort = { ...memory.port, read: async (path, maxBytes) => {
      const bytes = await memory.port.read(path, maxBytes); controller.abort(); return bytes;
    } };
    await expect(writeVerifiedProjectModelBackup(bundle, cancelled, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(memory.files.has('complete.json')).toBe(false);
    const complete = memoryPort(); await writeVerifiedProjectModelBackup(bundle, complete.port);
    const finalController = new AbortController();
    const finalRead: ProjectModelBackupPort = { ...complete.port, read: async (path, maxBytes) => {
      const bytes = await complete.port.read(path, maxBytes);
      if (path === bundle.manifest.files.at(-1)!.path) finalController.abort(); return bytes;
    } };
    await expect(readVerifiedProjectModelBackup(finalRead, { signal: finalController.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('完成后材料被改动必须拒绝，不能覆盖已有完成标记', async () => {
    const bundle = await createProjectModelBackup(source(), { operationId: 'tamper' }), memory = memoryPort();
    await writeVerifiedProjectModelBackup(bundle, memory.port);
    const path = bundle.manifest.files.find((file) => file.kind === 'records')!.path;
    memory.files.set(path, new TextEncoder().encode('[]'));
    await expect(readVerifiedProjectModelBackup(memory.port)).rejects.toThrow('content_digest_mismatch');
    await expect(writeVerifiedProjectModelBackup(bundle, memory.port)).rejects.toThrow('existing');
  });

  it('重复构造同一二进制载荷不能放大解码内存，也不能发布完成标记', async () => {
    const bundle = await createProjectModelBackup(source({ id: 'legacy-canvas', buffer: new Uint8Array([1, 2, 3]).buffer }),
      { operationId: 'binary-alias' });
    const file = bundle.manifest.files.find((entry) => entry.path.startsWith('stores/projects/'))!;
    type TaggedObject = { t: string; id: number; entries: Array<[string, unknown]> };
    const rows = JSON.parse(new TextDecoder().decode(bundle.files.get(file.path)!)) as TaggedObject[];
    const value = rows[0].entries.find(([key]) => key === 'value')![1] as TaggedObject;
    const buffer = value.entries.find(([key]) => key === 'buffer')![1] as { t: string; id: number; path: string };
    value.entries.push(['duplicateBuffer', { ...buffer, id: 999 }]);
    const bytes = new TextEncoder().encode(JSON.stringify(rows));
    bundle.manifest.totalBytes += bytes.byteLength - file.bytes;
    file.bytes = bytes.byteLength; file.sha256 = await sha256BytesHex(bytes); bundle.files.set(file.path, bytes);
    const memory = memoryPort();
    await expect(writeVerifiedProjectModelBackup(bundle, memory.port)).rejects.toThrow('reused_binary_payload');
    expect(memory.files.has('complete.json')).toBe(false);
  });

  it('拒绝manifest多余字段、越界路径和重复文件声明', async () => {
    const bundle = await createProjectModelBackup(source(), { operationId: 'manifest' });
    await expect(writeVerifiedProjectModelBackup({ ...bundle, manifest: { ...bundle.manifest, unexpected: true } as typeof bundle.manifest }, memoryPort().port)).rejects.toThrow('invalid_fields');
    const unsafe = structuredClone(bundle.manifest); unsafe.files[0].path = '../source.json';
    await expect(writeVerifiedProjectModelBackup({ ...bundle, manifest: unsafe }, memoryPort().port)).rejects.toThrow('invalid_path');
    const duplicate = structuredClone(bundle.manifest); duplicate.files.push(duplicate.files[0]);
    await expect(writeVerifiedProjectModelBackup({ ...bundle, manifest: duplicate }, memoryPort().port)).rejects.toThrow('duplicate_file');
  });
});
