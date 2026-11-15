/**
 * 从 Git 选择受影响的检查，预览时只读取改动清单。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyAffectedChanges, isReleaseMetadataPath } from './ci-affected-scope.mjs';

const require = createRequire(import.meta.url);
const decoder = new TextDecoder('utf-8', { fatal: true });
const commitSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

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

function fallbackPlan(base, reason, sha) {
  return {
    base: base ?? null,
    ...(sha ? { sha } : {}),
    ...classifyAffectedChanges([{ status: 'U', path: '' }]),
    reason,
  };
}

export function readCommittedPlan(baseSha) {
  if (typeof baseSha !== 'string' || !commitSha.test(baseSha)) {
    throw new Error('提交范围检查需要通过 --base 指定完整的基线提交 SHA');
  }
  const exactGit = (...args) => git('--no-replace-objects', ...args);
  let head;
  try {
    head = exactGit('rev-parse', '--verify', 'HEAD^{commit}').toString().trim();
    const base = exactGit('rev-parse', '--verify', '--end-of-options', `${baseSha}^{commit}`).toString().trim();
    if (!commitSha.test(head) || base !== baseSha) throw new Error('提交身份无法核对');
    exactGit('merge-base', '--is-ancestor', baseSha, head);
  } catch {
    throw new Error('基线提交必须是当前 HEAD 可验证的祖先');
  }
  const trackedStatus = exactGit('status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none');
  if (trackedStatus.length) throw new Error('提交范围检查需要干净的已跟踪文件和暂存区');

  try {
    // --raw 同时提供文件类型。新增符号链接、子模块和执行位变化均进入全量检查。
    const records = splitNullRecords(exactGit(
      'diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', baseSha, head, '--',
    ));
    const changes = [];
    for (let index = 0; index < records.length; index += 2) {
      const [header, path] = [records[index], records[index + 1]];
      const match = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ ([ADMTUXB])$/.exec(header);
      if (!match || !path) throw new Error('提交差异记录无法识别');
      const [, oldMode, newMode, status] = match;
      const regularFile = newMode === '100644' && (oldMode === '100644' || oldMode === '000000');
      const change = { status: regularFile || status === 'D' ? status : 'T', path };
      if (change.status === 'M' && isReleaseMetadataPath(path)) {
        change.before = decoder.decode(exactGit('show', `${baseSha}:${path}`));
        change.after = decoder.decode(exactGit('show', `${head}:${path}`));
      }
      changes.push(change);
    }
    return { base: baseSha, sha: head, ...classifyAffectedChanges(changes) };
  } catch {
    return fallbackPlan(baseSha, '无法完整读取提交差异', head);
  }
}

function readPlan(baseRef) {
  let base;
  try {
    base = baseRef === undefined
      ? git('merge-base', 'origin/master', 'HEAD').toString().trim()
      : git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`).toString().trim();
    if (!commitSha.test(base)) throw new Error('基线提交无效');
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
      if (change.status === 'M' && isReleaseMetadataPath(change.path)) {
        change.before = decoder.decode(git('show', `${base}:${change.path}`));
        change.after = decoder.decode(readFileSync(change.path));
      }
    }
    return { base, sha: git('rev-parse', 'HEAD').toString().trim(), ...classifyAffectedChanges(changes) };
  } catch {
    return fallbackPlan(base, '无法完整读取 Git 基线或工作区差异');
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

function relativeFile(path, root = process.cwd()) {
  if (typeof path !== 'string' || !path || /[\\\n\r\t:*?[\]{}]/.test(path)
      || path.startsWith('-') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('冻结检查计划包含无效相对路径');
  }
  let current = root;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry || entry.isSymbolicLink() || (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) {
      throw new Error('冻结检查计划中的文件缺失、不是普通文件或经过链接');
    }
  }
  return path;
}

/** 固定本次检查实际会运行的用例，不将运行时选择失败冒充增量通过。 */
export async function resolveAffectedPlan(plan, { release = false } = {}) {
  const resolved = { ...plan, schemaVersion: 1, release, typecheck: release || plan.typecheck, testFiles: [] };
  if (plan.mode === 'full') return { ...resolved, rust: release || plan.rust };
  if (plan.mode === 'skip') {
    return release ? { ...resolved, mode: 'affected' } : resolved;
  }
  if (plan.mode !== 'affected') throw new Error('检查范围模式无效');
  try {
    for (const field of ['lintFiles', 'relatedFiles', 'explicitTests']) {
      if (!Array.isArray(plan[field])) throw new Error('范围文件清单无效');
      plan[field].forEach((path) => relativeFile(path));
    }
    const selected = await selectTestFiles(plan);
    const testFiles = selected.map((path) => relativeFile(relative(process.cwd(), path).replaceAll('\\', '/')));
    if (!testFiles.length || testFiles.some((path) => !/^tests\/.+\.test\.[cm]?[jt]sx?$/.test(path))) {
      throw new Error('没有可靠的 Vitest 文件清单');
    }
    // 预留 Windows 工具路径和引号空间，避免在执行阶段才临时扩大范围。
    if (process.platform === 'win32' && [...plan.lintFiles, ...testFiles].reduce((size, path) => size + path.length + 5, 0) > 24_000) {
      throw new Error('定向检查的文件清单过长');
    }
    return { ...resolved, testFiles: [...new Set(testFiles)].sort() };
  } catch {
    return { ...resolved, mode: 'full', rust: release || plan.rust,
      reason: `${plan.reason}；关联测试清单无法可靠确定或超出执行上限，升级完整检查` };
  }
}

/** 校验同一提交上的冻结发布计划；执行阶段只按这份清单运行，不重新选测试。 */
export function validateResolvedPlan(plan, { head, isAncestor, root = process.cwd() }) {
  if (!plan || plan.schemaVersion !== 1 || plan.mode !== 'affected' || plan.release !== true
      || plan.typecheck !== true || typeof plan.rust !== 'boolean'
      || typeof plan.reason !== 'string' || !plan.reason || plan.reason.length > 4096
      || !commitSha.test(plan.sha) || !commitSha.test(plan.base) || plan.sha !== head || plan.base === plan.sha) {
    throw new Error('冻结发布检查计划的模式、版本或源码 SHA 无效');
  }
  if (!isAncestor(plan.base, plan.sha)) throw new Error('冻结发布检查计划的基线不是当前提交的祖先');
  for (const field of ['lintFiles', 'relatedFiles', 'explicitTests', 'testFiles']) {
    if (!Array.isArray(plan[field]) || plan[field].length > 10_000
        || new Set(plan[field]).size !== plan[field].length) throw new Error('冻结发布检查计划的文件清单无效');
    plan[field].forEach((path) => relativeFile(path, root));
  }
  if (plan.lintFiles.some((path) => !/\.[cm]?[jt]sx?$/.test(path))
      || [...plan.explicitTests, ...plan.testFiles].some((path) => !/^tests\/.+\.test\.[cm]?[jt]sx?$/.test(path))
      || (plan.testFiles.length === 0 && (plan.lintFiles.length || plan.relatedFiles.length || plan.explicitTests.length))
      || (process.platform === 'win32' && [...plan.lintFiles, ...plan.testFiles].reduce((size, path) => size + path.length + 5, 0) > 24_000)) {
    throw new Error('冻结发布检查计划的测试或 lint 范围无效');
  }
  return plan;
}

/** CLI 文件过滤器使用子串匹配；冻结计划必须与每个项目规格一一对应。 */
export function selectFrozenTestSpecifications(testFiles, specifications, root = process.cwd()) {
  const moduleId = (path) => {
    const absolute = resolve(root, path).replaceAll('\\', '/');
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const expected = testFiles.map(moduleId);
  if (new Set(expected).size !== expected.length) throw new Error('冻结测试清单包含重复文件');
  const selected = new Map();
  const expectedIds = new Set(expected);
  for (const specification of specifications) {
    if (typeof specification.moduleId !== 'string' || !isAbsolute(specification.moduleId)) continue;
    const id = moduleId(specification.moduleId);
    if (!expectedIds.has(id)) continue;
    if (selected.has(id)) throw new Error('冻结测试文件对应多个项目规格，拒绝扩大执行范围');
    selected.set(id, specification);
  }
  if (selected.size !== expected.length) throw new Error('冻结测试文件缺少可执行规格，拒绝更改执行范围');
  return expected.map((id) => selected.get(id));
}

async function runFrozenTests(testFiles) {
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { watch: false, run: true });
  let result;
  try {
    // standalone 只初始化 reporter / coverage；不使用 related 或 CLI filters 重选用例。
    await vitest.standalone();
    const specifications = selectFrozenTestSpecifications(testFiles, await vitest.globTestSpecifications());
    result = await vitest.runTestSpecifications(specifications);
    selectFrozenTestSpecifications(testFiles, result.testModules);
    if (result.testModules.length !== testFiles.length) throw new Error('实际测试文件与冻结清单不一致');
  } finally {
    await vitest.close();
  }
  return result.unhandledErrors.length || result.testModules.some((module) => !module.ok())
    || Number(process.exitCode ?? 0) !== 0 ? 1 : 0;
}

async function runResolvedChecks(plan, { rust = false, build = false, frozen = false } = {}) {
  if (plan.rust && !rust) {
    console.log(frozen ? '范围涉及原生检查，由本次 CI 的平台任务执行。'
      : '范围涉及原生检查。可加 --rust 在当前平台执行 Cargo 检查。');
  }
  if (plan.mode === 'full') {
    const status = runNpm('ci');
    if (status !== 0) return status;
  } else if (plan.mode === 'affected') {
    if (plan.lintFiles.length) {
      const eslint = join(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
      const status = run(process.execPath, [
        eslint, '--max-warnings=0', '--', ...plan.lintFiles.map((path) => `./${path}`),
      ]);
      if (status !== 0) return status;
    }
    if (plan.typecheck) {
      const typechecks = build ? ['test:typecheck'] : ['typecheck', 'test:typecheck'];
      for (const command of typechecks) {
        const status = runNpm(command);
        if (status !== 0) return status;
      }
    }
    console.log(`选中 ${plan.testFiles.length} 个 Vitest 文件。`);
    if (plan.testFiles.length) {
      const status = frozen ? await runFrozenTests(plan.testFiles) : run(process.execPath, [
        join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), 'run', ...plan.testFiles.map((path) => `./${path}`),
      ]);
      if (status !== 0) return status;
    } else console.log('只有独立资料或应用版本变化，不启动运行测试；仍完成项目类型检查和生产构建。');
    if (build) {
      const buildStatus = runNpm('build');
      if (buildStatus !== 0) return buildStatus;
    }
  }
  if (plan.rust && rust) {
    return run('cargo', ['check', '--lib', '--locked'], { cwd: 'src-tauri' });
  }
  return 0;
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      'committed-only': { type: 'boolean' },
      plan: { type: 'boolean' },
      rust: { type: 'boolean' },
      build: { type: 'boolean' },
      'execute-plan': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log('npm run ci:affected -- [--base <ref>] [--committed-only] [--plan] [--rust] [--build] 或 --execute-plan <json> --build');
    return 0;
  }
  process.chdir(git('rev-parse', '--show-toplevel').toString().replace(/\r?\n$/, ''));
  if (values['execute-plan']) {
    if (!values.build || values.base || values.plan || values.rust || values['committed-only']) {
      throw new Error('冻结发布计划须配合 --build，不能混用其他范围参数');
    }
    const assertSnapshot = () => {
      if (git('--no-replace-objects', 'status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none').length) {
        throw new Error('冻结发布检查需要干净的已跟踪文件和暂存区');
      }
      return git('--no-replace-objects', 'rev-parse', '--verify', 'HEAD^{commit}').toString().trim();
    };
    const head = assertSnapshot();
    const frozen = validateResolvedPlan(JSON.parse(decoder.decode(readFileSync(values['execute-plan']))), {
      head,
      isAncestor: (base, sha) => {
        try { git('--no-replace-objects', 'merge-base', '--is-ancestor', base, sha); return true; }
        catch { return false; }
      },
    });
    console.log(`执行冻结发布检查：${frozen.mode}，基线 ${frozen.base}，${frozen.testFiles.length} 个测试文件。`);
    const status = await runResolvedChecks(frozen, { build: true, frozen: true });
    if (status === 0 && assertSnapshot() !== head) throw new Error('冻结发布检查期间源码提交发生变化');
    return status;
  }
  const plan = values['committed-only'] ? readCommittedPlan(values.base) : readPlan(values.base);
  if (values.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  console.log(`已选择 ${plan.mode}。 ${plan.reason}`);
  const resolved = await resolveAffectedPlan(plan);
  if (resolved.mode !== plan.mode) console.log(resolved.reason);
  return runResolvedChecks(resolved, { rust: values.rust, build: values.build });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
