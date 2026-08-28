import type { AgentPackageInstallation } from '../../types/agentPackage';

export const AGENT_CATALOG_DB_NAME = 'ai-canvas-agent-catalog';
export const AGENT_CATALOG_DB_VERSION = 1;
export const AGENT_INSTALLATIONS_STORE = 'installations';

let catalogDbPromise: Promise<IDBDatabase> | null = null;

/** Open the optional Agent Catalog database without touching the core project DB. */
export function openAgentCatalogDb(): Promise<IDBDatabase> {
  if (catalogDbPromise) return catalogDbPromise;

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(AGENT_CATALOG_DB_NAME, AGENT_CATALOG_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AGENT_INSTALLATIONS_STORE)) {
        const store = db.createObjectStore(AGENT_INSTALLATIONS_STORE, { keyPath: 'id' });
        store.createIndex('packageId', 'packageId', { unique: true });
        store.createIndex('health', 'health', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        catalogDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Agent Catalog 数据库打开失败'));
  });

  catalogDbPromise = pending.catch((error) => {
    catalogDbPromise = null;
    throw error;
  });
  return catalogDbPromise;
}

export async function getAllAgentInstallations(): Promise<AgentPackageInstallation[]> {
  const db = await openAgentCatalogDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(AGENT_INSTALLATIONS_STORE, 'readonly')
      .objectStore(AGENT_INSTALLATIONS_STORE)
      .getAll();
    request.onsuccess = () => resolve(request.result as AgentPackageInstallation[]);
    request.onerror = () => reject(request.error ?? new Error('读取 Agent Catalog 失败'));
  });
}

export async function putAgentInstallation(record: AgentPackageInstallation): Promise<void> {
  const db = await openAgentCatalogDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AGENT_INSTALLATIONS_STORE, 'readwrite');
    transaction.objectStore(AGENT_INSTALLATIONS_STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error('保存 Agent Package 安装记录失败'),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error('保存 Agent Package 安装记录已中止'),
    );
  });
}

export async function deleteAgentInstallation(id: string): Promise<void> {
  const db = await openAgentCatalogDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AGENT_INSTALLATIONS_STORE, 'readwrite');
    transaction.objectStore(AGENT_INSTALLATIONS_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error('删除 Agent Package 安装记录失败'),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error('删除 Agent Package 安装记录已中止'),
    );
  });
}
