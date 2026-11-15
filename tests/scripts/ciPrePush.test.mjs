import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hook = fileURLToPath(new URL('../../scripts/ci-pre-push.mjs', import.meta.url));
const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const zero = '0'.repeat(40);
const branchUpdate = `HEAD ${sha} refs/heads/master ${base}\n`;
const tagUpdate = `refs/tags/v1.2.3 ${sha} refs/tags/v1.2.3 ${zero}\n`;

describe('推送不运行本地 CI', () => {
  it.each([
    ['普通默认分支', branchUpdate],
    ['其他分支', `HEAD ${sha} refs/heads/topic ${base}\n`],
    ['发布标签', tagUpdate],
    ['分支与标签的原子推送', branchUpdate + tagUpdate],
    ['删除引用', `(delete) ${zero} refs/heads/obsolete ${base}\n`],
    ['无引用更新', ''],
  ])('%s 不调用 Git、安装依赖或启动 npm 检查', async (_label, input) => {
    const cwd = await mkdtemp(join(tmpdir(), 'ai-canvas-push-no-ci-'));
    const marker = join(cwd, 'npm-called');
    const npmTrap = join(cwd, 'npm-trap.mjs');
    try {
      await writeFile(npmTrap, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CI_PUSH_TEST_MARKER, 'called'); process.exitCode = 23;\n", 'utf8');
      const result = spawnSync(process.execPath, [hook, 'origin'], {
        // 空目录没有 Git 仓库，空 PATH 没有 Git/npm；显式 npm 入口也不应被调用。
        cwd,
        env: { ...process.env, PATH: '', npm_execpath: npmTrap, CI_PUSH_TEST_MARKER: marker },
        input,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      expect(result.stdout).toContain('推送不自动运行 CI');
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
