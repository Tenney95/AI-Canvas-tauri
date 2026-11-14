/**
 * 从 Git 选择本地开发检查，预览时只读取改动清单。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyAffectedChanges } from './ci-affected-scope.mjs';

const require = createRequire(import.meta.url);
const decoder = new TextDecoder('utf-8', { fatal: true });

function splitNullRecords(output) {
  const value = typeof output === 'string' ? output : decoder.decode(output);
  if (!value) return [];
  if (!value.endsWith('\0')) throw new Error('Git 改动清单不完整');
  return value.slice(0, -1).split('\0');
}

export function parseNameStatus(output) {
  const records = splitNullRecords(output);
  const changes = [];
  for (let index = 0; index < records.length; index += 2) {
    const [status, path] = [records[index], records[index + 1]];
    if (!/^[ADMTUXB]$/.test(status) || !path) throw new Error('Git 改动记录无法识别');
    changes.push({ status, path });
  }
  return changes;
}

function git(...args) {
  return execFileSync('git', args, {
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readPlan(baseRef) {
  let base;
  try {
    base = baseRef === undefined
      ? git('merge-base', 'origin/master', 'HEAD').toString().trim()
      : git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`).toString().trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw new Error('基线提交无效');
    const diff = (...refs) => parseNameStatus(git(
      'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', ...refs, '--',
    ));
    const changes = [
      ...diff(base, 'HEAD'),
      ...diff('--cached', 'HEAD'),
      ...diff(),
      ...splitNullRecords(git('ls-files', '--others', '--exclude-standard', '-z'))
        .map((path) => ({ status: 'A', path })),
    ];
    for (const change of changes) {
      if ((change.status === 'A' || change.status === 'M') &&
          !lstatSync(change.path, { throwIfNoEntry: false })?.isFile()) change.status = 'T';
    }
    return { base, ...classifyAffectedChanges(changes) };
  } catch {
    return {
      base: base ?? null,
      ...classifyAffectedChanges([{ status: 'U', path: '' }]),
      reason: '无法完整读取 Git 基线或工作区差异',
    };
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`检查已中断（${result.signal}）`);
  return result.status;
}

function runNpm(script) {
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, 'run', script]);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    shell: process.platform === 'win32',
  });
}

async function selectTestFiles(plan) {
  if (!plan.relatedFiles.length) return plan.explicitTests.map((path) => resolve(path));
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { watch: false, run: true, related: plan.relatedFiles });
  try {
    const related = await vitest.getRelevantTestSpecifications();
    return [...new Set([
      ...related.map(({ moduleId }) => moduleId),
      ...plan.explicitTests.map((path) => resolve(path)),
    ])].sort();
  } finally {
    await vitest.close();
  }
}

async function runAffectedChecks(plan, { rust = false } = {}) {
  let effectivePlan = plan;
  let testFiles = [];
  if (plan.mode === 'affected') {
    try {
      testFiles = await selectTestFiles(plan);
      if (!testFiles.length || testFiles.some((path) => !lstatSync(path, { throwIfNoEntry: false })?.isFile())) {
        throw new Error('没有可靠的 Vitest 文件清单');
      }
      testFiles = testFiles.map((path) => `./${relative(process.cwd(), path).replaceAll('\\', '/')}`);
      // 为 Windows 进程参数长度上限预留工具路径和引号空间。
      if (process.platform === 'win32' &&
          [...plan.lintFiles, ...testFiles].reduce((size, path) => size + path.length + 5, 0) > 24_000) {
        throw new Error('定向检查的文件清单过长');
      }
    } catch {
      console.log('无法可靠选择 Vitest 用例，改跑完整前端 CI。');
      effectivePlan = { ...plan, mode: 'full', rust: true };
    }
  }

  if (effectivePlan.rust && !rust) {
    console.log('范围涉及原生检查。可加 --rust 在当前平台执行 Cargo 检查。');
  }
  if (effectivePlan.mode === 'full') {
    const status = runNpm('ci');
    if (status !== 0) return status;
  } else if (effectivePlan.mode === 'affected') {
    if (plan.lintFiles.length) {
      const eslint = join(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
      const status = run(process.execPath, [
        eslint, '--max-warnings=0', '--', ...plan.lintFiles.map((path) => `./${path}`),
      ]);
      if (status !== 0) return status;
    }
    if (plan.typecheck) {
      for (const command of ['typecheck', 'test:typecheck']) {
        const status = runNpm(command);
        if (status !== 0) return status;
      }
    }
    console.log(`选中 ${testFiles.length} 个 Vitest 文件。`);
    const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    const status = run(process.execPath, [vitest, 'run', ...testFiles]);
    if (status !== 0) return status;
  }
  if (effectivePlan.rust && rust) {
    return run('cargo', ['check', '--lib', '--locked'], { cwd: 'src-tauri' });
  }
  return 0;
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      plan: { type: 'boolean' },
      rust: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('npm run ci:affected -- [--base <ref>] [--plan] [--rust]');
    return 0;
  }
  process.chdir(git('rev-parse', '--show-toplevel').toString().replace(/\r?\n$/, ''));
  const plan = readPlan(values.base);
  if (values.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  console.log(`已选择 ${plan.mode}。 ${plan.reason}`);
  return runAffectedChecks(plan, { rust: values.rust });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
