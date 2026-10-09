/**
 * i18n 扫描工具：统计源码中的中文文案与 i18n 覆盖情况。
 *
 * 常用用法：
 *   node scripts/i18n-scan.mjs                      查看字典规模、缺词条、未包裹文案分类
 *   node scripts/i18n-scan.mjs --verify             校验三语是否有空译文/漏译
 *   node scripts/i18n-scan.mjs --missing-out=x.tsv  导出「已用 t() 但缺词条」清单
 *     [--prefix=src/components/settings] [--offset=0] [--limit=100]
 *   node scripts/i18n-scan.mjs --bare-out=x.tsv     导出「未包裹 t()」清单（需改造代码）
 *     [--kind=toast|dialog|attr|other] [--prefix=...] [--offset=0] [--limit=100]
 *   node scripts/i18n-scan.mjs --todo=ja-JP [--domain=settings]
 *     按域导出某语言相对 en-US 缺失的词条
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dirArg = args.find((a) => a.startsWith('--dir='));
const START = join(ROOT, dirArg ? dirArg.slice(6) : 'src');

const CJK = /[一-鿿]/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'locales' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = walk(START);
const wrapped = new Map(); // 真正被 t('中文') 包裹
const bare = new Map(); // 未包裹：text -> { files, kind }

const RE_STRING = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** 只认 `t(`，不吃 showToast( / confirmAction( 等以 t 结尾的函数 */
const RE_T_CALL = /(?<![\w$.])t\(\s*$/;

const RE_TOAST = /showToast|toast\.(success|error|info|warning)|\.toast\(/;
const RE_DIALOG = /confirmAction|confirm\(|showConfirm|Modal\.confirm|window\.alert|\balert\(|askConfirm|openConfirm/;
const RE_ATTR = /(placeholder|title|aria-label|alt|label|description|tooltip|helperText|emptyText|okText|cancelText)\s*=/;

/** 判断一行是否处在注释里（粗略：行注释 / 块注释行 / JSDoc） */
function isCommentLine(line) {
  const s = line.trim();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*');
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  let m;
  RE_STRING.lastIndex = 0;
  while ((m = RE_STRING.exec(src))) {
    const text = m[2];
    if (!CJK.test(text)) continue;
    if (/[{}<>]/.test(text)) continue; // 跳过含占位符/标签片段的复杂串
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    if (RE_T_CALL.test(before.trimEnd())) {
      if (!wrapped.has(text)) wrapped.set(text, new Set());
      wrapped.get(text).add(rel);
      continue;
    }
    // 未包裹：按所在行上下文分类
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index) === -1 ? src.length : src.indexOf('\n', m.index));
    let kind = 'other';
    if (isCommentLine(line)) kind = 'comment';
    else if (/console\.(log|warn|error|info|debug)/.test(line)) kind = 'console';
    else if (RE_TOAST.test(line)) kind = 'toast';
    else if (RE_DIALOG.test(line)) kind = 'dialog';
    else if (RE_ATTR.test(line)) kind = 'attr';
    if (!bare.has(text)) bare.set(text, { files: new Set(), kind });
    const entry = bare.get(text);
    entry.files.add(rel);
    // 同一文案出现多次时，取优先级更高的分类（toast/dialog 优先于 other）
    const rank = { comment: 0, console: 1, other: 2, attr: 3, dialog: 4, toast: 5 };
    if (rank[kind] > rank[entry.kind]) entry.kind = kind;
  }
}

/** 解析词条文件里的 'key': 'value' 对 */
function readDict(dir) {
  const dict = {};
  for (const f of (statSync(dir).isDirectory() ? walk(dir) : [dir])) {
    const src = readFileSync(f, 'utf8');
    const re = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1\s*:\s*(['"])((?:\\.|(?!\3)[^\\\n])*)\3/g;
    let m;
    while ((m = re.exec(src))) dict[m[2]] = m[4];
  }
  return dict;
}

const enUS = readDict(join(ROOT, 'src/i18n/locales/en-US'));
const jaJP = readDict(join(ROOT, 'src/i18n/locales/ja-JP'));
const koKR = readDict(join(ROOT, 'src/i18n/locales/ko-KR'));

const missingEn = [...wrapped.keys()].filter((k) => !(k in enUS));
const missingJa = [...wrapped.keys()].filter((k) => !(k in jaJP));
const missingKo = [...wrapped.keys()].filter((k) => !(k in koKR));

const out = {
  files: files.length,
  wrappedCount: wrapped.size,
  bareCount: bare.size,
  dictSizes: { enUS: Object.keys(enUS).length, jaJP: Object.keys(jaJP).length, koKR: Object.keys(koKR).length },
  missing: { enUS: missingEn.length, jaJP: missingJa.length, koKR: missingKo.length },
};

/** 按域文件列出某语言相对 en-US 缺失的词条，供逐域补齐 */
const todoArg = args.find((a) => a.startsWith('--todo='));
if (todoArg) {
  const lang = todoArg.slice(7);
  const dir = lang === 'ja-JP' ? 'ja-JP' : 'ko-KR';
  const target = readDict(join(ROOT, 'src/i18n/locales', dir));
  const rows = [];
  for (const f of walk(join(ROOT, 'src/i18n/locales/en-US'))) {
    const domain = f.split(/[\\/]/).pop().replace(/\.ts$/, '');
    if (domain === 'index') continue;
    const only = args.find((a) => a.startsWith('--domain='))?.slice(9);
    if (only && domain !== only) continue;
    for (const [k, v] of Object.entries(readDict(f))) {
      if (!(k in target)) rows.push(`${domain}\t${k}\t${v}`);
    }
  }
  const off = Number(args.find((a) => a.startsWith('--offset='))?.slice(9) ?? 0);
  const lim = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? rows.length);
  writeFileSync('scripts/.i18n-todo.tsv', rows.slice(off, off + lim).join('\n'), 'utf8');
  console.log(`${lang} 待补: ${rows.length}，本次导出 ${Math.min(lim, rows.length - off)}`);
}

/** 校验三语字典：是否有空译文、是否与中文原文完全相同（疑似漏译） */
if (args.includes('--verify')) {
  for (const lang of ['en-US', 'ja-JP', 'ko-KR']) {
    const d = readDict(join(ROOT, 'src/i18n/locales', lang));
    const keys = Object.keys(d);
    const empty = keys.filter((k) => d[k] === '');
    const same = keys.filter((k) => d[k] === k);
    console.log(`${lang}: total=${keys.length} empty=${empty.length} sameAsKey=${same.length}`);
    if (empty.length) console.log('  空译文:', JSON.stringify(empty).slice(0, 200));
    if (same.length) console.log('  与原文相同:', same.slice(0, 20).join(' / '));
  }
}

const missingOut = args.find((a) => a.startsWith('--missing-out='));
if (missingOut) {
  const prefixArg = args.find((a) => a.startsWith('--prefix='));
  const skipped = missingEn.filter((k) => k.includes('\\') || k.includes('\n'));
  if (skipped.length) console.log('跳过（含转义/换行）:', JSON.stringify(skipped));
  let list = missingEn
    .filter((k) => !k.includes('\\') && !k.includes('\n'))
    .map((k) => ({ text: k, files: [...wrapped.get(k)] }));
  if (prefixArg) {
    const p = prefixArg.slice(9);
    list = list.filter((i) => i.files.some((f) => f.includes(p)));
  }
  const off = Number(args.find((a) => a.startsWith('--offset='))?.slice(9) ?? 0);
  const lim = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? list.length);
  list = list.slice(off, off + lim);
  writeFileSync(
    missingOut.slice(14),
    list.map((i) => `${i.text}\t${i.files.join(',')}`).join('\n'),
    'utf8',
  );
  const groups = new Map();
  for (const item of list) {
    const g = item.files[0].split('/').slice(0, 3).join('/');
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  console.log('缺失词条分组统计:');
  for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${g}`);
  console.log(`总缺失: ${list.length}`);
}

/** 导出未包裹 t() 的文案（需要改代码加 t()） */
const bareOut = args.find((a) => a.startsWith('--bare-out='));
if (bareOut) {
  const kindArg = args.find((a) => a.startsWith('--kind='))?.slice(7);
  const prefixArg = args.find((a) => a.startsWith('--prefix='))?.slice(9);
  let list = [...bare].map(([text, v]) => ({ text, kind: v.kind, files: [...v.files] }));
  list = list.filter((i) => i.kind !== 'comment' && i.kind !== 'console');
  if (kindArg) list = list.filter((i) => i.kind === kindArg);
  if (prefixArg) list = list.filter((i) => i.files.some((f) => f.includes(prefixArg)));
  const off = Number(args.find((a) => a.startsWith('--offset='))?.slice(9) ?? 0);
  const lim = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? list.length);
  const page = list.slice(off, off + lim);
  writeFileSync(
    bareOut.slice(11),
    page.map((i) => `${i.kind}\t${i.text}\t${i.files.join(',')}`).join('\n'),
    'utf8',
  );
  const groups = new Map();
  for (const item of page) {
    const g = item.files[0].split('/').slice(0, 3).join('/');
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  console.log('未包裹文案分组统计:');
  for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${g}`);
  console.log(`总条数: ${list.length}，本次导出 ${page.length}`);
}

if (asJson) {
  console.log(JSON.stringify({ ...out, bare: [...bare].map(([k, v]) => ({ text: k, kind: v.kind, files: [...v.files] })) }, null, 2));
} else {
  console.log('字典规模:', JSON.stringify(out.dictSizes));
  console.log('t() 已包裹但缺词条:', JSON.stringify(out.missing));
  console.log(`文件数: ${files.length}`);
  console.log(`t() 包裹的中文串(去重): ${wrapped.size}`);
  const kinds = new Map();
  for (const [, v] of bare) kinds.set(v.kind, (kinds.get(v.kind) ?? 0) + 1);
  console.log('未包裹中文串(去重)分类:', JSON.stringify([...kinds].sort((a, b) => b[1] - a[1])));
}
