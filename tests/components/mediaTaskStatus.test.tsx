/**
 * mediaTaskStatus — 回归测试：跨媒体原任务续取入口。
 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const mocks = vi.hoisted(() => ({
  state: { currentProjectId: 'project' as string | null,
    nodes: [{ id: 'media', data: { type: 'ai-image', label: '图片', mediaTaskState: 'paused', status: 'idle' } as BaseNodeData }],
    showToast: vi.fn() },
  tasks: [] as Array<Record<string, unknown>>, resume: vi.fn(), discard: vi.fn(),
  nativeOperationId: undefined as string | undefined, resumeNative: vi.fn(), reviewNative: vi.fn(),
  busy: false, confirmed: undefined as string | undefined, cursor: 0,
  desktop: true, images: vi.fn(), reveal: vi.fn(), extraState: [] as unknown[],
  effectDeps: undefined as unknown[] | undefined, dispose: undefined as (() => void) | undefined,
}));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  memo: <T,>(component: T) => component,
  useState: () => {
    const index = mocks.cursor++;
    if (index === 0) return [mocks.busy, (value: boolean) => { mocks.busy = value; }];
    if (index === 1) return [mocks.confirmed, (value: string | undefined) => { mocks.confirmed = value; }];
    return [mocks.extraState[index], (value: unknown) => { mocks.extraState[index] = value; }];
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    if (mocks.effectDeps && deps.every((value, i) => value === mocks.effectDeps![i])) return;
    mocks.dispose?.();
    mocks.effectDeps = deps;
    mocks.dispose = effect();
  },
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state) }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => mocks.desktop }));
vi.mock('../../src/components/shared/Select', () => ({ default: 'select-control' }));
vi.mock('../../src/services/pollManager', () => ({
  getPendingTasksForProject: () => mocks.tasks, resumeMediaNodeTask: mocks.resume, discardMediaTask: mocks.discard,
  getNativeMediaNodeRecovery: () => mocks.nativeOperationId, resumeNativeMediaFromNode: mocks.resumeNative,
  reviewNativeMediaFromNode: mocks.reviewNative,
  listNativeMediaNodeImages: mocks.images, revealNativeMediaNodeImage: mocks.reveal,
  hasMuseQueryIdentity: (task: { taskType?: string; taskId: string }) => task.taskType === 'muse'
    && task.taskId === 'ac655c56-b537-4c04-8913-fd150fc0e92a',
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce((value, [key, replacement]) => value.replaceAll(`{${key}}`, String(replacement)), text) }));
import MediaTaskStatus from '../../src/components/nodes/shared/MediaTaskStatus';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function render(overlay = false, children?: ReactElement) { mocks.cursor = 0; return MediaTaskStatus({ nodeId: 'media', overlay, children }); }
const queryButton = () => elements(render()).find((element) => element.props['aria-label'] === '继续查询 / 保存');

beforeEach(() => {
  mocks.busy = false; mocks.confirmed = undefined; mocks.state.currentProjectId = 'project';
  mocks.state.nodes[0].data = { type: 'ai-image', label: '图片', mediaTaskState: 'paused', status: 'idle' };
  mocks.tasks = [{ projectId: 'project', nodeId: 'media', nodeType: 'ai-image', taskId: 'original', attemptId: 'first', submitted: true, mediaRecoveryState: 'query_paused' }];
  mocks.resume.mockReset().mockResolvedValue(undefined); mocks.discard.mockReset(); mocks.state.showToast.mockReset();
  mocks.nativeOperationId = undefined; mocks.resumeNative.mockReset().mockResolvedValue(undefined);
  mocks.reviewNative.mockReset().mockResolvedValue(undefined);
  mocks.desktop = true; mocks.images.mockReset().mockResolvedValue([]); mocks.reveal.mockReset().mockResolvedValue(undefined);
  mocks.extraState = []; mocks.effectDeps = undefined; mocks.dispose = undefined;
});
afterEach(() => mocks.dispose?.());

describe('跨媒体原任务续取入口', () => {
  const originalButton = () => elements(render()).find((element) => element.type === 'button' && element.props.children === '查看已保存原图');

  it('只显示核验后的原图，批量时按回执编号选择，查看不会续查或重新生成', async () => {
    mocks.nativeOperationId = 'original-operation';
    mocks.state.nodes[0].data.mediaTaskState = 'delivery_pending';
    const first = { ordinal: 0, sha256: 'a'.repeat(64) };
    const third = { ordinal: 2, sha256: 'b'.repeat(64) };
    mocks.images.mockResolvedValue([first, third]);
    expect(originalButton()).toBeUndefined();
    await vi.waitFor(() => expect(originalButton()).toBeDefined());
    const select = elements(render()).find((element) => element.props['aria-label'] === '选择已保存的原图')!;
    expect(select.props.options).toEqual([{ value: '0', label: '原图 1' }, { value: '2', label: '原图 3' }]);
    (select.props.onChange as (value: string) => void)('2');
    expect(JSON.stringify(render(true))).toContain('原图已保存到本机');
    (originalButton()!.props.onClick as () => void)();
    expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith('media', 'original-operation', third, expect.any(AbortSignal));
    expect(mocks.resumeNative).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('待下载、提交未知、网页和旧任务都不显示查看原图', async () => {
    mocks.nativeOperationId = 'original-operation';
    mocks.state.nodes[0].data.mediaTaskState = 'delivery_pending';
    expect(originalButton()).toBeUndefined();
    await Promise.resolve();
    expect(originalButton()).toBeUndefined();
    expect(JSON.stringify(render())).toContain('图片尚未回填');
    expect(mocks.images).toHaveBeenCalledTimes(1);
    mocks.state.nodes[0].data.mediaTaskState = 'submit_unknown';
    expect(originalButton()).toBeUndefined();
    mocks.desktop = false;
    mocks.state.nodes[0].data.mediaTaskState = 'delivery_pending';
    expect(originalButton()).toBeUndefined();
    mocks.desktop = true;
    mocks.nativeOperationId = undefined;
    expect(originalButton()).toBeUndefined();
    expect(mocks.images).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['NativeMediaInputChanged', '生成时的输入与当前节点不符，可查看已保存原图。'],
    ['Error', '原图已保存到本机，尚未回填到节点。'],
  ])('已保存原图的回填失败仅根据已核对的原因提示：%s', async (name, message) => {
    mocks.nativeOperationId = 'original-operation';
    mocks.state.nodes[0].data.mediaTaskState = 'delivery_pending';
    mocks.images.mockResolvedValue([{ ordinal: 0, sha256: 'a'.repeat(64) }]);
    mocks.resumeNative.mockRejectedValue(Object.assign(new Error('private error'), { name }));
    await vi.waitFor(() => expect(originalButton()).toBeDefined());
    const resume = elements(render()).find((element) => element.props['aria-label'] === '继续回填')!;
    (resume.props.onClick as () => void)();
    await vi.waitFor(() => expect(mocks.state.showToast).toHaveBeenCalledExactlyOnceWith(message, 'error'));
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it('切换任务后丢弃旧列表，卸载后取消定位并忽略迟到的错误', async () => {
    const image = { ordinal: 0, sha256: 'c'.repeat(64) };
    let finishFirst!: (images: typeof image[]) => void;
    let failReveal!: () => void;
    mocks.images.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce([]).mockResolvedValueOnce([image]);
    mocks.nativeOperationId = 'old';
    mocks.state.nodes[0].data.mediaTaskState = 'delivery_pending';
    render();
    mocks.nativeOperationId = 'new';
    render();
    finishFirst([image]);
    await Promise.resolve();
    expect(originalButton()).toBeUndefined();
    mocks.nativeOperationId = 'latest';
    await vi.waitFor(() => expect(originalButton()).toBeDefined());
    expect(elements(render()).some((element) => element.props['aria-label'] === '选择已保存的原图')).toBe(false);
    mocks.reveal.mockImplementationOnce(() => new Promise((_, reject) => { failReveal = () => reject(new Error('stale')); }));
    (originalButton()!.props.onClick as () => void)();
    expect(originalButton()?.props.disabled).toBe(true);
    mocks.dispose?.();
    expect((mocks.reveal.mock.calls[0][3] as AbortSignal).aborted).toBe(true);
    failReveal();
    await Promise.resolve();
    expect(mocks.state.showToast).not.toHaveBeenCalled();
  });

  it('新项目 ComfyUI 视频保存失败后只续取绑定的原操作', async () => {
    mocks.tasks = [];
    mocks.nativeOperationId = 'original-operation';
    mocks.state.nodes[0].data = { type: 'ai-video', label: '视频', status: 'idle', mediaTaskState: 'delivery_pending' };
    const button = elements(render(true)).find((element) => element.props['aria-label'] === '继续保存');
    expect(button).toBeDefined();
    (button!.props.onClick as () => void)();
    expect(mocks.resumeNative).toHaveBeenCalledExactlyOnceWith('media', 'original-operation');
    expect(mocks.resume).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.busy).toBe(false));
  });

  it('Muse 已留存本机任务身份时，发送回包丢失仍可仅读续查', async () => {
    mocks.tasks[0] = { ...mocks.tasks[0], taskType: 'muse', taskId: 'ac655c56-b537-4c04-8913-fd150fc0e92a',
      submitted: false, mediaSubmissionUncertain: true, mediaRecoveryState: 'submit_unknown' };
    mocks.state.nodes[0].data.mediaTaskState = 'paused';
    expect(queryButton()).toBeDefined();
    (queryButton()!.props.onClick as () => void)();
    expect(mocks.resume).toHaveBeenCalledWith('media');
    expect(mocks.discard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.busy).toBe(false));
  });

  it('新项目取消时未取得平台任务 ID，显示待核对状态', () => {
    mocks.tasks = [];
    mocks.nativeOperationId = 'original-operation';
    mocks.state.nodes[0].data.mediaTaskState = 'submit_unknown';
    expect(queryButton()).toBeUndefined();
    expect(JSON.stringify(render())).toContain('提交状态未知');
    expect(mocks.resumeNative).not.toHaveBeenCalled();
    expect(mocks.state.showToast).not.toHaveBeenCalled();
  });

  it('核对确认绑定原生回执，回执换了以后重新确认', async () => {
    mocks.tasks = [];
    mocks.nativeOperationId = 'old-operation';
    mocks.state.nodes[0].data.mediaTaskState = 'submit_unknown';
    const button = () => elements(render()).find((element) => element.type === 'button' && element.props.children === '结束跟踪')!;
    const check = () => {
      const checkbox = elements(render()).find((element) => element.type === 'input')!;
      (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    };
    expect(button().props.disabled).toBe(true);
    (button().props.onClick as () => void)();
    check();
    expect(button().props.disabled).toBe(false);
    mocks.nativeOperationId = 'current-operation';
    expect(button().props.disabled).toBe(true);
    (button().props.onClick as () => void)();
    expect(mocks.reviewNative).not.toHaveBeenCalled();
    check();
    (button().props.onClick as () => void)();
    expect(mocks.reviewNative).toHaveBeenCalledExactlyOnceWith('media', 'current-operation');
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.resumeNative).not.toHaveBeenCalled();
    expect(mocks.discard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.busy).toBe(false));
  });

  it('ComfyUI 提交未知到迟到 ID 转换只恢复原任务查询，不显示重新生成', () => {
    mocks.tasks[0] = { ...mocks.tasks[0], taskType: 'comfyui', taskId: '', submitted: false,
      mediaSubmissionUncertain: true, mediaRecoveryState: 'submit_unknown' };
    mocks.state.nodes[0].data.mediaTaskState = 'submit_unknown';
    expect(queryButton()).toBeUndefined();
    expect(JSON.stringify(render())).toContain('不会自动重新生成');
    mocks.tasks[0] = { ...mocks.tasks[0], taskId: 'accepted-id', submitted: true,
      mediaSubmissionUncertain: false, mediaRecoveryState: 'query_paused' };
    mocks.state.nodes[0].data.mediaTaskState = 'paused';
    expect(queryButton()).toBeDefined();
    expect(JSON.stringify(render())).not.toContain('提交状态未知');
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it('未知提交同时展示安全的 HTTP 原因，不提供重新生成或伪查询', () => {
    mocks.tasks[0] = { ...mocks.tasks[0], taskId: '', submitted: false,
      mediaRecoveryState: 'submit_unknown', mediaFailureDiagnostic: { kind: 'http', httpStatus: 504, raw: 'secret' } };
    mocks.state.nodes[0].data.mediaTaskState = 'submit_unknown';
    const tree = render(true);
    const text = elements(tree).filter((element) => element.type === 'span').map((element) => element.props.children);
    expect(text).toContain('提交状态未知，请到对应平台核对；应用不会自动重新生成。');
    expect(text).toContain('等待服务商响应超时（HTTP 504）');
    expect(JSON.stringify(tree)).not.toContain('secret');
    expect(queryButton()).toBeUndefined();
  });

  it('不展示非法状态码或任务诊断中的原始内容', () => {
    mocks.tasks[0].mediaFailureDiagnostic = { kind: 'http', httpStatus: 'secret', message: 'private content' };
    const text = JSON.stringify(render());
    expect(text).not.toContain('secret');
    expect(text).not.toContain('private content');
  });

  it('已知失败移除恢复任务后不再显示未知状态遮罩', () => {
    mocks.state.nodes[0].data = { ...mocks.state.nodes[0].data, status: 'error', error: '生成失败' };
    mocks.tasks = [];
    expect(render(true)).toBeNull();
  });

  it.each(['ai-image', 'ai-video', 'ai-audio'] as const)('%s 复用 UI Kit 按钮且只调用续取', async (kind) => {
    mocks.tasks[0].nodeType = kind;
    const button = queryButton()!;
    expect(button.props.className).toContain(`ui-btn--node-${kind.slice(3)}`);
    (button.props.onClick as () => void)();
    expect(mocks.resume).toHaveBeenCalledWith('media');
    expect(queryButton()?.props.disabled).toBe(true);
    await vi.waitFor(() => expect(mocks.busy).toBe(false));
  });

  it('提交未知不提供伪查询，解除记录必须确认当前attempt', () => {
    mocks.tasks[0].taskId = ''; mocks.tasks[0].submitted = false;
    mocks.state.nodes[0].data.mediaTaskState = 'submit_unknown';
    expect(queryButton()).toBeUndefined();
    const checkbox = elements(render()).find((element) => element.type === 'input')!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    let clear = elements(render()).find((element) => element.type === 'button')!;
    expect(clear.props.disabled).toBe(false);
    mocks.tasks[0].attemptId = 'new-attempt';
    clear = elements(render()).find((element) => element.type === 'button')!;
    expect(clear.props.disabled).toBe(true);
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it('生成成功但保存未完成显示交付阶段，并保留查询入口', () => {
    mocks.state.nodes[0].data.mediaTaskState = 'delivery_pending';
    mocks.tasks[0].mediaRecoveryState = 'delivery_pending';
    expect(elements(render()).find((element) => element.type === 'span')?.props.children)
      .toBe('媒体已生成，保存或回填尚未完成；可继续取回原结果。');
    expect(queryButton()).toBeDefined();
  });

  it('同一张恢复卡保留宿主取消入口，重新查询期间不遗留可点击操作', () => {
    mocks.state.nodes[0].data.mediaTaskState = 'delivery_pending';
    mocks.tasks[0].mediaRecoveryState = 'delivery_pending';
    mocks.tasks[0].mediaFailureDiagnostic = { kind: 'persistence', failureKind: 'permission' };
    const cancel = vi.fn();
    const action = <button type="button" onClick={cancel}>再次终止</button>;
    const tree = render(false, action);
    const button = elements(tree).find((element) => element.type === 'button' && element.props.children === '再次终止')!;
    (button.props.onClick as () => void)();
    expect(cancel).toHaveBeenCalledOnce();
    expect(elements(tree).filter((element) => element.props['aria-label'] === '继续查询 / 保存')).toHaveLength(1);
    expect(JSON.stringify(tree)).toContain('保存目录无法写入');
    mocks.state.nodes[0].data.status = 'loading';
    expect(render(false, action)).toBeNull();
  });

  it.each([
    ['timeout', '下载等待超时'], ['network', '下载连接中断'], ['permission', '保存目录无法写入'],
    ['disk_space', '目标磁盘空间不足'], ['connection_changed', '原连接或接口地址已变化'],
    ['missing_key', '原连接尚未填写 Key'],
  ])('显示 %s 保存诊断并保留原任务续取按钮', (failureKind, expected) => {
    mocks.tasks[0].mediaRecoveryState = 'delivery_pending';
    mocks.tasks[0].mediaFailureDiagnostic = { kind: 'persistence', failureKind };
    mocks.state.nodes[0].data.mediaTaskState = 'delivery_pending';
    const spans = elements(render()).filter((element) => element.type === 'span');
    expect(spans.some((element) => String(element.props.children).includes(expected))).toBe(true);
    expect(queryButton()).toBeDefined();
  });

  it.each([401, 403, 404, 410, 500])('下载 HTTP %i 与任务查询错误区分展示', (httpStatus) => {
    mocks.tasks[0].mediaFailureDiagnostic = { kind: 'persistence', failureKind: 'http', httpStatus };
    const spans = elements(render()).filter((element) => element.type === 'span');
    expect(spans.some((element) => String(element.props.children).includes(`HTTP ${httpStatus}`))).toBe(true);
    expect(spans.some((element) => String(element.props.children).includes('下载'))).toBe(true);
    expect(queryButton()).toBeDefined();
  });

  it('画布变化保留原任务并显示未回填的原因', () => {
    mocks.tasks[0].mediaRecoveryReason = 'canvas_changed';
    expect(elements(render()).some((element) => element.type === 'span'
      && String(element.props.children).includes('画布已变化，结果未回填'))).toBe(true);
    expect(queryButton()).toBeDefined();
  });

  it.each([401, 403])('ComfyUI HTTP %i 显示固定鉴权原因并仍只续查原任务', async (status) => {
    mocks.tasks[0].taskType = 'comfyui';
    mocks.tasks[0].comfyQueryHttpStatus = status;
    mocks.tasks[0].videoRecoveryMessage = '本轮视频查询中断或等待超时';
    const message = elements(render()).find((element) => element.type === 'span')?.props.children;
    expect(message).toContain(`HTTP ${status}`);
    expect(message).toContain(status === 401 ? '鉴权配置' : '访问权限');
    (queryButton()!.props.onClick as () => void)();
    expect(mocks.resume).toHaveBeenCalledWith('media');
    await vi.waitFor(() => expect(mocks.busy).toBe(false));
  });

  it('恢复记录中的未知鉴权状态不成为展示文案', () => {
    mocks.tasks[0].comfyQueryHttpStatus = '/private?token=secret';
    const message = elements(render()).find((element) => element.type === 'span')?.props.children;
    expect(message).toBe('查询已暂停，任务已保留');
  });

  it('ComfyUI 执行完成但没有文件输出时显示适配边界，仍只续查原任务', () => {
    mocks.tasks[0].taskType = 'comfyui';
    mocks.tasks[0].comfyRecoveryState = 'output_unavailable';
    const message = elements(render()).find((element) => element.type === 'span')?.props.children;
    expect(message).toContain('没有可下载的目标媒体');
    expect(message).toContain('SaveImage');
    expect(message).toContain('仅 WebSocket');
    expect(queryButton()).toBeDefined();
  });

  it('ComfyUI 文本缺失显示 SaveText 边界，不提示图片输出节点', () => {
    mocks.tasks[0].taskType = 'comfyui';
    mocks.tasks[0].nodeType = 'ai-text';
    mocks.tasks[0].comfyRecoveryState = 'output_unavailable';
    const message = elements(render()).find((element) => element.type === 'span')?.props.children;
    expect(message).toContain('SaveText');
    expect(message).not.toContain('SaveImage');
    expect(queryButton()?.props.className).toContain('ui-btn--node-text');
  });

  it('文本保存未完成时仅续取原任务', async () => {
    mocks.tasks[0].taskType = 'comfyui';
    mocks.tasks[0].nodeType = 'ai-text';
    mocks.tasks[0].mediaRecoveryState = 'delivery_pending';
    const message = elements(render()).find((element) => element.type === 'span')?.props.children;
    expect(message).toContain('文本已生成');
    (queryButton()!.props.onClick as () => void)();
    expect(mocks.resume).toHaveBeenCalledWith('media');
    await vi.waitFor(() => expect(mocks.busy).toBe(false));
  });

  it('批量已取得部分ID但后续提交未知时仍禁止伪续取', () => {
    mocks.tasks[0].mediaSubmissionUncertain = true;
    mocks.tasks[0].mediaRecoveryState = 'submit_unknown';
    mocks.state.nodes[0].data.mediaTaskState = 'submit_unknown';
    expect(queryButton()).toBeUndefined();
    expect(elements(render()).some((element) => element.type === 'input')).toBe(true);
  });

  it('查询正在进行或项目未打开时不重复显示恢复按钮', () => {
    mocks.state.nodes[0].data.status = 'loading'; expect(render()).toBeNull();
    mocks.state.nodes[0].data.status = 'idle'; mocks.state.currentProjectId = null; expect(render()).toBeNull();
  });
});
