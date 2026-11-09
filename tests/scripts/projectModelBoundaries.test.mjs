/** 只解析仓库文本和内存样本；不导入业务、不打开IDB/原生能力、不写真实或临时数据。 */
import { describe, expect, it } from 'vitest';
import { auditProjectModelBoundaries, auditProjectModelSources, scanProjectModelSource } from '../../scripts/audit-project-model-boundaries.mjs';

const entry = (file, allowed) => ({ file, allowed, category: 'legacy-compatibility', priority: 'P3',
  reason: '旧来源只读兼容仍需保留', removeAfter: '正式路由和恢复范围验收后再审查' });
const audit = (file, source, allowed = [], callBudgets = []) => auditProjectModelSources([{ file, source }], {
  consumers: allowed.length ? [entry(file, allowed)] : [], closedGates: [], callBudgets,
});

describe('项目模型旧消费者与正式门禁只读审计', () => {
  // 完整仓库的同步 AST 扫描在 Windows 超过默认 5 秒；保留全量扫描和所有边界断言。
  it('真实仓库的现有旧依赖必须登记分类，审计通过仍不宣称P7或正式激活完成', () => {
    const report = auditProjectModelBoundaries();
    expect(report.violations).toEqual([]);
    expect(report.status).toBe('registered-boundaries-preserved');
    expect(report.scannedFiles).toBeGreaterThan(100);
    expect(report.formalActivationReady).toBe(false); expect(report.p7Complete).toBe(false);
    expect(report.consumers).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'src/store/store.projects.ts', category: 'legacy-authority', priority: 'P1' }),
      expect.objectContaining({ file: 'src/services/indexedDb/projectImportRepository.ts', category: 'recovery-retained' }),
      expect.objectContaining({ file: 'src/services/dramaAssetTransferService.ts', category: 'legacy-support', priority: 'P2' }),
      expect.objectContaining({ file: 'src/services/projectModelRouter.ts', category: 'legacy-readonly-adapter', priority: 'P1' }),
      expect.objectContaining({ file: 'src/services/nativeArchiveHistoryCommit.ts', category: 'legacy-archive', priority: 'P1' }),
      expect.objectContaining({ file: 'src/services/projectModelBackup.ts', category: 'backup-audit-retained' }),
      expect.objectContaining({ file: 'src/projectModelFixtureHost.ts', category: 'fixture-source-retained', priority: 'P3' }),
    ]));
  }, 15_000);

  it('新旧联合目录的旧读取和导入历史冲突检查按具体作用域限制次数', () => {
    const router = 'src/services/projectModelRouter.ts';
    const routerSource = `import { getAllProjects, getProjectById } from './indexedDbService';
      import { STORE_PROJECTS, STORE_METADATA } from './indexedDb/schema';
      async function occupiedLegacyIds() { const transaction = db.transaction([STORE_PROJECTS, STORE_METADATA]);
        return transaction.objectStore(STORE_PROJECTS); }
      async function listProjectCatalog() { return getAllProjects(); }
      async function resolveProjectModel(id) { return getProjectById(id); }`;
    const routerBudgets = [
      { file: router, scope: 'occupiedLegacyIds', kind: 'table', operation: 'transaction', target: 'projects', max: 1 },
      { file: router, scope: 'occupiedLegacyIds', kind: 'table', operation: 'objectStore', target: 'projects', max: 1 },
      { file: router, scope: 'listProjectCatalog', kind: 'facade', operation: 'call', target: 'getAllProjects', max: 1 },
      { file: router, scope: 'resolveProjectModel', kind: 'facade', operation: 'call', target: 'getProjectById', max: 1 },
    ];
    expect(audit(router, routerSource, ['table', 'facade'], routerBudgets).violations).toEqual([]);
    expect(audit(router, routerSource.replace('return getProjectById(id);', 'getProjectById(id); return getProjectById(id);'),
      ['table', 'facade'], routerBudgets).violations).toContainEqual(expect.objectContaining({
      code: 'legacy-call-budget-exceeded', scope: 'resolveProjectModel', target: 'getProjectById', count: 2, max: 1,
    }));
    const importer = 'src/services/nativeArchiveHistoryCommit.ts';
    const importSource = `import { STORE_PROJECTS } from './indexedDb/schema';
      async function commitNativeArchiveHistory() { const tx = db.transaction([STORE_PROJECTS, 'metadata']);
        const work = async () => tx.objectStore(STORE_PROJECTS).getKey('id'); return work(); }`;
    const importBudgets = [
      { file: importer, scope: 'commitNativeArchiveHistory', kind: 'table', operation: 'transaction', target: 'projects', max: 1 },
      { file: importer, scope: 'commitNativeArchiveHistory::work', kind: 'table', operation: 'objectStore', target: 'projects', max: 1 },
    ];
    expect(audit(importer, importSource, ['table'], importBudgets).violations).toEqual([]);
    expect(audit(importer, importSource.replace("tx.objectStore(STORE_PROJECTS).getKey('id')",
      "[tx.objectStore(STORE_PROJECTS).getKey('id'), tx.objectStore(STORE_PROJECTS).getKey('other')]"), ['table'], importBudgets).violations)
      .toContainEqual(expect.objectContaining({ code: 'legacy-call-budget-exceeded', scope: 'commitNativeArchiveHistory::work', target: 'projects', count: 2, max: 1 }));
    expect(audit(importer, importSource.replace("getKey('id')", "put({ id: 'id' })"), ['table'], []).violations)
      .toContainEqual(expect.objectContaining({ code: 'legacy-call-budget-exceeded', scope: 'commitNativeArchiveHistory::work', target: 'projects' }));
  });

  it('新组件直接读旧表不可借UI projects栏目名漏过，纯栏目/类型/注释则不误报', () => {
    expect(scanProjectModelSource('src/components/Menu.tsx', `// tx.objectStore('projects')
      type T = Pick<State, 'projects'>; const tab = 'projects';`).hits).toEqual([]);
    const report = audit('src/components/NewCanvas.tsx', `const tab='projects'; tx.objectStore('projects').get('p');`);
    expect(report.violations).toContainEqual({ file: 'src/components/NewCanvas.tsx', code: 'unregistered-legacy-consumer' });
  });

  it('识别表常量别名、计算属性和常量拼接；不执行待扫描源码', () => {
    const source = `import { STORE_PROJECTS as legacyStore } from './schema';
      throw new Error('禁止执行样本');
      const table='pro'+'jects'; tx.objectStore(table); tx.objectStore(schema['STORE_PROJECT_SUMMARIES']);`;
    const scan = scanProjectModelSource('src/services/unregistered.ts', source);
    expect(scan.hits.filter((hit) => hit.kind === 'table').map((hit) => hit.name))
      .toEqual(expect.arrayContaining(['STORE_PROJECTS', 'projects', 'projectSummaries']));
  });

  it('识别旧门面命名别名和namespace调用；登记旧门面不能顺带获准新增直接旧表访问', () => {
    const file = 'src/services/registered.ts';
    const source = `import { getProjectById as readOld } from './indexedDbService';
      import * as files from './fileService'; readOld('p'); files.saveProject({id:'p'}); tx.objectStore('projects');`;
    const report = audit(file, source, ['facade']);
    expect(report.consumers[0].hits.filter((hit) => hit.kind === 'facade').map((hit) => hit.name))
      .toEqual(['getProjectById', 'saveProject']);
    expect(report.violations).toContainEqual({ file, code: 'new-legacy-access-kind' });
  });

  it('识别动态导入、局部门面别名和计算属性，并按原操作纳入调用预算', () => {
    const file = 'src/services/dynamic.ts';
    const source = `async function read() {
      const { getProjectById: getOld } = await import('./indexedDbService');
      const files = await import('./fileService');
      const lookup = getOld;
      await lookup('p'); await files['save' + 'Project']({ id: 'p' });
      tx['object' + 'Store']('projects');
    }`;
    const report = audit(file, source, ['facade', 'table']);
    expect(report.consumers[0].hits.filter((hit) => hit.kind === 'facade').map((hit) => hit.name))
      .toEqual(['getProjectById', 'saveProject']);
    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'legacy-call-budget-exceeded', scope: 'read', target: 'getProjectById' }),
      expect.objectContaining({ code: 'legacy-call-budget-exceeded', scope: 'read', target: 'saveProject' }),
      expect.objectContaining({ code: 'legacy-call-budget-exceeded', scope: 'read', operation: 'objectStore', target: 'projects' }),
    ]));
  });

  it('词法遮蔽不会将无关回调或局部函数误判为旧门面', () => {
    const source = `import { getProjectById as readOld } from './indexedDbService';
      import * as files from './fileService';
      function unrelated(readOld, files) { readOld('x'); files.saveProject({}); }
      function scope() { const files = { saveProject() {} }; files.saveProject({}); }
      function actual() { const { saveProject: save } = files; save({}); readOld('p'); }`;
    expect(scanProjectModelSource('src/services/aliases.ts', source).calls
      .filter((call) => call.kind === 'facade').map(({ scope, target }) => ({ scope, target })))
      .toEqual([{ scope: 'actual', target: 'saveProject' }, { scope: 'actual', target: 'getProjectById' }]);
  });

  it('嵌套解构和具名函数表达式遮蔽外层导入，var 别名按函数作用域提升', () => {
    const source = `import { getProjectById as readOld } from './indexedDbService';
      function arrayShadow() { const [{ readOld }] = other; readOld('x'); }
      function nestedShadow() { const { value: { readOld } } = other; readOld('x'); }
      const local = function readOld() { readOld('x'); };
      function read(condition) { if (condition) { var alias = readOld; } return alias('p'); }`;
    expect(scanProjectModelSource('src/services/scopes.ts', source).calls
      .filter((call) => call.kind === 'facade').map(({ scope, target }) => ({ scope, target })))
      .toEqual([{ scope: 'read', target: 'getProjectById' }]);
  });

  it('switch 分支的 let 只遮蔽 CaseBlock，不能掩盖 switch 之外的旧门面调用', () => {
    const source = `import { getProjectById as readOld } from './indexedDbService';
      function read(value) {
        switch (value) { case 1: let readOld = localRead; readOld('x'); break; }
        return readOld('p');
      }`;
    expect(scanProjectModelSource('src/services/switch.ts', source).calls
      .filter((call) => call.kind === 'facade').map(({ scope, target }) => ({ scope, target })))
      .toEqual([{ scope: 'read', target: 'getProjectById' }]);
  });

  it('具名 class 表达式在类体内遮蔽同名旧门面，不影响类体外的调用', () => {
    const source = `import { getProjectById as readOld } from './indexedDbService';
      const View = class readOld { method() { readOld(); } };
      function read() { return readOld('p'); }`;
    expect(scanProjectModelSource('src/services/class-expression.ts', source).calls
      .filter((call) => call.kind === 'facade').map(({ scope, target }) => ({ scope, target })))
      .toEqual([{ scope: 'read', target: 'getProjectById' }]);
  });

  it('解析静态表名数组及展开，参数遮蔽时不借外层同名常量认定为旧表', () => {
    const file = 'src/services/arrays.ts';
    const source = `const table = 'projects'; const tables = [table, 'metadata'];
      function read() { db.transaction([...tables]); }
      function other(table) { tx.objectStore(table); }`;
    const calls = scanProjectModelSource(file, source).calls.filter((call) => call.kind === 'table');
    expect(calls).toEqual([expect.objectContaining({ scope: 'read', operation: 'transaction', target: 'projects' })]);
    const fallback = `const names = ['projects']; try { readNew(); } catch { db['transaction'](names); }`;
    expect(scanProjectModelSource('src/services/projectModelNew.ts', fallback).violations)
      .toEqual([expect.objectContaining({ code: 'new-model-catch-falls-back-to-legacy' })]);
  });

  it('新模型异常不能静默退到旧门面；已有旧权威自身错误处理不因此冒充新模型问题', () => {
    const source = `import { getProjectById as readOld } from './indexedDbService';
      async function read(){ try { return await newRepository.read(); } catch { return readOld('p'); } }`;
    expect(scanProjectModelSource('src/services/projectModelNew.ts', source).violations)
      .toEqual([expect.objectContaining({ code: 'new-model-catch-falls-back-to-legacy' })]);
    expect(scanProjectModelSource('src/services/storageService.ts', source).violations).toEqual([]);
  });

  it('活动新模型分支或空值回退不能读取旧表/门面，旧包纯格式转换不属于运行时fallback', () => {
    const source = `import { getProjectById } from './indexedDbService';
      if(activeDataModel) return getProjectById('p');
      const result = newRepository.read() ?? getProjectById('p');`;
    const codes = scanProjectModelSource('src/services/projectModelNew.ts', source).violations.map((item) => item.code);
    expect(codes).toContain('active-model-branch-uses-legacy'); expect(codes).toContain('new-model-value-falls-back-to-legacy');
    expect(scanProjectModelSource('src/services/projectModelArchiveService.ts', `if(version===1) return adaptSnapshotV1ToV2(snapshot);`).violations).toEqual([]);
  });

  it('正式开关只接受真实AST字面量，注释false或运行时包装不能冒充关闭', () => {
    const file = 'src/services/gate.ts', gate = { file, export: 'CAPABILITIES', field: 'activation', expected: false };
    const manifest = { consumers: [], closedGates: [gate], callBudgets: [] };
    const checked = (source) => auditProjectModelSources([{ file, source }], manifest);
    expect(checked(`const CAPABILITIES=Object.freeze({activation:false} as const);`).violations).toEqual([]);
    expect(checked(`// activation:false
      const CAPABILITIES=Object.freeze({activation:true});`).violations).toContainEqual({ code: 'formal-gate-changed', file,
        export: gate.export, field: gate.field });
  });

  it('无效或重复登记和语法错误保留为审查失败，不用兼容清单掩盖坏代码', () => {
    const file = 'src/services/known.ts';
    const report = auditProjectModelSources([{ file, source: `tx.objectStore('projects');` }], {
      consumers: [entry(file, ['table']), entry(file, ['table'])], closedGates: [], callBudgets: [],
    });
    expect(report.violations).toContainEqual({ code: 'duplicate-consumer-entry' });
    expect(scanProjectModelSource(file, `const broken = ;`).violations[0].code).toBe('source-syntax-error');
  });

  it('已登记文件内新增同作用域同目标旧调用也必须重新审核，删减不阻断但报告预算余量', () => {
    const file = 'src/services/known.ts';
    const budget = { file, scope: 'read', kind: 'facade', operation: 'call', target: 'getProjectById', max: 1 };
    const source = `import { getProjectById as readOld } from './indexedDbService';
      function read() { return readOld('p'); }`;
    expect(audit(file, source, ['facade'], [budget]).violations).toEqual([]);
    const added = source.replace("return readOld('p');", "readOld('q'); return readOld('p');");
    expect(audit(file, added, ['facade'], [budget]).violations).toContainEqual(expect.objectContaining({
      code: 'legacy-call-budget-exceeded', file, scope: 'read', target: 'getProjectById', count: 2, max: 1,
    }));
    const moved = source + `\nfunction other() { return readOld('p'); }`;
    expect(audit(file, moved, ['facade'], [budget]).violations).toContainEqual(expect.objectContaining({
      code: 'legacy-call-budget-exceeded', file, scope: 'other', target: 'getProjectById', count: 1, max: 0,
    }));
    const removed = audit(file, source.replace("return readOld('p');", 'return null;'), ['facade'], [budget]);
    expect(removed.violations).toEqual([]);
    expect(removed.unusedCallBudgets).toEqual([expect.objectContaining({ file, scope: 'read', count: 0, max: 1 })]);
  });

  it('表操作按命名作用域、操作和目标分别计数，重排或变量别名不改变基线', () => {
    const file = 'src/services/known.ts';
    const callBudgets = [
      { file, scope: 'load', kind: 'table', operation: 'transaction', target: 'projects', max: 1 },
      { file, scope: 'load', kind: 'table', operation: 'objectStore', target: 'projects', max: 1 },
    ];
    const source = `const TABLE = 'projects';
      function load() { const transaction = db.transaction([TABLE]); return transaction.objectStore(TABLE); }`;
    expect(audit(file, source, ['table'], callBudgets).violations).toEqual([]);
    expect(audit(file, source.replace('return transaction.objectStore(TABLE);',
      'transaction.objectStore(TABLE); return transaction.objectStore(TABLE);'), ['table'], callBudgets).violations)
      .toContainEqual(expect.objectContaining({ code: 'legacy-call-budget-exceeded', file, scope: 'load',
        operation: 'objectStore', target: 'projects', count: 2, max: 1 }));
  });

  it('缺少、重复或无效的调用预算必须提示审查，不能静默关闭门禁', () => {
    const file = 'src/services/known.ts';
    const source = `function load() { return db.transaction('projects'); }`;
    const budget = { file, scope: 'load', kind: 'table', operation: 'transaction', target: 'projects', max: 1 };
    const base = { consumers: [entry(file, ['table'])], closedGates: [] };
    expect(auditProjectModelSources([{ file, source }], base).violations)
      .toContainEqual({ code: 'missing-call-budgets' });
    expect(auditProjectModelSources([{ file, source }], { ...base, callBudgets: [budget, budget, null] }).violations)
      .toEqual(expect.arrayContaining([
        { code: 'invalid-or-duplicate-call-budget', file }, { code: 'invalid-or-duplicate-call-budget' },
      ]));
  });
});
