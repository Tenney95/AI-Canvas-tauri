import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hook = fileURLToPath(new URL('../../scripts/ci-pre-push.mjs', import.meta.url));

async function withRepository(test) {
  const cwd = await mkdtemp(join(tmpdir(), 'ai-canvas-pre-push-test-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=disabled-hooks', ...args], { cwd, env, encoding: 'utf8' }).trim();
  const run = (input, remote = 'origin') => spawnSync(process.execPath, [hook, remote], { cwd, env, input, encoding: 'utf8' });
  const write = (path, content) => writeFile(join(cwd, path), `${content}\n`);
  const commit = () => {
    git('add', '.');
    git('commit', '--quiet', '-m', 'Fixture');
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'CI Fixture');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    await mkdir(join(cwd, 'scripts'));
    await write('package.json', JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: { ci: 'node scripts/check.mjs', 'ci:affected': 'node scripts/check.mjs' },
    }));
    await write('package-lock.json', JSON.stringify({
      name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } },
    }));
    await write('scripts/ci-affected.mjs', 'console.log(JSON.stringify({ mode: "affected" }));');
    await write('scripts/check.mjs', `import { readFileSync } from 'node:fs';
      const value = readFileSync('source.txt', 'utf8').trim();
      console.log('FIXTURE CHECK', value, ...process.argv.slice(2));
      if (value === 'fail' && process.argv.length > 2) process.exitCode = 7;`);
    await write('source.txt', 'base');
    const base = commit();
    await test({ base, commit, git, run, write });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const masterUpdate = (target, base) => `HEAD ${target} refs/heads/master ${base}\n`;

function successfulOutput(result) {
  expect(result.status, result.stderr || result.error?.message || result.stdout).toBe(0);
  return result.stdout;
}

describe('推送检查', () => {
  it('普通 origin/master 推送使用远端基线与快照中的生产构建，忽略当前工作区内容', async () => {
    await withRepository(async ({ base, commit, run, write }) => {
      await write('source.txt', 'pushed');
      const target = commit();
      await write('source.txt', 'dirty');

      const output = successfulOutput(run(masterUpdate(target, base)));
      expect(output).toContain(`FIXTURE CHECK pushed --base ${base} --committed-only --build`);
    });
  }, 30_000);

  it('分支和注释标签同时推送同一提交时只执行一次完整检查', async () => {
    await withRepository(async ({ base, commit, git, run, write }) => {
      await write('source.txt', 'release');
      const target = commit();
      git('tag', '-a', '-m', 'Release', 'v1.2.3');
      const tag = git('rev-parse', 'refs/tags/v1.2.3');
      const input = `${masterUpdate(target, base)}refs/tags/v1.2.3 ${tag} refs/tags/v1.2.3 ${'0'.repeat(base.length)}\n`;

      const output = successfulOutput(run(input));
      expect(output.match(/^FIXTURE CHECK.*$/gm)).toEqual(['FIXTURE CHECK release']);
    });
  }, 30_000);

  it('忽略删除引用，受影响检查失败时不会改用全量结果覆盖失败', async () => {
    await withRepository(async ({ base, commit, run, write }) => {
      const deletion = `(delete) ${'0'.repeat(base.length)} refs/heads/obsolete ${base}\n`;
      expect(successfulOutput(run(deletion))).toBe('');
      await write('source.txt', 'fail');
      const target = commit();

      const result = run(masterUpdate(target, base));
      expect(result.status).toBe(1);
      expect(result.stdout.match(/^FIXTURE CHECK.*$/gm)).toEqual([
        `FIXTURE CHECK fail --base ${base} --committed-only --build`,
      ]);
    });
  }, 30_000);
});
