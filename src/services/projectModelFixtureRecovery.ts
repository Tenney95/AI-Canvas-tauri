/** 固定合成演练的跨 IDB/localStorage 恢复决策，不适用于正式数据或真实回执。 */
export type FixtureSideState = 'original' | 'updated' | 'unknown';
export type FixtureQueueState = 'original' | 'updated' | 'unknown';
export type FixtureRecoveryDecision = 'resume' | 'complete-queue' | 'rollback' | 'verify-rollback' | 'blocked';

/** 首次样本的三张表只能全空或与固定样本全部一致，不能修补部分数据。 */
export function decideFixtureSeed(stores: readonly ('empty' | 'original' | 'unknown')[]): 'seed' | 'reuse' | 'blocked' {
  if (stores.length !== 3) return 'blocked';
  if (stores.every((state) => state === 'empty')) return 'seed';
  if (stores.every((state) => state === 'original')) return 'reuse';
  return 'blocked';
}

export function decideFixtureRecovery(stage: string | undefined, side: FixtureSideState, queue: FixtureQueueState): FixtureRecoveryDecision {
  // 续接仍由 staging 服务核验备份、seal、原操作、冻结标记及每批数据。
  if (['failed', 'staging', 'verifying'].includes(stage ?? '') && side === 'original' && queue === 'original') return 'resume';
  if (stage === 'ready') {
    if (side === 'original' && queue === 'original') return 'resume';
    if (side === 'updated' && queue === 'original') return 'complete-queue';
    if (side === 'updated' && queue === 'updated') return 'rollback';
  }
  if (stage === 'rolled_back' && side === 'updated' && queue === 'updated') return 'verify-rollback';
  return 'blocked';
}
