/** 菜单导入正文、取消与异步回写边界的回归用例。 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';

const driver = vi.hoisted(() => ({ state: {} as AppState, upload: vi.fn(), read: vi.fn(), dimensions: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => driver.state },
  generateId: () => 'imported', computeImageNodeDimensions: driver.dimensions }));
vi.mock('../../src/services/fileService', () => ({ uploadSourceFileToProject: driver.upload, readBinaryFile: driver.read }));
import { importSourceFileToCanvas } from '../../src/services/sourceFileImportService';
import { cancelProjectCanvasDerivations } from '../../src/services/canvasDerivationGuard';

beforeEach(() => {
  vi.resetAllMocks();
  driver.state = { currentProjectId: 'project', nodes: [], getCurrentRevision: () => 1, addNode: vi.fn() } as unknown as AppState;
  driver.dimensions.mockResolvedValue({ nodeWidth: 200, nodeHeight: 300 });
});

it.each(['desktop', 'browser'])('%s 文本使用 UTF-8 正文，不把资产地址写成正文', async (platform) => {
  const content = '中文正文\n第二行';
  driver.upload.mockResolvedValue({ fileName: 'note.txt', dataUrl: platform === 'desktop' ? 'asset://note'
    : `data:text/plain;base64,${Buffer.from(content).toString('base64')}`,
  ...(platform === 'desktop' ? { filePath: '/project/note.txt' } : {}) });
  driver.read.mockResolvedValue(new TextEncoder().encode(content));
  await importSourceFileToCanvas({ x: 20, y: 30 });
  expect(driver.state.addNode).toHaveBeenCalledWith(expect.objectContaining({ type: 'ai-text', position: { x: 20, y: 30 },
    data: expect.objectContaining({ role: 'source', output: content, prompt: '' }) }));
});

it('取消选择时不创建节点', async () => {
  driver.upload.mockResolvedValue(null);
  await importSourceFileToCanvas({ x: 0, y: 0 });
  expect(driver.state.addNode).not.toHaveBeenCalled();
});

it.each(['project', 'revision', 'switch-back'])('选择返回前 %s 变化时丢弃结果', async (change) => {
  let finish!: (value: unknown) => void;
  driver.upload.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const task = importSourceFileToCanvas({ x: 0, y: 0 });
  if (change === 'project') driver.state.currentProjectId = 'other';
  else if (change === 'revision') driver.state.getCurrentRevision = () => 2;
  else cancelProjectCanvasDerivations('project');
  finish({ fileName: 'photo.png', dataUrl: 'asset://photo' });
  await task;
  expect(driver.state.addNode).not.toHaveBeenCalled();
  expect(driver.dimensions).not.toHaveBeenCalled();
});

it('图片测量期间切换项目不创建节点', async () => {
  driver.upload.mockResolvedValue({ fileName: 'photo.png', dataUrl: 'asset://photo' });
  let finish!: (value: unknown) => void;
  driver.dimensions.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const task = importSourceFileToCanvas({ x: 0, y: 0 });
  await vi.waitFor(() => expect(driver.dimensions).toHaveBeenCalledOnce());
  driver.state.currentProjectId = 'other';
  finish({ nodeWidth: 200, nodeHeight: 300 });
  await task;
  expect(driver.state.addNode).not.toHaveBeenCalled();
});
