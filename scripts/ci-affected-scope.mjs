/**
 * 按仓库路径选择开发阶段的检查范围。这里的文件读取关系不在 Vitest 导入图中。
 */

const sharedFrontendPaths = [
  /^src\/(?:App\.tsx|RootView\.tsx|main\.tsx|index\.css|store\/useAppStore\.ts)$/,
  /^src\/(?:types|i18n|vendor)\//,
  // Worker 入口通过 URL 加载，未必出现在 Vitest 的导入关系中。
  /^src\/services\/(?:.+\/)?[^/]+Worker\.ts$/,
  /^tests\/setup\.ts$/,
  /^doc\/插件开发规范\.md$/,
];
const lintable = /\.(?:js|mjs|cjs|ts|tsx)$/;
const typescript = /\.tsx?$/;
const sourceCode = /^src\/(?:components|constants|data|hooks|services|store|utils)\//;
const testCode = /^tests\/(?:components|hooks|i18n|scripts|services|store|types|utils)\//;
const documentation = /^(?:doc\/.+\.md|README(?:\.(?:en|ja|ko))?\.md|AGENTS\.md)$/;

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

  for (const { status, path } of changes) {
    if ((status !== 'M' && status !== 'A') || !isUsablePath(path)) {
      return emptyScope('full', '差异包含删除、重命名、类型变化或无法安全处理的路径');
    }
    if (sharedFrontendPaths.some((pattern) => pattern.test(path))) {
      fullFrontendReason ??= `共享前端输入发生变化（${path}）`;
      continue;
    }
    if (documentation.test(path)) continue;

    let readers;
    if ((sourceCode.test(path) && lintable.test(path)) || /^src\/styles\/.+\.css$/.test(path)) {
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
    return emptyScope('skip', changes.length ? '仅改动了独立文档' : '没有文件改动');
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
