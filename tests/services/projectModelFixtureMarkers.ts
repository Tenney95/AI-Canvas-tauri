import { PROJECT_MODEL_BUSINESS_FIXTURE_KEY, type ProjectModelFixtureBusinessSession } from '../../src/types/projectModelBusiness';
import type { ProjectModelStagingJournal } from '../../src/types/projectModelJournal';

/** 复现早期隔离业务仓储写入的标记，用来验证历史备份和迁移保护。 */
export async function seedHistoricalBusinessMarker(database: IDBDatabase, journal: ProjectModelStagingJournal): Promise<void> {
  const marker: ProjectModelFixtureBusinessSession = {
    id: PROJECT_MODEL_BUSINESS_FIXTURE_KEY,
    operationId: journal.operationId,
    generation: journal.generation,
    sessionId: 'historical-business-session',
    sourceJournalSequence: journal.sequence,
    sourceDigest: journal.sourceDigest,
    targetManifestDigest: journal.manifestDigest,
    revision: 1,
    dirty: true,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').add(marker);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
