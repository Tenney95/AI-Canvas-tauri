/**
 * assetTextEditorRename — 回归测试：在 .%s 预览中改名并使用新路径继续保存正文。
 */
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), rename: vi.fn(), desktop: true,
  native: vi.fn(), oldProject: vi.fn(), history: vi.fn(), root: vi.fn(), relative: vi.fn(),
  state: { currentProjectId: 'p', nodes: [] as unknown[], projects: [] as unknown[] } }));
const values: unknown[] = [];
const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }> = [];
let stateIndex = 0;
let effectIndex = 0;
const pending: Array<() => void> = [];
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: <T,>(initial: T | (() => T)) => {
    const index = stateIndex++;
    if (!(index in values)) values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [values[index], (next: T | ((old: T) => T)) => {
      values[index] = typeof next === 'function' ? (next as (old: T) => T)(values[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = stateIndex++;
    return values[index] ??= { current: initial };
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = effectIndex++;
    const old = effects[index];
    if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
    pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: effect() ?? undefined }; });
  },
}));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: () => driver.desktop, readAssetTextFile: driver.read, saveAssetTextFile: driver.save,
  getProjectDataDir: driver.root, getRelativeAssetPath: driver.relative,
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign(
  (select: (state: unknown) => unknown) => select({ renameAssetFile: driver.rename }),
  { getState: () => driver.state },
) }));
vi.mock('../../src/services/indexedDbService', () => ({
  imageHistoryReferenceKey: (path: string) => path, getProjectById: driver.oldProject, getNodeHistoryEntries: driver.history,
}));
vi.mock('../../src/services/indexedDb/nativeProjectRepository', () => ({ readNativeProjectSelection: driver.native }));
vi.mock('../../src/components/shared/MarkdownEditor', () => ({ default: 'markdown-editor' }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'preview-modal' }));

import AssetTextPreview from '../../src/components/assets/AssetTextPreview';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
let props: ComponentProps<typeof AssetTextPreview>;
let tree: unknown;
const snapshot = { content: '原文', digest: 'digest', size: 6, bom: false, newline: 'LF', modified: 20 };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function find(predicate: (element: Element) => boolean) {
  const result = elements(tree).find(predicate);
  expect(result).toBeDefined();
  return result!;
}
function button(label: string) { return find((element) => element.props['aria-label'] === label); }
function click(element: Element) { (element.props.onClick as () => void)(); render(); }
function editor() { return find((element) => element.type === 'markdown-editor'); }
function render() {
  stateIndex = effectIndex = 0;
  tree = AssetTextPreview(props);
  pending.splice(0).forEach((effect) => effect());
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function changeName(value: string) {
  (button('新文件名').props.onChange as (event: unknown) => void)({ target: { value } }); render();
}
function submit() { (find((element) => element.type === 'form').props.onSubmit as (event: unknown) => void)({ preventDefault() {} }); }
beforeEach(() => {
  values.length = effects.length = pending.length = 0;
  driver.desktop = true;
  driver.read.mockReset().mockResolvedValue(snapshot);
  driver.save.mockReset().mockImplementation(async (_path, _baseline, content) => ({ ...snapshot, content }));
  driver.rename.mockReset().mockImplementation(async (file, name) => ({ file: { ...file, name: `${name}.md`, path: `/library/${name}.md` } }));
  driver.state = { currentProjectId: 'p', nodes: [], projects: [] };
  driver.native.mockReset(); driver.oldProject.mockReset(); driver.history.mockReset().mockResolvedValue([]);
  driver.root.mockReset().mockResolvedValue('/native'); driver.relative.mockReset().mockReturnValue('a.txt');
  props = { file: { name: '原文.md', path: '/library/原文.md', category: 'text', size: 6, source: 'global', assetId: 'stable' },
    projectId: 'p', onClose: vi.fn(), onRenamed: vi.fn(), onSaved: vi.fn() };
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

it('非当前新画布按显式作品和画布身份读取相对素材提示词，不回退旧库', async () => {
  const nativeView = { projectId: 'p2-owner', episodeId: null, canvasId: 'c2-canvas' };
  driver.state.projects = [{ id: 'c2-canvas', exchangeEpoch: 2, nativeView }];
  driver.native.mockResolvedValue({ project: { id: 'p2-owner', epoch: 2, storageRootRef: 'root' },
    context: { episodeId: null, canvasId: 'c2-canvas' },
    canvas: { storageRootRef: 'root', nodes: [{ id: 'node', data: { relativePath: 'a.txt', prompt: '新画布提示词' } }] } });
  props.projectId = 'c2-canvas'; props.file = { ...props.file, path: '/native/a.txt', name: 'a.txt' };
  render(); await settle(); await settle();
  expect(driver.native).toHaveBeenCalledWith('p2-owner', 'c2-canvas', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(driver.oldProject).not.toHaveBeenCalled();
  expect(elements(tree).some((element) => element.props.children === '新画布提示词')).toBe(true);
});

it.each(['txt', 'md', 'json'])('在 .%s 预览中改名并使用新路径继续保存正文', async (extension) => {
  props.file = { ...props.file, name: `原文.${extension}`, path: `/library/原文.${extension}` };
  const original = props.file;
  driver.rename.mockImplementationOnce(async (file, name) => ({ file: { ...file, name: `${name}.${extension}`, path: `/library/${name}.${extension}` } }));
  render(); await settle();
  expect(button('修改文件名').props.disabled).toBe(false);
  click(button('修改文件名'));
  expect(button('新文件名').props.value).toBe('原文');
  expect(editor().props.readOnly).toBe(true);
  changeName('剧本'); submit(); await settle(); await settle();
  expect(driver.rename).toHaveBeenCalledExactlyOnceWith(original, '剧本', 'p');
  expect(find((element) => element.type === 'h1').props.children).toBe(`剧本.${extension}`);
  expect(props.onRenamed).toHaveBeenCalledWith(original, expect.objectContaining({ path: `/library/剧本.${extension}`, assetId: 'stable' }));
  expect(original.path).toBe(`/library/原文.${extension}`);
  // 父列表刷新后仍使用新位置，不退回旧文件。
  props.file = (await driver.rename.mock.results[0].value).file;
  render();
  (editor().props.onChange as (value: string) => void)('新正文'); render();
  (editor().props.onSave as () => void)(); await settle();
  expect(driver.save).toHaveBeenCalledWith(`/library/剧本.${extension}`, snapshot, '新正文', expect.any(AbortSignal));
});

it('正文未保存时禁用改名，保留当前草稿', async () => {
  render(); await settle();
  (editor().props.onChange as (value: string) => void)('未保存内容'); render();
  expect(button('修改文件名').props.disabled).toBe(true);
  expect(editor().props.value).toBe('未保存内容');
  expect(driver.rename).not.toHaveBeenCalled();
});

it('改名期间禁止重复提交、关闭和正文写入', async () => {
  let finish!: (value: unknown) => void;
  driver.rename.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(); await settle(); click(button('修改文件名')); changeName('剧本');
  const oldEditor = editor();
  submit(); submit(); render();
  expect(driver.rename).toHaveBeenCalledOnce();
  expect(button('关闭文档预览').props.disabled).toBe(true);
  (find((element) => element.type === 'preview-modal').props.onClose as () => void)();
  (oldEditor.props.onChange as (value: string) => void)('不应写入'); render();
  expect(editor().props.value).toBe('原文');
  expect(props.onClose).not.toHaveBeenCalled();
  finish({ file: { ...props.file, name: '剧本.md', path: '/library/剧本.md' }, warning: '操作记录尚未完成清理' });
  await settle(); await settle();
  expect(find((element) => element.props.role === 'status' && element.props.children === '操作记录尚未完成清理')).toBeDefined();
});

it('改名失败保留输入和旧路径，可以取消改名继续编辑', async () => {
  driver.rename.mockRejectedValueOnce(new Error('已有同名文件'));
  render(); await settle(); click(button('修改文件名')); changeName('剧本'); submit(); await settle();
  expect(button('新文件名').props.value).toBe('剧本');
  expect(props.onRenamed).not.toHaveBeenCalled();
  expect(editor().props.label).toBe('原文.md');
  expect(find((element) => element.props.children === '已有同名文件')).toBeDefined();
  (find((element) => element.type === 'preview-modal').props.onClose as () => void)(); render();
  expect(button('修改文件名')).toBeDefined();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(editor().props.readOnly).toBe(false);
});

it('浏览器及离线文件不开放磁盘改名', async () => {
  driver.desktop = false;
  render(); await settle();
  expect(button('修改文件名').props.disabled).toBe(true);
  driver.desktop = true; props.file = { ...props.file, availability: 'offline' }; render();
  expect(button('修改文件名').props.disabled).toBe(true);
});
