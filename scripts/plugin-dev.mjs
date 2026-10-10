import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const text = async (path) => utf8.decode(await readFile(path));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let validator;

async function manifestParser() {
  if (!validator) {
    const result = await build({
      entryPoints: [join(repository, 'src/services/plugins/pluginManifest.ts')],
      bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
    });
    validator = import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  }
  return validator;
}

// 类型直接来自宿主源码；初始化时生成可独立携带的声明，避免手写第二套 API。
async function portableSdk() {
  const parse = async (path) => ts.createSourceFile(path, await text(join(repository, path)), ts.ScriptTarget.Latest, true);
  const common = await parse('src/types/index.ts');
  const aliases = common.statements.filter((node) => ts.isTypeAliasDeclaration(node)
    && ['NodeType', 'GeneralModelCategory'].includes(node.name.text)).map((node) => node.getText());
  const locale = await parse('src/i18n/index.ts');
  const locales = locale.statements.flatMap((node) => ts.isVariableStatement(node) ? node.declarationList.declarations : [])
    .find((node) => node.name.getText() === 'LOCALES').initializer.expression.elements;
  const plugin = await parse('src/types/plugin.ts');
  const aiTypes = await parse('src/types/aiTypes.ts');
  const aiDeclarations = new Map(aiTypes.statements.filter((node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
    .map((node) => [node.name.text, node]));
  const capabilityNames = new Set(['VideoModelCapability']);
  for (const name of capabilityNames) {
    const declaration = aiDeclarations.get(name);
    if (!declaration) throw new Error(`缺少视频能力声明：${name}`);
    const visit = (node) => {
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && aiDeclarations.has(node.typeName.text)) {
        capabilityNames.add(node.typeName.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  }
  const sdk = await parse('sdk/plugin-sdk.d.ts');
  return [
    '// 由 plugin-dev 生成；更新宿主后用 sdk 命令刷新。',
    ...aliases, `export type Locale = ${locales.map((node) => node.getText()).join(' | ')};`,
    ...aiTypes.statements.filter((node) => node.name && capabilityNames.has(node.name.text)).map((node) => node.getFullText()),
    ...plugin.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getFullText()),
    ...sdk.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)).map((node) => node.getFullText()),
  ].join('\n');
}

async function boundedFile(root, path, maximum) {
  const info = await stat(join(root, path));
  if (!info.isFile() || info.size > maximum) throw new Error(`文件 ${path} 不存在、不是普通文件或超过大小限制`);
  const bytes = await readFile(join(root, path));
  if (bytes.length > maximum) throw new Error(`文件 ${path} 超过大小限制`);
  return bytes;
}

export async function checkPlugin(root) {
  const parser = await manifestParser();
  const manifestText = utf8.decode(await boundedFile(root, 'manifest.json', 64 * 1024));
  const manifest = parser.parsePluginManifest(manifestText);
  const source = utf8.decode(await boundedFile(root, manifest.entry, 512 * 1024));
  parser.parsePluginBundle(manifestText, source);
  // 只编译语法，不执行作者代码；真实执行仍交给原生 Runtime。
  if (manifest.runtime === 'javascript') new Script(source, { filename: 'main.js' });
  if (manifest.ui) {
    const bytes = await boundedFile(root, manifest.ui.entry, 2 * 1024 * 1024);
    if (digest(bytes) !== manifest.ui.integrity.replace(/^sha256-/, '')) throw new Error('UI 摘要不匹配，请重新构建');
    new Script(utf8.decode(bytes), { filename: manifest.ui.entry });
  }
  for (const resource of manifest.resources ?? []) {
    const bytes = await boundedFile(root, resource.path, 16 * 1024 * 1024);
    if (bytes.length !== resource.bytes || digest(bytes) !== resource.integrity.replace(/^sha256-/, '')) {
      throw new Error(`资源 ${resource.id} 的摘要或大小不匹配`);
    }
  }
  return manifest;
}

async function atomicText(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.plugin-dev-${process.pid}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, path);
}

export async function initPlugin(root) {
  // mkdir 不使用 recursive，已存在的目录直接拒绝，避免覆盖作者的项目。
  await mkdir(root);
  await mkdir(join(root, 'src'));
  const { version } = JSON.parse(await text(join(repository, 'package.json')));
  const manifest = {
    apiVersion: 2, minHostVersion: version, requiredCapabilities: ['javascript.async'],
    id: 'com.example.uppercase', name: '文本大写', version: '1.0.0',
    runtime: 'javascript', category: 'content', entry: 'main.js', permissions: ['node.read', 'node.write'],
    contributes: { nodeTools: [{
      id: 'uppercase', title: '文本大写', icon: 'lucide:case-upper', dialog: { fields: [] }, placements: ['node-context-menu', 'node-toolbar'],
      nodeTypes: ['ai-text', 'source-text'], inputFields: ['output'], output: { mode: 'update-current', fields: ['output'] },
    }] },
  };
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'src/main.ts'), await text(join(repository, 'sdk/plugin-template.ts')), 'utf8');
  await writeFile(join(root, 'host.d.ts'), await portableSdk(), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
      noEmit: true, types: [], lib: ['ES2020', 'DOM'] },
    include: ['src/**/*', 'host.d.ts'],
  }, null, 2)}\n`, 'utf8');
  return buildPlugin(root);
}

export async function buildPlugin(root) {
  const parser = await manifestParser();
  const raw = JSON.parse(utf8.decode(await boundedFile(root, 'manifest.json', 64 * 1024)));
  const manifest = parser.parsePluginManifest(raw && JSON.stringify(raw));
  if (manifest.runtime !== 'javascript') throw new Error('构建命令仅处理 JavaScript；Python 包可以使用 check 校验');
  const configFile = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  if (configFile.error) throw new Error('缺少有效的 tsconfig.json，请先使用 init 初始化开发目录');
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const program = ts.createProgram(config.fileNames, config.options);
  const errors = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  if (errors.length) throw new Error(errors.slice(0, 12).map((error) => {
    const position = error.file && error.file.getLineAndCharacterOfPosition(error.start ?? 0);
    return `${error.file ? basename(error.file.fileName) : 'tsconfig.json'}${position ? `:${position.line + 1}` : ''}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`;
  }).join('\n'));
  const compile = async (entry) => {
    const result = await build({ entryPoints: [join(root, entry)], bundle: true, platform: 'browser',
      format: 'iife', target: 'es2020', write: false, sourcemap: false, legalComments: 'none', logLevel: 'silent' });
    if (result.outputFiles.length !== 1) throw new Error('插件必须打包成一个 JavaScript 文件');
    const source = result.outputFiles[0].text;
    new Script(source);
    return source;
  };
  const source = await compile('src/main.ts');
  parser.parsePluginBundle(JSON.stringify(raw), source);
  const ui = manifest.ui ? await compile('src/ui.ts') : undefined;
  if (ui && Buffer.byteLength(ui) > 2 * 1024 * 1024) throw new Error('UI 产物超过 2 MiB');
  if (ui) raw.ui.integrity = digest(ui);
  for (const resource of raw.resources ?? []) {
    const bytes = await boundedFile(root, resource.path, 16 * 1024 * 1024);
    resource.bytes = bytes.length;
    resource.integrity = digest(bytes);
  }
  parser.parsePluginManifest(JSON.stringify(raw));
  await atomicText(join(root, manifest.entry), source);
  if (ui) await atomicText(join(root, manifest.ui.entry), ui);
  await atomicText(join(root, 'manifest.json'), `${JSON.stringify(raw, null, 2)}\n`);
  return checkPlugin(root);
}

function errorMessage(error, root) {
  const message = error.errors?.length ? error.errors.slice(0, 12).map((entry) =>
    `${entry.location ? `${basename(entry.location.file)}:${entry.location.line}: ` : ''}${entry.text}`).join('\n') : String(error.message);
  return message.replaceAll(root, '<插件目录>').replaceAll(repository, '<宿主仓库>').slice(0, 2048);
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  if (!directory || !['init', 'sdk', 'check', 'build', 'watch'].includes(command)) {
    throw new Error('用法：node scripts/plugin-dev.mjs <init|sdk|check|build|watch> <插件目录>');
  }
  const root = resolve(directory);
  if (command === 'sdk') await atomicText(join(root, 'host.d.ts'), await portableSdk());
  else if (command === 'init') await initPlugin(root);
  else if (command === 'check') await checkPlugin(root);
  else if (command !== 'watch') await buildPlugin(root);
  if (command !== 'watch') {
    console.log('插件校验完成；在插件设置中安装或重新载入此目录。');
    return;
  }
  // 编辑中的错误不会结束监听，修好后仍能继续构建。
  try { await buildPlugin(root); console.log('构建完成，可重新载入插件。'); }
  catch (error) { console.error(errorMessage(error, root)); }
  let timer;
  let running = false;
  let dirty = false;
  const changedPaths = new Set();
  let lastManifest = await text(join(root, 'manifest.json')).catch(() => '');
  const resourcePaths = () => {
    try { return new Set((JSON.parse(lastManifest).resources ?? []).map((resource) => resource.path)); }
    catch { return new Set(); }
  };
  let declaredResources = resourcePaths();
  const rebuild = async () => {
    if (running) { dirty = true; return; }
    running = true;
    do {
      dirty = false;
      try { await buildPlugin(root); console.log('构建完成，可重新载入插件。'); }
      catch (error) { console.error(errorMessage(error, root)); }
    } while (dirty);
    running = false;
  };
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    const path = String(filename ?? '').replaceAll('\\', '/');
    if (!['manifest.json', 'tsconfig.json', 'host.d.ts'].includes(path)
      && !path.startsWith('src/') && !declaredResources.has(path)) return;
    // 合并这一批事件，避免清单事件盖掉源码变化。
    changedPaths.add(path);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const onlyManifest = changedPaths.size === 1 && changedPaths.has('manifest.json');
      changedPaths.clear();
      if (onlyManifest && await text(join(root, 'manifest.json')).catch(() => '') === lastManifest) return;
      await rebuild();
      lastManifest = await text(join(root, 'manifest.json')).catch(() => '');
      declaredResources = resourcePaths();
    }, 150);
  });
  process.once('SIGINT', () => { watcher.close(); clearTimeout(timer); });
  console.log('监听已启动；保存源码或清单后自动重建。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(errorMessage(error, resolve(process.argv[3] ?? '.'))); process.exitCode = 1; });
}
