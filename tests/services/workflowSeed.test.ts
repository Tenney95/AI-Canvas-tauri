import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowSeed, isWorkflowSeedParameter, resolveWorkflowSeed, workflowSeedInputValue, WORKFLOW_RANDOM_SEED } from '../../src/services/workflowSeed';

const spec = { name: 'seed', label: '随机种子', type: 'integer' as const, min: 0, max: 99 };
afterEach(() => vi.restoreAllMocks());

describe('工作流种子模式', () => {
  it('打开面板不抽值；未指定默认随机，旧固定值和零保留', () => {
    const random = vi.spyOn(Math, 'random');
    expect(workflowSeedInputValue(spec, undefined, 42)).toBe(WORKFLOW_RANDOM_SEED);
    expect(workflowSeedInputValue(spec, '0', 42)).toBe('0');
    expect(workflowSeedInputValue(spec, '77', 42)).toBe('77');
    expect(random).not.toHaveBeenCalled();
  });
  it('每次新解析独立取值；已解析的值重复校验及固定值不抽取', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    expect(resolveWorkflowSeed(spec, undefined)).toBe(10);
    expect(resolveWorkflowSeed(spec, WORKFLOW_RANDOM_SEED)).toBe(90);
    expect(resolveWorkflowSeed(spec, 10)).toBe(10);
    expect(resolveWorkflowSeed(spec, '0')).toBe(0);
    expect(random).toHaveBeenCalledTimes(2);
  });
  it('上下限、安全整数边界、单值区间及旧 -1 标记均不发送非法数字', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(createWorkflowSeed({ ...spec, min: 10, max: 20 })).toBe(10);
    random.mockReturnValue(0.9999999999999999);
    expect(createWorkflowSeed({ ...spec, min: 10, max: 20 })).toBe(20);
    const large = createWorkflowSeed({ ...spec, max: 18446744073709551615 });
    expect(Number.isSafeInteger(large)).toBe(true);
    expect(large).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(createWorkflowSeed({ ...spec, min: 7, max: 7 })).toBe(7);
    expect(resolveWorkflowSeed(spec, '-1')).toBe(99);
    expect(() => createWorkflowSeed({ ...spec, min: 100, max: 99 })).toThrow('范围');
    expect(() => createWorkflowSeed({ ...spec, min: Number.MAX_SAFE_INTEGER + 1 })).toThrow('范围');
  });
  it.each(['', '0.5', '100', '9007199254740993', '-2', 'NaN'])('非法固定种子 %s 不改成随机', (value) => {
    const random = vi.spyOn(Math, 'random');
    expect(() => resolveWorkflowSeed(spec, value)).toThrow('非负安全整数');
    expect(random).not.toHaveBeenCalled();
  });
  it('未声明上限的保守随机子集不限制用户原有大整数固定值', () => {
    expect(resolveWorkflowSeed({ ...spec, max: undefined }, '110761519084224')).toBe(110761519084224);
  });
  it('只识别数字种子，不接管枚举、种子文本或其他数字字段', () => {
    expect(isWorkflowSeedParameter({ ...spec, name: 'task.noise_seed' })).toBe(true);
    for (const other of [{ ...spec, type: 'string' as const }, { ...spec, options: [0, 1] },
      { ...spec, name: 'steps', label: '总步数' }]) {
      expect(isWorkflowSeedParameter(other)).toBe(false);
      expect(resolveWorkflowSeed(other, undefined)).toBeUndefined();
    }
  });
});
