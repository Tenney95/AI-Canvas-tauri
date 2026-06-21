/**
 * 从 package.json 读取版本号，同步到 README.md 的版本 badge。
 * 用法: node scripts/sync-version.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const readmePath = resolve(root, 'README.md');

let readme = readFileSync(readmePath, 'utf-8');

const badgePattern = /version-\d+\.\d+\.\d+-6366f1/;

if (badgePattern.test(readme)) {
  readme = readme.replace(badgePattern, `version-${pkg.version}-6366f1`);
  writeFileSync(readmePath, readme, 'utf-8');
  console.log(`README.md version badge synced to ${pkg.version}`);
} else {
  console.warn('Version badge not found in README.md, skipping.');
}
