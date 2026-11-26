/** 旧隔离备份和迁移保护使用的业务标记。 */
export const PROJECT_MODEL_BUSINESS_FIXTURE_KEY = 'project-model-business-fixture' as const;
export interface ProjectModelFixtureBusinessSession {
  id: typeof PROJECT_MODEL_BUSINESS_FIXTURE_KEY;
  operationId: string;
  generation: number;
  sessionId: string;
  sourceJournalSequence: number;
  sourceDigest: string;
  targetManifestDigest: string;
  revision: number;
  dirty: boolean;
}
