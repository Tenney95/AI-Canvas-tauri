import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { planSourceCi } from '../../scripts/ci-source-plan.mjs';

const sha = '1'.repeat(40);

function fixture() {
  return {
    input: { repository: 'example/ai-canvas', branch: 'master', event: 'push', ref: 'refs/tags/v1.2.3', sha },
    state: { head: vi.fn(() => sha), isDefaultBranchAncestor: vi.fn(() => true) },
  };
}

describe('仅在版本打包时运行源码 CI', () => {
  it('正式版本标签总是执行完整前端与三平台 Rust，不依赖按改动基线', () => {
    const { input, state } = fixture();
    expect(planSourceCi(input, state)).toMatchObject({ mode: 'full', rust: true, tag: 'v1.2.3', sha });
    expect(state.isDefaultBranchAncestor).toHaveBeenCalledExactlyOnceWith(sha, 'master');
  });

  it.each([
    { event: 'pull_request' }, { event: 'workflow_dispatch' }, { ref: 'refs/heads/master' },
    { ref: 'refs/heads/feature' }, { ref: 'refs/tags/not-a-release' }, { ref: 'refs/tags/v1.2.3-rc.1' },
    { ref: 'refs/tags/v01.2.3' }, { sha: '0'.repeat(40) }, { repository: '' }, { branch: '' },
  ])('非正式打包请求直接拒绝，不回退运行全量（%j）', (overrides) => {
    const { input, state } = fixture();
    expect(() => planSourceCi({ ...input, ...overrides }, state)).toThrow();
    expect(state.head).not.toHaveBeenCalled();
    expect(state.isDefaultBranchAncestor).not.toHaveBeenCalled();
  });

  it('错误检出和默认分支以外的提交不能获得打包检查计划', () => {
    const { input, state } = fixture();
    state.head.mockReturnValueOnce('2'.repeat(40));
    expect(() => planSourceCi(input, state)).toThrow('检出 SHA');
    expect(state.isDefaultBranchAncestor).not.toHaveBeenCalled();
    state.isDefaultBranchAncestor.mockReturnValueOnce(false);
    expect(() => planSourceCi(input, state)).toThrow('不属于默认分支历史');
  });

  it('工作流仅订阅版本标签，保留完整检查与不可变前端产物', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const trigger = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
    expect(trigger).toContain("tags:\n      - 'v*'");
    expect(trigger).not.toMatch(/pull_request:|branches:|workflow_dispatch:|schedule:/);
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('run: node scripts/ci-source-plan.mjs');
    expect(workflow).toContain('npm run test -- --shard=${{ matrix.shard }}');
    expect(workflow).toContain('cargo check --lib --locked');
    expect(workflow).toContain('Full source quality');
    expect(workflow).toContain('frontend-dist-${{ github.sha }}-${{ github.run_attempt }}');
    expect(workflow).not.toContain('ci:affected');
    expect(workflow).not.toContain('Source CI baseline');
  });
});
