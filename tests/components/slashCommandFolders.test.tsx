import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresetFolder, UserPreset } from '../../src/types';

const driver = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }));

// 与已有组件用例一致，只检查事件和渲染结构，不模拟桌面布局。
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.index++;
    if (!(index in driver.states)) {
      driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    }
    return [driver.states[index], (value: T | ((old: T) => T)) => {
      driver.states[index] = typeof value === 'function' ? (value as (old: T) => T)(driver.states[index] as T) : value;
    }];
  },
  useRef: <T,>(initial: T) => ({ current: initial }),
  useMemo: <T,>(compute: () => T) => compute(),
  useCallback: <T,>(callback: T) => callback,
  useEffect: () => undefined,
}));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('../../src/services/presetSequenceService', () => ({
  isAdvancedPreset: (preset: UserPreset) => preset.mode === 'advanced',
}));

import SlashCommandMenu from '../../src/components/nodes/shared/SlashCommandMenu';
import { groupPresetsByFolder } from '../../src/utils/presetFolders';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
type Props = Parameters<typeof SlashCommandMenu>[0];
const folder: PresetFolder = { id: 'characters', nodeType: 'ai-image', name: '人物' };
const preset: UserPreset = {
  id: 'three-view', nodeType: 'ai-image', name: '三视图', description: '人物三视图的详细说明',
  promptTemplate: '完整三视图模板', triggerMode: 'direct', folderId: folder.id,
};

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'props' in value) return text((value as Element).props.children);
  return '';
}

function render(props: Props) {
  driver.index = 0;
  return SlashCommandMenu(props);
}

function openCommands(props: Props) {
  const parent = elements(render(props)).find((element) => element.props['data-item-id'] === '__user_presets__');
  expect(parent).toBeDefined();
  (parent!.props.onClick as (event: { currentTarget: HTMLElement }) => void)({ currentTarget: {} as HTMLElement });
  return render(props);
}

let props: Props;
beforeEach(() => {
  driver.states = [];
  vi.stubGlobal('document', { body: {} });
  props = {
    nodeType: 'ai-image', currentPrompt: '', anchorEl: null, userPresets: [preset], presetFolders: [folder],
    skillOptions: [], onSelect: vi.fn(), onRunAdvancedPreset: vi.fn(), onSelectSkill: vi.fn(),
    onUploadSkill: vi.fn(), onManageSkills: vi.fn(), onClose: vi.fn(), onManagePresets: vi.fn(),
  };
});
afterEach(() => vi.unstubAllGlobals());

describe('快捷指令文件夹菜单', () => {
  it('用户未创建文件夹时，快捷指令直接打开二级列表', () => {
    props.presetFolders = [];
    props.userPresets = [{ ...preset, folderId: undefined }];
    const root = render(props);
    expect(elements(root).filter((element) => element.props['data-item-id'] === '__user_presets__')).toHaveLength(1);
    expect(text(root)).not.toContain('未分组');
    const tree = openCommands(props);
    expect(text(tree)).not.toContain('未分组');
    const children = elements(tree).filter((element) => element.props.role === 'menuitem');
    expect(children).toHaveLength(1);
    expect(text(children[0])).toContain(preset.name);
    expect(elements(tree).some((element) => element.props['aria-haspopup'] === 'menu' && element.props.role === 'menuitem')).toBe(false);
  });

  it('一级是快捷指令入口，二级显示指令和用户创建的分类，说明留在悬浮提示', () => {
    const root = render(props);
    const entry = elements(root).find((element) => element.props['data-item-id'] === '__user_presets__');
    expect(text(entry)).toBe('快捷指令1›');
    expect(elements(root).some((element) => element.props.role === 'menuitem')).toBe(false);
    const tree = openCommands(props);
    const child = elements(tree).find((element) => element.props.role === 'menuitem');
    expect(text(child)).toBe('三视图直接触发');
    expect(child?.props.title).toBe(preset.description);
    expect(text(tree)).not.toContain(preset.description);
    expect(elements(tree).find((element) => element.props.role === 'menu')?.props['aria-label']).toBe('快捷指令');
  });

  it('旧记录与失效关联直接显示，不增加未分组菜单，也不展示其他类型', () => {
    const videoFolder: PresetFolder = { id: 'video', nodeType: 'ai-video', name: '视频' };
    props.presetFolders = [folder, videoFolder];
    props.userPresets = [
      { ...preset, folderId: undefined }, { ...preset, id: 'orphan', folderId: 'missing' },
      { ...preset, id: 'wrong-type', folderId: videoFolder.id },
      { ...preset, id: 'video-command', nodeType: 'ai-video', folderId: videoFolder.id },
    ];
    const groups = groupPresetsByFolder(props.nodeType, props.userPresets, props.presetFolders);
    expect(groups[0].presets.map((item) => item.id)).toEqual([preset.id, 'orphan', 'wrong-type']);
    const tree = openCommands(props);
    expect(elements(tree).filter((element) => element.props.role === 'menuitem')).toHaveLength(3);
    expect(text(tree)).not.toContain('未分组');
    expect(elements(tree).some((element) => element.props.role === 'group' && element.props['aria-label'] === videoFolder.name)).toBe(false);
  });

  it('空文件夹保留二级分区，改名保留快捷指令菜单展开状态', () => {
    props.userPresets = [];
    const tree = openCommands(props);
    expect(text(tree)).toContain('暂无快捷指令');
    expect(text(elements(tree).find((element) => element.props.role === 'menu'))).toContain(folder.name);
    expect(text(tree)).not.toContain('未分组');
    props.presetFolders = [{ ...folder, name: '角色参考' }];
    const updated = render(props);
    expect(elements(updated).find((element) => element.props.role === 'menu')?.props['aria-label']).toBe('快捷指令');
    const menu = elements(updated).find((element) => element.props.role === 'menu');
    expect(text(menu)).toContain('角色参考');
    expect(text(menu)).not.toContain(folder.name);
  });

  it('直接触发传回原指令与模板，保留模型覆盖并关闭菜单', () => {
    const bound = { ...preset, model: 'image-model', provider: 'custom', imageSize: '2K' };
    props.userPresets = [bound];
    const child = elements(openCommands(props)).find((element) => element.props.role === 'menuitem');
    (child!.props.onClick as () => void)();
    expect(props.onSelect).toHaveBeenCalledWith(bound.promptTemplate, true, bound);
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onRunAdvancedPreset).not.toHaveBeenCalled();
  });

  it('加入提示词沿用追加方式，高级指令交给顺序执行入口', () => {
    props.currentPrompt = '用户输入';
    const insert: UserPreset = { ...preset, triggerMode: 'insertPrompt' };
    props.userPresets = [insert];
    let child = elements(openCommands(props)).find((element) => element.props.role === 'menuitem');
    (child!.props.onClick as () => void)();
    expect(props.onSelect).toHaveBeenCalledWith('用户输入\n用户输入\n\n完整三视图模板', false, insert);
    const advanced: UserPreset = { ...preset, mode: 'advanced', advanced: { parameters: [], steps: [
      { id: 'step', name: '步骤 1', nodeType: 'ai-image', promptTemplate: '步骤模板' },
    ] } };
    props.userPresets = [advanced];
    child = elements(openCommands(props)).find((element) => element.props.role === 'menuitem');
    expect(text(child)).toContain('顺序执行');
    (child!.props.onClick as () => void)();
    expect(props.onRunAdvancedPreset).toHaveBeenCalledWith(advanced);
    expect(props.onSelect).toHaveBeenCalledTimes(1);
  });

  it('方向键可打开和返回快捷指令菜单', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0; });
    const parent = elements(render(props)).find((element) => element.props['data-item-id'] === '__user_presets__');
    const event = { key: 'ArrowRight', currentTarget: {} as HTMLElement, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (parent!.props.onKeyDown as (keyEvent: typeof event) => void)(event);
    const menu = elements(render(props)).find((element) => element.props.role === 'menu');
    expect(menu).toBeDefined();
    (menu!.props.onKeyDown as (keyEvent: typeof event) => void)({ ...event, key: 'ArrowLeft' });
    expect(elements(render(props)).some((element) => element.props.role === 'menu')).toBe(false);
  });

  it('没有当前类型的指令与文件夹时隐藏快捷指令入口', () => {
    props.presetFolders = [{ ...folder, nodeType: 'ai-video' }];
    props.userPresets = [{ ...preset, nodeType: 'ai-video' }];
    expect(elements(render(props)).some((element) => element.props['data-item-id'] === '__user_presets__')).toBe(false);
  });
});
