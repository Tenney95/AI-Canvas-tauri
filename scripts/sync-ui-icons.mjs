/** 按源码中的固定图标名更新随包数据；只下载资源，不安装依赖或修改项目数据。 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import ts from 'typescript';
import { addCollection, getIcon } from '@iconify/react';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runFile = promisify(execFile);
const prefixes = new Set(['mdi', 'lucide', 'material-symbols', 'icon-park-outline', 'mingcute', 'solar', 'svg-spinners']);
const names = new Map();

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.tsx?$/.test(entry.name)) {
      const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const match = /^([a-z0-9-]+):([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(node.text);
          if (match && prefixes.has(match[1])) {
            if (!names.has(match[1])) names.set(match[1], new Set());
            names.get(match[1]).add(match[2]);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
}

async function download(url) {
  // 系统 curl 沿用开发环境的代理设置，避免 Node fetch 绕过代理后持续超时。
  try {
    const { stdout } = await runFile('curl', ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '10',
      '--max-time', '90', '--retry', '2', '--retry-delay', '1', url], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    throw new Error(`图标资源下载失败：${url}`);
  }
}

function archiveJson(archive, name) {
  // tar 仅向 stdout 读固定成员，不把 npm 包解压到磁盘或执行其中的代码。
  const result = spawnSync('tar', ['-xzOf', '-', `package/${name}`], { input: archive, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`无法读取图标包 ${name}，请确认系统 tar 可用`);
  return JSON.parse(result.stdout.toString('utf8'));
}

await collect(join(root, 'src'));
const sources = await Promise.all([...names.keys()].sort().map(async (prefix) => {
  const manifest = JSON.parse((await download(`https://registry.npmjs.org/@iconify-json/${prefix}/latest`)).toString('utf8'));
  const archive = await download(manifest.dist.tarball);
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  if (integrity !== manifest.dist.integrity) throw new Error(`图标包完整性校验失败：${prefix}`);
  const collection = archiveJson(archive, 'icons.json');
  if (collection.prefix !== prefix || !addCollection(collection, '')) throw new Error(`图标集无效：${prefix}`);
  const info = archiveJson(archive, 'info.json');
  return { prefix, version: manifest.version, author: info.author, license: info.license };
}));

const icons = {};
const missing = [];
for (const [prefix, items] of [...names].sort()) {
  for (const name of [...items].sort()) {
    const fullName = `${prefix}:${name}`, icon = getIcon(fullName);
    if (!icon?.body) missing.push(fullName);
    else icons[fullName] = icon;
  }
}
if (missing.length) throw new Error(`源码引用了不存在的图标：${missing.join(', ')}`);

const licenses = await Promise.all(sources.map(async ({ prefix, license }) => {
  const id = license.spdx;
  if (!/^[A-Za-z0-9.-]+$/.test(id)) throw new Error('图标许可证标识无效');
  const upstream = new URL(license.url);
  // 原项目的许可证保留具体版权声明；通用授权页面使用 SPDX 的完整条款。
  const url = upstream.hostname === 'github.com' && upstream.pathname.includes('/blob/')
    ? `https://raw.githubusercontent.com${upstream.pathname.replace('/blob/', '/')}`
    : `https://raw.githubusercontent.com/spdx/license-list-data/main/text/${id}.txt`;
  const text = await download(url);
  return `\n\n===== ${prefix}: ${id} =====\n\n${text.toString('utf8')}`;
}));
const attribution = sources.map(({ prefix, version, author, license }) =>
  `${prefix} (@iconify-json/${prefix}@${version})\nAuthor: ${author.name}\nSource: ${author.url}\nLicense: ${license.title} (${license.spdx})\n${license.url}`).join('\n\n');
await writeFile(join(root, 'src/assets/ui-icons.json'), `${JSON.stringify(icons, null, 2)}\n`, 'utf8');
await writeFile(join(root, 'src/assets/ui-icons.LICENSE.txt'), `Bundled UI icons\n\n${attribution}${licenses.join('')}\n`, 'utf8');
console.log(`已内置 ${Object.keys(icons).length} 个图标，来自 ${sources.length} 个图标集。`);
