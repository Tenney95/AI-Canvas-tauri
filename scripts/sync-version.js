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
const readme = readFileSync(readmePath, 'utf-8');
const badgePattern = /version-\d+\.\d+\.\d+-6366f1/;

if (badgePattern.test(readme)) {
  const nextReadme = readme.replace(badgePattern, `version-${version}-6366f1`);
  if (nextReadme !== readme) {
    writeFileSync(readmePath, nextReadme, 'utf-8');
    console.log(`README.md version badge synced to ${version}`);
  } else {
    console.log(`README.md version badge already matches ${version}, skipping write.`);
  }
} else {
  console.warn('Version badge not found in README.md, skipping.');
}

// 2. sync Cargo.toml package.version
const cargoPath = resolve(root, 'src-tauri', 'Cargo.toml');
const cargo = readFileSync(cargoPath, 'utf-8');
const cargoVersionPattern = /^version\s*=\s*"\d+\.\d+\.\d+"/m;

if (cargoVersionPattern.test(cargo)) {
  const nextCargo = cargo.replace(cargoVersionPattern, `version = "${version}"`);
  // 内容未变时不触碰文件，避免提交钩子触发 Tauri 开发监听重启。
  if (nextCargo !== cargo) {
    writeFileSync(cargoPath, nextCargo, 'utf-8');
    console.log(`Cargo.toml version synced to ${version}`);
  } else {
    console.log(`Cargo.toml version already matches ${version}, skipping write.`);
  }
} else {
  console.warn('Cargo.toml version not found, skipping.');
}
