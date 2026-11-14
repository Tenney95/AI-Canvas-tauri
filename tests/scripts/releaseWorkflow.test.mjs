/** 发布证明只绑定可信提交；下载产物的内容清单在各平台重新核对。 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublishable, inspectSourceCi, resolveReleaseTarget, resolveTagCommit, stampFrontend,
  validateReleaseMetadata, validateTag, verifyFrontend, waitForSourceCi } from '../../scripts/release-workflow.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const context = { repository: 'owner/repo', branch: 'master', sha, tag: 'v1.2.3' };

function fixture() {
  const workflow = { id: 17, path: '.github/workflows/ci.yml', state: 'active' };
  const run = { id: 71, workflow_id: 17, path: workflow.path, event: 'push', head_branch: 'master', head_sha: sha,
    repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'owner/repo' },
    status: 'completed', conclusion: 'success', run_attempt: 1 };
  const jobs = ['Frontend quality', 'Rust check', 'Full source quality'].map((name) => ({ name, head_sha: sha, status: 'completed', conclusion: 'success' }));
  const artifact = { id: 90, name: `frontend-dist-${sha}-1`, expired: false, size_in_bytes: 500,
    digest: `sha256:${'c'.repeat(64)}`, workflow_run: { id: 71, head_sha: sha } };
  const state = { workflow, runs: [run], jobs, artifacts: [artifact], tagSha: sha, release: null };
  const api = vi.fn(async (path) => {
    if (path === '/actions/workflows/ci.yml') return state.workflow;
    if (path.startsWith('/actions/workflows/17/runs?')) return { workflow_runs: state.runs };
    if (path === `/actions/runs/71/attempts/${state.runs[0].run_attempt}/jobs?per_page=100`) return { jobs: state.jobs };
    if (path === '/actions/runs/71/artifacts?per_page=100') return { artifacts: state.artifacts };
    if (path === '/git/ref/tags/v1.2.3') return { object: { type: 'commit', sha: state.tagSha } };
    if (path === '/releases/tags/v1.2.3') return 'byTag' in state ? state.byTag : state.release;
    if (path === '/releases?per_page=100&page=1') return state.releases ?? (state.release ? [state.release] : []);
    throw new Error(`Unexpected fixture API path: ${path}`);
  });
  return { state, api };
}

function metadata() {
  return { package: JSON.stringify({ version: '1.2.3' }), tauri: JSON.stringify({ version: '1.2.3' }),
    npmLock: JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }),
    cargo: '[package]\nname = "ai-canvas-tauri"\nversion = "1.2.3"\n\n[lib]\n',
    cargoLock: 'version = 4\n\n[[package]]\nname = "ai-canvas-tauri"\nversion = "1.2.3"\n',
    title: 'AI Canvas v1.2.3 - 剧本写作\n', notes: '## 版本摘要\n\nAI Canvas v1.2.3 完善写作。\n' };
}

describe('发布目标与不可变标签', () => {
  it.each(['master', 'v1.2', 'v1.2.3-rc.1', 'v01.2.3', '../v1.2.3', 'v1.2.3\n'])('拒绝非正式版本标签 %j', (tag) => {
    expect(() => validateTag(tag)).toThrow();
  });

  it('解析注释标签，同时限制异常嵌套和非提交对象', async () => {
    const api = vi.fn().mockResolvedValueOnce({ object: { type: 'tag', sha: otherSha } })
      .mockResolvedValueOnce({ object: { type: 'commit', sha } });
    await expect(resolveTagCommit(api, 'v1.2.3')).resolves.toBe(sha);
    expect(api).toHaveBeenNthCalledWith(2, `/git/tags/${otherSha}`);
    await expect(resolveTagCommit(async () => ({ object: { type: 'tree', sha } }), 'v1.2.3')).rejects.toThrow('没有指向');
    await expect(resolveTagCommit(async () => ({ object: { type: 'tag', sha } }), 'v1.2.3')).rejects.toThrow('嵌套层数');
  });

  it('版本、标题或说明不一致时拒绝发布，保留目标标签自己的文案', () => {
    const files = metadata();
    expect(validateReleaseMetadata('v1.2.3', files)).toMatchObject({ version: '1.2.3', title: 'AI Canvas v1.2.3 - 剧本写作' });
    for (const key of ['package', 'tauri', 'npmLock', 'cargo', 'cargoLock']) {
      expect(() => validateReleaseMetadata('v1.2.3', { ...files, [key]: files[key].replaceAll('1.2.3', '1.2.4') })).toThrow('五份版本');
    }
    expect(() => validateReleaseMetadata('v1.2.3', { ...files, title: 'AI Canvas v2.0.0 - 后续版本' })).toThrow('标题');
    expect(() => validateReleaseMetadata('v1.2.3', { ...files, notes: 'AI Canvas v2.0.0' })).toThrow('发布说明');
  });

  it('非默认分支的手动发布在读取标签和文案前拒绝', async () => {
    const { api } = fixture();
    await expect(resolveReleaseTarget(api, { tag: 'v1.2.3', defaultBranch: 'master', ref: 'refs/heads/other' })).rejects.toThrow('默认分支');
    expect(api).not.toHaveBeenCalled();
  });

  it('公开版本、错提交的草稿、移动的标签以及缺失标准平台草稿都不能继续写入', async () => {
    const { state, api } = fixture();
    await expect(assertPublishable(api, 'v1.2.3', sha)).resolves.toBeUndefined();
    await expect(assertPublishable(api, 'v1.2.3', sha, true)).rejects.toThrow('没有创建发布草稿');
    state.release = { id: 9, tag_name: 'v1.2.3', draft: false, prerelease: false, target_commitish: sha };
    await expect(assertPublishable(api, 'v1.2.3', sha)).rejects.toThrow('已公开');
    state.release.draft = true; state.release.target_commitish = otherSha;
    await expect(assertPublishable(api, 'v1.2.3', sha)).rejects.toThrow('没有绑定');
    state.release.target_commitish = sha;
    await expect(assertPublishable(api, 'v1.2.3', sha, true)).resolves.toBeUndefined();
    state.tagSha = otherSha;
    await expect(assertPublishable(api, 'v1.2.3', sha)).rejects.toThrow('标签已改变');
  });

  it('按 tag 查询 404 时从列表发现唯一草稿，拒绝公开记录、重复记录与错误提交', async () => {
    const { state, api } = fixture();
    state.byTag = null;
    const draft = { id: 9, tag_name: 'v1.2.3', draft: true, prerelease: false, target_commitish: sha };
    state.releases = [draft];
    await expect(assertPublishable(api, 'v1.2.3', sha, true)).resolves.toBeUndefined();
    state.releases = [{ ...draft, draft: false }];
    await expect(assertPublishable(api, 'v1.2.3', sha, true)).rejects.toThrow('已公开');
    state.releases = [draft, { ...draft, id: 10 }];
    await expect(assertPublishable(api, 'v1.2.3', sha, true)).rejects.toThrow('多个发布记录');
    state.releases = [{ ...draft, target_commitish: otherSha }];
    await expect(assertPublishable(api, 'v1.2.3', sha, true)).rejects.toThrow('没有绑定');
  });
});

describe('可信源码 CI 与前端 artifact 证明', () => {
  it('只接受同仓库默认分支 push 的准确工作流与 SHA', async () => {
    const { state, api } = fixture();
    await expect(inspectSourceCi(api, context)).resolves.toMatchObject({ status: 'success', runId: 71, artifactId: 90 });
    for (const changes of [{ head_sha: otherSha }, { event: 'pull_request' }, { head_branch: 'fork' },
      { head_repository: { full_name: 'fork/repo' } }, { repository: { full_name: 'other/repo' } },
      { workflow_id: 99 }, { path: '.github/workflows/fake.yml' }]) {
      const original = state.runs[0]; state.runs = [{ ...original, ...changes }];
      await expect(inspectSourceCi(api, context)).resolves.toEqual({ status: 'missing' });
      state.runs = [original];
    }
    state.workflow.path = '.github/workflows/fake.yml';
    await expect(inspectSourceCi(api, context)).rejects.toThrow('工作流身份');
  });

  it('最新运行未结束时等待，最新失败不能借旧成功继续发布', async () => {
    const { state, api } = fixture();
    const original = state.runs[0];
    state.runs = [original, { ...original, id: 72, status: 'in_progress', conclusion: null }];
    await expect(inspectSourceCi(api, context)).resolves.toEqual({ status: 'pending' });
    state.runs[1] = { ...state.runs[1], status: 'completed', conclusion: 'failure' };
    await expect(inspectSourceCi(api, context)).rejects.toThrow('源码 CI 未通过');
  });

  it('前端、Rust 和全量模式均须成功，日常 CI、缺失、跳过及错 SHA 都不能发布', async () => {
    const { state, api } = fixture();
    const original = state.jobs;
    for (const jobs of [original.slice(0, 2), [...original, original[0]],
      [original[0], { ...original[1], head_sha: otherSha }, original[2]],
      [...original.slice(0, 2), { ...original[2], conclusion: 'skipped' }]]) {
      state.jobs = jobs;
      await expect(inspectSourceCi(api, context)).rejects.toThrow('缺少完整前端、Rust 或全量模式成功证明');
      expect(api).not.toHaveBeenCalledWith('/actions/runs/71/artifacts?per_page=100');
    }
  });

  it('产物必须属于该运行与提交，且未过期、有固定名称及摘要', async () => {
    const { state, api } = fixture();
    const artifact = state.artifacts[0];
    for (const changes of [{ name: 'frontend-dist-other' }, { expired: true }, { workflow_run: { id: 71, head_sha: otherSha } },
      { workflow_run: { id: 72, head_sha: sha } }, { digest: '' }, { size_in_bytes: 0 }]) {
      state.artifacts = [{ ...artifact, ...changes }];
      await expect(inspectSourceCi(api, context)).rejects.toThrow('产物缺失、过期或身份不符');
    }
    state.artifacts = [artifact, artifact];
    await expect(inspectSourceCi(api, context)).rejects.toThrow('产物缺失');
  });

  it('重跑必须使用最新尝试的全量证明和新产物', async () => {
    const { state, api } = fixture();
    state.runs[0].run_attempt = 2;
    await expect(inspectSourceCi(api, context)).rejects.toThrow('重跑该源码 CI 的全部任务');
    expect(api).toHaveBeenCalledWith('/actions/runs/71/attempts/2/jobs?per_page=100');

    state.artifacts.push({ ...state.artifacts[0], id: 91, name: `frontend-dist-${sha}-2` });
    const jobs = state.jobs;
    state.jobs = jobs.filter(({ name }) => name !== 'Rust check');
    await expect(inspectSourceCi(api, context)).rejects.toThrow('全量模式成功证明');

    state.jobs = jobs;
    await expect(inspectSourceCi(api, context)).resolves.toMatchObject({ runId: 71, runAttempt: 2, artifactId: 91 });
  });

  it('原子推送时等待 CI 出现并完成，只读取回执；完成后仍复核标签未移动', async () => {
    const { state, api } = fixture();
    const run = state.runs[0]; state.runs = [];
    let time = 0;
    const statuses = [];
    const sleep = async (duration) => {
      time += duration;
      state.runs = [{ ...run, status: time === 30_000 ? 'in_progress' : 'completed' }];
    };
    await expect(waitForSourceCi(api, context, { now: () => time, sleep, timeoutMs: 90_000, onStatus: (status) => statuses.push(status) }))
      .resolves.toMatchObject({ artifactId: 90 });
    expect(statuses).toEqual(['missing', 'pending']);
    state.tagSha = otherSha;
    await expect(waitForSourceCi(api, context)).rejects.toThrow('标签已改变');
  });

  it('CI 一直缺失时有界等待并失败，不启动另一轮检查冒充结果', async () => {
    const { state, api } = fixture(); state.runs = [];
    let time = 0;
    await expect(waitForSourceCi(api, context, { now: () => time, sleep: async (duration) => { time += duration; }, timeoutMs: 60_000 }))
      .rejects.toThrow('等待同一提交的可信源码 CI 超时');
    expect(time).toBe(60_000);
    expect(api.mock.calls.every(([path]) => path.startsWith('/actions/workflows/'))).toBe(true);
  });
});

const temporaryDirectories = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(directory).startsWith('ai-canvas-release-')) throw new Error('Unsafe test cleanup target');
    await rm(directory, { recursive: true, force: true });
  }
});

async function frontend() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-canvas-release-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<html><script src="assets/app.js"></script></html>', 'utf8');
  await writeFile(join(directory, 'assets/app.js'), 'console.log("release");', 'utf8');
  return directory;
}

describe('跨平台复用的前端构建清单', () => {
  it('普通可见清单绑定源码和版本，每个文件均重新核对路径、大小和原始字节哈希', async () => {
    const directory = await frontend();
    const manifest = await stampFrontend(directory, sha, '1.2.3');
    expect(manifest.files).toHaveLength(2);
    expect(JSON.parse(await readFile(join(directory, 'release-frontend.json'), 'utf8')).sha).toBe(sha);
    await expect(verifyFrontend(directory, sha, '1.2.3')).resolves.toBeUndefined();
    await expect(verifyFrontend(directory, otherSha, '1.2.3')).rejects.toThrow('本次发布提交');
    await expect(verifyFrontend(directory, sha, '1.2.4')).rejects.toThrow('本次发布提交');
    await writeFile(join(directory, 'assets/app.js'), 'console.log("changed");', 'utf8');
    await expect(verifyFrontend(directory, sha, '1.2.3')).rejects.toThrow('内容与可信构建清单不一致');
  });

  it('缺少清单、文件被删或下载后夹带额外文件都拒绝打包', async () => {
    const directory = await frontend();
    await expect(verifyFrontend(directory, sha, '1.2.3')).rejects.toThrow();
    await stampFrontend(directory, sha, '1.2.3');
    await writeFile(join(directory, 'extra.js'), 'extra', 'utf8');
    await expect(verifyFrontend(directory, sha, '1.2.3')).rejects.toThrow('内容与可信构建清单不一致');
    await rm(join(directory, 'extra.js'));
    await rm(join(directory, 'assets/app.js'));
    await expect(verifyFrontend(directory, sha, '1.2.3')).rejects.toThrow('内容与可信构建清单不一致');
  });
});
