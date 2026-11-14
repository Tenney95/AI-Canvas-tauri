/** 按 Git 提交对象验证推送，当前工作区不参与检查。 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const master = 'refs/heads/master';
const installOptions = ['ci', '--prefer-offline', '--no-audit', '--no-fund'];

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function readUpdates(input, oidLength) {
  const oid = new RegExp(`^[0-9a-f]{${oidLength}}$`);
  const zero = '0'.repeat(oidLength);
  return input.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [localRef, localOid, remoteRef, remoteOid, extra] = line.split(' ');
    if (extra !== undefined || !localRef || !remoteRef?.startsWith('refs/') ||
        !oid.test(localOid) || !oid.test(remoteOid) || (localOid === zero) !== (localRef === '(delete)')) {
      throw new Error('Git 推送清单无法识别');
    }
    return localOid === zero ? [] : [{ localOid, remoteRef, remoteOid }];
  });
}

function npm(args, options) {
  const useNpmCli = process.env.npm_execpath;
  const command = useNpmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmArgs = useNpmCli ? [useNpmCli, ...args] : args;
  execFileSync(command, npmArgs, {
    ...options,
    stdio: 'inherit',
    shell: !useNpmCli && process.platform === 'win32',
  });
}

function affectedMode(base, options) {
  if (!base || !existsSync(join(options.cwd, 'scripts', 'ci-affected.mjs'))) return 'full';
  try {
    const { scripts } = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8'));
    if (!scripts?.['ci:affected']) return 'full';
    const output = execFileSync(process.execPath, [
      'scripts/ci-affected.mjs', '--plan', '--base', base, '--committed-only', '--build',
    ], { ...options, encoding: 'utf8' });
    const { mode } = JSON.parse(output);
    return mode === 'skip' || mode === 'affected' ? mode : 'full';
  } catch {
    return 'full';
  }
}

function verifySnapshot(commit, options) {
  if (git(['rev-parse', 'HEAD'], options).trim() !== commit) throw new Error('检出的提交与推送对象不一致');
  if (git(['status', '--porcelain=v1', '--untracked-files=no'], options)) {
    throw new Error('推送检查快照中的版本控制文件发生变化');
  }
}

function checkSnapshot(root, commit, base, env) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-canvas-pre-push-'));
  const options = { cwd: join(directory, 'source'), env };
  try {
    git(['clone', '--quiet', '--shared', '--no-checkout', '--', root, options.cwd], { cwd: directory, env });
    git(['-c', `core.hooksPath=${join(directory, 'disabled-hooks')}`, 'checkout', '--quiet', '--detach', commit], options);
    verifySnapshot(commit, options);
    const mode = affectedMode(base, options);
    console.log(`推送检查 ${commit.slice(0, 12)}，${{ full: '完整前端 CI', affected: '受影响检查和生产构建', skip: '仅独立文档或无文件差异' }[mode]}。`);
    if (mode === 'skip') return;

    npm(installOptions, options);
    verifySnapshot(commit, options);
    if (mode === 'affected') {
      npm(['run', 'ci:affected', '--', '--base', base, '--committed-only', '--build'], options);
    } else {
      npm(['run', 'ci'], options);
    }
    verifySnapshot(commit, options);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

function main() {
  const root = git(['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
  const localEnv = new Set(git(['rev-parse', '--local-env-vars']).split(/\s+/));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !localEnv.has(key.toUpperCase())));
  env.GIT_NO_REPLACE_OBJECTS = '1';
  const source = { cwd: root, env };
  const objectFormat = git(['rev-parse', '--show-object-format'], source).trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error('Git 对象格式不受支持');
  const updates = readUpdates(readFileSync(0, 'utf8'), objectFormat === 'sha1' ? 40 : 64);
  const commits = [...new Set(updates.map(({ localOid }) =>
    git(['rev-parse', '--verify', '--end-of-options', `${localOid}^{commit}`], source).trim()))];
  if (!commits.length) return;

  let base;
  if (process.argv[2] === 'origin' && updates.length === 1 && updates[0].remoteRef === master && updates[0].localOid === commits[0]) {
    const { remoteOid } = updates[0];
    const result = spawnSync('git', ['merge-base', '--is-ancestor', remoteOid, commits[0]], { ...source, stdio: 'ignore' });
    if (result.status === 0) base = remoteOid;
  }
  for (const commit of commits) checkSnapshot(root, commit, base, env);
}

try {
  main();
} catch (error) {
  console.error(`推送检查失败：${error.stderr?.trim() || error.message}`);
  process.exitCode = 1;
}
