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
  await assertPublishable(api, tag, sha);
  const paths = { package: 'package.json', tauri: 'src-tauri/tauri.conf.json', npmLock: 'package-lock.json',
    cargo: 'src-tauri/Cargo.toml', cargoLock: 'src-tauri/Cargo.lock', title: '.github/release-title.txt', notes: '.release-notes.md' };
  const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await sourceText(api, path, sha)]));
  return { sha, ...validateReleaseMetadata(tag, Object.fromEntries(entries)) };
}

/** 只检查可信默认分支 push 的最新一次 CI；旧成功不能掩盖新失败。 */
export async function inspectSourceCi(api, { repository, branch, sha }) {
  validSha(sha);
  if (!branch) throw new Error('默认分支身份不可用');
  const workflow = await api('/actions/workflows/ci.yml');
  if (workflow.path !== '.github/workflows/ci.yml' || workflow.state !== 'active' || !Number.isSafeInteger(workflow.id)) throw new Error('源码 CI 工作流身份无效');
  const result = await api(`/actions/workflows/${workflow.id}/runs?head_sha=${sha}&event=push&branch=${encodeURIComponent(branch)}&per_page=100`);
  const runs = (result.workflow_runs ?? []).filter((run) => run.head_sha === sha && run.event === 'push' && run.head_branch === branch
    && run.repository?.full_name === repository && run.head_repository?.full_name === repository
    && run.workflow_id === workflow.id && run.path === '.github/workflows/ci.yml');
  const run = runs.sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== 'completed') return { status: run ? 'pending' : 'missing' };
  if (run.conclusion !== 'success') throw new Error('同一提交的源码 CI 未通过，请修复或人工重跑后再发布');
  if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('源码 CI 回执无效');
  const resultJobs = await api(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const jobs = resultJobs.jobs ?? [];
  if (requiredJobs.some((name) => {
    const matches = jobs.filter((job) => job.name === name);
    return matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success' || matches[0].head_sha !== sha;
  })) throw new Error('源码 CI 缺少完整前端或 Rust 成功证明');
  const resultArtifacts = await api(`/actions/runs/${run.id}/artifacts?per_page=100`);
  const artifacts = (resultArtifacts.artifacts ?? []).filter((artifact) => artifact.name === `frontend-dist-${sha}`
    && artifact.expired === false && artifact.workflow_run?.head_sha === sha && artifact.workflow_run?.id === run.id && Number.isSafeInteger(artifact.id)
    && artifact.size_in_bytes > 0 && artifact.digest?.length === 71 && /^sha256:[a-f0-9]{64}$/.test(artifact.digest));
  if (artifacts.length !== 1) throw new Error('可信 CI 的前端产物缺失、过期或身份不符，请人工重跑该源码 CI');
  return { status: 'success', runId: run.id, artifactId: artifacts[0].id, artifactDigest: artifacts[0].digest };
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
  throw new Error('等待同一提交的可信源码 CI 超时，未构建或公开版本');
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
    const proof = await waitForSourceCi(api, { repository, tag: validateTag(tag), sha: validSha(sha), branch: process.env.DEFAULT_BRANCH },
      { onStatus: (status) => console.log(status === 'missing' ? '等待同一提交的默认分支源码 CI 出现' : '等待同一提交的源码 CI 完成；不重复启动检查') });
    await outputs({ artifact_run_id: proof.runId, artifact_id: proof.artifactId });
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## 发布 ${tag}\n\n- 源码：\`${sha}\`\n- 可信源码 CI：[${proof.runId}](https://github.com/${repository}/actions/runs/${proof.runId})\n`
      + `- 前端产物：\`${proof.artifactId}\`，来自上述成功 CI；打包前再次核对源码、版本和每个文件哈希。\n`
      + '- 本次不重复执行全量检查或 Vite 构建。前端 artifact 保留 7 天，过期需人工重跑源码 CI。\n'
      + '- Rust 依赖缓存按平台／标准版／Legacy 隔离；实际发布在默认分支运行以共享跨版本缓存。首次构建、工具链或依赖变更可能冷缓存，尚无本轮加速实测。\n', 'utf8');
    console.log(`已确认源码 CI ${proof.runId} 的完整成功回执与不可变前端产物`);
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
