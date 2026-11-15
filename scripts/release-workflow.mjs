/** 发布只接受同一提交的可信 CI 与前端产物；脚本不读取签名私钥。 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const VERSION = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)';
const TAG = new RegExp(`^v${VERSION}$`);
const FRONTEND_MANIFEST = 'release-frontend.json';
const requiredJobs = ['Frontend quality', 'Rust check'];
const FULL_QUALITY = 'Full source quality';
const AFFECTED_QUALITY = /^Affected source quality \(([a-f0-9]{40})\)$/;
const PROOF_ERROR = '源码 CI 缺少前端、Rust 或明确检查模式的成功证明';

export function validateTag(tag) {
  if (typeof tag !== 'string' || !TAG.test(tag) || tag.trim() !== tag || tag.length > 80) throw new Error('只接受 vX.Y.Z 格式的正式版本标签');
  return tag;
}

function validSha(sha) {
  if (typeof sha !== 'string' || sha.length !== 40 || !SHA.test(sha)) throw new Error('发布提交 SHA 无效');
  return sha;
}

export function createGitHubApi(repository, token, fetcher = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) throw new Error('GitHub 发布上下文不可用');
  return async (path, allowMissing = false) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub 发布证明读取失败（HTTP ${response.status}），未继续发布`);
    return response.json();
  };
}

export async function resolveTagCommit(api, tag) {
  validateTag(tag);
  let object = (await api(`/git/ref/tags/${encodeURIComponent(tag)}`))?.object;
  for (let depth = 0; depth < 4; depth += 1) {
    if (object?.type === 'commit') return validSha(object.sha);
    if (object?.type !== 'tag' || typeof object.sha !== 'string' || object.sha.length !== 40 || !SHA.test(object.sha)) throw new Error('标签没有指向受支持的提交');
    object = (await api(`/git/tags/${object.sha}`))?.object;
  }
  throw new Error('标签嵌套层数超过发布限制');
}

export async function assertPublishable(api, tag, sha, requireDraft = false) {
  if (await resolveTagCommit(api, tag) !== validSha(sha)) throw new Error('发布标签已改变，拒绝上传或公开');
  const byTag = await api(`/releases/tags/${encodeURIComponent(tag)}`, true);
  if (byTag && (byTag.tag_name !== tag || byTag.draft !== true || byTag.prerelease === true)) throw new Error('该版本已公开或发布身份不符，禁止改写');
  // GitHub 的按 tag 查询不能可靠返回草稿；与 Tauri Action 一样分页读取发布列表。
  const matches = new Map();
  if (byTag) {
    if (!Number.isSafeInteger(byTag.id) || byTag.id < 1) throw new Error('发布记录身份无效');
    matches.set(byTag.id, byTag);
  }
  for (let page = 1; page <= 20; page += 1) {
    const releases = await api(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('发布草稿列表无效');
    for (const release of releases.filter((item) => item.tag_name === tag)) {
      if (!Number.isSafeInteger(release.id) || release.id < 1) throw new Error('发布记录身份无效');
      if (release.draft !== true || release.prerelease === true) throw new Error('该版本已公开或发布身份不符，禁止改写');
      if (release.target_commitish !== sha) throw new Error('已有发布草稿没有绑定本次提交，拒绝改写');
      matches.set(release.id, release);
    }
    if (matches.size > 1) throw new Error('同一标签存在多个发布记录，拒绝改写');
    if (releases.length < 100) break;
    if (page === 20) throw new Error('发布草稿列表超过读取范围，未继续发布');
  }
  const release = matches.values().next().value;
  if (!release) {
    if (requireDraft) throw new Error('标准平台没有创建发布草稿，拒绝公开');
    return;
  }
  if (release.tag_name !== tag || release.draft !== true || release.prerelease === true) throw new Error('该版本已公开或发布身份不符，禁止改写');
  if (release.target_commitish !== sha) throw new Error('已有发布草稿没有绑定本次提交，拒绝改写');
}

async function sourceText(api, path, sha) {
  const file = await api(`/contents/${path}?ref=${validSha(sha)}`);
  if (!file || file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > 1_000_000) {
    throw new Error('目标提交的发布资料不可用');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.content, 'base64'));
}

export function validateReleaseMetadata(tag, files) {
  const version = validateTag(tag).slice(1);
  const pkg = JSON.parse(files.package);
  const tauri = JSON.parse(files.tauri);
  const lock = JSON.parse(files.npmLock);
  const cargoVersion = files.cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoLockVersion = files.cargoLock.match(/\[\[package\]\]\s*\nname = "ai-canvas-tauri"\s*\nversion = "([^"]+)"/)?.[1];
  if ([pkg.version, tauri.version, lock.version, lock.packages?.['']?.version, cargoVersion, cargoLockVersion].some((value) => value !== version)) {
    throw new Error('标签与五份版本资料不一致，拒绝发布');
  }
  const title = files.title.trim();
  if (!title.startsWith(`AI Canvas ${tag} - `) || !title.slice(`AI Canvas ${tag} - `.length).trim()
    || title.length > 200 || /[\r\n\x00-\x1f\x7f]/.test(title)) throw new Error('发布标题与目标标签不一致');
  const notes = files.notes.trim();
  if (!notes || notes.length > 100_000 || !notes.includes(`AI Canvas ${tag}`)) throw new Error('发布说明缺失或与目标版本不一致');
  return { tag, version, title, notes };
}

export async function resolveReleaseTarget(api, { tag, defaultBranch, ref }) {
  if (!defaultBranch || ref !== `refs/heads/${defaultBranch}`) throw new Error('实际发布必须从默认分支调度');
  const sha = await resolveTagCommit(api, tag);
  const comparison = await api(`/compare/${sha}...${encodeURIComponent(defaultBranch)}`);
  if (!['ahead', 'identical'].includes(comparison?.status) || comparison.base_commit?.sha !== sha
    || comparison.merge_base_commit?.sha !== sha) throw new Error('发布标签提交不属于默认分支历史，拒绝发布');
  await assertPublishable(api, tag, sha);
  const paths = { package: 'package.json', tauri: 'src-tauri/tauri.conf.json', npmLock: 'package-lock.json',
    cargo: 'src-tauri/Cargo.toml', cargoLock: 'src-tauri/Cargo.lock', title: '.github/release-title.txt', notes: '.release-notes.md' };
  const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await sourceText(api, path, sha)]));
  return { sha, ...validateReleaseMetadata(tag, Object.fromEntries(entries)) };
}

async function sourceWorkflow(api) {
  const workflow = await api('/actions/workflows/ci.yml');
  if (workflow?.path !== '.github/workflows/ci.yml' || workflow.state !== 'active'
    || !Number.isSafeInteger(workflow.id) || workflow.id < 1) throw new Error('源码 CI 工作流身份无效');
  return workflow;
}

function trustedSourceRun(run, workflow, repository) {
  return run?.event === 'push' && run.repository?.full_name === repository
    && run.head_repository?.full_name === repository && run.workflow_id === workflow.id
    && run.path === workflow.path && Number.isSafeInteger(run.id) && run.id > 0;
}

function trustedBaselineRun(run, workflow, repository, branch) {
  return trustedSourceRun(run, workflow, repository) && (run.head_branch === branch
    || (typeof run.head_branch === 'string' && run.head_branch.length <= 80
      && run.head_branch.trim() === run.head_branch && TAG.test(run.head_branch)));
}

async function workflowRuns(api, query, { allowTruncated = false } = {}) {
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await api(`${query}${page === 1 ? '' : `&page=${page}`}`);
    if (!Array.isArray(result?.workflow_runs)) throw new Error('源码 CI 运行清单无效');
    runs.push(...result.workflow_runs);
    if (result.workflow_runs.length < 100) return runs;
  }
  if (allowTruncated) return runs;
  throw new Error('源码 CI 运行历史超过读取范围，无法可靠确定检查证明');
}

async function attemptJobs(api, run) {
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('源码 CI 回执无效');
  const jobs = [];
  const query = `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
  for (let page = 1; page <= 10; page += 1) {
    const result = await api(`${query}${page === 1 ? '' : `&page=${page}`}`);
    if (!Array.isArray(result?.jobs)) throw new Error('源码 CI 作业清单无效');
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) return jobs;
  }
  throw new Error('源码 CI 作业超过读取范围，无法可靠确定检查证明');
}

function successfulJobs(jobs, names, sha) {
  return names.every((name) => {
    const matches = jobs.filter((job) => job.name === name);
    return matches.length === 1 && matches[0].status === 'completed'
      && matches[0].conclusion === 'success' && matches[0].head_sha === sha;
  });
}

function qualityJobs(jobs) {
  return jobs.filter((job) => job.name === FULL_QUALITY || job.name?.startsWith('Affected source quality'));
}

/** 仅完整检查可成为基线；增量、旧尝试及其他仓库的记录不能提升为完整证明。 */
export async function findFullSourceBaseline(api, { repository, branch, ancestors, excludeSha }) {
  if (!repository || !branch || !Array.isArray(ancestors) || ancestors.some((sha) => !SHA.test(sha))) {
    throw new Error('完整源码基线上下文无效');
  }
  const candidates = [...new Set(ancestors)].filter((sha) => sha !== excludeSha);
  if (!candidates.length) return null;
  const wanted = new Set(candidates);
  const workflow = await sourceWorkflow(api);
  const runs = await workflowRuns(api, `/actions/workflows/${workflow.id}/runs?event=push&per_page=100`, { allowTruncated: true });
  const latest = new Map();
  for (const run of runs.sort((a, b) => b.id - a.id)) {
    if (!trustedBaselineRun(run, workflow, repository, branch) || !wanted.has(run.head_sha)) continue;
    if (!latest.has(run.head_sha)) latest.set(run.head_sha, run);
  }
  for (const sha of candidates) {
    const candidate = latest.get(sha);
    if (!candidate || candidate.status !== 'completed' || candidate.conclusion !== 'success') continue;
    // 全局历史只用于发现候选；截断窗口不得掩盖该 SHA 的更新失败或运行尝试。
    const exact = await workflowRuns(api, `/actions/workflows/${workflow.id}/runs?head_sha=${sha}&event=push&per_page=100`);
    const run = exact.filter((item) => trustedBaselineRun(item, workflow, repository, branch) && item.head_sha === sha)
      .sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') continue;
    const jobs = await attemptJobs(api, run);
    const quality = qualityJobs(jobs);
    if (quality.length !== 1 || quality[0].name !== FULL_QUALITY
      || !successfulJobs(jobs, [...requiredJobs, FULL_QUALITY], sha)) continue;
    return { sha, runId: run.id, runAttempt: run.run_attempt };
  }
  return null;
}

/** 接受同版本标签的明确全量或增量证明，前端产物仍绑定该次运行尝试。 */
export async function inspectSourceCi(api, { repository, branch, tag, sha }) {
  validSha(sha);
  validateTag(tag);
  const workflow = await sourceWorkflow(api);
  const runs = (await workflowRuns(api, `/actions/workflows/${workflow.id}/runs?head_sha=${sha}&event=push&branch=${encodeURIComponent(tag)}&per_page=100`))
    .filter((run) => trustedSourceRun(run, workflow, repository) && run.head_sha === sha && run.head_branch === tag);
  const run = runs.sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== 'completed') return { status: run ? 'pending' : 'missing' };
  if (run.conclusion !== 'success') throw new Error('同版本标签的源码 CI 未通过，请修复或人工重跑后再发布');
  const jobs = await attemptJobs(api, run);
  const quality = qualityJobs(jobs);
  if (!successfulJobs(jobs, requiredJobs, sha) || quality.length !== 1
    || !successfulJobs(jobs, [quality[0].name], sha)) throw new Error(PROOF_ERROR);
  let mode = 'full';
  let base = '';
  let baselineRunId;
  let baselineRunAttempt;
  if (quality[0].name !== FULL_QUALITY) {
    const match = AFFECTED_QUALITY.exec(quality[0].name);
    if (!match || !branch || match[1] === sha) throw new Error(PROOF_ERROR);
    mode = 'affected';
    base = match[1];
    const comparison = await api(`/compare/${base}...${sha}`);
    if (comparison?.status !== 'ahead' || comparison.base_commit?.sha !== base
      || comparison.merge_base_commit?.sha !== base) throw new Error('增量检查基线不是本次提交的可信祖先');
    const baseline = await findFullSourceBaseline(api, { repository, branch, ancestors: [base], excludeSha: sha });
    if (!baseline) throw new Error('增量检查缺少可信的完整源码基线证明');
    baselineRunId = baseline.runId;
    baselineRunAttempt = baseline.runAttempt;
  }
  const resultArtifacts = await api(`/actions/runs/${run.id}/artifacts?per_page=100`);
  const artifacts = (resultArtifacts.artifacts ?? []).filter((artifact) => artifact.name === `frontend-dist-${sha}-${run.run_attempt}`
    && artifact.expired === false && artifact.workflow_run?.head_sha === sha && artifact.workflow_run?.id === run.id && Number.isSafeInteger(artifact.id)
    && artifact.size_in_bytes > 0 && artifact.digest?.length === 71 && /^sha256:[a-f0-9]{64}$/.test(artifact.digest));
  if (artifacts.length !== 1) throw new Error('可信 CI 的前端产物缺失、过期或身份不符，请重跑该源码 CI 的全部任务');
  return { status: 'success', mode, base, ...(baselineRunId ? { baselineRunId, baselineRunAttempt } : {}),
    runId: run.id, runAttempt: run.run_attempt, artifactId: artifacts[0].id, artifactDigest: artifacts[0].digest };
}

export async function waitForSourceCi(api, context, options = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const deadline = now() + (options.timeoutMs ?? 30 * 60_000);
  let previousStatus;
  do {
    const proof = await inspectSourceCi(api, context);
    if (proof.status === 'success') {
      if (await resolveTagCommit(api, context.tag) !== context.sha) throw new Error('等待 CI 期间发布标签已改变');
      return proof;
    }
    if (proof.status !== previousStatus) options.onStatus?.(proof.status);
    previousStatus = proof.status;
    if (now() >= deadline) break;
    await sleep(Math.min(30_000, deadline - now()));
  } while (now() <= deadline);
  throw new Error('等待同版本标签的可信源码 CI 超时，未构建或公开版本');
}

async function frontendFiles(directory, prefix = '') {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('前端产物必须位于普通目录');
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relativePath === FRONTEND_MANIFEST) continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('前端产物不能包含符号链接');
    if (info.isDirectory()) files.push(...await frontendFiles(path, relativePath));
    else if (info.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: relativePath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error('前端产物包含非常规文件');
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function stampFrontend(directory, sha, version) {
  validSha(sha);
  const files = await frontendFiles(directory);
  if (!files.some((file) => file.path === 'index.html') || !files.some((file) => file.path.startsWith('assets/'))) throw new Error('前端构建产物不完整');
  const manifest = { schema: 1, sha, version, files };
  await writeFile(join(directory, FRONTEND_MANIFEST), `${JSON.stringify(manifest)}\n`, 'utf8');
  return manifest;
}

export async function verifyFrontend(directory, sha, version) {
  const manifestPath = join(directory, FRONTEND_MANIFEST);
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error('前端产物清单无效');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || manifest.sha !== validSha(sha) || manifest.version !== version || !Array.isArray(manifest.files)) throw new Error('前端产物不属于本次发布提交');
  const actual = await frontendFiles(directory);
  if (!actual.some((file) => file.path === 'index.html') || !actual.some((file) => file.path.startsWith('assets/'))
    || JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('前端产物内容与可信构建清单不一致');
}

async function outputs(values) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub Actions 输出通道不可用');
  for (const [name, value] of Object.entries(values)) {
    const delimiter = `release_${randomBytes(16).toString('hex')}`;
    await appendFile(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8');
  }
}

async function main(command) {
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  const sha = process.env.RELEASE_SHA;
  if (command === 'stamp-frontend' || command === 'verify-frontend') {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const expectedSha = command === 'stamp-frontend' ? process.env.GITHUB_SHA : sha;
    if (currentSha !== validSha(expectedSha)) throw new Error('工作区不属于本次发布提交');
    if (command === 'stamp-frontend') await stampFrontend(resolve('dist'), expectedSha, pkg.version);
    else await verifyFrontend(resolve('dist'), expectedSha, pkg.version);
    console.log(command === 'stamp-frontend' ? '前端构建清单已生成' : '前端产物身份与摘要已确认');
    return;
  }
  const api = createGitHubApi(repository, process.env.GH_TOKEN);
  if (command === 'resolve') {
    const target = await resolveReleaseTarget(api, { tag, defaultBranch: process.env.DEFAULT_BRANCH, ref: process.env.GITHUB_REF });
    await outputs({ tag: target.tag, sha: target.sha, version: target.version, release_name: target.title, release_body: target.notes });
  } else if (command === 'wait-ci') {
    const proof = await waitForSourceCi(api, { repository, branch: process.env.DEFAULT_BRANCH, tag: validateTag(tag), sha: validSha(sha) },
      { onStatus: (status) => console.log(status === 'missing' ? '等待同版本标签、同一提交的源码 CI 出现' : '等待同版本标签的源码 CI 完成；不重复启动检查') });
    await outputs({ artifact_run_id: proof.runId, artifact_id: proof.artifactId, source_ci_mode: proof.mode, source_ci_base: proof.base });
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## 发布 ${tag}\n\n- 源码：\`${sha}\`\n- 源码 CI（\`${proof.mode}\`）：[${proof.runId}（第 ${proof.runAttempt} 次尝试）](https://github.com/${repository}/actions/runs/${proof.runId}/attempts/${proof.runAttempt})\n`
      + (proof.base ? `- 完整源码基线：\`${proof.base}\`，[检查证明（第 ${proof.baselineRunAttempt} 次尝试）](https://github.com/${repository}/actions/runs/${proof.baselineRunId}/attempts/${proof.baselineRunAttempt})。\n` : '')
      + `- 前端产物：\`${proof.artifactId}\`，来自上述成功 CI；打包前再次核对源码、版本和每个文件哈希。\n`
      + '- 本次复用上述明确检查范围的成功证明和 Vite 构建。前端 artifact 保留 7 天，过期需重跑该源码 CI 的全部任务。\n'
      + '- Rust 依赖缓存按平台／标准版／Legacy 隔离；实际发布在默认分支运行以共享跨版本缓存。首次构建、工具链或依赖变更可能冷缓存，尚无本轮加速实测。\n', 'utf8');
    console.log(`已确认源码 CI ${proof.runId} 的 ${proof.mode} 成功回执与不可变前端产物`);
  } else if (command === 'assert-publishable') {
    await assertPublishable(api, validateTag(tag), validSha(sha), process.env.REQUIRE_DRAFT === 'true');
  } else throw new Error('未知发布工作流操作');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((reason) => {
    console.error(reason instanceof Error ? reason.message : '发布工作流未确认完成');
    process.exitCode = 1;
  });
}
