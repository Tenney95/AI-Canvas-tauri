/**
 * 按仓库路径选择开发阶段的检查范围。这里的文件读取关系不在 Vitest 导入图中。
 */
import { isDeepStrictEqual } from 'node:util';

const sharedFrontendPaths = [
  /^src\/(?:App\.tsx|RootView\.tsx|main\.tsx|index\.css|store\/useAppStore\.ts)$/,
  /^src\/vendor\//,
  /^src\/types\/(?:index|agent|chat|mcp|plugin|agentPackage)\.ts$/,
  /^src\/i18n\/(?!locales\/(?:en-US|ja-JP|ko-KR)\/(?!index\.ts$)[^/]+\.ts$)/,
  /^src\/services\/(?:indexedDb\/|indexedDbService\.ts$|storageService\.ts$|providerSecretService\.ts$|fileService\.ts$|fs\/|plugins\/|mcp\/)/,
  /^src\/services\/chat\/(?:tools\/|(?:policyEngine|toolRegistry|agentRuntime|agentRoundExecutor|agentTaskControl|agentToolSchemas|skillManifest)\.ts$)/,
  /^src\/services\/ai\/(?:modelProtocol[^/]*\.ts|chatApiProtocol\.ts|providers\/)/,
  /^src\/store\/store\.(?:projects|plugins|config|agent|agentPackages)\.ts$/,
  /^src-tauri\/(?:permissions\/|capabilities\/|gen\/schemas\/|src\/(?:lib\.rs$|main\.rs$|path_policy\.rs$|secret_store\.rs$|plugins\/|mcp\/|agent\/|files\/))/,
  /^public\/(?:ai-app-|plugin-)/,
  // Worker 入口通过 URL 加载，未必出现在 Vitest 的导入关系中。
  /^src\/services\/(?:.+\/)?[^/]+Worker\.ts$/,
  /^tests\/setup\.ts$/,
  /^doc\/插件开发规范\.md$/,
];
const lintable = /\.(?:js|mjs|cjs|ts|tsx)$/;
const typescript = /\.tsx?$/;
const sourceCode = /^src\/(?:components|constants|data|hooks|services|store|utils)\//;
const testCode = /^tests\/(?:components|hooks|i18n|scripts|services|store|types|utils)\//;
const documentation = /^(?:doc\/.+\.md|README(?:\.(?:en|ja|ko))?\.md|AGENTS\.md|\.release-notes\.md|\.github\/release-title\.txt)$/;
const translations = /^src\/i18n\/locales\/(?:en-US|ja-JP|ko-KR)\/(?!index\.ts$)[^/]+\.ts$/;
const domainTypes = /^src\/types\/[^/]+\.ts$/;
const releaseMetadata = new Set(['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']);
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export function isReleaseMetadataPath(path) {
  return releaseMetadata.has(path);
}

function jsonWithoutVersion(text, path) {
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object' || !stableVersion.test(value.version)) throw new Error('版本字段无效');
  if (path === 'package-lock.json') {
    const app = value.packages?.[''];
    if (!app || app.version !== value.version || !stableVersion.test(app.version)) throw new Error('锁文件应用版本无效');
    delete app.version;
  }
  delete value.version;
  return value;
}

function tomlWithoutVersion(text, path) {
  const normalized = text.replace(/\r\n/g, '\n');
  const pattern = path.endsWith('Cargo.lock')
    ? /^\[\[package\]\][ \t]*\n[\s\S]*?(?=^\[\[package\]\]|(?![\s\S]))/gm
    : /^\[package\][ \t]*\n[\s\S]*?(?=^\[|(?![\s\S]))/gm;
  const sections = [...normalized.matchAll(pattern)].filter(([section]) => (
    !path.endsWith('Cargo.lock') || /^name[ \t]*=[ \t]*"ai-canvas-tauri"[ \t]*$/m.test(section)
  ));
  if (sections.length !== 1) throw new Error('应用版本区段无效');
  const section = sections[0];
  const versions = [...section[0].matchAll(/^version[ \t]*=[ \t]*"([^"]+)"[ \t]*(?:#[^\n]*)?$/gm)];
  if (versions.length !== 1 || !stableVersion.test(versions[0][1])) throw new Error('应用版本字段无效');
  const version = versions[0];
  const start = section.index + version.index;
  return normalized.slice(0, start) + 'version = "<application-version>"' + normalized.slice(start + version[0].length);
}

/** 只豁免已比较两个提交且确实仅应用版本变化的已存在文件。 */
export function isVersionOnlyReleaseChange({ status, path, before, after }) {
  if (status !== 'M' || !isReleaseMetadataPath(path) || typeof before !== 'string' || typeof after !== 'string') return false;
  try {
    if (path.endsWith('.json')) return isDeepStrictEqual(jsonWithoutVersion(before, path), jsonWithoutVersion(after, path));
    return tomlWithoutVersion(before, path) === tomlWithoutVersion(after, path);
  } catch {
    return false;
  }
}

const sourceReaderTests = [
  [/\.[cm]?[jt]sx?$/, ['tests/scripts/projectModelBoundaries.test.mjs']],
  [/\.tsx?$/, ['tests/i18n/i18n.test.ts']],
  [/\.tsx$/, ['tests/components/select.test.tsx']],
  [/^src\/(?:components|hooks|styles)\//, [
    'tests/components/imageFullscreenMemoryGuard.test.tsx',
    'tests/components/mediaPreviewMemoryGuard.test.ts',
    'tests/components/panoramaInternalization.test.ts',
    'tests/components/richTextChipSafety.test.ts',
    'tests/components/selectPortalBoundary.test.ts',
    'tests/components/videoEditorConfigIsolation.test.ts',
    'tests/components/viewportImage.test.tsx',
  ]],
  [/^src\/services\//, [
    'tests/components/mediaPreviewMemoryGuard.test.ts',
    'tests/services/mediaReferenceMemoryGuards.test.ts',
  ]],
  [/^src\/styles\//, ['tests/services/pluginRuntime.test.ts']],
];

const nativeReaderTests = [
  [/^src-tauri\/(?:capabilities\/[^/]+\.json|permissions\/[^/]+\.toml|(?:build\.rs|src\/.+\.rs))$/, [
    'tests/scripts/nativeAppCommandAcl.test.ts',
  ]],
  [/^src-tauri\/gen\/schemas\/(?:desktop|macOS|windows)-schema\.json$/, [
    'tests/scripts/nativeAppCommandAcl.test.ts',
  ]],
  [/^src-tauri\/src\/.+\.rs$/, ['tests/i18n/i18n.test.ts']],
  [/^src-tauri\/src\/media\/comfyui\/bridge\.(?:js|css)$/, [
    'tests/services/comfyBridgeInferCategory.test.ts',
    'tests/services/comfyBridgeSaveIdentity.test.ts',
    'tests/services/comfyBridgeWindowDrag.test.ts',
  ]],
  [/^src-tauri\/src\/media\/muse\/page\.js$/, ['tests/services/musePageAdapter.test.ts']],
  [/^src-tauri\/src\/plugins\/window-bootstrap\.js$/, ['tests/services/pluginUiWindowBootstrap.test.ts']],
];

const publicReaderTests = [
  [/^public\/(?:ai-app-bootstrap\.js|ai-app-host\.html)$/, ['tests/services/aiAppSandbox.test.ts']],
  [/^public\/plugin-preview-bootstrap\.js$/, ['tests/services/pluginPreviewBootstrap.test.ts']],
  [/^public\/plugin-ui-bootstrap\.js$/, ['tests/services/pluginUiFrameBootstrap.test.ts']],
  [/^public\/favicon\.svg$/, ['tests/services/comfyBridgeSaveIdentity.test.ts']],
  [/^public\/licenses\/XiaoLuo-Panorama-(?:LICENSE|NOTICE)\.txt$/, ['tests/components/panoramaInternalization.test.ts']],
];

function readerTests(path, rules) {
  return rules.flatMap(([pattern, tests]) => pattern.test(path) ? tests : []);
}

function emptyScope(mode, reason, rust = mode === 'full') {
  return {
    mode,
    reason,
    lintFiles: [],
    relatedFiles: [],
    explicitTests: [],
    typecheck: mode === 'full',
    rust,
  };
}

function isUsablePath(path) {
  return typeof path === 'string' &&
    !/[\\\n\r\t:*?[\]{}]/.test(path) &&
    path.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

export function classifyAffectedChanges(changes) {
  const lintFiles = new Set();
  const relatedFiles = new Set();
  const explicitTests = new Set();
  let typecheck = false;
  let rust = false;
  let fullFrontendReason;

  for (const change of changes) {
    const { status, path } = change;
    if ((status !== 'M' && status !== 'A') || !isUsablePath(path)) {
      return emptyScope('full', '差异包含删除、重命名、类型变化或无法安全处理的路径');
    }
    if (isReleaseMetadataPath(path)) {
      if (isVersionOnlyReleaseChange(change)) continue;
      return emptyScope('full', `版本资料含有依赖、配置或无法确认的变化（${path}）`);
    }
    if (sharedFrontendPaths.some((pattern) => pattern.test(path))) {
      fullFrontendReason ??= `共享前端输入发生变化（${path}）`;
      rust ||= path.startsWith('src-tauri/') || path.startsWith('public/');
      continue;
    }
    if (documentation.test(path)) continue;
    // 官网和演示由独立 Pages 工作流构建，不进入 Tauri 的 src/public 输入。
    if (path.startsWith('site/')) continue;

    let readers;
    if (translations.test(path) || domainTypes.test(path)) {
      relatedFiles.add(path);
      typecheck = true;
      readers = [...readerTests(path, sourceReaderTests), 'tests/i18n/i18n.test.ts'];
    } else if ((sourceCode.test(path) && lintable.test(path)) || /^src\/styles\/.+\.css$/.test(path)) {
      relatedFiles.add(path);
      typecheck ||= typescript.test(path);
      // Tauri 的原生工具栏直接嵌入这两份 CSS。
      rust ||= path === 'src/styles/base.css' || path === 'src/styles/ui-kit.css';
      readers = readerTests(path, sourceReaderTests);
    } else if (testCode.test(path) && lintable.test(path)) {
      relatedFiles.add(path);
      typecheck ||= typescript.test(path);
      readers = [];
    } else if (path.startsWith('src-tauri/')) {
      rust = true;
      readers = readerTests(path, nativeReaderTests);
      if (readers.length === 0) return emptyScope('full', `原生输入的前端影响未分类（${path}）`);
    } else {
      readers = readerTests(path, publicReaderTests);
      if (readers.length === 0) return emptyScope('full', `文件影响范围未分类（${path}）`);
      rust ||= path === 'public/favicon.svg';
    }

    if (lintable.test(path)) lintFiles.add(path);
    for (const test of readers) explicitTests.add(test);
  }

  if (fullFrontendReason) return emptyScope('full', fullFrontendReason, rust);
  if (!lintFiles.size && !relatedFiles.size && !explicitTests.size && !rust) {
    return emptyScope('skip', changes.length ? '仅改动了独立文档、官网或应用版本资料' : '没有文件改动');
  }
  return {
    mode: 'affected',
    reason: '检查改动文件、依赖这些文件的用例，以及直接读取相关文件的用例',
    lintFiles: [...lintFiles].sort(),
    relatedFiles: [...relatedFiles].sort(),
    explicitTests: [...explicitTests].sort(),
    typecheck,
    rust,
  };
}
