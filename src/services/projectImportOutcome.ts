/** 提交已完成或回执不明时阻断旧内存画布恢复写入；错误只携可移植操作身份。 */
export class ProjectImportCommittedError extends Error {
  readonly operationId: string;
  readonly ownerId: string;
  readonly outcome: 'committed' | 'unknown';

  constructor(operationId: string, ownerId: string, outcome: 'committed' | 'unknown', cause: unknown) {
    super(outcome === 'committed'
      ? `项目已提交，界面交接未确认；请按原操作 ${operationId} 重新读取，勿重复导入`
      : `项目提交结果尚未确认；请按原操作 ${operationId} 核对，已保留媒体，勿重复导入`, { cause });
    this.name = 'ProjectImportCommittedError';
    this.operationId = operationId;
    this.ownerId = ownerId;
    this.outcome = outcome;
  }
}

/** 只在尝试原子提交后使用；已知未提交保留原错误，读取失败不能推断事务未完成。 */
export async function throwProjectImportCommitFailure(error: unknown, operationId: string, ownerId: string,
  confirmed: boolean, readOperation: () => Promise<{ phase: string } | null>): Promise<never> {
  if (error instanceof ProjectImportCommittedError) throw error;
  if (confirmed) throw new ProjectImportCommittedError(operationId, ownerId, 'committed', error);
  let operation: { phase: string } | null;
  try { operation = await readOperation(); }
  catch { throw new ProjectImportCommittedError(operationId, ownerId, 'unknown', error); }
  if (!operation) throw new ProjectImportCommittedError(operationId, ownerId, 'unknown', error);
  if (['committed', 'db_committed', 'projected', 'finalized'].includes(operation.phase)) {
    throw new ProjectImportCommittedError(operationId, ownerId, 'committed', error);
  }
  throw error;
}
