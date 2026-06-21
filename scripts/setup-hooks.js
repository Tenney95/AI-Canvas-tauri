/**
 * 将 git hooks 路径指向 scripts/ 目录，使 hooks 可以被版本管理。
 * 用法: node scripts/setup-hooks.js
 */
import { execSync } from 'node:child_process';

try {
  execSync('git config core.hooksPath scripts', { stdio: 'inherit' });
  console.log('Git hooks path set to scripts/');
} catch (err) {
  console.error('Failed to set git hooks path:', err.message);
  process.exit(1);
}
