/** P7 前置只读盘点；登记旧依赖不等于完成迁移，也不授权清理。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptPath = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const stores = new Set(['projects', 'projectSummaries']);
const storeSymbols = new Set(['STORE_PROJECTS', 'STORE_PROJECT_SUMMARIES']);
const legacyApis = new Set(['getProjectById', 'getAllProjects', 'saveProjectToDb', 'saveProject', 'loadProjectData', 'loadProjectsList',
  'deleteProjectFromDb', 'deleteProjectData', 'updateProjectSnapshot', 'updateProjectStoryGraphCAS', 'getLastActiveProjectId',
  'setLastActiveProjectId', 'createLegacyProjectRepository', 'readProjectImportScope']);
const facadeModule = /(?:fileService|storageService|indexedDbService|projectRepository|projectImportRepository)$/;
const materialSymbols = new Set(['isProjectModelFixtureBackupStore']);
const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const property = (node) => ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
function walk(node, visit) { visit(node); ts.forEachChild(node, (child) => walk(child, visit)); }
function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
  return node;
}

/** 只解析源码，不导入业务模块、不建立TS程序、不打开任何应用数据库或文件端口。 */
export function scanProjectModelSource(file, source) {
  const tree = parse(file, source), hits = [], violations = [], named = new Map(), namespaces = new Set(), constants = new Map();
  for (const diagnostic of tree.parseDiagnostics) violations.push({ code: 'source-syntax-error',
    line: tree.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') });
  const add = (kind, name, node) => hits.push({ kind, name, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier) || !facadeModule.test(node.moduleSpecifier.text)) return;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      const name = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && legacyApis.has(name)) named.set(element.name.text, name);
    }
  });
  const value = (input, depth = 0) => {
    const node = unwrap(input); if (!node || depth > 12) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return storeSymbols.has(node.text) ? node.text === 'STORE_PROJECTS' ? 'projects' : 'projectSummaries' : value(constants.get(node.text), depth + 1);
    if (ts.isPropertyAccessExpression(node) && storeSymbols.has(node.name.text)) return node.name.text === 'STORE_PROJECTS' ? 'projects' : 'projectSummaries';
    if (ts.isElementAccessExpression(node)) {
      const name = value(node.argumentExpression, depth + 1);
      if (storeSymbols.has(name)) return name === 'STORE_PROJECTS' ? 'projects' : 'projectSummaries';
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = value(node.left, depth + 1), right = value(node.right, depth + 1);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
  };
  const api = (node) => {
    const expression = unwrap(node.expression);
    if (ts.isIdentifier(expression)) return named.get(expression.text);
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)
      && legacyApis.has(expression.name.text)) return expression.name.text;
  };
  const hasLegacyCall = (node) => {
    let found = false;
    walk(node, (child) => {
      if (!ts.isCallExpression(child)) return;
      if (api(child)) found = true;
      const expression = unwrap(child.expression);
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'objectStore' && stores.has(value(child.arguments[0]))) found = true;
    });
    return found;
  };
  const newModelFile = /(?:^|\/)projectModel[^/]*\.[cm]?[jt]sx?$/.test(file);
  walk(tree, (node) => {
    if (ts.isIdentifier(node) && storeSymbols.has(node.text)) add('table', node.text, node);
    if (ts.isIdentifier(node) && materialSymbols.has(node.text)) add('material', node.text, node);
    if (!file.startsWith('src/components/') && ts.isStringLiteralLike(node) && stores.has(node.text) && !ts.isLiteralTypeNode(node.parent)
      && !ts.isCaseClause(node.parent) && !ts.isJsxAttribute(node.parent)
      && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) add('table', node.text, node);
    if (ts.isCallExpression(node)) {
      const name = api(node); if (name) add('facade', name, node);
      const expression = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(expression) && ['objectStore', 'createObjectStore', 'transaction'].includes(expression.name.text)) {
        const first = unwrap(node.arguments[0]);
        for (const argument of first && ts.isArrayLiteralExpression(first) ? first.elements : first ? [first] : []) {
          const table = value(argument);
          // 拼接/局部别名的表名也列入边界，不能只靠字符串正则。
          if (stores.has(table) && !(ts.isStringLiteralLike(argument) && stores.has(argument.text) && !file.startsWith('src/components/'))
            && !(ts.isIdentifier(argument) && storeSymbols.has(argument.text))) add('table', table, argument);
        }
      }
    }
    if (newModelFile && ts.isCatchClause(node) && hasLegacyCall(node.block)) violations.push({ code: 'new-model-catch-falls-back-to-legacy', line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
    if (ts.isIfStatement(node) && /activeDataModel|modelGeneration\s*>\s*0/.test(node.expression.getText(tree)) && hasLegacyCall(node.thenStatement)) {
      violations.push({ code: 'active-model-branch-uses-legacy', line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
    }
    if (newModelFile && ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)
      && hasLegacyCall(node.right)) violations.push({ code: 'new-model-value-falls-back-to-legacy', line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
  });
  return { file, hits, violations };
}

export function readRepositorySources(root = repositoryRoot) {
  const sources = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && absolute !== scriptPath) sources.push({
        file: path.relative(root, absolute).split(path.sep).join('/'), source: fs.readFileSync(absolute, 'utf8'),
      });
    }
  };
  for (const directory of ['src', 'scripts']) visit(path.join(root, directory));
  return sources.sort((left, right) => left.file.localeCompare(right.file));
}
function literalGate(source, name, field) {
  let result;
  walk(parse('gate.ts', source), (node) => {
    if (!ts.isVariableDeclaration(node) || property(node.name) !== name) return;
    let value = unwrap(node.initializer);
    if (value && ts.isCallExpression(value) && value.expression.getText().replace(/\s/g, '') === 'Object.freeze') value = unwrap(value.arguments[0]);
    if (field && value && ts.isObjectLiteralExpression(value)) value = unwrap(value.properties.find((item) => ts.isPropertyAssignment(item) && property(item.name) === field)?.initializer);
    if (value?.kind === ts.SyntaxKind.FalseKeyword) result = false;
    else if (value?.kind === ts.SyntaxKind.TrueKeyword) result = true;
    else if (value && ts.isNumericLiteral(value)) result = Number(value.text);
  });
  return result;
}

export function auditProjectModelSources(sources, manifest) {
  const violations = [], consumers = [], byFile = new Map(sources.map((item) => [item.file, item.source]));
  const entries = new Map(manifest.consumers.map((entry) => [entry.file, entry]));
  if (entries.size !== manifest.consumers.length) violations.push({ code: 'duplicate-consumer-entry' });
  for (const entry of manifest.consumers) if (!byFile.has(entry.file) || !entry.reason || !entry.removeAfter || !entry.priority) violations.push({ code: 'invalid-or-missing-consumer-entry', file: entry.file });
  for (const { file, source } of sources) {
    const scan = scanProjectModelSource(file, source), entry = entries.get(file);
    violations.push(...scan.violations.map((failure) => ({ file, ...failure })));
    if (!scan.hits.length) continue;
    if (!entry) violations.push({ file, code: 'unregistered-legacy-consumer' });
    else if (scan.hits.some((hit) => !entry.allowed.includes(hit.kind))) violations.push({ file, code: 'new-legacy-access-kind' });
    consumers.push({ file, category: entry?.category ?? 'unregistered', priority: entry?.priority ?? 'review', hits: scan.hits,
      reason: entry?.reason, removeAfter: entry?.removeAfter });
  }
  for (const gate of manifest.closedGates ?? []) if (!byFile.has(gate.file) || literalGate(byFile.get(gate.file), gate.export, gate.field) !== gate.expected) {
    violations.push({ code: 'formal-gate-changed', file: gate.file, export: gate.export, ...(gate.field ? { field: gate.field } : {}) });
  }
  return { schemaVersion: 1, status: violations.length ? 'review-required' : 'registered-boundaries-preserved', formalActivationReady: false,
    p7Complete: false, sourceRoots: ['src', 'scripts'], scannedFiles: sources.length, consumers, violations,
    limitations: ['只分析源码中的静态表名、已登记旧项目API和有限回退语法；不替代动态调用链、桌面或原生验收。',
      'Rust不直接读取IndexedDB；原生文件、进程、收费回执及平台停写能力不在此扫描结论内。',
      '清单登记表示当前仍需保留；通过审计不表示正式新模型已接管，也不授权删除旧表、审计、journal、媒体或备份。'] };
}
export function auditProjectModelBoundaries(root = repositoryRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts/project-model-boundaries.json'), 'utf8'));
  return auditProjectModelSources(readRepositorySources(root), manifest);
}
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const report = auditProjectModelBoundaries();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`项目模型边界：${report.status}；扫描 ${report.scannedFiles} 文件，旧依赖 ${report.consumers.length} 个模块。`);
    for (const item of report.consumers) console.log(`${item.priority} ${item.category} ${item.file} (${item.hits.length} 处静态引用)`);
    for (const issue of report.violations) console.error(`${issue.code}: ${issue.file ?? 'manifest'}${issue.line ? ':' + issue.line : ''}`);
    console.log('正式激活未就绪；P7未完成；本命令不打开业务数据库、不修改源码或数据。');
  }
  if (report.violations.length) process.exitCode = 1;
}
