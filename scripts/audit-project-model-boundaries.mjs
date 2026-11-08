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
function namedScope(node) {
  const names = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name) names.unshift(parent.name.text);
    else if (ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) {
      names.unshift(property(parent.name) ?? parent.name.getText());
    } else if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isVariableDeclaration(parent.parent)
      && ts.isIdentifier(parent.parent.name)) names.unshift(parent.parent.name.text);
    else if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isPropertyAssignment(parent.parent)) {
      names.unshift(property(parent.parent.name) ?? parent.parent.name.getText());
    }
  }
  return names.length ? names.join('::') : '<module>';
}

/** 只解析源码，不导入业务模块、不建立TS程序、不打开任何应用数据库或文件端口。 */
export function scanProjectModelSource(file, source) {
  const tree = parse(file, source), hits = [], calls = [], violations = [], bindings = new Map();
  for (const diagnostic of tree.parseDiagnostics) violations.push({ code: 'source-syntax-error',
    line: tree.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') });
  const add = (kind, name, node) => hits.push({ kind, name, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
  const addCall = (kind, operation, target, node) => calls.push({ scope: namedScope(node), kind, operation, target,
    line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
  // 仅解析词法作用域内可静态证明的门面别名；同名参数、局部变量遮蔽外层绑定。
  const isScope = (node) => ts.isSourceFile(node) || ts.isBlock(node) || ts.isCaseBlock(node) || ts.isFunctionLike(node) || ts.isClassExpression(node)
    || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCatchClause(node);
  const scopeOf = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (isScope(parent)) return parent;
    return tree;
  };
  const variableScope = (node) => {
    if (!ts.isVariableDeclarationList(node.parent) || (node.parent.flags & ts.NodeFlags.BlockScoped)) return scopeOf(node);
    // var 声明提升到最近的函数或文件，不能按 if／循环块登记。
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isSourceFile(parent) || ts.isFunctionLike(parent)) return parent;
    }
    return tree;
  };
  const bind = (scope, name, binding) => {
    if (!ts.isIdentifier(name)) return;
    let scopeBindings = bindings.get(scope);
    if (!scopeBindings) bindings.set(scope, scopeBindings = new Map());
    // 同一作用域重复声明无法可靠归因，保守地不认定其目标。
    scopeBindings.set(name.text, scopeBindings.has(name.text) ? { kind: 'unknown' } : binding);
  };
  const blockPattern = (scope, pattern) => {
    if (ts.isIdentifier(pattern)) bind(scope, pattern, { kind: 'unknown' });
    else if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
      for (const element of pattern.elements) if (ts.isBindingElement(element)) blockPattern(scope, element.name);
    }
  };
  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node)) {
      const scope = variableScope(node);
      if (ts.isIdentifier(node.name)) {
        bind(scope, node.name, node.initializer ? { kind: 'alias', expression: node.initializer } : { kind: 'unknown' });
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const name = property(element.propertyName ?? element.name);
          if (ts.isIdentifier(element.name)) bind(scope, element.name, node.initializer && name && !element.dotDotDotToken
            ? { kind: 'member', expression: node.initializer, name } : { kind: 'unknown' });
          else blockPattern(scope, element.name);
        }
      } else blockPattern(scope, node.name);
    } else if (ts.isParameter(node) || ts.isCatchClause(node) && node.variableDeclaration) {
      const name = ts.isParameter(node) ? node.name : node.variableDeclaration.name;
      blockPattern(ts.isCatchClause(node) ? node : scopeOf(node), name);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      bind(scopeOf(node), node.name, { kind: 'unknown' });
    } else if (ts.isFunctionExpression(node) && node.name) {
      bind(node, node.name, { kind: 'unknown' });
    } else if (ts.isClassExpression(node) && node.name) {
      bind(node, node.name, { kind: 'unknown' });
    }
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    const facade = !node.importClause?.isTypeOnly && facadeModule.test(node.moduleSpecifier.text), imports = node.importClause?.namedBindings;
    if (imports && ts.isNamespaceImport(imports)) bind(tree, imports.name, { kind: facade ? 'namespace' : 'unknown' });
    else if (imports && ts.isNamedImports(imports)) for (const element of imports.elements) {
      const name = (element.propertyName ?? element.name).text;
      bind(tree, element.name, !node.importClause?.isTypeOnly && !element.isTypeOnly && storeSymbols.has(name) ? { kind: 'store', name }
        : facade && !element.isTypeOnly && legacyApis.has(name) ? { kind: 'api', name } : { kind: 'unknown' });
    }
  });
  const lookup = (node) => {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (!isScope(scope)) continue;
      const binding = bindings.get(scope)?.get(node.text);
      if (binding) return binding;
    }
  };
  const value = (input, depth = 0) => {
    const node = unwrap(input); if (!node || depth > 12) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) {
      const binding = lookup(node);
      if (binding?.kind === 'alias') return value(binding.expression, depth + 1);
      const symbol = binding?.kind === 'store' ? binding.name : !binding && storeSymbols.has(node.text) ? node.text : undefined;
      return symbol === 'STORE_PROJECTS' ? 'projects' : symbol === 'STORE_PROJECT_SUMMARIES' ? 'projectSummaries' : undefined;
    }
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
  const resolve = (input, depth = 0) => {
    let node = unwrap(input); if (!node || depth > 12) return undefined;
    if (ts.isAwaitExpression(node)) node = unwrap(node.expression);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]) && facadeModule.test(node.arguments[0].text)) return { kind: 'namespace' };
    if (ts.isIdentifier(node)) {
      const binding = lookup(node);
      if (binding?.kind === 'alias') return resolve(binding.expression, depth + 1);
      if (binding?.kind === 'member') {
        const owner = resolve(binding.expression, depth + 1);
        return owner?.kind === 'namespace' && legacyApis.has(binding.name) ? { kind: 'api', name: binding.name } : undefined;
      }
      return binding;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const owner = resolve(node.expression, depth + 1);
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : value(node.argumentExpression);
      if (owner?.kind === 'namespace' && legacyApis.has(name)) return { kind: 'api', name };
    }
    return undefined;
  };
  const api = (node) => { const resolved = resolve(node.expression); return resolved?.kind === 'api' ? resolved.name : undefined; };
  const method = (expression) => ts.isPropertyAccessExpression(expression) ? expression.name.text
    : ts.isElementAccessExpression(expression) ? value(expression.argumentExpression) : undefined;
  const tableTargets = (input, depth = 0) => {
    const node = unwrap(input); if (!node || depth > 12) return [];
    if (ts.isSpreadElement(node)) return tableTargets(node.expression, depth + 1);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((element) => tableTargets(element, depth + 1));
    if (ts.isIdentifier(node)) {
      const binding = lookup(node);
      if (binding?.kind === 'alias') return tableTargets(binding.expression, depth + 1);
    }
    const table = value(node);
    return stores.has(table) ? [table] : [];
  };
  const hasLegacyCall = (node) => {
    let found = false;
    walk(node, (child) => {
      if (!ts.isCallExpression(child)) return;
      if (api(child)) found = true;
      const expression = unwrap(child.expression);
      if (['objectStore', 'createObjectStore', 'transaction'].includes(method(expression)) && tableTargets(child.arguments[0]).length) found = true;
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
      const name = api(node);
      if (name) {
        add('facade', name, node);
        addCall('facade', 'call', name, node);
      }
      const expression = unwrap(node.expression);
      const operation = method(expression);
      if (['objectStore', 'createObjectStore', 'transaction'].includes(operation)) {
        const first = unwrap(node.arguments[0]);
        for (const table of new Set(tableTargets(first))) {
          addCall('table', operation, table, node);
          // 计算属性、局部别名及存放表名的数组也列入边界。
          add('table', table, first);
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
  return { file, hits, calls, violations };
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
  const budgets = new Map(), observed = new Map();
  const key = (file, call) => JSON.stringify([file, call.scope, call.kind, call.operation, call.target]);
  if (!Array.isArray(manifest.callBudgets)) violations.push({ code: 'missing-call-budgets' });
  for (const budget of Array.isArray(manifest.callBudgets) ? manifest.callBudgets : []) {
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
      violations.push({ code: 'invalid-or-duplicate-call-budget' });
      continue;
    }
    const valid = typeof budget.file === 'string' && byFile.has(budget.file) && typeof budget.scope === 'string' && !!budget.scope
      && (budget.kind === 'table' && ['transaction', 'objectStore', 'createObjectStore'].includes(budget.operation) && stores.has(budget.target)
        || budget.kind === 'facade' && budget.operation === 'call' && legacyApis.has(budget.target))
      && Number.isSafeInteger(budget.max) && budget.max > 0;
    const id = key(budget.file, budget);
    if (!valid || budgets.has(id)) violations.push({ code: 'invalid-or-duplicate-call-budget', file: budget.file });
    else budgets.set(id, budget.max);
  }
  if (entries.size !== manifest.consumers.length) violations.push({ code: 'duplicate-consumer-entry' });
  for (const entry of manifest.consumers) if (!byFile.has(entry.file) || !entry.reason || !entry.removeAfter || !entry.priority) violations.push({ code: 'invalid-or-missing-consumer-entry', file: entry.file });
  for (const { file, source } of sources) {
    const scan = scanProjectModelSource(file, source), entry = entries.get(file);
    violations.push(...scan.violations.map((failure) => ({ file, ...failure })));
    for (const call of scan.calls) {
      const id = key(file, call);
      const count = (observed.get(id)?.count ?? 0) + 1;
      observed.set(id, { file, ...call, count });
    }
    if (!scan.hits.length) continue;
    if (!entry) violations.push({ file, code: 'unregistered-legacy-consumer' });
    else if (scan.hits.some((hit) => !entry.allowed.includes(hit.kind))) violations.push({ file, code: 'new-legacy-access-kind' });
    consumers.push({ file, category: entry?.category ?? 'unregistered', priority: entry?.priority ?? 'review', hits: scan.hits,
      reason: entry?.reason, removeAfter: entry?.removeAfter });
  }
  for (const [id, call] of observed) {
    const max = budgets.get(id) ?? 0;
    if (call.count > max) violations.push({ code: 'legacy-call-budget-exceeded', ...call, max });
  }
  const unusedCallBudgets = [...budgets].flatMap(([id, max]) => {
    const count = observed.get(id)?.count ?? 0;
    if (count >= max) return [];
    const [file, scope, kind, operation, target] = JSON.parse(id);
    return [{ file, scope, kind, operation, target, count, max }];
  });
  for (const gate of manifest.closedGates ?? []) if (!byFile.has(gate.file) || literalGate(byFile.get(gate.file), gate.export, gate.field) !== gate.expected) {
    violations.push({ code: 'formal-gate-changed', file: gate.file, export: gate.export, ...(gate.field ? { field: gate.field } : {}) });
  }
  return { schemaVersion: 1, status: violations.length ? 'review-required' : 'registered-boundaries-preserved', formalActivationReady: false,
    p7Complete: false, sourceRoots: ['src', 'scripts'], scannedFiles: sources.length, consumers, unusedCallBudgets, violations,
    limitations: ['调用预算只覆盖可静态确定的旧调用；跨文件转发、运行时动态别名、未知门面和同一作用域等量替换仍需人工审查。',
      '只分析源码中的静态表名、已登记旧项目API和有限回退语法；不替代动态调用链、桌面或原生验收。',
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
    if (report.unusedCallBudgets.length) console.log(`已有 ${report.unusedCallBudgets.length} 项调用预算出现余量；确认移除后应同步收紧清单。`);
    console.log('正式激活未就绪；P7未完成；本命令不打开业务数据库、不修改源码或数据。');
  }
  if (report.violations.length) process.exitCode = 1;
}
