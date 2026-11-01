/**
 * 将 git hooks 路径指向 scripts/ 目录，使 hooks 可以被版本管理。
 * 用法: node scripts/setup-hooks.js
 */
import { execSync } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';

const HOOKS = ['scripts/pre-commit', 'scripts/pre-push'];

try {
  execSync('git config core.hooksPath scripts', { stdio: 'inherit' });
  // 没有可执行位时 Git 会静默跳过 hook，门禁失效且没有任何提示
  for (const hook of HOOKS) {
    const mode = statSync(hook).mode;
    if ((mode & 0o111) !== 0o111) chmodSync(hook, (mode & 0o7777) | 0o755);
  }
  console.log('Git hooks path set to scripts/');
} catch (err) {
  console.error('Failed to set git hooks path:', err.message);
  process.exit(1);
}
