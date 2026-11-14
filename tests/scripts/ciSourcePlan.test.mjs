import { describe, expect, it, vi } from 'vitest';
import { planSourceCi } from '../../scripts/ci-source-plan.mjs';

const repository = 'example/ai-canvas';
const workflowPath = '.github/workflows/ci.yml';
const head = '1'.repeat(40);
const before = '2'.repeat(40);
const ancestor = '3'.repeat(40);
const unrelated = '4'.repeat(40);

function run(headSha, overrides = {}) {
  return {
    id: 21, run_attempt: 2, workflow_id: 4, event: 'push', path: workflowPath,
    head_branch: 'master', head_sha: headSha, repository: { full_name: repository },
    head_repository: { full_name: repository }, status: 'completed', conclusion: 'success',
    ...overrides,
  };
}

function fixture(runs, output = 'affected') {
  const api = vi.fn(async (path) => {
    if (path === '/actions/workflows/ci.yml') return { path: workflowPath, state: 'active', id: 4 };
    if (path.startsWith('/actions/workflows/4/runs?')) return { workflow_runs: runs };
    const match = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100$/.exec(path);
    const source = runs.find((item) => Number(match[1]) === item.id && Number(match[2]) === item.run_attempt);
    return { jobs: source?.jobs ?? [{
      name: 'Source CI baseline', head_sha: source?.head_sha, status: 'completed', conclusion: 'success',
    }] };
  });
  const input = { api, repository, branch: 'master', event: 'push', ref: 'refs/heads/master', sha: head, before, forced: 'false' };
  const state = {
    head: () => head,
    ancestors: vi.fn(() => [before, ancestor]),
    readPlan: vi.fn((base) => ({ mode: base === ancestor ? output : 'affected', rust: base === ancestor && output !== 'skip' })),
  };
  return { input, state, api };
}

describe('默认分支源码 CI 基线', () => {
  it('从最后一个可信祖先开始比较，保留失败或取消推送里的改动', async () => {
    const { input, state } = fixture([
      run(before, { id: 27, conclusion: 'cancelled' }),
      run(before, { id: 25, conclusion: 'failure' }),
      run(before, { id: 24 }), // 旧成功被同 SHA 的新运行替代
      run(unrelated, { id: 23 }),
      run(ancestor),
    ]);

    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'affected', base: ancestor, rust: true });
    expect(state.ancestors).toHaveBeenCalledWith(before);
    expect(state.readPlan.mock.calls).toEqual([[before], [ancestor]]);
  });

  it.each([
    { event: 'pull_request' },
    { ref: 'refs/heads/feature' },
    { forced: 'true' },
    { before: '0'.repeat(40) },
  ])('特殊事件完整检查（%j）', async (overrides) => {
    const { input, state, api } = fixture([run(before)]);
    await expect(planSourceCi({ ...input, ...overrides }, state)).resolves.toMatchObject({ mode: 'full', rust: true });
    expect(api).not.toHaveBeenCalled();
  });

  it('推送包含发版或共享资料时总是全量，独立于近期成功记录', async () => {
    const { input, state, api } = fixture([run(before)]);
    state.readPlan.mockReturnValueOnce({ mode: 'full' });

    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'full', base: '', rust: true });
    expect(api).not.toHaveBeenCalled();
  });

  it('独立文档的受影响回执可作为下一次成功基线', async () => {
    const { input, state, api } = fixture([run(ancestor)], 'skip');

    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'skip', base: ancestor, rust: false });
    expect(api).toHaveBeenCalledWith('/actions/runs/21/attempts/2/jobs?per_page=100');
  });

  it('排除外部、PR、旧版和当前尝试缺少成功证明的回执', async () => {
    const { input, state } = fixture([
      run(before, { id: 24, head_repository: { full_name: 'fork/ai-canvas' } }),
      run(before, { id: 23, event: 'pull_request' }),
      run(before, { id: 22, jobs: [] }),
      run(ancestor, { jobs: [{ name: 'Source CI baseline', head_sha: ancestor, status: 'completed', conclusion: 'skipped' }] }),
    ]);

    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'full', base: '', rust: true });
  });

  it('无法查询 GitHub 或范围计算失败时回退完整 CI', async () => {
    const { input, state, api } = fixture([run(before)]);
    api.mockRejectedValueOnce(new Error('unavailable'));
    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'full', rust: true });
    state.readPlan.mockImplementationOnce(() => { throw new Error('history unavailable'); });
    await expect(planSourceCi(input, state)).resolves.toMatchObject({ mode: 'full', rust: true });
  });
});
