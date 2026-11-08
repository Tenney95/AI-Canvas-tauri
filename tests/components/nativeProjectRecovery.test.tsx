/** 按原操作恢复入口：不重新发起项目包写入。 */
import type { ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as Array<{ current: unknown }>, index: 0, refIndex: 0,
  importRecovery: vi.fn(), exportRecovery: vi.fn(), sharedRecovery: vi.fn(), sharedAbort: vi.fn(), refresh: vi.fn(),
  editorList: vi.fn(), editorReview: vi.fn(), editorResume: vi.fn(), inspectMedia: vi.fn(), resumeMedia: vi.fn(), mediaReview: vi.fn(), summary: vi.fn(), listMedia: vi.fn() }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: <T,>(initial: T) => {
    const index = driver.index++;
    if (!(index in driver.states)) driver.states[index] = initial;
    return [driver.states[index], (value: T) => { driver.states[index] = value; }];
  },
  useRef: <T,>(initial: T) => (driver.refs[driver.refIndex++] ??= { current: initial }),
  useEffect: () => undefined,
}));
vi.mock('../../src/i18n', () => ({ useT: () => (key: string, params?: Record<string, string>) =>
  Object.entries(params ?? {}).reduce((value, [name, item]) => value.replaceAll(`{${name}}`, item), key) }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ refreshProjectCatalog: driver.refresh }) } }));
vi.mock('../../src/services/nativeProjectImportService', () => ({ resumeNativeProjectImport: driver.importRecovery }));
vi.mock('../../src/services/nativeProjectArchiveService', () => ({ reconcileNativeProjectArchiveExport: driver.exportRecovery }));
vi.mock('../../src/services/indexedDb/nativeSharedAssetSyncRepository', () => ({
  recoverNativeSharedAssetSync: driver.sharedRecovery, abortNativeSharedAssetSync: driver.sharedAbort,
}));
vi.mock('../../src/services/nativeEditorTransitionService', () => ({ listNativeEditorTransitions: driver.editorList,
  reviewNativeEditorTransition: driver.editorReview, recoverNativeEditorTransition: driver.editorResume }));
vi.mock('../../src/services/nativeVolcengineRecovery', () => ({ inspectNativeVolcengineTask: driver.inspectMedia,
  resumeNativeVolcengineTask: driver.resumeMedia }));
vi.mock('../../src/services/projectExecutionContext', () => ({ captureLegacyCanvasContext: () => ({ modelGeneration: 1 }) }));
vi.mock('../../src/services/indexedDb/nativeMediaTaskRepository', () => ({ reviewNativeMediaTask: driver.mediaReview, listNativeMediaTasks: driver.listMedia }));
vi.mock('../../src/services/nativeMediaRecoverySummary', async (original) => ({ ...await original<typeof import('../../src/services/nativeMediaRecoverySummary')>(),
  readNativeMediaRecoverySummary: driver.summary }));

import NativeProjectRecovery from '../../src/components/settings/NativeProjectRecovery';
import { describeNativeMediaRecovery } from '../../src/services/nativeMediaRecoverySummary';

type Element = ReactElement<{ children?: unknown; [key: string]: unknown }>;
const elements = (value: unknown): Element[] => Array.isArray(value) ? value.flatMap(elements)
  : value && typeof value === 'object' && 'props' in value ? [value as Element, ...elements((value as Element).props.children)] : [];
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('')
  : typeof value === 'string' ? value : value && typeof value === 'object' && 'props' in value ? text((value as Element).props.children) : '';
function render() { driver.index = 0; driver.refIndex = 0; return NativeProjectRecovery(); }
function input(value: string) {
  const field = elements(render()).find((item) => item.type === 'input')!;
  (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function click(label: string) {
  const button = elements(render()).find((item) => item.type === 'button' && text(item.props.children) === label)!;
  expect(button.props.disabled).not.toBe(true);
  (button.props.onClick as () => void)();
}
beforeEach(() => {
  driver.states = []; driver.refs = []; driver.importRecovery.mockReset(); driver.exportRecovery.mockReset();
  driver.sharedRecovery.mockReset(); driver.sharedAbort.mockReset(); driver.refresh.mockReset();
  driver.refresh.mockResolvedValue(undefined);
  driver.editorList.mockReset().mockResolvedValue([]); driver.editorReview.mockReset().mockResolvedValue(undefined);
  driver.editorResume.mockReset(); driver.inspectMedia.mockReset(); driver.resumeMedia.mockReset();
  driver.mediaReview.mockReset().mockResolvedValue(undefined);
  driver.summary.mockReset().mockImplementation(describeNativeMediaRecovery); driver.listMedia.mockReset().mockResolvedValue([]);
});

it('按原 ID 恢复共享同步，或者显式撤销未提交的本机应用', async () => {
  driver.sharedRecovery.mockRejectedValue(new Error('尚无提交收据'));
  driver.sharedAbort.mockResolvedValue(undefined);
  input('shared-operation'); click('恢复共享素材');
  await vi.waitFor(() => expect(text(render())).toContain('尚无提交收据'));
  expect(driver.sharedRecovery).toHaveBeenCalledWith('shared-operation');
  click('撤销未提交的共享素材本机应用');
  await vi.waitFor(() => expect(text(render())).toContain('未提交的本机应用已撤销'));
  expect(driver.sharedAbort).toHaveBeenCalledWith('shared-operation');
});

it('恢复原导入后刷新列表，不调用导出恢复', async () => {
  driver.importRecovery.mockResolvedValue({ projectName: '作品' });
  input('original-operation'); click('继续导入');
  await vi.waitFor(() => expect(driver.refresh).toHaveBeenCalledOnce());
  expect(driver.importRecovery).toHaveBeenCalledWith('original-operation');
  expect(driver.exportRecovery).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(text(render())).toContain('导入已完成，可从项目库打开「作品」'));
});

it('导入完成但列表刷新失败时明确保留已完成状态', async () => {
  driver.importRecovery.mockResolvedValue({ projectName: '作品' });
  driver.refresh.mockRejectedValue(new Error('temporary'));
  input('operation'); click('继续导入');
  await vi.waitFor(() => expect(text(render())).toContain('导入已完成，但项目列表刷新失败'));
});

it('导出核验失败保留原 ID 和错误，不触发导入或覆盖', async () => {
  driver.exportRecovery.mockRejectedValue(new Error('原回执无法核实'));
  input('export-operation'); click('核验原导出');
  await vi.waitFor(() => expect(text(render())).toContain('原回执无法核实'));
  expect(driver.importRecovery).not.toHaveBeenCalled();
  expect(driver.refresh).not.toHaveBeenCalled();
  expect(elements(render()).find((item) => item.type === 'input')?.props.value).toBe('export-operation');
});

it('拒绝非法操作 ID', () => {
  input('../outside'); click('继续导入');
  expect(text(render())).toContain('请输入有效的原操作 ID');
  expect(driver.importRecovery).not.toHaveBeenCalled();
});

it('原剪辑节点被删除后仍可核对并结束跟踪，不恢复投递或重新生成', async () => {
  driver.editorList.mockResolvedValue([{ operationId: 'editor-operation', anchorNodeId: 'deleted-node', status: 'outcome-unknown' }]);
  input('editor-operation'); click('核对原媒体任务状态');
  await vi.waitFor(() => expect(text(render())).toContain('原视频节点已删除时'));
  click('我已核对，结束剪辑任务跟踪');
  await vi.waitFor(() => expect(driver.editorReview).toHaveBeenCalledWith('editor-operation'));
  expect(driver.editorResume).not.toHaveBeenCalled();
  expect(driver.resumeMedia).not.toHaveBeenCalled();
});

it('已保存的同步产物明确显示本机交付，不要求查询远端任务', async () => {
  driver.inspectMedia.mockResolvedValue({ status: 'submitted', submissionKind: 'sync', localResult: { relativePath: 'media/a.png' } });
  input('sync-operation'); click('核对原媒体任务状态');
  await vi.waitFor(() => expect(text(render())).toContain('原产物已保存在本机'));
  expect(driver.resumeMedia).not.toHaveBeenCalled();
});

it('已提交媒体原节点不可用时仍能显式结束跟踪，保留回执且不重新生成', async () => {
  driver.inspectMedia.mockResolvedValue({ status: 'submitted', remoteTaskId: 'original-remote-id' });
  input('submitted-operation'); click('核对原媒体任务状态');
  await vi.waitFor(() => expect(text(render())).toContain('我已核对，结束媒体任务跟踪'));
  click('我已核对，结束媒体任务跟踪');
  await vi.waitFor(() => expect(driver.mediaReview).toHaveBeenCalledWith('submitted-operation', { modelGeneration: 1 }));
  expect(driver.resumeMedia).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(text(render())).toContain('远端不会因此取消'));
});

it('普通恢复发现未发送的音乐阶段先显示费用按钮，用户再次点击后才授予原阶段提交', async () => {
  const original = { status: 'prepared', ownerProjectId: 'original-owner' };
  const summary = { ...describeNativeMediaRecovery(original as Parameters<typeof describeNativeMediaRecovery>[0]),
    canContinueGenerationStage: true, maySubmitUnstartedStage: true, currentStage: 'music', unknownSubmissions: 0, resultCount: 0 };
  driver.inspectMedia.mockResolvedValue(original); driver.summary.mockResolvedValue(summary);
  driver.resumeMedia.mockResolvedValue(undefined); driver.listMedia.mockResolvedValue([{ ...original, operationId: 'music-operation', status: 'delivered' }]);
  input('music-operation'); click('继续取回原媒体产物');
  await vi.waitFor(() => expect(text(render())).toContain('继续原生成阶段（可能产生费用）'));
  expect(driver.resumeMedia).not.toHaveBeenCalled();
  click('继续原生成阶段（可能产生费用）');
  await vi.waitFor(() => expect(driver.resumeMedia).toHaveBeenCalledWith('music-operation', undefined, { allowUnstartedStage: true }));
});

it('完整缓存与部分失败数量一并展示，不把多个本机产物误称整批成功', async () => {
  const original = { status: 'submitted' };
  driver.inspectMedia.mockResolvedValue(original);
  driver.summary.mockResolvedValue({ ...describeNativeMediaRecovery(original as Parameters<typeof describeNativeMediaRecovery>[0]),
    resultCount: 3, expectedCount: 2, taskCount: 2, failedTasks: 1, failedSubmissions: 1, unknownSubmissions: 0, notStartedSubmissions: 0,
    lateTaskCount: 2, cachedOnly: true, partial: true });
  input('cached-operation'); click('核对原媒体任务状态');
  await vi.waitFor(() => expect(text(render())).toContain('已保存 3 个产物'));
  expect(text(render())).toContain('失败任务 1 个'); expect(text(render())).toContain('失败提交 1 次');
  expect(text(render())).toContain('迟到任务 2 个'); expect(text(render())).toContain('不会再次调用服务商');
  expect(driver.resumeMedia).not.toHaveBeenCalled();
});

it('剪辑delivered仍显示部分失败和原任务总数，不把多个已保存视频误称全成功', async () => {
  driver.editorList.mockResolvedValue([{ operationId: 'partial-editor', anchorNodeId: 'original-video', status: 'delivered',
    localResults: [{ relativePath: 'private-a' }, { relativePath: 'private-b' }], completion: { taskCount: 2, failedTasks: 1 } }]);
  input('partial-editor'); click('核对原媒体任务状态');
  await vi.waitFor(() => expect(text(render())).toContain('已保存 2 个产物，原计划 2 个'));
  expect(text(render())).toContain('失败任务 1 个'); expect(text(render())).not.toContain('private-a');
  expect(elements(render()).some((item) => item.props.role === 'status' && String(item.props.className).includes('ui-alert--warning'))).toBe(true);
  expect(driver.editorResume).not.toHaveBeenCalled();
});
