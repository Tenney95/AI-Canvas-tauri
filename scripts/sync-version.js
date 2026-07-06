/**
 * 从 package.json 读取版本号，同步到：
 * - README.md 的版本 badge
 * - src-tauri/Cargo.toml 的 package.version
 * 用法: node scripts/sync-version.js
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const version = pkg.version;

// 1. sync README.md badge
const readmePath = resolve(root, 'README.md');
let readme = readFileSync(readmePath, 'utf-8');
const badgePattern = /version-\d+\.\d+\.\d+-6366f1/;

if (badgePattern.test(readme)) {
  readme = readme.replace(badgePattern, `version-${version}-6366f1`);
  writeFileSync(readmePath, readme, 'utf-8');
  console.log(`README.md version badge synced to ${version}`);
} else {
  console.warn('Version badge not found in README.md, skipping.');
}

// 2. sync Cargo.toml package.version
const cargoPath = resolve(root, 'src-tauri', 'Cargo.toml');
let cargo = readFileSync(cargoPath, 'utf-8');
const cargoVersionPattern = /^version\s*=\s*"\d+\.\d+\.\d+"/m;

if (cargoVersionPattern.test(cargo)) {
  cargo = cargo.replace(cargoVersionPattern, `version = "${version}"`);
  writeFileSync(cargoPath, cargo, 'utf-8');
  console.log(`Cargo.toml version synced to ${version}`);
} else {
  console.warn('Cargo.toml version not found, skipping.');
}
