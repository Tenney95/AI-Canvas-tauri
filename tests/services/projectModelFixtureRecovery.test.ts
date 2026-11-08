/** 固定合成演练的恢复决策；不打开数据库或模拟正式迁移。 */
import { describe, expect, it } from 'vitest';
import { decideFixtureRecovery, decideFixtureSeed } from '../../src/services/projectModelFixtureRecovery';

describe('fixture 首次样本恢复', () => {
  it('仅全空表可一次性写入，仅完整原始样本可重用', () => {
    expect(decideFixtureSeed(['empty', 'empty', 'empty'])).toBe('seed');
    expect(decideFixtureSeed(['original', 'original', 'original'])).toBe('reuse');
  });
  it('部分、未知或数量不符的表失败关闭', () => {
    for (const stores of [
      ['empty', 'original', 'empty'], ['original', 'unknown', 'original'],
      ['unknown', 'unknown', 'unknown'], ['empty', 'empty'], [],
    ] as const) expect(decideFixtureSeed(stores)).toBe('blocked');
  });
});

describe('fixture 账本与队列断点恢复', () => {
  it.each(['failed', 'staging', 'verifying', 'ready'])('在 %s 阶段，原账本和原队列只续接原操作', (stage) => {
    expect(decideFixtureRecovery(stage, 'original', 'original')).toBe('resume');
  });
  it('账本先提交但队列尚未写入时，只补已证明的固定队列再回滚', () => {
    expect(decideFixtureRecovery('ready', 'updated', 'original')).toBe('complete-queue');
  });
  it('账本和队列均已更新时直接回滚；已提交回滚只做读回复验', () => {
    expect(decideFixtureRecovery('ready', 'updated', 'updated')).toBe('rollback');
    expect(decideFixtureRecovery('rolled_back', 'updated', 'updated')).toBe('verify-rollback');
  });
  it.each([
    ['ready', 'original', 'updated'], ['failed', 'updated', 'original'], ['failed', 'updated', 'updated'],
    ['staging', 'updated', 'original'], ['staging', 'original', 'updated'], ['staging', 'updated', 'updated'],
    ['verifying', 'updated', 'original'], ['verifying', 'original', 'updated'], ['verifying', 'updated', 'updated'],
    ['staging', 'unknown', 'original'], ['verifying', 'original', 'unknown'],
    ['rolled_back', 'original', 'updated'], ['rolled_back', 'updated', 'original'],
    ['ready', 'unknown', 'original'], ['ready', 'updated', 'unknown'], ['quarantined', 'original', 'original'],
    [undefined, 'original', 'original'],
  ] as const)('未知、损坏或不符合写入顺序的状态 %s / %s / %s 失败关闭', (stage, side, queue) => {
    expect(decideFixtureRecovery(stage, side, queue)).toBe('blocked');
  });
});
