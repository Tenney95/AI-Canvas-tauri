/**
 * 为默认分支 push 选择检查范围。缺少可信祖先时执行完整 CI。
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile } from 'node:fs/promises';
import { readCommittedPlan } from './ci-affected.mjs';
import { createGitHubApi } from './release-workflow.mjs';

const workflowPath = '.github/workflows/ci.yml';
const shaPattern = /^(?!0{40}$)[a-f0-9]{40}$/;

function full(reason) {
  return { mode: 'full', base: '', rust: true, reason };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sourceRun(run, { repository, branch, workflowId }) {
  return run?.event === 'push' && run.head_branch === branch &&
    run.repository?.full_name?.toLowerCase() === repository.toLowerCase() &&
    run.head_repository?.full_name?.toLowerCase() === repository.toLowerCase() &&
    run.path === workflowPath && run.workflow_id === workflowId &&
    shaPattern.test(run.head_sha) && Number.isSafeInteger(run.id) && run.id > 0;
}

async function latestBaseline(api, context, ancestors) {
  const workflow = await api('/actions/workflows/ci.yml');
  if (workflow?.path !== workflowPath || workflow.state !== 'active' || !Number.isSafeInteger(workflow.id)) {
    throw new Error('源码工作流身份无效');
  }
  const response = await api(`/actions/workflows/${workflow.id}/runs?branch=${encodeURIComponent(context.branch)}&event=push&per_page=30`);
  if (!Array.isArray(response?.workflow_runs)) throw new Error('源码运行清单无效');
  const bySha = new Map();
  for (const run of response.workflow_runs) {
    if (!sourceRun(run, { ...context, workflowId: workflow.id })) continue;
    if (!bySha.has(run.head_sha) || bySha.get(run.head_sha).id < run.id) bySha.set(run.head_sha, run);
  }

  for (const sha of ancestors) {
    const run = bySha.get(sha);
    if (run?.status !== 'completed' || run.conclusion !== 'success' ||
        !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) continue;
    const result = await api(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (!Array.isArray(result?.jobs)) throw new Error('源码检查清单无效');
    const proof = result.jobs.filter((job) => job.name === 'Source CI baseline');
    if (proof.length === 1 && proof[0].head_sha === sha &&
        proof[0].status === 'completed' && proof[0].conclusion === 'success') return sha;
  }
  return '';
}

export async function planSourceCi({ api, repository, branch, event, ref, sha, before, forced }, repositoryState) {
  if (event !== 'push' || !repository || !branch || ref !== `refs/heads/${branch}` || forced !== 'false' ||
      !shaPattern.test(sha) || !shaPattern.test(before) || sha === before) {
    return full('PR、特殊推送或没有可核验的推送基线');
  }
  try {
    if (repositoryState.head() !== sha) return full('检出 SHA 与推送 SHA 不符');

    // 发版资料和 CI 规则属于共享输入。检查本次 push 的差异，使同 SHA 重跑不因基线变化而降级。
    if (repositoryState.readPlan(before).mode === 'full') return full('推送包含共享输入或无法缩小范围的改动');
    const base = await latestBaseline(api, { repository, branch }, repositoryState.ancestors(before));
    if (!base) return full('近期历史没有已验证的成功源码 CI 祖先');

    const plan = repositoryState.readPlan(base);
    if (plan.mode === 'full') return full('自可信基线以来需要完整检查');
    return { mode: plan.mode, base, rust: plan.rust, reason: '使用已验证的成功源码 CI 祖先' };
  } catch {
    return full('无法可靠确认 Git 差异或线上检查证明');
  }
}

async function main() {
  const env = process.env;
  const repositoryState = {
    head: () => git('rev-parse', 'HEAD'),
    ancestors: (before) => git('rev-list', '--first-parent', '--max-count=200', before).split('\n'),
    readPlan: readCommittedPlan,
  };
  const plan = await planSourceCi({
    api: (...args) => createGitHubApi(env.GITHUB_REPOSITORY, env.GH_TOKEN)(...args),
    repository: env.GITHUB_REPOSITORY,
    branch: env.DEFAULT_BRANCH,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    before: env.CI_EVENT_BEFORE,
    forced: env.CI_EVENT_FORCED,
  }, repositoryState);

  await appendFile(env.GITHUB_OUTPUT, `mode=${plan.mode}\nbase=${plan.base}\nrust=${plan.rust}\n`, 'utf8');
  if (env.GITHUB_STEP_SUMMARY) {
    const baseNote = plan.base ? `，基线 \`${plan.base}\`` : '';
    await appendFile(env.GITHUB_STEP_SUMMARY, `源码检查为 **${plan.mode}**${baseNote}。\n\n${plan.reason}。Rust 检查为 \`${plan.rust}\`。\n`, 'utf8');
  }
  console.log(`源码检查为 ${plan.mode}。 ${plan.reason}。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
