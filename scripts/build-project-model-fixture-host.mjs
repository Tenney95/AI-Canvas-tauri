/** 由 Cargo feature 调用，产物仅写入构建目录，不启动应用或访问数据库。 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
if (!output || process.argv.length !== 3 || !process.env.OUT_DIR
  || resolve(output) !== resolve(process.env.OUT_DIR, 'project-model-fixture-host.js')) throw new Error('fixture 构建输出无效');
// 封闭依赖集：新增依赖必须经审查，不能把主应用、文件服务或远程脚本带进维护窗口。
const localInputs = [
  'src/projectModelFixtureHost.ts',
  'src/services/chat/teams/teamGraphService.ts', 'src/services/chat/teams/teamProfileService.ts',
  'src/services/creationProfiles/creationProfileManifest.ts',
  'src/services/indexedDb/projectModelMigrationRepository.ts', 'src/services/indexedDb/projectModelStagingRepository.ts',
  'src/services/indexedDb/projectSummary.ts', 'src/services/indexedDb/schema.ts', 'src/services/mediaDataUrl.ts',
  'src/services/projectModelBackup.ts', 'src/services/projectModelComparisonMaterial.ts', 'src/services/projectModelCompatibility.ts',
  'src/services/projectModelFixtureRecovery.ts', 'src/services/projectModelNativeSafety.ts', 'src/services/projectModelSourceFingerprint.ts', 'src/services/projectModelStaging.ts',
  'src/services/storyGraphService.ts', 'src/types/episodeAssets.ts', 'src/types/projectModelBusiness.ts',
  'src/types/projectModelJournal.ts', 'src/types/storyGraph.ts', 'src/utils/manuscriptFileReference.ts',
  'node_modules/@tauri-apps/api/core.js', 'node_modules/@tauri-apps/api/external/tslib/tslib.es6.js',
];
const allowed = new Set(await Promise.all(localInputs.map((path) => realpath(resolve(root, path)))));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/projectModelFixtureHost.ts'],
  outfile: output,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome109',
  legalComments: 'none',
  sourcemap: false,
  minify: true,
  metafile: true,
  write: false,
  logLevel: 'silent',
});
if (result.warnings.length || result.outputFiles.length !== 1
  || Object.values(result.metafile.outputs).some((entry) => entry.imports.length)) throw new Error('fixture 构建包含未解析依赖');
for (const input of Object.keys(result.metafile.inputs)) {
  const path = await realpath(resolve(root, input));
  if (!allowed.has(path)) throw new Error('fixture 构建包含未经允许的模块');
  const source = await readFile(path, 'utf8');
  if (/\bimport\s*\.\s*meta\b|\bimport\s*\(|\bprocess\s*\.\s*env\b/.test(source)) throw new Error('fixture 模块包含动态环境或导入');
}
const bytes = result.outputFiles[0].contents;
const script = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
if (/\bimport\s*\.\s*meta\b|\bimport\s*\(|\b(?:fetch|WebSocket|XMLHttpRequest|EventSource|eval)\s*\(/.test(script)) {
  throw new Error('fixture 脚本包含动态导入或外部访问');
}
const realOutputDirectory = await realpath(process.env.OUT_DIR);
const temporary = resolve(realOutputDirectory, `project-model-fixture-host-${process.pid}.tmp`);
await writeFile(temporary, bytes, { flag: 'wx' });
await rename(temporary, resolve(realOutputDirectory, 'project-model-fixture-host.js'));
