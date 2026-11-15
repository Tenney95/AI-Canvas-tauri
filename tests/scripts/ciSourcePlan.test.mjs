import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planSourceCi } from '../../scripts/ci-source-plan.mjs';

const baseline = vi.hoisted(() => vi.fn());
vi.mock('../../scripts/release-workflow.mjs', async (importOriginal) => ({
  ...await importOriginal(), findFullSourceBaseline: baseline,
}));

const sha = '1'.repeat(40), base = '2'.repeat(40);

function fixture() {
  return {
    input: { repository: 'example/ai-canvas', branch: 'master', event: 'push', ref: 'refs/tags/v1.2.3', sha, api: vi.fn() },
    state: {
      head: vi.fn(() => sha), isDefaultBranchAncestor: vi.fn(() => true), ancestors: vi.fn(() => [sha, base]),
      readPlan: vi.fn(() => ({ base, sha, mode: 'affected', rust: false, reason: '普通组件改动',
        lintFiles: ['src/components/Header.tsx'], relatedFiles: ['src/components/Header.tsx'], explicitTests: [], typecheck: true })),
    },
  };
}

beforeEach(() => {
  baseline.mockReset().mockResolvedValue({ sha: base, runId: 71, runAttempt: 1 });
});

describe('仅在版本打包时选择可靠检查范围', () => {
  it('使用可信完整祖先比较累计改动，普通改动只选择相关范围', async () => {
    const { input, state } = fixture();
    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'affected', rust: false, tag: 'v1.2.3',
      sha, base, schemaVersion: 1, release: true, typecheck: true, baselineRunId: 71 });
    expect(state.readPlan).toHaveBeenCalledExactlyOnceWith(base);
    expect(baseline).toHaveBeenCalledWith(input.api, { repository: input.repository, branch: 'master', ancestors: [base], excludeSha: sha });
  });

  it('高风险全量必须包含三平台 Rust；只有版本或文档改动交由冻结阶段保留类型与构建', async () => {
    const { input, state } = fixture();
    state.readPlan.mockReturnValueOnce({ base, sha, mode: 'full', rust: false, reason: '权限规则变化' });
    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'full', rust: true, reason: '权限规则变化' });
    state.readPlan.mockReturnValueOnce({ base, sha, mode: 'skip', rust: false, reason: '仅发布版本', lintFiles: [], relatedFiles: [], explicitTests: [] });
    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'skip', typecheck: true, base });
  });

  it('无基线、基线读取失败或差异身份不符时明确转全量', async () => {
    const { input, state } = fixture();
    baseline.mockResolvedValueOnce(null);
    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'full', rust: true, base: '' });
    expect(state.readPlan).not.toHaveBeenCalled();
    baseline.mockRejectedValueOnce(new Error('unavailable'));
    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'full', rust: true });
    state.readPlan.mockReturnValueOnce({ base: sha, sha, mode: 'affected' });
    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'full', rust: true });
    state.readPlan.mockReturnValueOnce({ base, sha: base, mode: 'affected' });
    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'full', rust: true });
  });

  it.each([
    { event: 'pull_request' }, { event: 'workflow_dispatch' }, { ref: 'refs/heads/master' },
    { ref: 'refs/heads/feature' }, { ref: 'refs/tags/not-a-release' }, { ref: 'refs/tags/v1.2.3-rc.1' },
    { ref: 'refs/tags/v01.2.3' }, { sha: '0'.repeat(40) }, { repository: '' }, { branch: '' },
  ])('非正式打包请求直接拒绝（%j）', async (overrides) => {
    const { input, state } = fixture();
    await expect(planSourceCi({ ...input, ...overrides }, state)).rejects.toThrow();
    expect(state.head).not.toHaveBeenCalled();
    expect(baseline).not.toHaveBeenCalled();
  });

  it('错误检出和默认分支以外的提交不能获得打包检查计划', async () => {
    const { input, state } = fixture();
    state.head.mockReturnValueOnce(base);
    await expect(planSourceCi(input, state)).rejects.toThrow('检出 SHA');
    expect(state.isDefaultBranchAncestor).not.toHaveBeenCalled();
    state.isDefaultBranchAncestor.mockReturnValueOnce(false);
    await expect(planSourceCi(input, state)).rejects.toThrow('不属于默认分支历史');
    expect(baseline).not.toHaveBeenCalled();
  });

  it('工作流保留标签触发、同次冻结计划、真实增量证明和完整前端产物', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const trigger = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
    expect(trigger).toContain("tags:\n      - 'v*'");
    expect(trigger).not.toMatch(/pull_request:|branches:|workflow_dispatch:|schedule:/);
    expect(workflow).toContain('node scripts/ci-source-plan.mjs finalize');
    expect(workflow).toContain('ci-plan-${{ github.sha }}-${{ github.run_attempt }}');
    expect(workflow).toContain('ci:affected -- --execute-plan release-ci-plan.json --build');
    expect(workflow).toContain('npm run test -- --shard=${{ matrix.shard }}');
    expect(workflow).toContain('cargo check --lib --locked');
    expect(workflow).toContain('Affected source quality ({0})');
    expect(workflow).toContain('frontend-dist-${{ github.sha }}-${{ github.run_attempt }}');
    expect(workflow).not.toContain('Source CI baseline');
  });
});
