/** 仅被显式 Windows debug feature 打包到冷维护窗口，不接入正式应用入口。 */
import { createProjectModelStagingRepository, projectModelSourceToken } from './services/indexedDb/projectModelStagingRepository';
import { stageProjectModelFixture, rollbackProjectModelFixtureStaging, ProjectModelStagingError } from './services/projectModelStaging';
import { getProjectModelMaintenanceLease, verifyProjectModelMaintenanceLease, openNativeProjectModelBackupPort, verifyNativeProjectModelBackupSeal } from './services/projectModelNativeSafety';
import { readVerifiedProjectModelBackup } from './services/projectModelBackup';
import { decideFixtureRecovery, decideFixtureSeed } from './services/projectModelFixtureRecovery';
import type { PendingTask } from './services/pollManager';
import type { AgentTask } from './types/agent';
import type { ProjectModelStagingJournal } from './types/projectModelJournal';
import { PROJECT_MODEL_GENERATION_STORES, PROJECT_MODEL_SOURCE_FREEZE_KEY } from './types/projectModelJournal';

const PHASE = 'ai-canvas-fixture-selftest-phase-v1';
const PRIOR_LEASE = 'ai-canvas-fixture-selftest-prior-lease-sha256';
const PENDING = 'ai_canvas_pending_tasks';
const OPERATION = 'fixture-selftest-migration-v1';
const originalMedia: PendingTask = { projectId: 'episode-one', nodeId: 'fixture-media-node', nodeType: 'ai-image',
  provider: 'general', taskType: 'general', taskId: 'fixture-media-task', submitted: true };
const laterMedia: PendingTask = { projectId: 'episode-two', nodeId: 'fixture-media-node-2', nodeType: 'ai-image',
  provider: 'general', taskType: 'general', taskId: '', submitted: false, mediaRecoveryState: 'submit_unknown' };
const QUEUE = JSON.stringify([originalMedia]);
const UPDATED_QUEUE = JSON.stringify([originalMedia, laterMedia]);
const originalReceipt = { id: 'fixture-receipt', projectId: 'episode-one', conversationId: 'fixture-conversation',
  userMessageId: 'fixture-message', mode: 'plan', goal: '隔离演练', status: 'paused', steps: [], modelRounds: 1,
  toolCallCount: 2, budget: { maxModelRounds: 12, maxToolCalls: 24, maxParallelReadTools: 3, maxReadRetries: 3 },
  dispatches: [{ id: 'fixture-dispatch', kind: 'tool', phase: 'outcome_unknown', preparedAt: 1 }], createdAt: 1, updatedAt: 1 } satisfies AgentTask;
const updatedReceipt = { ...originalReceipt, toolCallCount: 3, updatedAt: 2 };
const originalMetadata = { id: 'last-active-project', value: 'ordinary', sequence: 1 };
const updatedMetadata = { ...originalMetadata, sequence: 2 };
const records = [
  { id: 'ordinary', name: '普通样本', createdAt: 1, updatedAt: 2, nodes: [], edges: [], episodeScript: '普通样本正文' },
  { id: 'series', name: '剧集样本', createdAt: 1, updatedAt: 2, nodes: [], edges: [], series: { script: '全剧样本' } },
  { id: 'episode-one', parentId: 'series', name: '第一集', episodeNo: 1, createdAt: 1, updatedAt: 2, nodes: [], edges: [], episodeScript: '第一集样本' },
  { id: 'episode-two', parentId: 'series', name: '第二集', episodeNo: 2, createdAt: 1, updatedAt: 2, nodes: [], edges: [], episodeScript: '第二集样本' },
];

function show(stage: string, details: Record<string, boolean | number | string> = {}): void {
  const element = document.getElementById('result');
  if (element) element.textContent = JSON.stringify({ stage, ...details }, null, 2);
}
function requireState(condition: unknown): asserts condition {
  if (!condition) throw new Error('fixture-invariant');
}
async function leaseFingerprint(leaseId: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(leaseId));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function assertLease(leaseId: string, profileId: string): Promise<void> {
  const current = await verifyProjectModelMaintenanceLease(leaseId);
  requireState(current.leaseId === leaseId && current.profileId === profileId && current.mode === 'isolated-fixture'
    && current.productionAllowed === false && current.coldStart === true && typeof current.fixtureArchiveContainer === 'boolean');
}
function open(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reason: string) => { if (!settled) { settled = true; reject(new Error(reason)); } };
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    request.onupgradeneeded = (event) => {
      if (settled || version !== 27 || event.oldVersion !== 0) { request.transaction?.abort(); return; }
      for (const store of ['projects', 'metadata', 'agentTasks']) request.result.createObjectStore(store, { keyPath: 'id' });
    };
    request.onerror = () => fail('fixture-open-failed');
    request.onblocked = () => fail('fixture-open-blocked');
    request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; resolve(request.result); };
  });
}
async function seed(name: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const fail = (reason: string) => { if (!settled) { settled = true; reject(new Error(reason)); } };
    const request = indexedDB.open(name, 27);
    request.onupgradeneeded = (event) => {
      if (settled || event.oldVersion !== 0) { request.transaction?.abort(); return; }
      for (const store of ['projects', 'metadata', 'agentTasks']) request.result.createObjectStore(store, { keyPath: 'id' });
    };
    request.onerror = () => fail('fixture-seed-failed');
    request.onblocked = () => fail('fixture-seed-blocked');
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      resolve(request.result);
    };
  });
  try {
    requireState(database.version === 27
      && projectModelSourceToken(Array.from(database.objectStoreNames)) === projectModelSourceToken(['agentTasks', 'metadata', 'projects']));
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['projects', 'metadata', 'agentTasks'], 'readwrite');
      const names = ['projects', 'metadata', 'agentTasks'] as const;
      const expected: readonly unknown[][] = [
        [...records].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        [originalMetadata], [originalReceipt],
      ];
      const stores = names.map((storeName) => tx.objectStore(storeName));
      if (stores.some((store) => store.keyPath !== 'id' || store.autoIncrement || store.indexNames.length !== 0)) {
        tx.abort();
      } else {
        const reads = stores.map((store) => store.getAll());
        let finished = 0;
        for (const read of reads) read.onsuccess = () => {
          if (++finished !== reads.length) return;
          try {
            const states = reads.map((item, index) => item.result.length === 0 ? 'empty' as const
              : projectModelSourceToken(item.result) === projectModelSourceToken(expected[index]) ? 'original' as const : 'unknown' as const);
            const decision = decideFixtureSeed(states);
            if (decision === 'blocked') { tx.abort(); return; }
            if (decision === 'seed') {
              for (const record of records) stores[0].add(record);
              stores[1].add(originalMetadata);
              stores[2].add(originalReceipt);
            }
          } catch { tx.abort(); }
        };
      }
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error('fixture-seed-transaction-failed'));
    });
  } finally { database.close(); }
}
function all(database: IDBDatabase, store: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, 'readonly');
    const request = transaction.objectStore(store).getAll();
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(new Error('fixture-read-failed'));
  });
}
async function advanceReceipts(databaseName: string, leaseId: string, profileId: string): Promise<void> {
  const database = await open(databaseName);
  try {
    await assertLease(leaseId, profileId);
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['metadata', 'agentTasks'], 'readwrite');
      tx.objectStore('metadata').put(updatedMetadata);
      tx.objectStore('agentTasks').put(updatedReceipt);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error('fixture-receipt-update-failed'));
    });
  } finally { database.close(); }
  await assertLease(leaseId, profileId);
  localStorage.setItem(PENDING, UPDATED_QUEUE);
}
async function inspectJournal(databaseName: string) {
  const database = await open(databaseName);
  try { return await createProjectModelStagingRepository(database).readJournal(OPERATION); }
  finally { database.close(); }
}
async function inspectSideState(databaseName: string, journal: ProjectModelStagingJournal): Promise<'original' | 'updated'> {
  const database = await open(databaseName);
  try {
    const source = await all(database, 'projects');
    const metadata = await all(database, 'metadata') as Array<{ id?: string; operationId?: string; state?: string }>;
    const receipts = await all(database, 'agentTasks');
    const frozen = metadata.filter((entry) => entry.id === PROJECT_MODEL_SOURCE_FREEZE_KEY);
    const expectedFreeze = journal.stage === 'rolled_back' ? [] : [{ id: PROJECT_MODEL_SOURCE_FREEZE_KEY,
      operationId: OPERATION, generation: journal.generation, sourceDigest: journal.sourceDigest, state: 'frozen' }];
    requireState(journal.operationId === OPERATION && journal.generation === 1
      && projectModelSourceToken(source) === projectModelSourceToken([...records].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      && projectModelSourceToken(frozen) === projectModelSourceToken(expectedFreeze));
    const savedMetadata = metadata.filter((entry) => entry.id !== PROJECT_MODEL_SOURCE_FREEZE_KEY);
    if (projectModelSourceToken(receipts) === projectModelSourceToken([originalReceipt])
      && projectModelSourceToken(savedMetadata) === projectModelSourceToken([originalMetadata])) return 'original';
    if (projectModelSourceToken(receipts) === projectModelSourceToken([updatedReceipt])
      && projectModelSourceToken(savedMetadata) === projectModelSourceToken([updatedMetadata])) return 'updated';
    throw new Error('fixture-side-state-unknown');
  } finally { database.close(); }
}
async function verifyOriginalBackup(databaseName: string, leaseId: string): Promise<void> {
  await verifyNativeProjectModelBackupSeal(leaseId, OPERATION);
  const backup = await readVerifiedProjectModelBackup(await openNativeProjectModelBackupPort(leaseId, OPERATION));
  const original = (name: string) => backup.source.stores.find((store) => store.name === name)?.records.map((entry) => entry.value);
  requireState(backup.source.databaseName === databaseName && backup.source.schemaVersion === 27
    && projectModelSourceToken(backup.source.databaseStoreNames) === projectModelSourceToken(['agentTasks', 'metadata', 'projects'])
    && projectModelSourceToken(original('projects')) === projectModelSourceToken([...records].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    && projectModelSourceToken(original('metadata')) === projectModelSourceToken([originalMetadata])
    && projectModelSourceToken(original('agentTasks')) === projectModelSourceToken([originalReceipt])
    && projectModelSourceToken(backup.source.localStorage) === projectModelSourceToken([{ key: PENDING, value: QUEUE }]));
}
async function verifyRollback(databaseName: string, leaseId: string): Promise<void> {
  const database = await open(databaseName);
  try {
    const source = await all(database, 'projects');
    const metadata = await all(database, 'metadata');
    const receipts = await all(database, 'agentTasks');
    const journal = await createProjectModelStagingRepository(database).readJournal(OPERATION);
    requireState(database.version === 28 && journal?.stage === 'rolled_back' && journal.generation === 1
      && projectModelSourceToken(source) === projectModelSourceToken([...records].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      && projectModelSourceToken(receipts) === projectModelSourceToken([updatedReceipt])
      && projectModelSourceToken(metadata) === projectModelSourceToken([updatedMetadata]));
    for (const store of PROJECT_MODEL_GENERATION_STORES) requireState((await all(database, store)).length === 0);
  } finally { database.close(); }
  await verifyOriginalBackup(databaseName, leaseId);
  requireState(localStorage.getItem(PENDING) === UPDATED_QUEUE);
}
async function run(): Promise<void> {
  // 在首次读写任何 IndexedDB/localStorage 之前取得原生独占租约。
  const lease = await getProjectModelMaintenanceLease();
  requireState(lease.mode === 'isolated-fixture' && lease.productionAllowed === false && lease.coldStart === true
    && typeof lease.fixtureArchiveContainer === 'boolean' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(lease.profileId));
  const databaseName = `ai-canvas-model-fixture-${lease.profileId}`;
  const input = { databaseName, operationId: OPERATION, generation: 1, batchSize: 1, localStorage };
  let phase = localStorage.getItem(PHASE);
  if (phase === null) {
    const previous = localStorage.getItem(PRIOR_LEASE);
    const fingerprint = await leaseFingerprint(lease.leaseId);
    // 标记先于 phase 落盘时必须换原生租约；未知队列一律保留，不能覆盖。
    requireState((previous === null || /^[a-f0-9]{64}$/.test(previous) && previous !== fingerprint)
      && (localStorage.getItem(PENDING) === null || localStorage.getItem(PENDING) === QUEUE));
    await assertLease(lease.leaseId, lease.profileId);
    await seed(databaseName);
    await assertLease(lease.leaseId, lease.profileId);
    localStorage.setItem(PENDING, QUEUE);
    localStorage.setItem(PRIOR_LEASE, fingerprint);
    localStorage.setItem(PHASE, 'seeding-complete');
    const original = IDBObjectStore.prototype.add;
    let planned = 0;
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      if (this.transaction.db.name === databaseName
        && PROJECT_MODEL_GENERATION_STORES.includes(this.name as typeof PROJECT_MODEL_GENERATION_STORES[number]) && ++planned === 2) {
        throw new DOMException('fixture quota', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
    let failed = false;
    try { await stageProjectModelFixture(input); }
    catch (error) { failed = error instanceof ProjectModelStagingError && error.code === 'staging-failed'; }
    finally { IDBObjectStore.prototype.add = original; }
    requireState(failed);
    const database = await open(databaseName);
    try {
      const journal = await createProjectModelStagingRepository(database).readJournal(OPERATION);
      requireState(journal?.stage === 'failed' && journal.nextRow === 1 && journal.activationAllowed === false);
    } finally { database.close(); }
    await verifyNativeProjectModelBackupSeal(lease.leaseId, OPERATION);
    // 只保留不可反向使用的摘要；同一窗口刷新不能冒充新的原生冷启动租约。
    await assertLease(lease.leaseId, lease.profileId);
    localStorage.setItem(PHASE, 'restart-required');
    show('restart-required', { backupSealed: true, stagedRows: 1, archiveContainers: lease.fixtureArchiveContainer, formalActivation: false });
    return;
  }
  if (phase === 'seeding-complete') {
    // 异常已进入 journal 但 UI checkpoint 尚未落盘时，只采纳能逐项读回的原操作。
    const priorLease = localStorage.getItem(PRIOR_LEASE);
    requireState(!!priorLease && /^[a-f0-9]{64}$/.test(priorLease)
      && priorLease !== await leaseFingerprint(lease.leaseId) && localStorage.getItem(PENDING) === QUEUE);
    const journal = await inspectJournal(databaseName);
    requireState(journal?.stage === 'failed' && journal.failureCode === 'transaction-failed'
      && journal.nextRow === 1 && journal.activationAllowed === false
      && await inspectSideState(databaseName, journal) === 'original');
    await verifyOriginalBackup(databaseName, lease.leaseId);
    await assertLease(lease.leaseId, lease.profileId);
    localStorage.setItem(PHASE, 'restart-required');
    phase = 'restart-required';
  }
  if (phase === 'complete') {
    await verifyRollback(databaseName, lease.leaseId);
    show('complete', { sourceRecords: records.length, backupSealed: true, rolledBack: true, archiveContainers: lease.fixtureArchiveContainer, formalActivation: false });
    return;
  }
  // 若任一 checkpoint 没有完整提交，不猜测原操作是否发生，也不覆盖备份。
  const priorLease = localStorage.getItem(PRIOR_LEASE);
  const currentLease = await leaseFingerprint(lease.leaseId);
  requireState(phase === 'restart-required' && !!priorLease && /^[a-f0-9]{64}$/.test(priorLease) && priorLease !== currentLease);
  await assertLease(lease.leaseId, lease.profileId);
  localStorage.setItem(PRIOR_LEASE, currentLease);
  const journal = await inspectJournal(databaseName);
  requireState(journal);
  const side = await inspectSideState(databaseName, journal);
  const rawQueue = localStorage.getItem(PENDING);
  const queue = rawQueue === QUEUE ? 'original' : rawQueue === UPDATED_QUEUE ? 'updated' : 'unknown';
  const decision = decideFixtureRecovery(journal?.stage, side, queue);
  if (decision === 'verify-rollback') {
    // 回滚已提交而完成标记未保存时，仅读回原材料，不重发暂存或重建备份。
    requireState(rawQueue === UPDATED_QUEUE);
  } else {
    if (decision === 'complete-queue' || decision === 'rollback') {
      // 后到回执事务已提交；只有原/新两种已知队列可证明，其他状态失败关闭。
      await verifyOriginalBackup(databaseName, lease.leaseId);
      if (decision === 'complete-queue') {
        await assertLease(lease.leaseId, lease.profileId);
        localStorage.setItem(PENDING, UPDATED_QUEUE);
      }
    } else {
      // 合成队列先于账本变化不符合本演练的写入顺序，不能猜测如何恢复。
      requireState(decision === 'resume');
      const staged = await stageProjectModelFixture({ ...input, resume: true });
      requireState(staged.stage === 'ready' && staged.stagedRows === staged.totalRows && !staged.canActivate && !staged.canRestoreContent);
      // 在已暂存的隔离库中模拟后到回执，验证撤销不回滚预算、原操作与待续队列。
      await advanceReceipts(databaseName, lease.leaseId, lease.profileId);
    }
    const rolled = await rollbackProjectModelFixtureStaging(input);
    requireState(rolled.stage === 'rolled_back' && !rolled.canActivate && !rolled.canRestoreContent);
  }
  await verifyRollback(databaseName, lease.leaseId);
  await assertLease(lease.leaseId, lease.profileId);
  localStorage.setItem(PHASE, 'complete');
  show('complete', { sourceRecords: records.length, backupSealed: true, rolledBack: true, archiveContainers: lease.fixtureArchiveContainer, formalActivation: false });
}
void run().catch((error: unknown) => show('blocked', {
  reason: error instanceof ProjectModelStagingError ? error.code : 'fixture-invariant-or-io', formalActivation: false,
}));
