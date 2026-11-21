import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const manualFile = new URL('../site/manual.html', import.meta.url);
const sourceFile = new URL('../site/manual.js', import.meta.url);
const [html, source] = await Promise.all([readFile(manualFile, 'utf8'), readFile(sourceFile, 'utf8')]);

const openingTag = '<script id="manual-interactions">';
const start = html.indexOf(openingTag);
const end = html.indexOf('</script>', start + openingTag.length);
if (start === -1 || end === -1 || start !== html.lastIndexOf(openingTag)) {
  throw new Error('manual.html 缺少唯一的手册脚本标记');
}

const { code } = await transform(source, {
  charset: 'utf8',
  minifyWhitespace: true,
  lineLimit: 160,
  supported: { 'inline-script': true },
});
const updated = html.slice(0, start + openingTag.length) + '\n' + code + html.slice(end);
if (process.argv.includes('--check')) {
  if (updated !== html) throw new Error('手册脚本需要同步，请运行 node scripts/sync-site-manual.mjs');
} else if (updated !== html) {
  await writeFile(manualFile, updated);
}
