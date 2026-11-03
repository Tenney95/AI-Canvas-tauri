/** MarkdownNode 上传回归：读取正文、复用项目文件与阻止迟到结果覆盖。 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { AssetTextSnapshot } from '../../src/services/fileService';

const driver = vi.hoisted(() => ({
  upload: vi.fn(), read: vi.fn(), save: vi.fn(), binary: vi.fn(), missing: vi.fn(),
  state: {
    currentProjectId: 'p' as string | null, projectLoadStatus: 'ready', switchingProjectName: null as string | null,
    isCreatingProject: false, isReturningToStartPage: false,
    nodes: [] as Array<{ id: string; data: BaseNodeData }>,
    getCurrentRevision: vi.fn(() => 0), updateNodeData: vi.fn(), updateNodeDataTransient: vi.fn(),
    commitToHistory: vi.fn(), showToast: vi.fn(),
  },
}));
const values: unknown[] = [];
const effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }> = [];
const pending: Array<() => void> = [];
let stateIndex = 0;
let effectIndex = 0;
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  memo: <T,>(component: T) => component,
  useState: <T,>(initial: T | (() => T)) => {
    const index = stateIndex++;
    if (!(index in values)) values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [values[index], (next: T | ((old: T) => T)) => {
      values[index] = typeof next === 'function' ? (next as (old: T) => T)(values[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => values[stateIndex++] ??= { current: initial },
  useCallback: <T,>(callback: T) => callback,
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = effectIndex++;
    const old = effects[index];
    if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
    pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: effect() ?? undefined }; });
  },
}));
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign(
  (select: (state: typeof driver.state) => unknown) => select(driver.state),
  { getState: () => driver.state },
) }));
vi.mock('../../src/services/fileService', () => ({
  uploadSourceFileToProject: driver.upload, readAssetTextFile: driver.read, saveAssetTextFile: driver.save,
  saveBinaryToProjectData: driver.binary, isFileMissing: driver.missing,
}));
vi.mock('@xyflow/react', () => ({ Handle: 'node-handle', Position: { Left: 'left', Right: 'right' } }));
vi.mock('../../src/components/nodes/shared/NodeLabel', () => ({ default: 'node-label' }));
vi.mock('../../src/components/nodes/shared/GooeyBtn', () => ({ default: 'gooey-button' }));
vi.mock('../../src/components/nodes/shared/ResizeHandle', () => ({ default: 'resize-handle' }));
vi.mock('../../src/components/nodes/shared/useNodeRename', () => ({
  useNodeRename: (_id: string, data: BaseNodeData) => ({ displayLabel: data.label, handleRename: vi.fn() }),
}));
vi.mock('../../src/components/shared/FullscreenOverlay', () => ({ default: 'fullscreen-overlay' }));
vi.mock('../../src/components/shared/MarkdownEditor', () => ({ default: 'markdown-editor' }));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'animated-button' }));
vi.mock('../../src/hooks/useComfyDomImageSources', () => ({ useComfyDomImageSources: () => {} }));
vi.mock('../../src/utils/renderMarkdown', () => ({ renderMarkdown: (content: string) => content }));

import MarkdownNode from '../../src/components/nodes/MarkdownNode';
import { cancelProjectCanvasDerivations } from '../../src/services/canvasDerivationGuard';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
const oldPath = '/project/data/原文.md';
const copiedPath = '/project/data/上传文档.md';
const assetUrl = 'http://asset.localhost/project/data/copied.md';
const oldSnapshot: AssetTextSnapshot = { content: '磁盘旧正文', digest: 'old-digest', size: 15, modified: 10, bom: false, newline: 'LF' };
const body = '# 中文标题\n\n第一行正文\n第二行：保留完整内容。\n文末标记';
const uploadedSnapshot: AssetTextSnapshot = { content: body, digest: 'copied-digest', size: 80, modified: 20, bom: true, newline: 'CRLF' };
let tree: unknown;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function find(predicate: (element: Element) => boolean) {
  const element = elements(tree).find(predicate);
  expect(element).toBeDefined();
  return element!;
}
function currentData() { return driver.state.nodes[0].data; }
function render() {
  stateIndex = effectIndex = 0;
  tree = MarkdownNode({ id: 'md', data: currentData() });
  pending.splice(0).forEach((effect) => effect());
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function click(label: string) {
  (find((element) => element.props['data-tooltip'] === label).props.onClick as (event: unknown) => void)({ stopPropagation() {} });
  render();
}
function editor() { return find((element) => element.type === 'markdown-editor'); }
function editAndSave(content: string) {
  click('全屏显示');
  (editor().props.onChange as (value: string) => void)(content); render();
  (editor().props.onSave as () => void)();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
beforeEach(() => {
  values.length = effects.length = pending.length = 0;
  driver.state.currentProjectId = 'p'; driver.state.projectLoadStatus = 'ready'; driver.state.switchingProjectName = null;
  driver.state.isCreatingProject = driver.state.isReturningToStartPage = false;
  driver.state.nodes = [{ id: 'md', data: {
    type: 'ai-markdown', label: '原文', output: '节点原有草稿', fileName: '原文.md', filePath: oldPath,
    relativePath: 'data/原文.md', assetId: 'old-asset', assetSource: 'project',
  } }];
  const patch = (id: string, data: Partial<BaseNodeData>) => {
    driver.state.nodes = driver.state.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...data } } : node);
  };
  driver.state.updateNodeData.mockReset().mockImplementation(patch);
  driver.state.updateNodeDataTransient.mockReset().mockImplementation(patch);
  driver.state.getCurrentRevision.mockReset().mockReturnValue(0);
  driver.state.commitToHistory.mockReset(); driver.state.showToast.mockReset();
  driver.upload.mockReset().mockResolvedValue({ filePath: copiedPath, fileName: '上传文档.md', dataUrl: assetUrl });
  driver.read.mockReset().mockImplementation(async (path: string) => path === oldPath ? oldSnapshot : uploadedSnapshot);
  driver.save.mockReset().mockImplementation(async (_path: string, baseline: AssetTextSnapshot, content: string) => ({ ...baseline, content, digest: 'saved-digest' }));
  driver.binary.mockReset().mockResolvedValue({ filePath: copiedPath });
  driver.missing.mockReset().mockResolvedValue(false);
});
afterEach(() => {
  effects.forEach((effect) => effect.cleanup?.());
  cancelProjectCanvasDerivations('p'); cancelProjectCanvasDerivations('other');
});

it('从复制后的项目文件读取中文多行正文，复用原路径并以读取摘要继续保存', async () => {
  render(); await settle(); click('上传 .md 文件'); await settle();
  expect(driver.upload).toHaveBeenCalledExactlyOnceWith('.md', 'p');
  expect(driver.read).toHaveBeenCalledWith(copiedPath, expect.any(AbortSignal));
  expect(driver.state.updateNodeData).toHaveBeenCalledWith('md', expect.objectContaining({
    output: body, fileName: '上传文档.md', filePath: copiedPath, label: '上传文档.md',
    relativePath: undefined, assetId: undefined, assetSource: undefined,
  }));
  expect(currentData()).toMatchObject({ output: body, filePath: copiedPath, relativePath: undefined, assetId: undefined });
  expect(driver.binary).not.toHaveBeenCalled(); expect(driver.save).not.toHaveBeenCalled();
  const edited = `${body}\n追加一行`;
  editAndSave(edited); await settle();
  expect(driver.save).toHaveBeenCalledExactlyOnceWith(copiedPath, uploadedSnapshot, edited, expect.any(AbortSignal));
  expect(driver.binary).not.toHaveBeenCalled();
});

it('没有文件路径的合法 octet-stream data URL 按 UTF-8 解码并保存正文', async () => {
  const raw = '# 中文\r\n\r\n浏览器上传内容';
  const normalized = raw.replace(/\r\n/g, '\n');
  driver.upload.mockResolvedValue({ fileName: '浏览器.md', dataUrl: `data:application/octet-stream;base64,${Buffer.from(raw, 'utf8').toString('base64')}` });
  driver.read.mockImplementation(async (path: string) => path === oldPath ? oldSnapshot : { ...uploadedSnapshot, content: normalized });
  render(); await settle(); click('上传 .md 文件'); await settle();
  expect(currentData().output).toBe(normalized);
  expect(driver.binary).toHaveBeenCalledWith(expect.any(Uint8Array), 'p', '浏览器.md', { throwOnError: true });
  expect(new TextDecoder().decode(driver.binary.mock.calls[0][0])).toBe(normalized);
  expect(driver.save).not.toHaveBeenCalled();
});

it.each(['取消', '读取失败', '未知 HTTP 地址'])('%s时保留原正文和文件身份', async (scenario) => {
  if (scenario === '取消') driver.upload.mockResolvedValue(null);
  if (scenario === '读取失败') driver.read.mockImplementation(async (path: string) => {
    if (path === oldPath) return oldSnapshot;
    throw new Error('读取失败');
  });
  if (scenario === '未知 HTTP 地址') driver.upload.mockResolvedValue({ fileName: '远程.md', dataUrl: 'https://example.com/document.md' });
  render(); await settle(); const original = currentData();
  click('上传 .md 文件'); await settle();
  expect(currentData()).toBe(original);
  expect(driver.state.updateNodeData).not.toHaveBeenCalled();
  expect(driver.binary).not.toHaveBeenCalled(); expect(driver.save).not.toHaveBeenCalled();
  if (scenario === '取消') expect(driver.state.showToast).not.toHaveBeenCalled();
  else expect(driver.state.showToast).toHaveBeenCalledWith('文件读取失败', 'error');
});

it.each([
  ['upload', 'project'], ['upload', 'edit'], ['read', 'project'], ['read', 'edit'],
] as const)('%s 等待期间发生 %s 变化时丢弃迟到上传结果', async (stage, change) => {
  const upload = deferred<{ filePath: string; fileName: string; dataUrl: string }>();
  const read = deferred<AssetTextSnapshot>();
  const result = { filePath: copiedPath, fileName: '上传文档.md', dataUrl: assetUrl };
  if (stage === 'upload') driver.upload.mockReturnValue(upload.promise);
  else driver.read.mockImplementation((path: string) => path === oldPath ? Promise.resolve(oldSnapshot) : read.promise);
  render(); await settle(); click('上传 .md 文件'); await settle();
  if (change === 'project') driver.state.currentProjectId = 'other';
  else driver.state.updateNodeDataTransient('md', { output: '等待期间继续编辑的草稿' });
  const changed = currentData();
  if (stage === 'upload') upload.resolve(result);
  else read.resolve(uploadedSnapshot);
  await settle();
  expect(currentData()).toBe(changed);
  expect(driver.state.updateNodeData).not.toHaveBeenCalled();
  expect(driver.binary).not.toHaveBeenCalled(); expect(driver.save).not.toHaveBeenCalled();
});

it('等待旧文件保存结束后安装新摘要，后续编辑不复用迟到的旧文件基线', async () => {
  const oldSave = deferred<AssetTextSnapshot>();
  driver.save.mockReturnValueOnce(oldSave.promise);
  render(); await settle(); editAndSave('旧文件待保存正文'); await settle();
  expect(driver.save).toHaveBeenCalledWith(oldPath, oldSnapshot, '旧文件待保存正文', expect.any(AbortSignal));
  click('上传 .md 文件'); await settle();
  expect(driver.read).toHaveBeenCalledWith(copiedPath, expect.any(AbortSignal));
  expect(driver.state.updateNodeData).not.toHaveBeenCalled();
  oldSave.resolve({ ...oldSnapshot, content: '旧文件待保存正文', digest: 'late-old-digest' });
  await settle();
  expect(currentData()).toMatchObject({ output: body, filePath: copiedPath });
  editAndSave('新文件下一版正文'); await settle();
  expect(driver.save).toHaveBeenLastCalledWith(copiedPath, uploadedSnapshot, '新文件下一版正文', expect.any(AbortSignal));
  expect(driver.binary).not.toHaveBeenCalled();
});
