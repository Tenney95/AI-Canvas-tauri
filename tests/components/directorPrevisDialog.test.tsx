import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BaseNodeData } from '../../src/types';

// Run effects and state transitions without a browser; WebGL is covered by the manual preview check.
const driver = vi.hoisted(() => ({
  index: 0, slots: [] as unknown[], pending: [] as (() => void)[],
  effects: [] as { dependencies: unknown[]; cleanup?: () => void }[],
  data: {} as BaseNodeData,
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useCallback: <T,>(callback: T) => callback,
  useRef: <T,>(initial: T) => {
    const index = driver.index++;
    driver.slots[index] ??= { current: initial };
    return driver.slots[index];
  },
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.index++;
    if (!(index in driver.slots)) driver.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.slots[index], (next: T) => { driver.slots[index] = next; }];
  },
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    const index = driver.index++;
    const old = driver.effects[index];
    if (old && old.dependencies.length === dependencies.length && dependencies.every((value, i) => Object.is(value, old.dependencies[i]))) return;
    old?.cleanup?.();
    const entry = { dependencies, cleanup: undefined as (() => void) | undefined };
    driver.effects[index] = entry;
    driver.pending.push(() => { entry.cleanup = effect() || undefined; });
  },
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({
    currentProjectId: 'project-a', projects: [], config: { theme: 'dark' }, nodes: [{ id: 'director-a', data: driver.data }],
  }), { getState: () => ({ nodes: [{ id: 'director-a', data: driver.data }] }) }),
}));
vi.mock('../../src/services/fileService', () => ({ isTauriEnv: () => true }));
vi.mock('../../src/services/directorPrevisService', () => ({
  loadDirectorPrevisScene: vi.fn(), generateDirectorPrevis: vi.fn(), saveDirectorPrevisScene: vi.fn(), saveDirectorPrevisOutput: vi.fn(),
  cancelDirectorPrevisGeneration: vi.fn(),
}));
import DirectorPrevisDialog from '../../src/components/director/DirectorPrevisDialog';
import { cancelDirectorPrevisGeneration, generateDirectorPrevis, loadDirectorPrevisScene, saveDirectorPrevisScene, saveDirectorPrevisOutput } from '../../src/services/directorPrevisService';
import { createDefaultPrevisScene } from '../../src/services/directorPrevisSchema';
import DirectorPrevisViewport from '../../src/components/director/DirectorPrevisViewport';
import MentionEditor, { type MentionEditorHandle } from '../../src/components/nodes/shared/MentionEditor';
import ConnectedNodesPreview from '../../src/components/nodes/shared/ConnectedNodesPreview';

const onClose = vi.fn();
function render() {
  driver.index = 0;
  const tree = DirectorPrevisDialog({ nodeId: 'director-a', initialAction: 'video', onClose });
  driver.pending.splice(0).forEach((effect) => effect());
  return tree;
}
function find(tree: ReactElement, matches: (element: ReactElement<Record<string, unknown>>) => boolean) {
  const pending: unknown[] = [tree];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === 'object' && 'props' in item) {
      const element = item as ReactElement<Record<string, unknown>>;
      if (matches(element)) return element.props;
      pending.push(element.props.children);
    }
  }
  throw new Error('Element not found');
}
const button = (tree: ReactElement, text: string) => find(tree, (element) => element.type === 'button' && element.props.children === text);
function ready(tree: ReactElement) {
  const props = find(tree, (element) => element.type === DirectorPrevisViewport);
  (props.onReady as (value: object) => void)({});
}
beforeEach(() => {
  driver.effects.forEach((effect) => effect?.cleanup?.());
  driver.index = 0; driver.slots = []; driver.effects = []; driver.pending = [];
  driver.data = { type: 'ai-director', label: '导演台', directorRuntimeKind: 'ai-threejs', directorInstanceId: 'instance-a',
    directorPrevisScene: { kind: 'project-file', relativePath: `director/previs/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), bytes: 100 } };
  vi.resetAllMocks();
});

describe('previs dialog saved-scene boundary', () => {
  it('reports video export failures without suggesting a text model configuration change', async () => {
    vi.mocked(loadDirectorPrevisScene).mockResolvedValue(createDefaultPrevisScene());
    vi.mocked(saveDirectorPrevisOutput).mockRejectedValue(new TypeError('Type error'));
    ready(render());
    await vi.waitFor(() => {
      expect(find(render(), (element) => element.type === 'p' && element.props.className === 'ui-error min-w-0 flex-1').children)
        .toBe('导出参考视频失败，请检查项目存储或视频编码支持后重试');
    });
    expect(saveDirectorPrevisOutput).toHaveBeenCalledOnce();
    expect(saveDirectorPrevisOutput).toHaveBeenCalledWith('director-a', 'video', expect.any(Function), expect.any(AbortSignal));
  });

  it('generates using the same mention editor and connected material chips as node prompts', async () => {
    driver.data = { ...driver.data, directorPrevisScene: undefined, prompt: '参考 @{image:空间图} 生成跟拍', model: 'general/vision', provider: 'general' };
    let tree = render();
    const props = find(tree, (element) => element.type === MentionEditor);
    expect(props.value).toBe(driver.data.prompt);
    expect(props.nodeId).toBe('director-a');
    expect(props.submitOnShiftEnter).toBe(true);
    const insert = vi.fn();
    (props.ref as { current: MentionEditorHandle }).current = { insertMentionAtCursor: insert };
    const connected = find(tree, (element) => element.type === ConnectedNodesPreview);
    (connected.onInsertMention as (value: string) => void)('@{sheet:整张分镜表}');
    expect(insert).toHaveBeenCalledWith('sheet', '整张分镜表');
    (props.onChange as (value: string) => void)('参考 @{image:空间图} @{sheet:整张分镜表} 生成跟拍');
    tree = render();
    vi.mocked(generateDirectorPrevis).mockResolvedValue(createDefaultPrevisScene());
    (find(tree, (element) => element.type === MentionEditor).onSubmit as () => void)();
    expect(generateDirectorPrevis).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'director-a', model: 'general/vision', provider: 'general',
      description: '参考 @{image:空间图} @{sheet:整张分镜表} 生成跟拍' }));
    await Promise.resolve(); await Promise.resolve();
  });

  it('disables modal edits during node generation and cancels the shared request', () => {
    driver.data = { ...driver.data, directorPrevisScene: undefined, status: 'loading', model: 'general/vision', provider: 'general' };
    const tree = render();
    expect(find(tree, (element) => element.type === MentionEditor).canSubmit).toBe(false);
    expect(button(tree, '保存镜头调整').disabled).toBe(true);
    expect(button(tree, '导出参考视频').disabled).toBe(true);
    (button(tree, '取消').onClick as () => void)();
    expect(cancelDirectorPrevisGeneration).toHaveBeenCalledWith('director-a');
  });
  it('does not export the example or auto-export after the saved scene fails verification', async () => {
    vi.mocked(loadDirectorPrevisScene).mockRejectedValue(new Error('hash mismatch'));
    ready(render());
    await vi.waitFor(() => {
      const tree = render();
      expect(find(tree, (element) => element.props.role === 'alert')).toBeDefined();
      expect(button(tree, '同步当前镜头').disabled).toBe(true);
      expect(button(tree, '导出参考视频').disabled).toBe(true);
      expect(button(tree, '保存镜头调整').disabled).toBe(false);
    });
    expect(saveDirectorPrevisOutput).not.toHaveBeenCalled();
  });

  it('releases the loading operation when undo removes its reference and ignores the late read', async () => {
    let resolve!: (scene: ReturnType<typeof createDefaultPrevisScene>) => void;
    vi.mocked(loadDirectorPrevisScene).mockReturnValue(new Promise((done) => { resolve = done; }));
    ready(render());
    driver.data = { ...driver.data, directorPrevisScene: undefined };
    render();
    await Promise.resolve();
    const tree = render();
    expect(button(tree, '保存镜头调整').disabled).toBe(false);
    vi.mocked(saveDirectorPrevisScene).mockRejectedValue(new Error('test save failure'));
    (button(tree, '保存镜头调整').onClick as () => void)();
    expect(saveDirectorPrevisScene).toHaveBeenCalledOnce();
    resolve(createDefaultPrevisScene());
    await Promise.resolve(); await Promise.resolve();
    expect(saveDirectorPrevisOutput).not.toHaveBeenCalled();
    expect(button(render(), '导出参考视频').disabled).toBe(true);
  });
});
