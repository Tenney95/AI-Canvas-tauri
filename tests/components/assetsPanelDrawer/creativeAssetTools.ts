import { expect, it, vi } from 'vitest';
import type { DramaAsset, DramaAssetWriteOptions } from '../../../src/types/dramaAssets';
import DramaAssetsPanel from '../../../src/components/DramaAssetsPanel';
import GlobalCreativeAssetsPanel from '../../../src/components/assets/GlobalCreativeAssetsPanel';
import { setLocale } from '../../../src/i18n';
import type { AssetDrawerFixture } from '../assetsPanelDrawer.test';

export function registerProjectAssetToolbarTests(panel: AssetDrawerFixture) {
  const { driver, all, visibleText, find, button, click, renderDramaCards, key, canvasNode } = panel;
  function renderDrama() {
    const compact = driver.store!.getState().assetsPanelMode === 'drawer';
    for (let pass = 0; pass < 5; pass++) {
      driver.stateIndex = 0; driver.refIndex = 0; driver.effectIndex = 1; driver.memoIndex = 0; driver.dirty = false;
      panel.tree = renderDramaCards(DramaAssetsPanel({ compact }));
      if (!driver.dirty) break;
    }
    const pending = driver.pending; driver.pending = [];
    pending.forEach((effect) => effect());
  }
  async function settleDrama() { await new Promise<void>((resolve) => setImmediate(resolve)); renderDrama(); }
  function open(mode: 'page' | 'drawer' = 'page') {
    const base = { key: 'asset', summary: '', visualNotes: '', importance: 'main', confirmed: true,
      createdAt: 1, updatedAt: 1, source: 'manual' } as const;
    driver.store!.setState({
      dramaAssets: { version: 2, characters: [{ ...base, id: 'hero', name: '人物甲', kind: 'character', identity: '' }],
        scenes: [{ ...base, id: 'room', name: '场景甲', kind: 'scene' }], props: [{ ...base, id: 'key', name: '道具甲', kind: 'prop' }] },
      showToast: vi.fn(), importDramaAssets: vi.fn().mockResolvedValue(1), saveCurrentProjectSilent: vi.fn().mockResolvedValue('project-1'),
    });
    driver.store!.getState().setAssetsPanelOpen(true, mode);
    driver.store!.getState().setDramaAssetsPanelOpen(true);
    renderDrama();
  }

  it('Tab 抽屉只显示浏览控件，并按角色库顺序展示图片、旧记录和缺失状态', () => {
    open('drawer');
    const { dramaAssets } = driver.store!.getState();
    const [character] = dramaAssets.characters;
    const node = canvasNode('source', 'source-image');
    const imageUrl = 'https://example.test/source.png';
    driver.store!.setState({
      nodes: [{ ...node, data: { ...node.data, imageUrl } }],
      dramaAssets: { ...dramaAssets, characters: [
        { ...character, referenceImages: [
          { id: 'avatar', kind: 'avatar', imageUrl: 'https://example.test/avatar.png', prompt: '', createdAt: 1, updatedAt: 1 },
          { id: 'body', kind: 'full_body', sourceNodeId: node.id, prompt: '', createdAt: 1, updatedAt: 1 },
          { id: 'expression', kind: 'expression', imageUrl: 'https://example.test/expression.png', prompt: '', createdAt: 1, updatedAt: 1 },
          { id: 'missing', kind: 'outfit', prompt: '', createdAt: 1, updatedAt: 1 },
        ] },
        { ...character, id: 'legacy', name: '旧人物', imageUrl: 'https://example.test/legacy.png' },
      ] },
    });
    renderDrama();
    const card = find((element) => element.props['data-asset-id'] === 'hero');
    const gallery = all(card, (element) => element.props['aria-label'] === '角色参考图')[0];
    const images = all(gallery, (element) => typeof element.props.src === 'string');
    expect(images.map((element) => element.props.src)).toEqual([
      'https://example.test/avatar.png', imageUrl, 'https://example.test/expression.png',
    ]);
    expect(images.every((element) => element.props.draggable && typeof element.props.onDragStart === 'function')).toBe(true);
    expect(all(gallery, (element) => element.props['aria-label'] === '参考图不可用')).toHaveLength(1);
    expect(all(panel.tree, (element) => element.props.src === 'https://example.test/legacy.png')).toHaveLength(1);
    expect(button('创作资产排序方式')).toBeDefined();
    click(find((element) => element.type === 'button' && visibleText(element.props.children) === '人物 2'));
    renderDrama();
    expect(all(panel.tree, (element) => String(element.props.className).includes('drama-asset-actions'))).toHaveLength(0);
    expect(all(panel.tree, (element) => ['上传资产类型', '导入创作资产', '导出创作资产'].includes(String(element.props['aria-label'])))).toHaveLength(0);
    expect(visibleText(panel.tree)).not.toMatch(/打开角色库|新增人物|多选|清空本类/);
    click(button('打开人物：人物甲'));
    expect(driver.store!.getState().characterLibraryRequest).toMatchObject({ scope: 'project', characterId: 'hero' });
  });

  it('Tab 抽屉的道具卡优先展示可拖动的大图，整页仍使用原缩略图', () => {
    open('drawer');
    const { dramaAssets } = driver.store!.getState();
    const imageUrl = 'https://example.test/prop.png';
    driver.store!.setState({ dramaAssets: { ...dramaAssets, props: [{ ...dramaAssets.props[0], imageUrl }] } });
    renderDrama();
    const gallery = button('参考图');
    expect(all(gallery, (element) => element.props.src === imageUrl)[0].props.draggable).toBe(true);
    expect(all(gallery, (element) => String(element.props.className).includes('col-span-2'))).toHaveLength(1);

    driver.store!.getState().setAssetsPanelOpen(true, 'page');
    renderDrama();
    expect(find((element) => element.props.src === imageUrl).props.draggable).toBe(false);
  });

  it('使用小尺寸控件，先保存新项目，导出完整创作资产而不受分类和搜索影响', async () => {
    open();
    const upload = find((element) => element.type === 'button' && String(element.props.className).includes('ui-btn--primary'));
    expect(upload.props.className).toContain('ui-btn--sm');
    expect(button('上传资产类型').props.size).toBe('sm');
    const search = find((element) => element.props.placeholder === '搜索名称、简介、别名…');
    expect(search.props.className).toContain('ui-input--sm');
    click(find((element) => element.type === 'button' && Array.isArray(element.props.children) && element.props.children[0] === '人物')); renderDrama();
    (find((element) => element.props.placeholder === '搜索名称、简介、别名…').props.onChange as (event: unknown) => void)({ target: { value: '无匹配' } }); renderDrama();
    driver.store!.setState({ currentProjectId: null });
    vi.mocked(driver.store!.getState().saveCurrentProjectSilent).mockImplementation(async () => {
      driver.store!.setState({ currentProjectId: 'project-1' }); return 'project-1';
    });
    driver.exportDrama.mockResolvedValue({ assetCount: 3, mediaCount: 4 });
    click(button('导出创作资产')); await settleDrama();
    expect(driver.store!.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
    expect(driver.exportDrama).toHaveBeenCalledOnce();
    expect(driver.exportDrama.mock.calls[0][0]).toMatchObject({ projectId: 'project-1', ownerId: 'project-1', projectName: '项目一',
      assets: [expect.objectContaining({ id: 'hero' }), expect.objectContaining({ id: 'room' }), expect.objectContaining({ id: 'key' })],
    });
    expect(driver.exportDrama.mock.calls[0][0]).not.toHaveProperty('assetName');
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导出 3 项创作资产，包含 4 份媒体', 'success');
  });

  it('单卡按类别和 ID 导出最新记录及绑定媒体，沿用分集资产归属与忙碌保护', async () => {
    open();
    const current = driver.store!.getState();
    const scene = { ...current.dramaAssets.scenes[0], id: 'hero' };
    const nodes = [canvasNode('scene-image', 'source-image', '场景参考图')];
    driver.store!.setState({ currentProjectId: 'episode-1',
      projects: [{ ...current.projects[0], id: 'series-1', name: '整部剧' },
        { ...current.projects[0], id: 'episode-1', name: '第一集', parentId: 'series-1' }],
      dramaAssets: { ...current.dramaAssets, scenes: [scene] }, nodes,
    });
    renderDrama();
    const exportSingle = button('导出资产「场景甲」');
    const exportAll = button('导出创作资产');
    expect(exportSingle.props.className).toContain('ui-btn--sm');
    expect(exportSingle.props.title).toBe('导出当前资产及其绑定媒体');
    const latestScene = { ...scene, name: '场景乙', summary: '最新场景简介', imageNodeId: 'scene-image' };
    driver.store!.setState({ dramaAssets: { ...current.dramaAssets, scenes: [latestScene] } });
    let finishExport!: () => void;
    driver.exportDrama.mockImplementation(() => new Promise((resolve) => { finishExport = () => resolve({ assetCount: 1, mediaCount: 1 }); }));
    click(exportSingle); renderDrama();
    expect(driver.exportDrama).toHaveBeenCalledOnce();
    const input = driver.exportDrama.mock.calls[0][0];
    expect(input).toMatchObject({ projectId: 'episode-1', ownerId: 'series-1', projectName: '整部剧', assetName: '场景乙' });
    expect(input.assets).toEqual([latestScene]);
    expect(input.assets[0]).toBe(latestScene);
    expect(input.nodes).toBe(nodes);
    expect(driver.store!.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
    expect(button('导出资产「场景乙」').props.disabled).toBe(true);
    expect(button('导出创作资产').props.disabled).toBe(true);
    click(exportSingle); click(exportAll);
    expect(driver.exportDrama).toHaveBeenCalledOnce();
    finishExport(); await settleDrama();
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导出 1 项创作资产，包含 1 份媒体', 'success');
    expect(button('导出资产「场景乙」').props.disabled).toBe(false);
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
  });

  it.each(['before-click', 'while-saving'] as const)('%s 删除卡片后，旧导出入口不会导出其他类别的同 ID 资产', async (change) => {
    open();
    const exportSingle = button('导出资产「人物甲」');
    let finishSave!: () => void;
    if (change === 'while-saving') {
      driver.store!.setState({ currentProjectId: null });
      vi.mocked(driver.store!.getState().saveCurrentProjectSilent).mockImplementation(() => new Promise<string>((resolve) => {
        finishSave = () => { driver.store!.setState({ currentProjectId: 'project-1' }); resolve('project-1'); };
      }));
      click(exportSingle);
      expect(driver.store!.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
    }
    const library = driver.store!.getState().dramaAssets;
    driver.store!.setState({ dramaAssets: { ...library, characters: [], scenes: [{ ...library.scenes[0], id: 'hero' }] } });
    if (change === 'before-click') click(exportSingle);
    else finishSave();
    await settleDrama();
    expect(driver.exportDrama).not.toHaveBeenCalled();
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('资产已删除，请重新选择', 'error');
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
    expect(all(panel.tree, (element) => element.props['aria-label'] === '导出资产「人物甲」')).toEqual([]);
  });

  it.each(['project', 'owner'] as const)('%s 改变后撤销单卡导出范围，迟到结果不显示成功', async (change) => {
    open();
    let finishExport!: () => void;
    driver.exportDrama.mockImplementation(() => new Promise((resolve) => { finishExport = () => resolve({ assetCount: 1, mediaCount: 0 }); }));
    click(button('导出资产「人物甲」')); renderDrama();
    const options = driver.exportDrama.mock.calls[0][1] as DramaAssetWriteOptions;
    expect(options.signal?.aborted).toBe(false);
    if (change === 'project') driver.store!.setState({ currentProjectId: 'project-2' });
    else driver.store!.setState({ projects: driver.store!.getState().projects.map((project) => ({ ...project, parentId: 'series-2' })) });
    expect(options.signal?.aborted).toBe(true);
    expect(() => options.assertCurrent?.()).toThrow('资产操作已取消');
    finishExport(); await settleDrama();
    expect(driver.exportDrama).toHaveBeenCalledOnce();
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
  });

  it.each([
    ['en-US', 'Export asset “人物甲”', 'Export this asset and its bound media'],
    ['ja-JP', 'アセット「人物甲」を書き出す', 'このアセットと紐付いたメディアを書き出す'],
    ['ko-KR', '에셋 "人物甲" 내보내기', '이 에셋과 연결된 미디어 내보내기'],
  ] as const)('%s 使用翻译后的单卡导出名称和媒体说明', (locale, label, title) => {
    open();
    setLocale(locale); renderDrama();
    expect(button(label).props.title).toBe(title);
    expect(all(panel.tree, (element) => element.props['aria-label'] === '导出资产「人物甲」')).toEqual([]);
    setLocale('zh-CN'); renderDrama();
    expect(button('导出资产「人物甲」').props.title).toBe('导出当前资产及其绑定媒体');
  });

  it('上传和传输共用忙碌保护，导入等待 Store 保存且保存阶段不可取消', async () => {
    open();
    const upload = find((element) => element.type === 'button' && String(element.props.className).includes('ui-btn--primary'));
    const exportButton = button('导出创作资产');
    let finishSave!: () => void;
    vi.mocked(driver.store!.getState().importDramaAssets).mockImplementation(() => new Promise<number>((resolve) => { finishSave = () => resolve(1); }));
    driver.importDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }, options: DramaAssetWriteOptions & { onProgress: (text: string) => void }) => {
      options.onProgress('正在保存资产');
      const assets = [{ ...driver.store!.getState().dramaAssets.characters[0], id: 'imported' }];
      await input.commit(assets);
      return { assetCount: 1, mediaCount: 2, assets: assets.map(({ kind, id }) => ({ kind, id })) };
    });
    click(button('导入创作资产')); renderDrama();
    click(exportButton); click(upload);
    expect(driver.exportDrama).not.toHaveBeenCalled(); expect(driver.uploadDrama).not.toHaveBeenCalled();
    expect(button('导入创作资产').props.disabled).toBe(true);
    expect(button('导出创作资产').props.disabled).toBe(true);
    expect(button('取消资产操作').props.disabled).toBe(true);
    expect(find((element) => String(element.props.className).includes('drama-assets-grid')).props.inert).toBe(true);
    click(button('取消资产操作'));
    expect(driver.importDrama.mock.calls[0][1].signal.aborted).toBe(false);
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
    finishSave(); await settleDrama();
    expect(driver.store!.getState().importDramaAssets).toHaveBeenCalledWith([expect.objectContaining({ id: 'imported' })], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导入 1 项创作资产，包含 2 份媒体', 'success');
    expect(button('导入创作资产').props.disabled).toBe(false);
  });

  it.each(['project', 'close', 'unmount'] as const)('%s 后中止导入，迟到提交不能写入其他项目或显示成功', async (change) => {
    open();
    let finishRead!: () => void;
    driver.importDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }) => {
      await new Promise<void>((resolve) => { finishRead = resolve; });
      await input.commit([]);
      return { assetCount: 1, mediaCount: 0 };
    });
    click(button('导入创作资产')); renderDrama();
    const options = driver.importDrama.mock.calls[0][1] as DramaAssetWriteOptions;
    if (change === 'project') driver.store!.setState({ currentProjectId: 'project-2' });
    else if (change === 'close') driver.store!.getState().setAssetsPanelOpen(false);
    else driver.effects.slice(1).forEach((effect) => effect?.cleanup?.());
    expect(options.signal?.aborted).toBe(true);
    finishRead(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.store!.getState().importDramaAssets).not.toHaveBeenCalled();
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
  });
}

export function registerGlobalAssetToolbarTests(panel: AssetDrawerFixture) {
  const { driver, all, visibleText, find, button, click, renderDramaCards, key } = panel;
  function renderGlobal(kind: DramaAsset['kind'] = 'character') {
    const compact = driver.store!.getState().assetsPanelMode === 'drawer';
    for (let pass = 0; pass < 5; pass++) {
      driver.stateIndex = 0; driver.refIndex = 0; driver.effectIndex = 1; driver.memoIndex = 0; driver.dirty = false;
      panel.tree = renderDramaCards(GlobalCreativeAssetsPanel({ kind, compact }));
      if (!driver.dirty) break;
    }
    const pending = driver.pending; driver.pending = [];
    pending.forEach((effect) => effect());
  }
  async function settleGlobal(kind: DramaAsset['kind'] = 'character') { await new Promise<void>((resolve) => setImmediate(resolve)); renderGlobal(kind); }
  function open(kind: DramaAsset['kind'] = 'character', mode: 'page' | 'drawer' = 'page') {
    const base = { key: 'global', summary: '', visualNotes: '', importance: 'main', confirmed: true,
      createdAt: 1, updatedAt: 1, source: 'manual' } as const;
    driver.store!.setState({ currentProjectId: null,
      globalCharacters: [{ ...base, id: 'character-1', name: '人物甲', kind: 'character', identity: '' },
        { ...base, id: 'character-2', name: '人物乙', kind: 'character', identity: '' }],
      globalScenes: [{ ...base, id: 'scene-1', name: '场景甲', kind: 'scene' }, { ...base, id: 'scene-2', name: '场景乙', kind: 'scene' }],
      globalProps: [{ ...base, id: 'prop-1', name: '道具甲', kind: 'prop' }, { ...base, id: 'prop-2', name: '道具乙', kind: 'prop' }],
      globalDramaAssetsLoading: false, globalDramaAssetsError: null,
      showToast: vi.fn(), saveCurrentProjectSilent: vi.fn(), importGlobalDramaAssets: vi.fn().mockResolvedValue(3),
      saveGlobalDramaAsset: vi.fn().mockResolvedValue(true), deleteGlobalDramaAsset: vi.fn().mockResolvedValue(true),
      bindGlobalDramaAssetImage: vi.fn().mockResolvedValue(true),
    });
    driver.store!.getState().setAssetsPanelOpen(true, mode, { tab: 'permanent' });
    renderGlobal(kind);
  }
  function mixedAssets(): DramaAsset[] {
    const state = driver.store!.getState();
    return [state.globalCharacters[0], state.globalScenes[0], state.globalProps[0]].map((asset) => ({ ...asset, id: `imported-${asset.kind}` }));
  }

  it('Tab 抽屉中的全局角色卡展示参考图，隐藏卡片与批量管理入口', () => {
    open('character', 'drawer');
    const [character] = driver.store!.getState().globalCharacters;
    driver.store!.setState({ globalCharacters: [{ ...character, referenceImages: [
      { id: 'front', kind: 'primary', imageUrl: 'https://example.test/front.png', prompt: '', createdAt: 1, updatedAt: 1 },
      { id: 'side', kind: 'turnaround', imageUrl: 'https://example.test/side.png', prompt: '', createdAt: 1, updatedAt: 1 },
    ] }] });
    renderGlobal();
    expect(all(button('角色参考图'), (element) => typeof element.props.src === 'string').map((element) => element.props.src)).toEqual([
      'https://example.test/front.png', 'https://example.test/side.png',
    ]);
    expect(visibleText(panel.tree)).not.toMatch(/上传图片|新增人物|导入|导出|多选|复制简介/);
    expect(button('搜索全局创作资产')).toBeDefined();
  });

  it.each([
    ['character', '人物'], ['scene', '场景'], ['prop', '道具'],
  ] as const)('没有当前项目也可导出全部全局%s，不受搜索或项目切换影响', async (kind, label) => {
    open(kind);
    const search = button('搜索全局创作资产');
    expect(search.props.className).toContain('ui-input--sm');
    const controls = find((element) => String(element.props.className).includes('ml-auto') && all(element, (child) => child === search).length === 1);
    expect(controls.props.className).toContain('min-w-0');
    expect(controls.props.className).toContain('flex-wrap');
    expect(all(controls, (element) => String(element.props.className).includes('ui-input-group'))[0].props.className).toContain('max-w-full');
    (search.props.onChange as (event: unknown) => void)({ target: { value: '甲' } }); renderGlobal(kind);
    expect(all(panel.tree, (element) => element.props['data-asset-kind'] === kind)).toHaveLength(1);
    let finishExport!: () => void;
    driver.exportGlobalDrama.mockImplementation(() => new Promise((resolve) => { finishExport = () => resolve({ assetCount: 2, mediaCount: 3 }); }));
    click(button(`导出全部全局${label}`)); renderGlobal(kind);
    const [input, options] = driver.exportGlobalDrama.mock.calls[0];
    expect(input).toMatchObject({ libraryName: `全局${label}`, assets: [expect.objectContaining({ kind, name: `${label}甲` }), expect.objectContaining({ kind, name: `${label}乙` })] });
    expect(input).not.toHaveProperty('assetName'); expect(input).not.toHaveProperty('projectId'); expect(input).not.toHaveProperty('ownerId');
    expect(driver.store!.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
    driver.store!.setState({ currentProjectId: 'project-2' });
    expect(options.signal.aborted).toBe(false);
    expect(() => options.assertCurrent()).not.toThrow();
    finishExport(); await settleGlobal(kind);
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导出 2 项全局创作资产，包含 3 份媒体', 'success');
  });

  it('单卡只导出同类别同 ID 的最新全局记录，并与顶部操作互斥', async () => {
    open('scene');
    const exportSingle = button('导出资产「场景甲」');
    const exportAll = button('导出全部全局场景');
    const state = driver.store!.getState();
    const latest = { ...state.globalScenes[0], name: '最新场景', summary: '修改后的简介' };
    driver.store!.setState({ globalScenes: [latest, state.globalScenes[1]],
      globalCharacters: [{ ...state.globalCharacters[0], id: latest.id }] });
    let finishExport!: () => void;
    driver.exportGlobalDrama.mockImplementation(() => new Promise((resolve) => { finishExport = () => resolve({ assetCount: 1, mediaCount: 0 }); }));
    click(exportSingle); renderGlobal('scene');
    expect(driver.exportGlobalDrama).toHaveBeenCalledOnce();
    expect(driver.exportGlobalDrama.mock.calls[0][0]).toEqual({
      libraryName: '全局场景', assetName: '最新场景', assets: [latest],
      allAssets: [{ ...state.globalCharacters[0], id: latest.id }, latest, state.globalScenes[1], ...state.globalProps],
    });
    expect(button('导出资产「最新场景」').props.disabled).toBe(true);
    expect(button('导入全局创作资产').props.disabled).toBe(true);
    click(exportAll); click(exportSingle);
    expect(driver.exportGlobalDrama).toHaveBeenCalledOnce();
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
    finishExport(); await settleGlobal('scene');
    driver.exportGlobalDrama.mockClear();
    const staleButton = button('导出资产「最新场景」');
    driver.store!.setState({ globalScenes: [] });
    click(staleButton); await settleGlobal('scene');
    expect(driver.exportGlobalDrama).not.toHaveBeenCalled();
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('资产已删除，请重新选择', 'error');
  });

  it('混合包按自身类别提交全局 Store，导入等待保存且保存阶段不可取消', async () => {
    open('prop');
    const incoming = mixedAssets();
    const exportAll = button('导出全部全局道具');
    let finishSave!: () => void;
    vi.mocked(driver.store!.getState().importGlobalDramaAssets).mockImplementation(() => new Promise<number>((resolve) => { finishSave = () => resolve(3); }));
    driver.importGlobalDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }, options: DramaAssetWriteOptions & { onProgress: (text: string) => void }) => {
      options.onProgress('正在保存资产');
      await input.commit(incoming);
      return { assetCount: 3, mediaCount: 4, assets: incoming.map(({ kind, id }) => ({ kind, id })) };
    });
    click(button('导入全局创作资产')); renderGlobal('prop');
    expect(driver.store!.getState().importGlobalDramaAssets).toHaveBeenCalledWith(incoming, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(incoming.map((asset) => asset.kind)).toEqual(['character', 'scene', 'prop']);
    expect(find((element) => String(element.props.className).includes('drama-assets-grid')).props.inert).toBe(true);
    expect(button('取消资产操作').props.disabled).toBe(true);
    click(button('取消资产操作')); click(exportAll);
    expect(driver.exportGlobalDrama).not.toHaveBeenCalled();
    const options = driver.importGlobalDrama.mock.calls[0][1] as DramaAssetWriteOptions;
    driver.store!.setState({ currentProjectId: 'project-2' });
    expect(options.signal?.aborted).toBe(false);
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
    finishSave(); await settleGlobal('prop');
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导入 3 项全局创作资产，包含 4 份媒体', 'success');
    expect(find((element) => String(element.props.className).includes('drama-assets-grid')).props.inert).toBeUndefined();
    expect(button('导入全局创作资产').props.disabled).toBe(false);
  });

  it.each(['close', 'kind', 'unmount'] as const)('%s 后中止全局导入，迟到读取不能提交', async (change) => {
    open();
    const incoming = mixedAssets();
    let finishRead!: () => void;
    driver.importGlobalDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }) => {
      await new Promise<void>((resolve) => { finishRead = resolve; });
      await input.commit(incoming);
      return { assetCount: 3, mediaCount: 0 };
    });
    click(button('导入全局创作资产')); renderGlobal();
    const options = driver.importGlobalDrama.mock.calls[0][1] as DramaAssetWriteOptions;
    if (change === 'close') driver.store!.getState().setAssetsPanelOpen(false);
    else if (change === 'kind') renderGlobal('scene');
    else driver.effects.slice(1).forEach((effect) => effect?.cleanup?.());
    expect(options.signal?.aborted).toBe(true);
    finishRead(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.store!.getState().importGlobalDramaAssets).not.toHaveBeenCalled();
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
  });

  it('保存已开始后关闭页面仍等待全局保存，不显示迟到成功提示', async () => {
    open();
    let finishSave!: () => void;
    vi.mocked(driver.store!.getState().importGlobalDramaAssets).mockImplementation(() => new Promise<number>((resolve) => { finishSave = () => resolve(1); }));
    const committed = vi.fn();
    driver.importGlobalDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }, options: DramaAssetWriteOptions & { onProgress: (text: string) => void }) => {
      options.onProgress('正在保存资产');
      await input.commit([mixedAssets()[0]]);
      committed(); return { assetCount: 1, mediaCount: 0 };
    });
    click(button('导入全局创作资产')); renderGlobal();
    expect(button('取消资产操作').props.disabled).toBe(true);
    driver.store!.getState().setAssetsPanelOpen(false);
    finishSave(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(committed).toHaveBeenCalledOnce();
    expect(driver.store!.getState().importGlobalDramaAssets).toHaveBeenCalledOnce();
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
  });
}
