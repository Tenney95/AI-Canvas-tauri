import { expect, it, vi } from 'vitest';
import type { AssetFileEntry } from '../../../src/services/fileService';
import AssetFileContextMenu from '../../../src/components/assets/AssetFileContextMenu';
import type { AssetDrawerFixture, Element } from '../assetsPanelDrawer.test';

export function registerCardTooltipTests({ driver, all, find, render, settle, file, cards, fileMenu, openFileMenu }: AssetDrawerFixture) {
  async function open(mode: 'drawer' | 'modal' | 'page' = 'drawer') {
    driver.store!.getState().setAssetsPanelOpen(true, mode);
    render(); await settle(); vi.useFakeTimers();
  }
  function hover(index = 0) { (cards()[index].props.onHover as () => void)(); render(); }
  function leave(index = 0) { (cards()[index].props.onHoverEnd as () => void)(); render(); }
  function cardElement(index = 0) {
    const card = cards()[index];
    return (card.type as (props: Record<string, unknown>) => Element)(card.props);
  }
  async function readPrompt() { await vi.advanceTimersByTimeAsync(400); render(); }

  it('停留后读取编辑提示词并展示拖拽说明，悬浮不产生最近使用记录', async () => {
    driver.imageDetails.mockResolvedValue({ record: { prompt: '编辑后的\n提示词' }, history: { prompt: '旧提示词' } });
    await open();
    const index = cards().findIndex((element) => (element.props.file as AssetFileEntry).name === '森林');
    hover(index);
    expect(driver.imageDetails).not.toHaveBeenCalled();
    expect(cardElement(index).props['data-tooltip']).toContain('正在读取');
    await readPrompt();
    expect(driver.imageDetails).toHaveBeenCalledWith(cards()[index].props.file, 'project-1', expect.any(AbortSignal));
    expect(cardElement(index).props['data-tooltip']).toBe('拖拽到画布可添加节点；\n提示词：编辑后的 提示词\n标签：\n夜景');
    expect(driver.markUsed).not.toHaveBeenCalled();
    expect(all(cardElement(index), (element) => element.type === 'asset-thumb')[0].props.showNativeTooltip).toBe(false);
  });

  it('快速扫过不读取；移开后忽略迟到结果，重新悬浮可读取最新内容', async () => {
    await open(); hover(); leave(); await readPrompt();
    expect(driver.imageDetails).not.toHaveBeenCalled();
    let finish!: (value: unknown) => void;
    driver.imageDetails.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    hover(); await readPrompt();
    const signal = driver.imageDetails.mock.calls[0][2] as AbortSignal;
    leave(); expect(signal.aborted).toBe(true);
    finish({ record: { prompt: '已过期' } }); await readPrompt();
    expect(cardElement().props['data-tooltip']).not.toContain('已过期');
    hover(); await readPrompt();
    expect(cardElement().props['data-tooltip']).toContain('历史提示词');
  });

  it('主动清空不回退历史，缺少记录与读取失败分别反馈', async () => {
    driver.imageDetails.mockResolvedValueOnce({ record: { prompt: '' }, history: { prompt: '旧提示词' } })
      .mockResolvedValueOnce({ record: null, history: null }).mockRejectedValueOnce(new Error('read failed'));
    await open(); hover(); await readPrompt();
    expect(cardElement().props['data-tooltip']).toContain('暂无提示词');
    expect(cardElement().props['data-tooltip']).not.toContain('旧提示词');
    leave(); hover(); await readPrompt();
    expect(cardElement().props['data-tooltip']).toContain('暂无提示词');
    leave(); hover(); await readPrompt();
    expect(cardElement().props['data-tooltip']).toContain('读取失败，请重试');
  });

  it('视频按所查看项目查询；弹窗和整页使用相应的拖拽说明', async () => {
    driver.listProject.mockResolvedValue([{ name: '视频', path: '/video.mp4', category: 'video', size: 12 }]);
    await open('modal'); hover(); await readPrompt();
    expect(driver.videoHistory).toHaveBeenCalledWith('/video.mp4', undefined, 'project-1', expect.any(AbortSignal));
    expect(cardElement().props['data-tooltip']).toBe('拖出弹窗到画布可添加节点；\n提示词：视频提示词\n标签：\n暂无标签');
    driver.store!.setState({ currentProjectId: null });
    driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent', folder: { kind: 'all' } });
    render(); await vi.advanceTimersByTimeAsync(0); render(); hover(); await readPrompt();
    expect(driver.imageDetails).toHaveBeenCalledWith(expect.objectContaining({ name: '全局参考' }), undefined, expect.any(AbortSignal));
    expect(cardElement().props['data-tooltip']).toContain('可拖拽到其他窗口或应用');
  });

  it('文本、虚拟和离线素材不查询图像历史，提示拖拽可用性', async () => {
    driver.listProject.mockResolvedValue([
      { ...file('文本'), category: 'text' }, { ...file('虚拟'), path: 'virtual://image' },
      { ...file('离线'), availability: 'offline' },
    ]);
    await open();
    for (let index = 0; index < cards().length; index++) {
      hover(index); await readPrompt();
      expect(cardElement(index).props['data-tooltip']).toContain('暂无提示词');
      if ((cards()[index].props.file as AssetFileEntry).category !== 'text') {
        expect(cardElement(index).props['data-tooltip']).toContain('暂不支持拖拽');
      }
    }
    expect(driver.imageDetails).not.toHaveBeenCalled(); expect(driver.videoHistory).not.toHaveBeenCalled();
  });

  it('搜索、项目切换和关闭面板取消读取，旧上下文内容不展示', async () => {
    driver.imageDetails.mockImplementation(() => new Promise(() => {}));
    await open(); hover(); await readPrompt();
    const first = driver.imageDetails.mock.calls[0][2] as AbortSignal;
    (find((element) => element.props.placeholder === '搜索名称或标签…').props.onChange as (event: unknown) => void)({ target: { value: '森林' } });
    render(); expect(first.aborted).toBe(true);
    hover(); await readPrompt();
    const second = driver.imageDetails.mock.calls[1][2] as AbortSignal;
    driver.store!.setState({ currentProjectId: 'project-2' }); render(); expect(second.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0); render(); hover(); await readPrompt();
    const third = driver.imageDetails.mock.calls[2][2] as AbortSignal;
    driver.store!.getState().setAssetsPanelOpen(false); render(); expect(third.aborted).toBe(true);
  });

  it('长提示词截取摘要，拖拽与右键时隐藏提示，键盘焦点仍可读取', async () => {
    driver.imageDetails.mockResolvedValue({ record: { prompt: '长'.repeat(1000) } });
    await open('modal');
    (cardElement().props.onFocus as (event: unknown) => void)({ currentTarget: { contains: () => false }, relatedTarget: null });
    render(); await readPrompt();
    expect(String(cardElement().props['data-tooltip'])).toContain('点击查看完整提示词');
    expect(String(cardElement().props['data-tooltip']).length).toBeLessThan(300);
    openFileMenu(); expect(cardElement().props['data-tooltip']).toBeUndefined();
    fileMenu().onClose(); render(); leave(); hover(); await readPrompt();
    (cards()[0].props.onDragStart as (event: unknown) => void)({ preventDefault: vi.fn(), currentTarget: { closest: () => null } });
    render(); expect(cardElement().props['data-tooltip']).toBeUndefined();
  });

  it('鼠标和键盘焦点交接时保留已读取提示，均离开后取消', async () => {
    await open(); hover(); await readPrompt();
    const signal = driver.imageDetails.mock.calls[0][2] as AbortSignal;
    (cardElement().props.onMouseLeave as (event: unknown) => void)({ currentTarget: { contains: () => true } });
    expect(signal.aborted).toBe(false);
    (cardElement().props.onBlur as (event: unknown) => void)({ currentTarget: { contains: () => false, matches: () => true }, relatedTarget: null });
    expect(signal.aborted).toBe(false);
    (cardElement().props.onBlur as (event: unknown) => void)({ currentTarget: { contains: () => false, matches: () => false }, relatedTarget: null });
    expect(signal.aborted).toBe(true);
  });
}

export function registerFileMenuTests(panel: AssetDrawerFixture) {
  const {
    driver, all, find, click, render, settle, key, file, cards, fileMenu, openFileMenu, canvasNode,
  } = panel;
  it('抽屉与弹窗都提供文件复制和打开目录，完整路径不被改写', async () => {
    key(); render(); await settle();
    let menu = openFileMenu(cards().findIndex((element) => (element.props.file as AssetFileEntry).name === '森林'));
    expect(menu).toMatchObject({ name: '森林', canFileActions: true, canCopyPrompt: true, x: 120, y: 180 });
    await menu.onCopy(); expect(driver.copyClipboard).toHaveBeenCalledWith('assets/森林.png');
    await menu.onReveal(); expect(driver.revealFile).toHaveBeenCalledWith('assets/森林.png');
    driver.store!.getState().setAssetsPanelOpen(true); render(); await settle();
    click(all(panel.tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    menu = openFileMenu(); await menu.onCopy(); await menu.onReveal();
    expect(driver.copyClipboard).toHaveBeenLastCalledWith('assets/全局参考.png');
    expect(driver.revealFile).toHaveBeenLastCalledWith('assets/全局参考.png');
  });
  it('图片优先复制用户保存的提示词，清空后的编辑内容不回退到生成历史', async () => {
    key(); render(); await settle();
    driver.imageDetails.mockResolvedValue({ record: { prompt: '用户编辑\n完整提示词' }, history: { prompt: '原始' } });
    const index = cards().findIndex((element) => (element.props.file as AssetFileEntry).name === '森林');
    await openFileMenu(index).onCopyPrompt();
    expect(driver.copyText).toHaveBeenLastCalledWith('用户编辑\n完整提示词');
    expect(driver.imageDetails).toHaveBeenCalledWith(expect.objectContaining({ path: 'assets/森林.png' }), 'project-1', expect.any(AbortSignal));
    driver.copyText.mockClear(); driver.imageDetails.mockResolvedValue({ record: { prompt: '' }, history: { prompt: '原始' } });
    await openFileMenu(index).onCopyPrompt(); render();
    expect(driver.copyText).not.toHaveBeenCalled(); expect(find((el) => el.props.children === '此资产暂无提示词')).toBeDefined();
  });
  it('视频按项目与完整媒体地址读取，全局资产不限定项目', async () => {
    const video: AssetFileEntry = { name: '视频', path: '/assets/video.mp4', category: 'video', size: 10, assetUrl: 'asset://video' };
    driver.listProject.mockResolvedValue([video]); driver.listGlobal.mockResolvedValue([video]);
    key(); render(); await settle(); await openFileMenu().onCopyPrompt();
    expect(driver.videoHistory).toHaveBeenCalledWith(video.path, video.assetUrl, 'project-1', expect.any(AbortSignal));
    expect(driver.copyText).toHaveBeenLastCalledWith('视频提示词');
    click(all(panel.tree, (el) => el.props.role === 'tab')[1]); render(); await settle(); await openFileMenu().onCopyPrompt();
    expect(driver.videoHistory).toHaveBeenLastCalledWith(video.path, video.assetUrl, undefined, expect.any(AbortSignal));
  });
  it('读取失败和剪贴板失败有反馈，不伪造成功', async () => {
    key(); render(); await settle(); driver.copyClipboard.mockResolvedValue(false);
    await openFileMenu().onCopy(); render(); expect(find((el) => el.props.children === '复制失败，请检查文件和系统剪贴板')).toBeDefined();
    driver.imageDetails.mockRejectedValue(new Error('db')); await openFileMenu().onCopyPrompt(); render();
    expect(driver.copyText).not.toHaveBeenCalled(); expect(find((el) => el.props.children === '提示词读取或复制失败，请重试')).toBeDefined();
    driver.revealFile.mockRejectedValue(new Error('offline')); await openFileMenu().onReveal(); render();
    expect(find((el) => el.props.children === '打开目录失败，请检查文件位置和权限')).toBeDefined();
  });
  it.each(['project', 'tab', 'close', 'dismiss'])('提示词读取期间 %s 会取消查询且不复制迟到结果', async (change) => {
    key(); render(); await settle();
    let finish!: (value: unknown) => void;
    driver.imageDetails.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const menu = openFileMenu(); const pending = menu.onCopyPrompt();
    const signal = driver.imageDetails.mock.calls[0][2] as AbortSignal;
    if (change === 'project') driver.store!.setState({ currentProjectId: 'project-2' });
    else if (change === 'tab') click(all(panel.tree, (el) => el.props.role === 'tab')[1]);
    else if (change === 'close') driver.store!.getState().setAssetsPanelOpen(false);
    else menu.onClose();
    render(); finish({ record: { prompt: '迟到提示词' }, history: null }); await pending;
    expect(signal.aborted).toBe(true); expect(driver.copyText).not.toHaveBeenCalled();
  });
  it('虚拟资源、离线文件与 Web 环境禁用磁盘操作，文本不提供提示词复制', async () => {
    driver.listProject.mockResolvedValue([
      { ...file('虚拟'), path: 'node://image' }, { ...file('离线'), availability: 'offline' },
      { ...file('文本'), category: 'text' }, { ...file('远程'), path: 'https://example.test/image.png' },
    ]); key(); render(); await settle();
    const named = (name: string) => openFileMenu(cards().findIndex((el) => (el.props.file as AssetFileEntry).name === name));
    expect(named('虚拟').canFileActions).toBe(false); expect(named('离线').canFileActions).toBe(false);
    expect(named('文本').canCopyPrompt).toBe(false); expect(named('远程').canFileActions).toBe(false);
    driver.native = false; expect(named('文本').canFileActions).toBe(false);
    await fileMenu().onDelete().catch(() => {}); expect(driver.deleteFile).not.toHaveBeenCalled();
  });
  it('删除失败保留卡片，成功刷新列表且不重新加入残留节点引用', async () => {
    key(); render(); await settle();
    const menu = openFileMenu(cards().findIndex((element) => (element.props.file as AssetFileEntry).name === '森林'));
    expect(driver.deleteFile).not.toHaveBeenCalled(); driver.deleteFile.mockRejectedValueOnce(new Error('locked'));
    await expect(menu.onDelete()).rejects.toThrow('删除失败'); render(); expect(cards()).toHaveLength(2);
    driver.listProject.mockResolvedValue([file('人物')]);
    driver.nodeFile = file('森林'); driver.store!.setState({ nodes: [canvasNode('source', 'source-image')] });
    await menu.onDelete(); render(); expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['人物']);
    expect(driver.deleteFile).toHaveBeenCalledWith('assets/森林.png');
    expect(driver.store!.getState().nodes).toHaveLength(1);
  });
  it('全局资产原有删除按钮也先确认；确认期间切换项目不会删除旧文件', async () => {
    key(); render(); await settle(); click(all(panel.tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    (cards()[0].props.onDelete as () => void)(); render();
    const menu = fileMenu(); expect(menu.confirmDelete).toBe(true); expect(driver.deleteFile).not.toHaveBeenCalled();
    driver.store!.setState({ currentProjectId: 'project-2' }); render(); await menu.onDelete();
    expect(driver.deleteFile).not.toHaveBeenCalled();
  });
  it('键盘 ContextMenu/Shift+F10 定位菜单；标签输入保留原生菜单', async () => {
    key(); render(); await settle();
    const event = { key: 'F10', shiftKey: true, target: { closest: () => null }, currentTarget: { focus: vi.fn(), getBoundingClientRect: () => ({ left: 20, top: 40 }) }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (cards()[0].props.onMenuKeyDown as (event: unknown) => void)(event); render();
    expect(fileMenu()).toMatchObject({ x: 32, y: 52 }); fileMenu().onClose(); render();
    const preventDefault = vi.fn();
    (cards()[0].props.onContextMenu as (event: unknown) => void)({ target: { closest: () => ({}) }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled(); expect(all(panel.tree, (el) => el.type === AssetFileContextMenu)).toHaveLength(0);
  });
}

export function registerFileOrderingTests(panel: AssetDrawerFixture) {
  const { driver, all, find, button, click, render, settle, file, cards } = panel;
  async function open(files: AssetFileEntry[]) {
    vi.mocked(driver.store!.getState().updateConfig).mockImplementation((patch) => {
      driver.store!.setState((state) => ({ config: { ...state.config, ...patch } }));
    });
    vi.mocked(driver.store!.getState().saveConfig).mockResolvedValue(undefined);
    driver.listGlobal.mockResolvedValue(files);
    driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent', folder: { kind: 'all' } });
    render(); await settle(); await settle();
  }
  function choose(value: string) {
    (button('排序方式').props.onChange as (value: string) => void)(value); render();
  }
  function names() { return cards().map((element) => (element.props.file as AssetFileEntry).name); }

  it('默认名称自然升序，大小和真实时间排序保存字段与方向，未知创建时间始终置后', async () => {
    const files: AssetFileEntry[] = [
      { ...file('clip10'), size: 10, createdAt: 30, modifiedAt: 100 },
      { ...file('clip2'), size: 20, createdAt: 10, modifiedAt: 300 },
      { ...file('clip1'), size: 30, modifiedAt: 200 },
    ];
    await open(files);
    expect(button('排序方式').props.value).toBe('name');
    expect(button('切换为降序').props.children).toContain('升序');
    expect(names()).toEqual(['clip1', 'clip2', 'clip10']);
    choose('size');
    expect(names()).toEqual(['clip10', 'clip2', 'clip1']);
    expect(driver.store!.getState().updateConfig).toHaveBeenLastCalledWith({ assetSortBy: 'size', assetSortOrder: 'asc' });
    choose('createdAt');
    expect(names()).toEqual(['clip2', 'clip10', 'clip1']);
    click(button('切换为降序')); render();
    expect(names()).toEqual(['clip10', 'clip2', 'clip1']);
    expect(driver.store!.getState().updateConfig).toHaveBeenLastCalledWith({ assetSortBy: 'createdAt', assetSortOrder: 'desc' });
    expect(button('切换为升序').props.children).toContain('降序');
    choose('modifiedAt');
    expect(names()).toEqual(['clip2', 'clip1', 'clip10']);
    expect(driver.store!.getState().config).toMatchObject({ assetSortBy: 'modifiedAt', assetSortOrder: 'desc' });
    expect(driver.store!.getState().saveConfig).toHaveBeenCalledTimes(4);
    expect(driver.store!.getState().saveConfig).toHaveBeenLastCalledWith({ silent: true });
    expect(files.map((entry) => entry.name)).toEqual(['clip10', 'clip2', 'clip1']);
  });

  it('先排序完整筛选结果再取第一页，切换排序保留搜索分类标签并关闭图片预览', async () => {
    await open([
      ...Array.from({ length: 60 }, (_, index) => ({ ...file(`clip${60 - index}`, ['精选']), size: 60 - index })),
      { ...file('clip999', ['其他']), size: 999 },
      { ...file('clip-video', ['精选']), category: 'video', size: 9999 },
      { ...file('noise', ['精选']), size: 99999 },
    ]);
    const search = find((element) => element.props.placeholder === '搜索名称或标签…');
    (search.props.onChange as (event: unknown) => void)({ target: { value: 'clip' } }); render();
    click(find((element) => element.type === 'button' && Array.isArray(element.props.children) && element.props.children.includes('图像'))); render();
    click(find((element) => String(element.props.className).includes('assets-tag-chip')
      && Array.isArray(element.props.children) && element.props.children.includes('精选'))); render();
    expect(cards()).toHaveLength(48);
    // 瀑布流按列存放 DOM；校验第一页成员，避免把列内顺序误认为排序结果。
    expect(new Set(names())).toEqual(new Set(Array.from({ length: 48 }, (_, index) => `clip${index + 1}`)));
    (cards()[0].props.onImagePreview as () => void)(); render();
    expect(find((element) => element.type === 'asset-image-preview')).toBeDefined();
    choose('size');
    click(button('切换为降序')); render();
    expect(cards()).toHaveLength(48);
    expect(new Set(names())).toEqual(new Set(Array.from({ length: 48 }, (_, index) => `clip${60 - index}`)));
    expect(find((element) => element.props.placeholder === '搜索名称或标签…').props.value).toBe('clip');
    expect(find((element) => element.type === 'button' && Array.isArray(element.props.children)
      && element.props.children.includes('图像')).props.className).toContain('active');
    expect(find((element) => String(element.props.className).includes('assets-tag-chip')
      && Array.isArray(element.props.children) && element.props.children.includes('精选')).props.className).toContain('active');
    expect(all(panel.tree, (element) => element.type === 'asset-image-preview')).toHaveLength(0);
  });

  it('最近使用默认降序且按稳定资产身份读取记录，使用记录变更会刷新当前排序', async () => {
    driver.lastUsedTimes.mockResolvedValue(new Map([['ten', 10], ['two', 20]]));
    await open([
      { ...file('clip10'), assetId: 'ten' }, { ...file('clip2'), assetId: 'two' }, { ...file('clip1'), assetId: 'one', createdAt: 999 },
    ]);
    choose('usedAt'); await settle();
    expect(names()).toEqual(['clip2', 'clip10', 'clip1']);
    expect(driver.store!.getState().updateConfig).toHaveBeenLastCalledWith({ assetSortBy: 'usedAt', assetSortOrder: 'desc' });
    expect(driver.store!.getState().saveConfig).toHaveBeenLastCalledWith({ silent: true });
    expect(driver.lastUsedTimes).toHaveBeenCalledWith(expect.arrayContaining(['ten', 'two', 'one']));
    const reads = driver.lastUsedTimes.mock.calls.length;
    (cards()[0].props.onImagePreview as () => void)(); render();
    driver.lastUsedTimes.mockResolvedValue(new Map([['one', 30], ['two', 20], ['ten', 10]]));
    driver.store!.setState((state) => ({ recentAssetsRevision: state.recentAssetsRevision + 1 }));
    render(); await settle();
    expect(names()).toEqual(['clip2', 'clip10', 'clip1']);
    expect(driver.lastUsedTimes.mock.calls.length).toBe(reads);
    (find((element) => element.type === 'asset-image-preview').props.onClose as () => void)();
    render(); await settle();
    expect(driver.lastUsedTimes.mock.calls.length).toBeGreaterThan(reads);
    expect(names()).toEqual(['clip1', 'clip2', 'clip10']);
    expect(button('排序方式').props.value).toBe('usedAt');
    expect(button('切换为升序').props.children).toContain('降序');
  });
}
