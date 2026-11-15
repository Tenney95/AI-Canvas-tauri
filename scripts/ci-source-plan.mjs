/** 仅为正式版本标签的打包选择完整源码门禁。普通推送不启动 CI。 */
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTag } from './release-workflow.mjs';

const shaPattern = /^(?!0{40}$)[a-f0-9]{40}$/;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function planSourceCi({ repository, branch, event, ref, sha }, repositoryState) {
  if (!repository || !branch || event !== 'push' || !ref?.startsWith('refs/tags/') || !shaPattern.test(sha)) {
    throw new Error('源码 CI 仅允许正式版本标签的打包请求');
  }
  const tag = validateTag(ref.slice('refs/tags/'.length));
  if (repositoryState.head() !== sha) throw new Error('检出 SHA 与版本标签的提交不一致');
  if (!repositoryState.isDefaultBranchAncestor(sha, branch)) {
    throw new Error('版本标签的提交不属于默认分支历史，拒绝打包检查');
  }
  return { mode: 'full', rust: true, tag, sha, reason: '版本打包执行完整前端与三平台 Rust 门禁' };
}

async function main() {
  const env = process.env;
  const plan = planSourceCi({
    repository: env.GITHUB_REPOSITORY,
    branch: env.DEFAULT_BRANCH,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
  }, {
    head: () => git('rev-parse', 'HEAD'),
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
  await appendFile(env.GITHUB_OUTPUT, `mode=${plan.mode}\nrust=${plan.rust}\n`, 'utf8');
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `版本打包 \`${plan.tag}\` 的源码检查为 **full**。\n\n源码：\`${plan.sha}\`。完整前端和三平台 Rust 均须通过后才允许打包。\n`, 'utf8');
  }
  console.log(`源码检查为 full。${plan.reason}。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
