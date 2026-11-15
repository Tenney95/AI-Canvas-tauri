import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNameStatus, resolveAffectedPlan, selectFrozenTestSpecifications, validateResolvedPlan } from '../../scripts/ci-affected.mjs';
import { classifyAffectedChanges, isVersionOnlyReleaseChange } from '../../scripts/ci-affected-scope.mjs';

const script = fileURLToPath(new URL('../../scripts/ci-affected.mjs', import.meta.url));
const dependencies = fileURLToPath(new URL('../../node_modules', import.meta.url));

async function withTemporaryRepository(useRepository) {
  const root = await mkdtemp(join(tmpdir(), 'ai-canvas-ci-affected-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|VITEST(?:_|$))/i.test(key)));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=disabled-hooks', ...args], { cwd: root, env });
  const write = async (path, content) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });

  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Affected CI Fixture');
    git('config', 'user.email', 'affected-ci@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    await useRepository({ root, git, write, run });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('CI 改动清单', () => {
  it('读取由 NUL 分隔的 Git 记录，保留中文、空格和换行', () => {
    const output = Buffer.from(['M', 'src/示例 组件.tsx', 'A', 'src/line\nbreak.ts', 'D', 'src/deleted.ts', ''].join('\0'));

    expect(parseNameStatus(output)).toEqual([
      { status: 'M', path: 'src/示例 组件.tsx' },
      { status: 'A', path: 'src/line\nbreak.ts' },
      { status: 'D', path: 'src/deleted.ts' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });

  it.each([
    'M\0',
    'M\0src/incomplete.ts',
    'R100\0old.ts\0renamed.ts\0',
  ])('拒绝截断或超出约定的 Git 记录 %j', (output) => {
    expect(() => parseNameStatus(output)).toThrow();
  });

  it('从指定基线纳入已提交、已暂存、未暂存和未跟踪改动', async () => {
    await withTemporaryRepository(async ({ git, write, run }) => {
      const plan = (...args) => JSON.parse(run('--plan', ...args));

      await write('src/components/Tracked.tsx', 'export const value = 1;\n');
      await write('src/components/RevertedInWorktree.tsx', 'export const reverted = false;\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'Base');
      git('checkout', '--quiet', '--detach', 'HEAD');
      await write('src/components/Upstream.tsx', 'export const upstream = true;\n');
      git('add', 'src/components/Upstream.tsx');
      git('commit', '--quiet', '-m', 'Upstream change');
      git('update-ref', 'refs/remotes/origin/master', 'HEAD');
      git('checkout', '--quiet', '--detach', 'HEAD~1');

      await write('src/components/Committed.tsx', 'export const committed = true;\n');
      git('add', 'src/components/Committed.tsx');
      git('commit', '--quiet', '-m', 'Committed change');

      await write('src/components/Staged.tsx', 'export const staged = true;\n');
      git('add', 'src/components/Staged.tsx');
      await write('src/components/RevertedInWorktree.tsx', 'export const reverted = true;\n');
      git('add', 'src/components/RevertedInWorktree.tsx');
      await write('src/components/RevertedInWorktree.tsx', 'export const reverted = false;\n');
      await write('src/components/Tracked.tsx', 'export const value = 2;\n');
      await write('src/components/Untracked.tsx', 'export const untracked = true;\n');

      const affected = plan('--base', 'HEAD~1');
      expect(affected.mode).toBe('affected');
      expect(affected.lintFiles.toSorted()).toEqual([
        'src/components/Committed.tsx',
        'src/components/RevertedInWorktree.tsx',
        'src/components/Staged.tsx',
        'src/components/Tracked.tsx',
        'src/components/Untracked.tsx',
      ]);
      expect(plan()).toMatchObject({ mode: 'affected', lintFiles: affected.lintFiles });
      expect(plan('--base', 'refs/heads/missing')).toMatchObject({ mode: 'full', rust: true });
    });
  }, 15_000);

  it('只使用提交树，要求可验证的祖先和干净的已跟踪文件', async () => {
    await withTemporaryRepository(async ({ git, write, run }) => {
      await write('src/components/Base.tsx', 'export const base = true;\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'Base');
      const base = git('rev-parse', 'HEAD').toString().trim();
      git('checkout', '--quiet', '--detach', base);

      await write('src/components/Committed.tsx', 'export const committed = true;\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'Committed change');
      const head = git('rev-parse', 'HEAD').toString().trim();
      await write('src/components/Untracked.tsx', 'export const untracked = true;\n');

      const plan = (sha) => JSON.parse(run('--plan', '--committed-only', '--base', sha));
      expect(plan(base)).toMatchObject({
        mode: 'affected',
        base,
        lintFiles: ['src/components/Committed.tsx'],
      });
      expect(plan(head)).toMatchObject({ mode: 'skip', base: head });
      expect(() => plan('HEAD')).toThrow('完整的基线提交 SHA');

      await write('src/components/Base.tsx', 'export const base = false;\n');
      expect(() => plan(base)).toThrow('干净的已跟踪文件和暂存区');
      git('add', 'src/components/Base.tsx');
      expect(() => plan(base)).toThrow('干净的已跟踪文件和暂存区');
      git('reset', '--hard', head);

      git('checkout', '--quiet', '--detach', base);
      git('commit', '--quiet', '--allow-empty', '-m', 'Other history');
      const unrelated = git('rev-parse', 'HEAD').toString().trim();
      git('checkout', '--quiet', '--detach', head);
      expect(() => plan(unrelated)).toThrow('当前 HEAD 可验证的祖先');
    });
  }, 15_000);

  it('提交新增的可执行文件回退完整检查', async () => {
    await withTemporaryRepository(async ({ git, write, run }) => {
      git('commit', '--quiet', '--allow-empty', '-m', 'Base');
      const base = git('rev-parse', 'HEAD').toString().trim();
      await write('doc/filename.md', 'test\n');
      git('add', 'doc/filename.md');
      git('update-index', '--chmod=+x', 'doc/filename.md');
      git('commit', '--quiet', '-m', 'Executable markdown');
      const head = git('rev-parse', 'HEAD').toString().trim();
      git('checkout', '--quiet', '--force', '--detach', base);
      git('checkout', '--quiet', '--detach', head);

      expect(JSON.parse(run('--plan', '--committed-only', '--base', base))).toMatchObject({ mode: 'full', rust: true });
    });
  }, 15_000);

  it('检查提交中的关联用例，通过后运行生产构建', async () => {
    await withTemporaryRepository(async ({ root, git, write, run }) => {
      await write('.gitignore', 'node_modules\nvitest-cache/\n');
      await write('package.json', '{"type":"module","private":true,"scripts":{"build":"node build.mjs"}}\n');
      await write('build.mjs', "import { copyFileSync } from 'node:fs';\ncopyFileSync('selected-result.txt', 'build-result.txt');\n");
      await write('eslint.config.mjs', 'export default [{}];\n');
      await write('vitest.config.mjs', `export default {
        cacheDir: 'vitest-cache',
        test: { globals: true, fileParallelism: false },
      };\n`);
      await write('tests/utils/changed-helper.js', 'export const value = 1;\n');
      await write('tests/utils/selected.test.js', `import { writeFileSync } from 'node:fs';
        import { value } from './changed-helper.js';
        it('reads the updated value', () => {
          expect(value).toBe(2);
          writeFileSync('selected-result.txt', String(value));
        });\n`);
      await write('tests/utils/unrelated.test.js', `it('fails when the file filter is lost', () => {
        throw new Error('Unexpected unrelated test execution');
      });\n`);
      git('add', '.');
      git('commit', '--quiet', '-m', 'Base');
      const base = git('rev-parse', 'HEAD').toString().trim();
      await symlink(dependencies, join(root, 'node_modules'), 'junction');
      await write('tests/utils/changed-helper.js', 'export const value = 2;\n');
      git('add', 'tests/utils/changed-helper.js');
      git('commit', '--quiet', '-m', 'Change helper');

      run('--committed-only', '--base', base, '--build');
      expect(await readFile(join(root, 'selected-result.txt'), 'utf8')).toBe('2');
      expect(await readFile(join(root, 'build-result.txt'), 'utf8')).toBe('2');
      await rm(join(root, 'build-result.txt'));
      run('--committed-only', '--base', git('rev-parse', 'HEAD').toString().trim(), '--build');
      await expect(readFile(join(root, 'build-result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 30_000);
});

describe('CI 影响范围', () => {
  const modify = (...paths) => classifyAffectedChanges(paths.map((path) => ({ status: 'M', path })));

  it('普通 UI 源码进入关联用例和 TypeScript 检查，并保留全仓源码扫描', () => {
    const component = 'src/components/styleGuide/StyleGuideSections.tsx';
    const plan = modify(component);

    expect(plan).toMatchObject({
      mode: 'affected',
      lintFiles: [component],
      relatedFiles: [component],
      typecheck: true,
      rust: false,
    });
    expect(plan.explicitTests).toEqual(expect.arrayContaining([
      'tests/i18n/i18n.test.ts',
      'tests/scripts/projectModelBoundaries.test.mjs',
    ]));
  });

  it('普通开发文档可跳过检查，插件开发规范仍触发验证', () => {
    expect(modify('doc/开发指南.md')).toMatchObject({ mode: 'skip', rust: false });
    expect(modify('doc/插件开发规范.md')).toMatchObject({ mode: 'full', rust: false });
  });

  it('权限声明升级全量，普通原生实现仍保留 ACL 读取映射', () => {
    expect(modify('src-tauri/permissions/external-agent.toml')).toMatchObject({ mode: 'full', rust: true });
    const native = modify('src-tauri/src/media/example.rs');
    expect(native).toMatchObject({ mode: 'affected', rust: true });
    expect(native.explicitTests).toContain('tests/scripts/nativeAppCommandAcl.test.ts');
  });

  it('改动原生工具栏嵌入的 CSS 和公开插件脚本时保留两者的验证范围', () => {
    const css = 'src/styles/ui-kit.css';
    const bootstrap = 'public/plugin-ui-bootstrap.js';
    const plan = modify(css);

    expect(plan).toMatchObject({ mode: 'affected', lintFiles: [], rust: true });
    expect(plan.relatedFiles).toContain(css);
    expect(modify(bootstrap)).toMatchObject({ mode: 'full', rust: true });
  });

  it.each([
    'package-lock.json',
    'tsconfig.test.json',
    '.github/workflows/ci.yml',
    'src/projectModelFixtureHost.ts',
    'unknown/build-input.json',
  ])('共享输入或无法归类的 %s 回退完整检查', (path) => {
    expect(modify(path)).toMatchObject({ mode: 'full', rust: true });
  });

  it('共享前端输入保持完整前端检查，并合并其他改动要求的 Rust 检查', () => {
    const frontend = ['tests/setup.ts', 'src/types/aiTypes.ts', 'src/i18n/locales/en-US/character.ts'];
    const native = 'src-tauri/permissions/external-agent.toml';

    expect(modify(...frontend)).toMatchObject({ mode: 'full', rust: false });
    expect(modify(...frontend, native)).toMatchObject({ mode: 'full', rust: true });
    expect(modify(native, ...frontend)).toMatchObject({ mode: 'full', rust: true });
  });

  it('仅翻译词条和领域类型不直接升级所有业务测试，保留 key 与类型检查', () => {
    for (const path of ['src/i18n/locales/en-US/chat.ts', 'src/types/canvasNote.ts']) {
      const scope = modify(path);
      expect(scope).toMatchObject({ mode: 'affected', typecheck: true, relatedFiles: [path] });
      expect(scope.explicitTests).toContain('tests/i18n/i18n.test.ts');
    }
    for (const path of ['src/i18n/index.ts', 'src/i18n/locales/en-US/index.ts', 'src/types/index.ts',
      'src/services/chat/policyEngine.ts', 'src/services/chat/tools/fileTools.ts', 'src/services/chat/skillManifest.ts',
      'src/services/indexedDb/schema.ts', 'src-tauri/src/path_policy.rs']) {
      expect(modify(path).mode).toBe('full');
    }
  });

  it('发布说明及独立官网资料不触发应用运行测试', () => {
    expect(modify('.github/release-title.txt', '.release-notes.md', 'site/manual.html')).toMatchObject({ mode: 'skip', rust: false });
  });

  it('删除源码时不能仅靠当前分支的导入图选测试', () => {
    expect(classifyAffectedChanges([
      { status: 'D', path: 'src/components/OldComponent.tsx' },
      { status: 'A', path: 'src/components/MovedComponent.tsx' },
    ])).toMatchObject({ mode: 'full', rust: true });
  });
});

function releaseDocument(path, version) {
  if (path === 'package.json') return JSON.stringify({ name: 'ai-canvas-tauri', version, dependencies: { react: '19' } });
  if (path === 'package-lock.json') return JSON.stringify({ version, lockfileVersion: 3,
    packages: { '': { name: 'ai-canvas-tauri', version, dependencies: { react: '19' } }, 'node_modules/react': { version: '19' } } });
  if (path === 'src-tauri/tauri.conf.json') return JSON.stringify({ version, app: { security: { csp: 'default-src self' } } });
  if (path === 'src-tauri/Cargo.toml') return `[package]\nname = "ai-canvas-tauri"\nversion = "${version}"\nedition = "2021"\n\n[lib]\nname = "app_lib"\n\n[dependencies]\nreact = "19"\n`;
  return `version = 4\n\n[[package]]\nname = "ai-canvas-tauri"\nversion = "${version}"\ndependencies = ["react"]\n\n[[package]]\nname = "react"\nversion = "19"\n`;
}

describe('发布版本资料的精确比较', () => {
  const paths = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json'];

  it.each(paths)('%s 仅应用版本变化可跳过运行测试，其他依赖或安全配置仍全量', (path) => {
    const change = { status: 'M', path, before: releaseDocument(path, '1.2.3'), after: releaseDocument(path, '1.2.4') };
    expect(isVersionOnlyReleaseChange(change)).toBe(true);
    expect(classifyAffectedChanges([change])).toMatchObject({ mode: 'skip', rust: false });
    const after = path.endsWith('tauri.conf.json')
      ? change.after.replace('default-src self', 'default-src unsafe')
      : change.after.replace(/"19"/g, '"20"');
    expect(classifyAffectedChanges([{ ...change, after }])).toMatchObject({ mode: 'full', rust: true });
  });

  it('缺少提交正文、无法解析或非已存在资料不能当作版本更新豁免', () => {
    for (const change of [
      { status: 'M', path: 'package.json' },
      { status: 'M', path: 'package.json', before: '{}', after: '{"version":"1.2.3"}' },
      { status: 'M', path: 'package-lock.json', before: '{"version":"1.2.3"}', after: '{"version":"1.2.4"}' },
      { status: 'M', path: 'src-tauri/Cargo.toml', before: '[package]\nversion = "1.2.3"\n', after: '[package]\nversion = "1.2.4"\nversion = "2.0.0"\n' },
      { status: 'A', path: 'package.json', before: releaseDocument('package.json', '1.2.3'), after: releaseDocument('package.json', '1.2.4') },
    ]) expect(classifyAffectedChanges([change]).mode).toBe('full');
  });

  it('提交范围比较读取旧新正文，不因发版必改的版本号强制全量', async () => {
    await withTemporaryRepository(async ({ git, write, run }) => {
      for (const path of paths) await write(path, releaseDocument(path, '1.2.3'));
      git('add', '.');
      git('commit', '--quiet', '-m', 'Base versions');
      const base = git('rev-parse', 'HEAD').toString().trim();
      for (const path of paths) await write(path, releaseDocument(path, '1.2.4'));
      git('add', '.');
      git('commit', '--quiet', '-m', 'Application version only');
      expect(JSON.parse(run('--plan', '--committed-only', '--base', base))).toMatchObject({ mode: 'skip', base });
      await write('package.json', releaseDocument('package.json', '1.2.4').replace('"19"', '"20"'));
      git('add', '.');
      git('commit', '--quiet', '-m', 'Dependency changed');
      expect(JSON.parse(run('--plan', '--committed-only', '--base', base))).toMatchObject({ mode: 'full', rust: true });
    });
  }, 15_000);
});

describe('冻结发布检查计划', () => {
  const identity = { sha: 'a'.repeat(40), base: 'b'.repeat(40) };
  const empty = { ...identity, reason: 'Fixture scope', rust: false, typecheck: false, lintFiles: [], relatedFiles: [], explicitTests: [] };

  it('按完整路径选择规格，排除同名嵌套文件并拒绝缺失或多个项目规格', () => {
    const root = join(tmpdir(), 'frozen-specifications');
    const file = 'tests/utils/selected.test.js';
    const selected = { moduleId: join(root, file), project: { name: 'selected' } };
    const nested = { moduleId: join(root, 'tests/nested', file), project: { name: 'nested' } };

    expect(selectFrozenTestSpecifications([file], [nested, selected], root)).toEqual([selected]);
    expect(() => selectFrozenTestSpecifications([file], [nested], root)).toThrow('缺少可执行规格');
    expect(() => selectFrozenTestSpecifications([file], [selected, { ...selected, project: { name: 'duplicate' } }], root))
      .toThrow('多个项目规格');
    expect(() => selectFrozenTestSpecifications([file, file], [selected], root)).toThrow('重复文件');
  });

  it('全量计划不需要加载测试图；发布资料仍执行完整类型和构建', async () => {
    await expect(resolveAffectedPlan({ ...empty, mode: 'full' }, { release: true }))
      .resolves.toMatchObject({ schemaVersion: 1, release: true, mode: 'full', rust: true, typecheck: true, testFiles: [] });
    await expect(resolveAffectedPlan({ ...empty, mode: 'skip' }, { release: true }))
      .resolves.toMatchObject({ schemaVersion: 1, release: true, mode: 'affected', rust: false, typecheck: true, testFiles: [] });
    await expect(resolveAffectedPlan({ ...empty, mode: 'affected', explicitTests: ['tests/missing-scope.test.ts'] }, { release: true }))
      .resolves.toMatchObject({ mode: 'full', rust: true, typecheck: true });
  });

  it('校验源码、严格祖先、普通文件和固定清单，拒绝误用与路径逃逸', async () => {
    await withTemporaryRepository(async ({ root, write }) => {
      const source = 'src/components/Example.tsx', test = 'tests/components/example.test.tsx';
      await write(source, 'export const value = 1;\n');
      await write(test, 'export {};\n');
      const frozen = { ...empty, schemaVersion: 1, release: true, mode: 'affected', typecheck: true,
        lintFiles: [source], relatedFiles: [source], testFiles: [test] };
      const context = { root, head: identity.sha, isAncestor: () => true };
      expect(validateResolvedPlan(frozen, context)).toBe(frozen);
      for (const fields of [
        { schemaVersion: 2 }, { release: false }, { mode: 'full' }, { typecheck: false },
        { sha: identity.base }, { base: identity.sha }, { testFiles: [] }, { testFiles: ['../outside.test.ts'] },
        { lintFiles: [join(root, source)] }, { lintFiles: ['--config'] }, { testFiles: [test, test] },
      ]) expect(() => validateResolvedPlan({ ...frozen, ...fields }, context)).toThrow();
      expect(() => validateResolvedPlan(frozen, { ...context, isAncestor: () => false })).toThrow('祖先');
      await symlink(join(root, 'src/components'), join(root, 'linked'), 'junction');
      expect(() => validateResolvedPlan({ ...frozen, lintFiles: ['linked/Example.tsx'] }, context)).toThrow('链接');
    });
  });

  it('CLI 在源码失配时不执行 npm，在纯资料计划下不启动任何 Vitest 用例', { timeout: 15_000 }, async () => {
    await withTemporaryRepository(async ({ root, git, write }) => {
      await write('doc/change.md', 'base\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'Base');
      const base = git('rev-parse', 'HEAD').toString().trim();
      await write('doc/change.md', 'release\n');
      await write('tests/utils/unexpected.test.js', "it('must not run', () => { throw new Error('Unexpected Vitest execution'); });\n");
      git('add', '.');
      git('commit', '--quiet', '-m', 'Document target');
      const sha = git('rev-parse', 'HEAD').toString().trim();
      const npmTrap = join(root, 'npm-trap.mjs');
      await write('npm-trap.mjs', "import { appendFileSync } from 'node:fs'; appendFileSync('npm-calls.txt', process.argv.slice(2).join(' ') + '\\n');\n");
      const frozen = { ...empty, schemaVersion: 1, release: true, mode: 'affected', typecheck: true, base, sha, testFiles: [] };
      await write('frozen-plan.json', JSON.stringify({ ...frozen, sha: identity.sha }));
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|VITEST(?:_|$))/i.test(key)));
      env.npm_execpath = npmTrap;
      const execute = () => execFileSync(process.execPath, [script, '--execute-plan', 'frozen-plan.json', '--build'],
        { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
      expect(execute).toThrow();
      await expect(readFile(join(root, 'npm-calls.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await write('frozen-plan.json', JSON.stringify(frozen));
      expect(execute()).toContain('0 个 Vitest 文件');
      expect(await readFile(join(root, 'npm-calls.txt'), 'utf8')).toBe('run test:typecheck\nrun build\n');
    });
  });

  it('CLI 仅执行冻结文件，避开会失败的同名嵌套用例；选中用例失败则阻止构建', { timeout: 30_000 }, async () => {
    await withTemporaryRepository(async ({ root, git, write }) => {
      await write('.gitignore', 'node_modules\nvitest-cache/\n');
      await write('doc/base.md', 'base\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'Base');
      const base = git('rev-parse', 'HEAD').toString().trim();
      const test = 'tests/utils/selected.test.js';
      const nested = `tests/nested/${test}`;
      await write('package.json', '{"type":"module","private":true}\n');
      await write('vitest.config.mjs', `export default {
        cacheDir: 'vitest-cache',
        test: { globals: true, fileParallelism: false },
      };\n`);
      await write(test, `import { writeFileSync } from 'node:fs';
        it('runs the exact frozen file', () => {
          writeFileSync('selected-result.txt', 'selected');
          expect(true).toBe(true);
        });\n`);
      await write(nested, "it('fails if the filename filter expands', () => { throw new Error('Unexpected nested test'); });\n");
      git('add', '.');
      git('commit', '--quiet', '-m', 'Frozen test fixtures');
      const sha = git('rev-parse', 'HEAD').toString().trim();
      await symlink(dependencies, join(root, 'node_modules'), 'junction');
      await write('npm-trap.mjs', "import { appendFileSync } from 'node:fs'; appendFileSync('npm-calls.txt', process.argv.slice(2).join(' ') + '\\n');\n");
      const frozen = { ...empty, schemaVersion: 1, release: true, mode: 'affected', typecheck: true, base, sha,
        explicitTests: [test], testFiles: [test] };
      await write('frozen-plan.json', JSON.stringify(frozen));
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|VITEST(?:_|$))/i.test(key)));
      env.npm_execpath = join(root, 'npm-trap.mjs');
      const execute = () => execFileSync(process.execPath, [script, '--execute-plan', 'frozen-plan.json', '--build'],
        { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });

      expect(execute()).toContain('1 个 Vitest 文件');
      expect(await readFile(join(root, 'selected-result.txt'), 'utf8')).toBe('selected');
      expect(await readFile(join(root, 'npm-calls.txt'), 'utf8')).toBe('run test:typecheck\nrun build\n');
      await write('frozen-plan.json', JSON.stringify({ ...frozen, explicitTests: [nested], testFiles: [nested] }));
      expect(execute).toThrow();
      expect(await readFile(join(root, 'npm-calls.txt'), 'utf8')).toBe('run test:typecheck\nrun build\nrun test:typecheck\n');
    });
  });
});
