import { expect, it, vi } from 'vitest';
import {
  type ElementLike,
  type TestNode,
  type TestStore,
  findElement,
  componentName,
  installReactHookDriver,
  createStore,
  installStoreMock,
  installCommonNodeMocks,
  installShotlistTimelineMock,
} from './nodeFixture';

async function setupShotlistWidths(
  widths?: Record<string, number>, rows: Record<string, unknown>[] = [],
  dataOverrides: Record<string, unknown> = {},
  options: { nodes?: TestNode[]; picker?: Record<string, unknown> } = {},
) {
  const setters: Array<ReturnType<typeof vi.fn>> = [];
  await installReactHookDriver((initial, index) => index === 1 ? true : index === 4 ? options.picker ?? initial : initial,
  undefined, undefined, setters);
  const shotlist: TestNode = {
    id: 'shotlist', type: 'ai-shotlist', position: { x: 0, y: 0 },
    data: { type: 'ai-shotlist', label: '第一场', shotlistColumnWidths: widths, shotlistRows: rows, ...dataOverrides },
  };
  const store = createStore([shotlist, ...(options.nodes ?? [])], () => 1);
  installStoreMock(store);
  installCommonNodeMocks();
  vi.doMock('@xyflow/react', () => ({
    Handle: function HandleMock() { return null; },
    Position: { Left: 'left', Right: 'right' },
    useReactFlow: () => ({ setCenter: vi.fn(), getNode: vi.fn() }),
  }));
  vi.doMock('react-dom', () => ({ createPortal: (children: unknown) => children }));
  const timeline = await installShotlistTimelineMock();
  const ShotlistNode = (await import('../../../src/components/nodes/ShotlistNode')).default as unknown as (
    props: { id: string; data: Record<string, unknown>; selected: boolean },
  ) => unknown;
  const tree = ShotlistNode({ id: shotlist.id, data: shotlist.data, selected: true });
  const table = findElement(tree, (element) => element.type === 'table');
  const header = {
    dataset: { shotColumn: 'content' }, offsetWidth: widths?.content ?? 200,
    getBoundingClientRect: () => ({ width: (widths?.content ?? 200) / 2 }),
  };
  const ownerDocument = Object.assign(new EventTarget(), { elementFromPoint: vi.fn() });
  const tableElement = { offsetWidth: 1456, ownerDocument };
  (table.props.ref as { current: unknown }).current = tableElement;
  const handle = findElement(tree, (element) => element.type === 'button' && element.props['aria-label'] === '内容列宽');
  const pointer = (clientX: number) => ({
    button: 0, buttons: 1, isPrimary: true, pointerId: 7, pointerType: 'mouse', clientX, clientY: 120,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    currentTarget: {
      closest: () => header, setPointerCapture: vi.fn(),
      hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    },
  });
  const dragRow = (sourceId: string) => {
    const row = findElement(tree, (element) => element.props['data-shot-row-id'] === sourceId);
    const grip = findElement(row, (element) => typeof element.props.onLostPointerCapture === 'function');
    const dragWindow = new EventTarget();
    vi.stubGlobal('window', dragWindow);
    const start = pointer(100);
    const send = (handler: string, event = { ...pointer(150), currentTarget: start.currentTarget }) =>
      (grip.props[handler] as (event: ReturnType<typeof pointer>) => void)(event);
    send('onPointerDown', start);
    return {
      dragWindow, ownerDocument, send, start,
      hit: (id: string, sameTable = true) => tableElement.ownerDocument.elementFromPoint.mockReturnValue({
        closest: () => ({ dataset: { shotRowId: id }, closest: () => sameTable ? tableElement : {} }),
      }),
    };
  };
  return { tree, table, store, handle, pointer, setters, timeline, dragRow };
}

function visibleShotRatio(store: TestStore, column: string) {
  const ratios = store.nodes[0].data.shotlistColumnRatios as Record<string, number>;
  const total = ['shotSize', 'camera', 'cinematography', 'content', 'dialogue']
    .reduce((sum, key) => sum + ratios[key], 0);
  return ratios[column] / total * 100;
}

export function registerShotlistEditingTests() {
  it('shows shot numbers as read-only row positions even when saved numbers differ', async () => {
    const { tree, store } = await setupShotlistWidths(undefined, [
      { id: 'row-1', shotNo: '3a' }, { id: 'row-2', shotNo: '9' },
    ]);
    const body = findElement(tree, (element) => element.type === 'tbody');
    const numbers = (body.props.children as ElementLike[]).map((row) =>
      findElement(row, (element) => element.props['aria-label'] === '镜号'));
    expect(numbers.map((number) => number.type)).toEqual(['span', 'span']);
    expect(numbers.map((number) => number.props.children)).toEqual([1, 2]);
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
  });

  it('keeps the generated video column visible and opens a separate ready-video picker', async () => {
    vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 900 });
    const frame = { nodeId: 'reference', kind: 'image', url: 'asset://reference.png' };
    const { tree, table, setters } = await setupShotlistWidths(undefined, [
      { id: 'row-1', shotNo: '1', frame },
    ], { shotlistColumns: ['camera', 'dialogue'] }, { nodes: [
      { id: 'other-video', type: 'source-video', position: { x: 0, y: 0 }, data: { label: '导入视频', videoUrl: 'asset://other.mp4' } },
      { id: 'shot-video', type: 'ai-video', position: { x: 0, y: 0 }, data: { label: '本镜成片', videoUrl: 'asset://shot.mp4',
        shotlistProductionSource: { kind: 'video', nodeId: 'shotlist', rowId: 'row-1' } } },
      { id: 'pending-video', type: 'ai-video', position: { x: 0, y: 0 }, data: { status: 'loading' } },
      { id: 'reference', type: 'source-image', position: { x: 0, y: 0 }, data: { imageUrl: frame.url } },
    ] });
    const videoHeader = findElement(table, (element) => element.type === 'th' && element.props['data-shot-column'] === 'video');
    expect((videoHeader.props.children as unknown[])[0]).toBe('生成视频');
    const videoCell = findElement(tree, (element) => element.props['data-shot-video-row'] === 'row-1');
    const anchor = { getBoundingClientRect: () => ({ left: 200, bottom: 300 }) };
    (videoCell.props.onClick as (event: unknown) => void)({ currentTarget: anchor });
    expect(setters[4]).toHaveBeenLastCalledWith(expect.objectContaining({ rowId: 'row-1', target: 'video',
      candidates: [expect.objectContaining({ nodeId: 'shot-video' }), expect.objectContaining({ nodeId: 'other-video' })],
    }));
    const framePicker = findElement(tree, (element) => element.props['aria-label'] === '换一个画面');
    (framePicker.props.onClick as (event: unknown) => void)({ currentTarget: anchor });
    expect(setters[4]).toHaveBeenLastCalledWith(expect.objectContaining({ rowId: 'row-1', target: 'frame' }));
  });

  it('binds a picked generated video through its own Store action', async () => {
    vi.stubGlobal('document', { body: {} });
    const frame = { nodeId: 'reference', kind: 'image', url: 'asset://reference.png' };
    const { tree, store } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1', frame }], {}, {
      picker: { rowId: 'row-1', target: 'video', projectId: 'project-a', left: 0, top: 0,
        candidates: [{ nodeId: 'shot-video', kind: 'video', label: '本镜成片' }] },
    });
    const candidate = findElement(tree, (element) => element.type === 'button' && element.props.title === '本镜成片');
    (candidate.props.onClick as () => void)();
    expect(store.bindShotlistVideo).toHaveBeenCalledWith('shotlist', 'row-1', 'shot-video');
    expect(store.bindShotlistFrame).not.toHaveBeenCalled();
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0].frame).toBe(frame);
  });

  it('clears only the generated video binding and preserves the reference frame', async () => {
    const frame = { nodeId: 'reference', kind: 'image', url: 'asset://reference.png' };
    const video = { nodeId: 'shot-video', kind: 'video', url: 'asset://shot.mp4' };
    const { tree, store } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1', frame, video }]);
    const clear = findElement(tree, (element) => element.props['aria-label'] === '解除视频绑定');
    (clear.props.onClick as () => void)();
    expect(store.nodes[0].data.shotlistRows).toEqual([{ id: 'row-1', shotNo: '1', frame, video: null }]);
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    expect(store.bindShotlistFrame).not.toHaveBeenCalled();
  });

  it('pushes only ready generated videos and reports the skipped shot numbers', async () => {
    const { tree, store, timeline } = await setupShotlistWidths(undefined, [
      { id: 'row-1', shotNo: '1', frame: { nodeId: 'reference-video', kind: 'video', url: 'asset://reference.mp4' } },
      { id: 'row-2', shotNo: '2', frame: { nodeId: 'reference', kind: 'image', url: 'asset://reference.png' },
        video: { nodeId: 'shot-video', kind: 'video', url: 'asset://old.mp4' } },
      { id: 'row-3', shotNo: '3', video: { nodeId: 'pending-video', kind: 'video', url: 'asset://stale.mp4' } },
    ], undefined, { nodes: [
      { id: 'shot-video', type: 'ai-video', position: { x: 0, y: 0 }, data: { videoUrl: 'asset://ready.mp4' } },
      { id: 'pending-video', type: 'ai-video', position: { x: 0, y: 0 }, data: {} },
    ] });
    const push = findElement(tree, (element) => element.type === 'button' && element.props.className === 'shotlist-btn shotlist-btn--primary');
    await (push.props.onClick as () => Promise<void>)();
    expect(timeline.openVideoEditorForShotlist).toHaveBeenCalledOnce();
    expect(timeline.openVideoEditorForShotlist).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', nodeId: 'shotlist', rows: [expect.objectContaining({ id: 'row-2',
        video: expect.objectContaining({ nodeId: 'shot-video', url: 'asset://ready.mp4' }),
      })],
    }));
    expect(store.showToast).toHaveBeenCalledWith('已推送 1 段视频；跳过未就绪镜头：1、3', 'info');
  });

  it('does not open or replace a timeline when the table has no ready generated videos', async () => {
    const { tree, store, timeline } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1',
      frame: { nodeId: 'reference-video', kind: 'video', url: 'asset://reference.mp4' }, video: null,
    }]);
    const push = findElement(tree, (element) => element.type === 'button' && element.props.className === 'shotlist-btn shotlist-btn--primary');
    await (push.props.onClick as () => Promise<void>)();
    expect(timeline.hasShotlistTimeline).not.toHaveBeenCalled();
    expect(timeline.openVideoEditorForShotlist).not.toHaveBeenCalled();
    expect(store.showToast).toHaveBeenCalledWith('请先在“生成视频”列回填已就绪的视频，再推送时间轴', 'error');
  });

  it.each(['add', 'delete', 'reorder'])(
    'renumbers shots after %s while keeping their stable IDs and frame bindings', async (action) => {
      const frame = { nodeId: 'image-source', kind: 'image', url: 'data:image/png;base64,frame' };
      const { tree, store, dragRow } = await setupShotlistWidths(undefined, [
        { id: 'row-1', shotNo: '3a', frame },
        { id: 'row-2', shotNo: '9' },
        { id: 'row-3', shotNo: '12' },
      ]);
      const body = findElement(tree, (element) => element.type === 'tbody');
      const renderedRows = body.props.children as ElementLike[];
      if (action === 'add') {
        const add = findElement(tree, (element) => element.props.onClick !== undefined
          && element.props.className === 'shotlist-add nodrag');
        (add.props.onClick as () => void)();
      } else if (action === 'delete') {
        const remove = findElement(renderedRows[1], (element) => element.props['aria-label'] === '删除该镜');
        (remove.props.onClick as () => void)();
      } else {
        const drag = dragRow('row-1');
        drag.hit('row-3');
        drag.send('onPointerMove');
        expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
        drag.send('onPointerUp');
        expect(drag.start.currentTarget.setPointerCapture).toHaveBeenCalledWith(7);
        expect(drag.start.currentTarget.releasePointerCapture).toHaveBeenCalledOnce();
      }
      const result = store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>;
      const expectedIds = action === 'add' ? ['row-1', 'row-2', 'row-3', 'shot-generated']
        : action === 'delete' ? ['row-1', 'row-3'] : ['row-2', 'row-3', 'row-1'];
      expect(result.map((row) => row.id)).toEqual(expectedIds);
      expect(result.map((row) => row.shotNo)).toEqual(expectedIds.map((_, index) => String(index + 1)));
      expect(result.find((row) => row.id === 'row-1')?.frame).toBe(frame);
      expect(store.updateNodeDataTransient).toHaveBeenCalledOnce();
      expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    'outside', 'another table', 'cancel', 'lost capture', 'removed grip',
    'escape', 'window blur', 'project switch', 'revision change', 'mouse released', 'click',
  ])(
    'clears the row drag without reordering after %s', async (reason) => {
      const { store, dragRow, pointer, setters } = await setupShotlistWidths(undefined, [
        { id: 'row-1', shotNo: '1' }, { id: 'row-2', shotNo: '2' },
      ]);
      const drag = dragRow('row-1');
      if (reason !== 'outside') drag.hit('row-2', reason !== 'another table');
      if (reason !== 'click') drag.send('onPointerMove');
      if (reason === 'project switch') store.currentProjectId = 'project-b';
      if (reason === 'revision change') store.getCurrentRevision = () => 2;
      if (reason === 'escape') drag.dragWindow.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
      if (reason === 'window blur') drag.dragWindow.dispatchEvent(new Event('blur'));
      if (reason === 'removed grip') {
        drag.ownerDocument.dispatchEvent(Object.assign(new Event('lostpointercapture'), { pointerId: 7 }));
      }
      if (reason === 'mouse released') drag.send('onPointerMove', { ...pointer(150), buttons: 0 });
      const handler = reason === 'cancel' ? 'onPointerCancel' : reason === 'lost capture' ? 'onLostPointerCapture' : 'onPointerUp';
      drag.send(handler, reason === 'click' ? drag.start : undefined);
      expect(drag.start.currentTarget.releasePointerCapture).toHaveBeenCalledOnce();
      expect(setters[2]).toHaveBeenLastCalledWith(null);
      expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
      expect(store.commitToHistory).not.toHaveBeenCalled();
    },
  );

  it('edits shot content with shared mention chips while preserving serialized references and row bindings', async () => {
    const content = '参考 @drama{scene-1:工作室} 与 @{image-1:参考图}';
    const frame = { nodeId: 'frame-1', mediaType: 'image' };
    const { tree, store } = await setupShotlistWidths(undefined, [
      { id: 'row-1', shotNo: '1', content, dialogue: '原台词', frame, duration: 3 },
      { id: 'row-2', shotNo: '2', content: '第二镜', duration: 4 },
    ]);
    const editor = findElement(tree, (element) => element.props.value === content
      && element.props.className === 'shot-content-editor w-full');
    expect(editor.props).toMatchObject({ nodeId: 'shotlist', ariaLabel: '内容', portalDropdown: true, canSubmit: false, submitShortcut: 'ctrl-enter' });
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    (editor.props.onChange as (value: string) => void)(`${content}\n补充动作`);
    expect(store.nodes[0].data.shotlistRows).toEqual([
      { id: 'row-1', shotNo: '1', content: `${content}\n补充动作`, dialogue: '原台词', frame, duration: 3 },
      { id: 'row-2', shotNo: '2', content: '第二镜', duration: 4 },
    ]);
    expect(store.commitToHistory).not.toHaveBeenCalled();
    (editor.props.onBlur as () => void)();
    expect(store.commitToHistory).toHaveBeenCalledOnce();
  });

  it.each([['content', '内容'], ['dialogue', '台词']])('opens the full field editor for %s while chip double-click keeps preview behavior', async (field, label) => {
    const { tree, store, setters } = await setupShotlistWidths(undefined, [{
      id: 'row-1', shotNo: '1', content: '镜头内容', dialogue: '台词内容', duration: 3,
    }]);
    const cell = findElement(tree, (element) => element.props.className === 'ui-input-group shot-input nodrag nowheel'
      && (element.props.children as ElementLike)?.props?.ariaLabel === label);
    const event = { stopPropagation: vi.fn(), target: { closest: vi.fn(() => null) } };
    (cell.props.onDoubleClick as (event: unknown) => void)(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(setters.some((setter) => setter.mock.calls.some(([value]) => value?.rowId === 'row-1'
      && value?.field === field && value?.projectId === 'project-a'))).toBe(true);
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    (cell.props.onDoubleClick as (event: unknown) => void)({ ...event, target: { closest: () => ({}) } });
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    const editor = cell.props.children as ElementLike;
    expect(editor.props).toMatchObject({ nodeId: 'shotlist', ariaLabel: label, portalDropdown: true, canSubmit: false });
    const shortcut = { altKey: true, key: 'Enter', nativeEvent: { isComposing: true, keyCode: 229 }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (cell.props.onKeyDownCapture as (event: unknown) => void)(shortcut);
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    (cell.props.onKeyDownCapture as (event: unknown) => void)({ ...shortcut, nativeEvent: { isComposing: false, keyCode: 13 } });
    expect(shortcut.preventDefault).toHaveBeenCalledOnce();
    expect(shortcut.stopPropagation).toHaveBeenCalledOnce();
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
  });

  it('edits dialogue through the shared reference editor without changing shot content', async () => {
    const { tree, store } = await setupShotlistWidths(undefined, [{
      id: 'row-1', shotNo: '1', content: '保留画面内容', dialogue: '原台词', duration: 3,
    }]);
    const editor = findElement(tree, (element) => element.props.ariaLabel === '台词' && element.props.portalDropdown === true);
    (editor.props.onChange as (value: string) => void)('角色 @drama{character-1:人物}：新台词');
    expect(store.nodes[0].data.shotlistRows).toEqual([{
      id: 'row-1', shotNo: '1', content: '保留画面内容', dialogue: '角色 @drama{character-1:人物}：新台词', duration: 3,
    }]);
  });

  it('keeps all long-table row targets and mounts the heavy editors only for the initial window', async () => {
    const rows = Array.from({ length: 49 }, (_, i) => ({
      id: `row-${i}`, shotNo: String(i + 1), content: `镜头 ${i + 1}`, dialogue: `台词 ${i + 1}`,
    }));
    const { tree, store } = await setupShotlistWidths(undefined, rows);
    const row = (id: string) => findElement(tree, (element) => element.props['data-shot-row-id'] === id);
    const near = row('row-0');
    expect(findElement(near, (element) => element.props.ariaLabel === '内容').props.value).toBe('镜头 1');
    const far = row('row-48');
    expect(findElement(far, (element) => element.props['data-shot-frame-row'] === 'row-48')).toBeTruthy();
    expect(findElement(far, (element) => element.props['aria-label'] === '台词').props)
      .toMatchObject({ children: '台词 49', tabIndex: 0, role: 'textbox', 'data-shot-editor-placeholder': '' });
    expect(() => findElement(far, (element) => element.props.ariaLabel === '内容')).toThrow('Element not found');
    expect(store.commitToHistory).not.toHaveBeenCalled();
  });

  it('opens table defaults and stable-row photography from the shared table, without writing on open', async () => {
    const { tree, store, setters } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1', content: '原内容' }]);
    const defaults = findElement(tree, (element) => element.type === 'button' && Array.isArray(element.props.children)
      && element.props.children.includes('整表摄影'));
    (defaults.props.onClick as () => void)();
    expect(setters.some((setter) => setter.mock.calls.some(([value]) => value?.projectId === 'project-a' && value?.rowId === undefined))).toBe(true);
    const shot = findElement(tree, (element) => element.type === 'button' && element.props['aria-label'] === '摄影设置 · 镜头 1');
    (shot.props.onClick as (event: unknown) => void)({ stopPropagation: vi.fn() });
    expect(setters.some((setter) => setter.mock.calls.some(([value]) => value?.projectId === 'project-a' && value?.rowId === 'row-1'))).toBe(true);
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    expect(store.commitToHistory).not.toHaveBeenCalled();
  });

  it('keeps custom shotlist options editable and stores real values when selecting UI Kit presets', async () => {
    const { tree, store } = await setupShotlistWidths(undefined, [{
      id: 'row-1', shotNo: '1', shotSize: '特写', camera: '手持跟拍并轻微晃动', duration: 3,
    }]);
    const cameraSelect = findElement(tree, (element) => componentName(element) === 'Select'
      && element.props['aria-label'] === '运镜');
    expect(cameraSelect.props.fixedMenu).toBe(true);
    expect(cameraSelect.props.value).toBe('custom');
    expect(() => findElement(tree, (element) => element.type === 'input'
      && element.props['aria-label'] === '运镜自定义')).toThrow('Element not found');
    const Select = (await import('../../../src/components/shared/Select')).default;
    const control = Select(cameraSelect.props as unknown as Parameters<typeof Select>[0]);
    const customInput = findElement(control, (element) => element.type === 'input');
    expect(customInput.props.value).toBe('手持跟拍并轻微晃动');
    expect(customInput.props.role).toBe('combobox');
    const inputGroup = findElement(control, (element) => (element.props.className as string | undefined)?.includes('ui-input-group') ?? false);
    expect(findElement(inputGroup, (element) => element.type === 'button').props['aria-haspopup']).toBe('listbox');
    (customInput.props.onChange as (event: unknown) => void)({ target: { value: '环绕后推进' } });
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0].camera).toBe('环绕后推进');
    store.commitToHistory.mockClear();
    (cameraSelect.props.onChange as (value: string) => void)('preset:0');
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0]).toMatchObject({
      camera: '固定', shotSize: '特写', duration: 3,
    });
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    store.updateNodeDataTransient.mockClear();
    (cameraSelect.props.onChange as (value: string) => void)('custom');
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    (cameraSelect.props.onChange as (value: string) => void)('');
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0].camera).toBe('');
  });

  it('resizes shotlist columns in canvas coordinates and saves once when the drag ends', async () => {
    const { tree, handle, pointer, store } = await setupShotlistWidths();
    const initialRatio = findElement(tree, (element) => componentName(element) === 'NumberStepper'
      && element.props['aria-label'] === '内容列宽').props.value as number;
    (handle.props.onPointerDown as (event: unknown) => void)(pointer(100));
    (handle.props.onPointerMove as (event: unknown) => void)(pointer(150));
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    expect(store.commitToHistory).not.toHaveBeenCalled();
    (handle.props.onPointerUp as (event: unknown) => void)(pointer(150));
    // 剩余弹性空间 1000px，画布缩放 50%，屏幕上移动 50px 对应增加 10 个百分点。
    expect(store.updateNodeDataTransient).toHaveBeenCalledOnce();
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(initialRatio + 10);
    expect(store.nodes[0].data.shotlistColumnWidths).toBeUndefined();
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    (handle.props.onLostPointerCapture as (event: unknown) => void)(pointer(150));
    expect(store.updateNodeDataTransient).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'lost capture', 'project switch', 'revision change', 'no movement'])(
    'does not save a column drag after %s', async (reason) => {
      const { handle, pointer, store } = await setupShotlistWidths();
      (handle.props.onPointerDown as (event: unknown) => void)(pointer(100));
      if (reason !== 'no movement') (handle.props.onPointerMove as (event: unknown) => void)(pointer(150));
      if (reason === 'project switch') store.currentProjectId = 'project-b';
      if (reason === 'revision change') store.getCurrentRevision = () => 2;
      const callback = reason === 'cancel' ? 'onPointerCancel'
        : reason === 'lost capture' ? 'onLostPointerCapture' : 'onPointerUp';
      (handle.props[callback] as (event: unknown) => void)(pointer(150));
      expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
      expect(store.commitToHistory).not.toHaveBeenCalled();
    },
  );

  it('converts legacy widths to percentages, redistributes space and resets the layout', async () => {
    const { tree, table, store } = await setupShotlistWidths({ content: 320, dialogue: 180 });
    const input = findElement(tree, (element) => componentName(element) === 'NumberStepper' && element.props['aria-label'] === '内容列宽');
    expect(input.props.value).toBeCloseTo(320 / (68 + 68 + 180 + 320 + 180) * 100);
    expect(input.props.unit).toBe('%');
    expect((table.props.style as Record<string, string>)['--shotlist-columns']).toContain('minmax(0,');
    expect((table.props.style as Record<string, string>).width).toBeUndefined();
    expect((table.props.style as Record<string, string>).minWidth).toBeUndefined();
    (input.props.onChange as (value: number) => void)(12);
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(12);
    expect(store.nodes[0].data.shotlistColumnWidths).toBeUndefined();
    const reset = findElement(tree, (element) => element.type === 'button' && element.props.children === '恢复默认');
    (reset.props.onClick as () => void)();
    expect(store.nodes[0].data.shotlistColumnWidths).toBeUndefined();
    expect(store.nodes[0].data.shotlistColumnRatios).toBeUndefined();
  });

  it('supports keyboard resizing with a bounded width', async () => {
    const { handle, store } = await setupShotlistWidths(undefined, [], {
      shotlistColumnRatios: { shotNo: 1, frame: 1, video: 1, shotSize: 2, camera: 2, cinematography: 2, dialogue: 2, content: 94 },
    });
    (handle.props.onKeyDown as (event: unknown) => void)({
      key: 'ArrowRight', shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(95);
  });

  it.each([
    { column: 'duration', label: '时长', width: 84, layout: '84px 106px' },
    { column: 'frame', label: '画面', width: 96, layout: '48px 96px 96px' },
    { column: 'video', label: '生成视频', width: 96, layout: '48px 96px 96px' },
  ])('keeps $column fixed at $width px and excludes it from resizing and percentage settings', async ({ column, label, layout }) => {
    const { tree, table } = await setupShotlistWidths({ [column]: 500, content: 300 });
    expect((table.props.style as Record<string, string>)['--shotlist-columns']).toContain(layout);
    expect(() => findElement(tree, (element) => element.props['aria-label'] === `${label}列宽`)).toThrow('Element not found');
  });

  it('keeps shot numbers fixed at 48px and excludes them from resizing and percentage settings', async () => {
    const { tree, table } = await setupShotlistWidths({ shotNo: 300, content: 300 }, [], {
      shotlistColumnRatios: { shotNo: 90, content: 30 },
    });
    expect((table.props.style as Record<string, string>)['--shotlist-columns']).toMatch(/^26px 48px /);
    expect(() => findElement(tree, (element) => element.props['aria-label'] === '镜号列宽')).toThrow('Element not found');
  });

  it('restores persisted ratios while keeping hidden column preferences', async () => {
    const { tree, store } = await setupShotlistWidths(undefined, [], {
      shotlistColumnRatios: { shotNo: 5, frame: 10, shotSize: 10, camera: 15, cinematography: 20, content: 30, dialogue: 30, note: 20 },
    });
    const stepper = findElement(tree, (element) => componentName(element) === 'NumberStepper'
      && element.props['aria-label'] === '内容列宽');
    // 画面和生成视频固定后，剩余列只按自己的旧比例重新分配空间。
    expect(stepper.props.value).toBeCloseTo(30 / (10 + 15 + 20 + 30 + 30) * 100);
    (stepper.props.onChange as (value: number) => void)(40);
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(40);
    expect((store.nodes[0].data.shotlistColumnRatios as Record<string, number>).note).toBe(20);
    expect(visibleShotRatio(store, 'shotSize') / visibleShotRatio(store, 'camera')).toBeCloseTo(10 / 15);
  });

  it('uses the small NumberStepper for fractional durations without losing frame bindings', async () => {
    const frame = { nodeId: 'image-source', kind: 'image' };
    const { tree, store } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1', duration: 3, frame }]);
    const stepper = findElement(tree, (element) => componentName(element) === 'NumberStepper'
      && element.props['aria-label'] === '时长');
    expect(stepper.props).toMatchObject({ value: 3, size: 'sm', min: 0, step: 0.5, unit: 's' });
    (stepper.props.onChange as (value: number) => void)(3.5);
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0])
      .toMatchObject({ id: 'row-1', shotNo: '1', duration: 3.5, frame });
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
  });

  it.each(['时长', '内容列宽'])('groups NumberStepper scrubbing for %s into one history change', async (label) => {
    const { tree, store } = await setupShotlistWidths({ content: 300 }, [{ id: 'row-1', shotNo: '1', duration: 3 }]);
    const stepper = findElement(tree, (element) => componentName(element) === 'NumberStepper'
      && element.props['aria-label'] === label);
    const scrub = stepper.props.onScrubStateChange as (active: boolean) => void;
    const change = stepper.props.onChange as (value: number) => void;
    scrub(true);
    change(label === '时长' ? 3.5 : 31);
    change(label === '时长' ? 4 : 32);
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    scrub(false);
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    if (label === '时长') {
      expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0].duration).toBe(4);
    } else {
      expect(visibleShotRatio(store, 'content')).toBeCloseTo(32);
    }
  });
}
