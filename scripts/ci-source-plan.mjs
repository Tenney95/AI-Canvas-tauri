/** 为正式版本标签冻结相关检查或全量门禁；普通推送不启动源码 CI。 */
import { execFileSync } from 'node:child_process';
import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubApi, findFullSourceBaseline, validateTag } from './release-workflow.mjs';
import { readCommittedPlan, resolveAffectedPlan } from './ci-affected.mjs';

const shaPattern = /^(?!0{40}$)[a-f0-9]{40}$/;
const planFile = 'release-ci-plan.json';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fullPlan(identity, reason) {
  return { ...identity, mode: 'full', base: '', reason, rust: true, typecheck: true,
    lintFiles: [], relatedFiles: [], explicitTests: [] };
}

export async function planSourceCi({ repository, branch, event, ref, sha, api }, repositoryState) {
  if (!repository || !branch || event !== 'push' || !ref?.startsWith('refs/tags/') || !shaPattern.test(sha)) {
    throw new Error('源码 CI 仅允许正式版本标签的打包请求');
  }
  const tag = validateTag(ref.slice('refs/tags/'.length));
  if (repositoryState.head() !== sha) throw new Error('检出 SHA 与版本标签的提交不一致');
  if (!repositoryState.isDefaultBranchAncestor(sha, branch)) {
    throw new Error('版本标签的提交不属于默认分支历史，拒绝打包检查');
  }
  const identity = { schemaVersion: 1, release: true, tag, sha };
  try {
    const ancestors = repositoryState.ancestors(sha).filter((item) => shaPattern.test(item) && item !== sha);
    const baseline = await findFullSourceBaseline(api, { repository, branch, ancestors, excludeSha: sha });
    if (!baseline) return fullPlan(identity, '没有可信的完整检查祖先，执行全量门禁');
    const scope = repositoryState.readPlan(baseline.sha);
    if (scope.base !== baseline.sha || scope.sha !== sha || !['full', 'affected', 'skip'].includes(scope.mode)) {
      return fullPlan(identity, '提交检查范围无法核对，执行全量门禁');
    }
    return { ...scope, ...identity, base: baseline.sha, baselineRunId: baseline.runId,
      baselineRunAttempt: baseline.runAttempt, typecheck: true, rust: scope.mode === 'full' || scope.rust === true };
  } catch {
    return fullPlan(identity, '无法可靠读取完整检查基线或提交差异，执行全量门禁');
  }
}

async function freezePlan(env) {
  const metadata = await lstat(planFile);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('打包检查计划必须是当前运行生成的普通文件');
  const candidate = JSON.parse(await readFile(planFile, 'utf8'));
  if (candidate.sha !== git('rev-parse', 'HEAD') || candidate.schemaVersion !== 1 || candidate.release !== true) {
    throw new Error('打包检查计划与当前源码不一致');
  }
  const plan = await resolveAffectedPlan(candidate, { release: true });
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  await appendFile(env.GITHUB_OUTPUT, `mode=${plan.mode}\nbase=${plan.base || ''}\nrust=${plan.rust}\n`, 'utf8');
  if (env.GITHUB_STEP_SUMMARY) {
    const names = (files) => files.length ? files.map((file) => `- \`${file}\``).join('\n') : '- 无';
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `## 打包检查计划：${plan.mode}\n\n- 标签：\`${plan.tag}\`\n- 源码：\`${plan.sha}\`\n`
      + `- 完整基线：\`${plan.base || '无'}\`\n- 选择原因：${plan.reason}\n- Rust 预检矩阵：\`${plan.rust}\`\n`
      + '- 两种模式均执行完整应用／测试类型检查和真实生产构建；检查清单保存在本次 ci-plan 产物。\n\n'
      + (plan.mode === 'full' ? '全量执行全部前端测试及三平台 Rust 门禁。\n'
        : `### lint 文件（${plan.lintFiles.length}）\n${names(plan.lintFiles)}\n\n### 测试文件（${plan.testFiles.length}）\n${names(plan.testFiles)}\n`), 'utf8');
  }
  console.log(`已冻结 ${plan.mode} 打包检查计划。${plan.reason}。`);
}

async function main(command = 'plan') {
  const env = process.env;
  if (command === 'finalize') return freezePlan(env);
  if (command !== 'plan') throw new Error('未知打包检查计划操作');
  const plan = await planSourceCi({
    repository: env.GITHUB_REPOSITORY,
    branch: env.DEFAULT_BRANCH,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    api: (...args) => createGitHubApi(env.GITHUB_REPOSITORY, env.GH_TOKEN)(...args),
  }, {
    head: () => git('rev-parse', 'HEAD'),
    ancestors: (sha) => git('rev-list', '--first-parent', '--max-count=500', sha).split('\n'),
    readPlan: readCommittedPlan,
    isDefaultBranchAncestor: (sha, branch) => {
      try {
        git('check-ref-format', `refs/heads/${branch}`);
        git('merge-base', '--is-ancestor', sha, `refs/remotes/origin/${branch}`);
        return true;
      } catch {
        return false;
      }
    },
  });
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await appendFile(env.GITHUB_OUTPUT, `candidate_mode=${plan.mode}\n`, 'utf8');
  console.log(`候选打包检查为 ${plan.mode}。${plan.reason}。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
