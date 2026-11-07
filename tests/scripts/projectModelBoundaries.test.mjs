/** 只解析仓库文本和内存样本；不导入业务、不打开IDB/原生能力、不写真实或临时数据。 */
import { describe, expect, it } from 'vitest';
import { auditProjectModelBoundaries, auditProjectModelSources, scanProjectModelSource } from '../../scripts/audit-project-model-boundaries.mjs';

const entry = (file, allowed) => ({ file, allowed, category: 'legacy-compatibility', priority: 'P3',
  reason: '旧来源只读兼容仍需保留', removeAfter: '正式路由和恢复范围验收后再审查' });
const audit = (file, source, allowed = []) => auditProjectModelSources([{ file, source }], {
  consumers: allowed.length ? [entry(file, allowed)] : [], closedGates: [],
});

describe('项目模型旧消费者与正式门禁只读审计', () => {
  it('真实仓库的现有旧依赖必须登记分类，审计通过仍不宣称P7或正式激活完成', () => {
    const report = auditProjectModelBoundaries();
    expect(report.violations).toEqual([]);
    expect(report.status).toBe('registered-boundaries-preserved');
    expect(report.scannedFiles).toBeGreaterThan(100);
    expect(report.formalActivationReady).toBe(false); expect(report.p7Complete).toBe(false);
    expect(report.consumers).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'src/store/store.projects.ts', category: 'legacy-authority', priority: 'P1' }),
      expect.objectContaining({ file: 'src/services/indexedDb/projectImportRepository.ts', category: 'recovery-retained' }),
      expect.objectContaining({ file: 'src/services/projectModelBackup.ts', category: 'backup-audit-retained' }),
    ]));
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
    const manifest = { consumers: [], closedGates: [gate] };
    const checked = (source) => auditProjectModelSources([{ file, source }], manifest);
    expect(checked(`const CAPABILITIES=Object.freeze({activation:false} as const);`).violations).toEqual([]);
    expect(checked(`// activation:false
      const CAPABILITIES=Object.freeze({activation:true});`).violations).toContainEqual({ code: 'formal-gate-changed', file,
        export: gate.export, field: gate.field });
  });

  it('无效或重复登记和语法错误保留为审查失败，不用兼容清单掩盖坏代码', () => {
    const file = 'src/services/known.ts';
    const report = auditProjectModelSources([{ file, source: `tx.objectStore('projects');` }], {
      consumers: [entry(file, ['table']), entry(file, ['table'])], closedGates: [],
    });
    expect(report.violations).toContainEqual({ code: 'duplicate-consumer-entry' });
    expect(scanProjectModelSource(file, `const broken = ;`).violations[0].code).toBe('source-syntax-error');
  });
});
