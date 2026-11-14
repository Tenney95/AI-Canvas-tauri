import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNameStatus } from '../../scripts/ci-affected.mjs';
import { classifyAffectedChanges } from '../../scripts/ci-affected-scope.mjs';

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
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });

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

  it('执行依赖改动文件的 Vitest 用例，同时排除会失败的无关用例', async () => {
    await withTemporaryRepository(async ({ root, git, write, run }) => {
      await write('.gitignore', 'node_modules\nvitest-cache/\n');
      await write('package.json', '{"type":"module","private":true}\n');
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
      await symlink(dependencies, join(root, 'node_modules'), 'junction');
      await write('tests/utils/changed-helper.js', 'export const value = 2;\n');

      run('--base', 'HEAD');
      expect(await readFile(join(root, 'selected-result.txt'), 'utf8')).toBe('2');
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
    expect(modify('doc/插件开发规范.md')).toMatchObject({ mode: 'full' });
  });

  it.each([
    'src-tauri/permissions/external-agent.toml',
    'src-tauri/gen/schemas/macOS-schema.json',
  ])('Tauri 权限和平台 schema 改动可定向检查（%s）', (path) => {
    const plan = modify(path);

    expect(plan).toMatchObject({ mode: 'affected', rust: true });
    expect(plan.explicitTests).toContain('tests/scripts/nativeAppCommandAcl.test.ts');
  });

  it('改动原生工具栏嵌入的 CSS 和公开插件脚本时保留两者的验证范围', () => {
    const css = 'src/styles/ui-kit.css';
    const bootstrap = 'public/plugin-ui-bootstrap.js';
    const plan = modify(css, bootstrap);

    expect(plan).toMatchObject({ mode: 'affected', lintFiles: [bootstrap], rust: true });
    expect(plan.relatedFiles).toContain(css);
    expect(plan.explicitTests).toContain('tests/services/pluginUiFrameBootstrap.test.ts');
  });

  it.each([
    'package-lock.json',
    'tsconfig.test.json',
    'tests/setup.ts',
    '.github/workflows/ci.yml',
    'unknown/build-input.json',
  ])('共享输入或无法归类的 %s 回退完整检查', (path) => {
    expect(modify(path)).toMatchObject({ mode: 'full', rust: true });
  });

  it('删除源码时不能仅靠当前分支的导入图选测试', () => {
    expect(classifyAffectedChanges([
      { status: 'D', path: 'src/components/OldComponent.tsx' },
      { status: 'A', path: 'src/components/MovedComponent.tsx' },
    ])).toMatchObject({ mode: 'full', rust: true });
  });
});
