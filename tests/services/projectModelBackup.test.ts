/** 备份类型往返、完整性、旧journal兼容与完成标记边界。 */
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
import { IDBFactory } from 'fake-indexeddb';
import { openProjectModelFixtureDatabase, createProjectModelStagingRepository } from '../../src/services/indexedDb/projectModelStagingRepository';
import { beginProjectModelFixtureBusinessSession } from '../../src/services/indexedDb/projectModelBusinessRepository';
import { readLegacyMigrationSnapshot } from '../../src/services/indexedDb/projectModelMigrationRepository';
import { projectModelSourceToken, readProjectModelSourceToken } from '../../src/services/projectModelComparisonMaterial';
import { fingerprintProjectModelSource } from '../../src/services/projectModelSourceFingerprint';
import type { ProjectModelStagingJournal } from '../../src/types/projectModelJournal';

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
async function rewriteCheckedChunk(memory: ReturnType<typeof memoryPort>, path: string, value: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); memory.files.set(path, bytes);
  const manifest = JSON.parse(new TextDecoder().decode(memory.files.get('manifest.json')!));
  const descriptor = manifest.files.find((file: { path: string }) => file.path === path);
  descriptor.bytes = bytes.byteLength; descriptor.sha256 = await sha256BytesHex(bytes);
  manifest.totalBytes = manifest.files.reduce((sum: number, file: { bytes: number }) => sum + file.bytes, 0);
  const encoded = new TextEncoder().encode(JSON.stringify(manifest)); memory.files.set('manifest.json', encoded);
  memory.files.set('complete.json', new TextEncoder().encode(JSON.stringify({ format: manifest.format,
    operationId: manifest.operationId, manifestSha256: await sha256BytesHex(encoded) })));
}

async function fixtureSource(options: { empty?: boolean; business?: boolean } = {}) {
  const factory = new IDBFactory(), name = 'ai-canvas-model-fixture-backup-codec';
  const original = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 27);
    request.onupgradeneeded = () => { for (const store of ['projects', 'metadata', 'agentTasks']) request.result.createObjectStore(store, { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  if (!options.empty) await new Promise<void>((resolve, reject) => {
    const tx = original.transaction(['projects', 'metadata', 'agentTasks'], 'readwrite');
    tx.objectStore('projects').put({ id: 'P', name: '旧项目', createdAt: 1, updatedAt: 2, nodes: [], edges: [], dataFolder: 'old-folder' });
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer, child = { text: '原值' }, sparse = new Array(3); sparse[1] = undefined;
    tx.objectStore('metadata').put({ id: 'mcp-operation:original', sequence: 1,
      material: { missing: undefined, sparse, negative: -0, nan: NaN, infinite: Infinity, date: new Date(4), invalid: new Date(NaN),
        amount: 3n, buffer, view: new Uint16Array(buffer), dataView: new DataView(buffer, 1, 2), child, repeated: child,
        map: new Map([['item', child]]), set: new Set([child]) } });
    tx.objectStore('agentTasks').put({ id: 'paid', sequence: 1, toolCallCount: 3 });
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  const snapshot = await readLegacyMigrationSnapshot(original, { localStorage: { getItem: () => '[]' } }); original.close();
  const backup = await createProjectModelBackup(snapshot.source, { operationId: 'original-backup', createdAt: 0 });
  const database = await openProjectModelFixtureDatabase({ factory, name }), staging = createProjectModelStagingRepository(database);
  try {
    await staging.prepare({ operationId: 'old-journal', generation: 1, source: snapshot.source,
      sourceDigest: await fingerprintProjectModelSource(backup.manifest), backupOperationId: 'original-backup', backupManifestDigest: 'a'.repeat(64) });
    await staging.stageNextBatch({ operationId: 'old-journal', batchSize: 500 }); await staging.verify({ operationId: 'old-journal' });
    if (options.business) await beginProjectModelFixtureBusinessSession(database, { operationId: 'old-journal', generation: 1, sessionId: 'business-session' });
    const names = Array.from(database.objectStoreNames);
    const captured = await new Promise<ProjectModelBackupSource['stores']>((resolve, reject) => {
      const tx = database.transaction(names, 'readonly');
      const stores = names.map((name) => { const store = tx.objectStore(name), keys = store.getAllKeys(), rows = store.getAll();
        const indexes = Array.from(store.indexNames).map((name) => { const index = store.index(name); return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; });
        return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, keys, rows }; });
      tx.oncomplete = () => resolve(stores.map(({ name, keyPath, autoIncrement, indexes, keys, rows }) => ({ name, keyPath, autoIncrement, indexes,
        records: keys.result.map((key, index) => ({ key, value: rows.result[index] })) })));
      tx.onabort = () => reject(tx.error);
    });
    const source: ProjectModelBackupSource = { databaseName: name, schemaVersion: 28, databaseStoreNames: names, stores: captured,
      localStorage: [{ key: 'ai_canvas_pending_tasks', value: '[]' }] };
    const journal = source.stores.find((store) => store.name === 'projectModelMigrations')!.records[0].value as ProjectModelStagingJournal;
    return { source, journal };
  } finally { database.close(); }
}

describe('项目模型本地备份', () => {
  it('真实旧P2 journal无损往返，比较材料编码与新备份来源指纹稳定', async () => {
    const original = await fixtureSource(), before = projectModelSourceToken(original.source);
    const bundle = await createProjectModelBackup(original.source, { operationId: 'journal-roundtrip', createdAt: 10 }), memory = memoryPort();
    const checked = await writeVerifiedProjectModelBackup(bundle, memory.port);
    expect(checked.source).toEqual(original.source);
    expect(projectModelSourceToken(original.source)).toBe(before);
    const copied = await createProjectModelBackup(checked.source, { operationId: 'journal-roundtrip', createdAt: 10 });
    expect(copied).toEqual(bundle);
    expect(await fingerprintProjectModelSource(copied.manifest)).toBe(await fingerprintProjectModelSource(bundle.manifest));
    const sourceValue = original.source.stores.find((store) => store.name === 'metadata')!.records.find((record) => record.key === 'mcp-operation:original')!.value;
    const comparison = original.journal.sourceStores.find((store) => store.name === 'metadata')!.records.find((record) => record.key === 'mcp-operation:original')!.token;
    expect(readProjectModelSourceToken(comparison)).toEqual(sourceValue);
  });

  it('旧v2空journal保持raw编码和指纹，不因兼容转义制造新来源', async () => {
    const original = await fixtureSource({ empty: true }), memory = memoryPort();
    const bundle = await createProjectModelBackup(original.source, { operationId: 'empty-journal', createdAt: 10 });
    expect(original.journal.rows).toHaveLength(0);
    expect(original.journal.sourceStores.every((store) => store.records.length === 0)).toBe(true);
    const chunk = bundle.manifest.stores.find((store) => store.name === 'projectModelMigrations')!.chunks[0];
    expect(new TextDecoder().decode(bundle.files.get(chunk)!)).not.toContain('project-model-staging-journal-backup-v1');
    const checked = await writeVerifiedProjectModelBackup(bundle, memory.port);
    expect(checked.source).toEqual(original.source);
    expect(await createProjectModelBackup(checked.source, { operationId: 'empty-journal', createdAt: 10 })).toEqual(bundle);
  });

  it('P2源冻结仍核原表/行闭包；失败、回滚和业务后的历史比较值原样保留', async () => {
    const healthy = await fixtureSource(), before = projectModelSourceToken(healthy.journal);
    healthy.source.stores.find((store) => store.name === 'agentTasks')!.records[0].value = { id: 'paid', sequence: 2 };
    await expect(createProjectModelBackup(healthy.source, { operationId: 'changed-live' })).rejects.toThrow('staging_source_changed');
    expect(projectModelSourceToken(healthy.journal)).toBe(before);
    for (const stage of ['failed', 'rolled_back'] as const) {
      const source = structuredClone(healthy.source), journal = source.stores.find((store) => store.name === 'projectModelMigrations')!.records[0].value as ProjectModelStagingJournal;
      journal.stage = stage; if (stage === 'failed') journal.failureCode = 'source-changed';
      source.stores = source.stores.filter((store) => store.name !== 'agentTasks'); source.databaseStoreNames = source.databaseStoreNames.filter((name) => name !== 'agentTasks');
      const memory = memoryPort(), bundle = await createProjectModelBackup(source, { operationId: `historical-${stage.replace('_', '-')}` });
      expect((await writeVerifiedProjectModelBackup(bundle, memory.port)).source).toEqual(source);
    }
    const missingRecord = await fixtureSource(); missingRecord.journal.sourceStores.find((store) => store.name === 'projects')!.records = [];
    await expect(createProjectModelBackup(missingRecord.source, { operationId: 'missing-record' })).rejects.toThrow('staging_source_changed');
    const missingStore = await fixtureSource(); missingStore.journal.sourceStores = missingStore.journal.sourceStores.filter((store) => store.name !== 'agentTasks');
    await expect(createProjectModelBackup(missingStore.source, { operationId: 'missing-store' })).rejects.toThrow('staging_source_changed');
    const business = await fixtureSource({ business: true }), frozen = projectModelSourceToken(business.journal);
    business.source.stores.find((store) => store.name === 'agentTasks')!.records[0].value = { id: 'paid', sequence: 9, toolCallCount: 8 };
    business.source.stores.find((store) => store.name === 'metadata')!.records.push({ key: 'mcp-operation:new-receipt', value: { id: 'mcp-operation:new-receipt', sequence: 1 } });
    const memory = memoryPort(), bundle = await createProjectModelBackup(business.source, { operationId: 'business-audit' });
    const checked = await writeVerifiedProjectModelBackup(bundle, memory.port);
    expect(checked.source).toEqual(business.source); expect(projectModelSourceToken(business.journal)).toBe(frozen);
  });

  it('journal token豁免不能扩散到伪造材料、业务/metadata token或嵌套凭据', async () => {
    const original = await fixtureSource({ business: true });
    for (const mutate of [
      (journal: ProjectModelStagingJournal) => { journal.rows[0].token = 'opaque-secret'; },
      (journal: ProjectModelStagingJournal) => { journal.rows[0].value.provider = { apiKey: 'private-value' }; },
      (journal: ProjectModelStagingJournal) => { journal.sourceStores.find((store) => store.name === 'agentTasks')!.records[0].token = projectModelSourceToken({ id: 'paid', provider: { token: 'private-value' } }); },
      (journal: ProjectModelStagingJournal) => { journal.sourceStores.find((store) => store.name === 'agentTasks')!.records[0].token = projectModelSourceToken({ id: 'another-task' }); },
      (journal: ProjectModelStagingJournal) => { journal.activationAllowed = true as false; },
    ]) {
      const source = structuredClone(original.source), journal = source.stores.find((store) => store.name === 'projectModelMigrations')!.records[0].value as ProjectModelStagingJournal;
      mutate(journal); await expect(createProjectModelBackup(source, { operationId: 'malicious-journal' })).rejects.toThrow();
    }
    for (const name of ['metadata', 'projects']) {
      const source = structuredClone(original.source), store = source.stores.find((store) => store.name === name)!;
      store.records[0].value = { ...store.records[0].value as object, token: 'private-value' };
      await expect(createProjectModelBackup(source, { operationId: `outside-${name}` })).rejects.toThrow('plaintext_credential_field');
    }
    for (const patch of [{ operationId: 'missing-journal' }, { sessionId: 'invalid:session' }, { sourceJournalSequence: 999 }]) {
      const source = structuredClone(original.source), marker = source.stores.find((store) => store.name === 'metadata')!.records.find((record) => record.key === 'project-model-business-fixture')!;
      marker.value = { ...marker.value as object, ...patch };
      await expect(createProjectModelBackup(source, { operationId: 'unbound-marker' })).rejects.toThrow('invalid_business_journal');
    }
    expect(() => readProjectModelSourceToken('["ref",0]')).toThrow('invalid-source-material');
    expect(() => readProjectModelSourceToken('["number","not-a-number"]')).toThrow('invalid-source-material');
  });

  it('恶意journal即便重签全部文件摘要也不能通过读回的比较材料/凭据校验', async () => {
    const original = await fixtureSource({ business: true });
    const bundle = await createProjectModelBackup(original.source, { operationId: 'tampered-journal' });
    const path = bundle.manifest.stores.find((store) => store.name === 'projectModelMigrations')!.chunks[0];
    for (const credential of [false, true]) {
      const memory = memoryPort(); await writeVerifiedProjectModelBackup(bundle, memory.port);
      const items = JSON.parse(new TextDecoder().decode(memory.files.get(path)!));
      const field = (node: { entries: Array<[string, unknown]> }, name: string) => node.entries.find(([key]) => key === name)![1];
      if (credential) {
        const wrapper = field(items[0], 'value') as { entries: Array<[string, unknown]> };
        const journal = field(wrapper, 'journal') as { entries: Array<[string, unknown]> };
        journal.entries.push(['token', 'private-value']);
      } else {
        const replace = (node: unknown): boolean => {
          if (Array.isArray(node)) {
            if (node[0] === 'comparisonMaterial') { node[1] = 'not-canonical-comparison'; return true; }
            return node.some(replace);
          }
          return !!node && typeof node === 'object' && Object.values(node).some(replace);
        };
        expect(replace(items)).toBe(true);
      }
      await rewriteCheckedChunk(memory, path, items);
      await expect(readVerifiedProjectModelBackup(memory.port)).rejects.toThrow(credential ? 'plaintext_credential_field' : 'invalid-source-material');
    }
  });

  it('fixture v2不能用于正式库，schema28也不能伪造旧v1或省略新表覆盖', async () => {
    const formal = source(); formal.schemaVersion = 28;
    await expect(createProjectModelBackup(formal, { operationId: 'formal-v2' })).rejects.toThrow('invalid_source');
    const incompleteFixture = source(); incompleteFixture.databaseName = 'ai-canvas-model-fixture-v2'; incompleteFixture.schemaVersion = 28;
    await expect(createProjectModelBackup(incompleteFixture, { operationId: 'incomplete-v2' })).rejects.toThrow('incomplete_fixture_coverage');
    const bundle = await createProjectModelBackup(source(), { operationId: 'old-source' }), memory = memoryPort();
    await writeVerifiedProjectModelBackup(bundle, memory.port);
    const manifest = JSON.parse(new TextDecoder().decode(memory.files.get('manifest.json')!));
    manifest.format = 'project-model-fixture-backup-v2';
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    memory.files.set('manifest.json', bytes);
    memory.files.set('complete.json', new TextEncoder().encode(JSON.stringify({ format: manifest.format,
      operationId: 'old-source', manifestSha256: await sha256BytesHex(bytes) })));
    await expect(readVerifiedProjectModelBackup(memory.port)).rejects.toThrow('unsupported_schema');
  });
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
