import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { PresetFolder, UserPreset } from '../../src/types';

const storage = vi.hoisted(() => ({
  savePreset: vi.fn(), deletePreset: vi.fn(), loadPresets: vi.fn(),
  savePresetFolder: vi.fn(), deletePresetFolder: vi.fn(), loadPresetFolders: vi.fn(),
}));
vi.mock('../../src/services/fileService', () => storage);
import { createPresetSlice } from '../../src/store/store.presets';

const folder: PresetFolder = { id: 'characters', nodeType: 'ai-image', name: '人物' };
const preset: UserPreset = { id: 'three-view', nodeType: 'ai-image', name: '三视图', description: '人物参考', promptTemplate: '保持人物一致', triggerMode: 'direct', folderId: folder.id };

function createSlice() {
  let state = {} as AppState;
  const set = (patch: Partial<AppState> | ((current: AppState) => Partial<AppState>)) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  };
  const slice = createPresetSlice(set as never, () => state, {} as never);
  state = { ...state, ...slice, presetFolders: [folder], userPresets: [preset] };
  return { slice, get: () => state };
}

beforeEach(() => {
  vi.resetAllMocks();
  storage.loadPresets.mockResolvedValue([]);
  storage.loadPresetFolders.mockResolvedValue([]);
});

describe('快捷指令文件夹与保存队列', () => {
  it('保存失败保留原模板与分类，之后可以重试', async () => {
    const { slice, get } = createSlice();
    storage.savePreset.mockRejectedValueOnce(new Error('磁盘满'));
    await expect(slice.updateUserPreset(preset.id, { promptTemplate: '新模板', folderId: undefined })).rejects.toThrow('磁盘满');
    expect(get().userPresets).toEqual([preset]);
    await slice.updateUserPreset(preset.id, { promptTemplate: '新模板', folderId: undefined });
    expect(get().userPresets[0]).toMatchObject({ id: preset.id, promptTemplate: '新模板', folderId: undefined });
  });

  it('先保存再删除文件夹，最后内存和持久化引用都移回未分组', async () => {
    const { slice, get } = createSlice();
    let finish!: () => void;
    storage.savePreset.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const save = slice.updateUserPreset(preset.id, { promptTemplate: '最终正文' });
    const remove = slice.deletePresetFolder(folder.id);
    await Promise.resolve();
    expect(storage.deletePresetFolder).not.toHaveBeenCalled();
    finish(); await save; await remove;
    expect(get().presetFolders).toEqual([]);
    expect(get().userPresets[0]).toMatchObject({ id: preset.id, promptTemplate: '最终正文', folderId: undefined });
  });

  it('先删除再提交旧草稿时，不会恢复已删除的文件夹引用', async () => {
    const { slice, get } = createSlice();
    const remove = slice.deletePresetFolder(folder.id);
    const save = slice.updateUserPreset(preset.id, { folderId: folder.id, promptTemplate: '保留正文' });
    await remove; await save;
    expect(storage.savePreset).toHaveBeenLastCalledWith(expect.objectContaining({ folderId: undefined, promptTemplate: '保留正文' }));
    expect(get().userPresets[0].folderId).toBeUndefined();
  });

  it('文件夹删除和改名失败均不修改内存', async () => {
    const { slice, get } = createSlice();
    storage.deletePresetFolder.mockRejectedValueOnce(new Error('写入失败'));
    await expect(slice.deletePresetFolder(folder.id)).rejects.toThrow('写入失败');
    storage.savePresetFolder.mockRejectedValueOnce(new Error('写入失败'));
    await expect(slice.renamePresetFolder(folder.id, '角色')).rejects.toThrow('写入失败');
    expect(get().presetFolders).toEqual([folder]);
    expect(get().userPresets).toEqual([preset]);
  });

  it('旧记录、跨类型和失效分类在加载后回到未分组，空库清除旧内存', async () => {
    const { slice, get } = createSlice();
    storage.loadPresetFolders.mockResolvedValue([folder]);
    storage.loadPresets.mockResolvedValue([{ ...preset, folderId: undefined }, { ...preset, id: 'video', nodeType: 'ai-video' }, { ...preset, id: 'orphan', folderId: 'missing' }]);
    await slice.loadPresets();
    expect(get().userPresets.every((item) => item.folderId === undefined)).toBe(true);
    storage.loadPresets.mockResolvedValue([]); storage.loadPresetFolders.mockResolvedValue([]);
    await slice.loadPresets();
    expect(get().userPresets).toEqual([]); expect(get().presetFolders).toEqual([]);
  });

  it('读取失败保留现有分类和指令，不能把失败当成空库', async () => {
    const { slice, get } = createSlice();
    storage.loadPresets.mockRejectedValueOnce(new Error('读取失败'));
    await expect(slice.loadPresets()).rejects.toThrow('读取失败');
    expect(get().presetFolders).toEqual([folder]);
    expect(get().userPresets).toEqual([preset]);
    storage.loadPresetFolders.mockRejectedValueOnce(new Error('分类读取失败'));
    await expect(slice.loadPresets()).rejects.toThrow('分类读取失败');
    expect(get().presetFolders).toEqual([folder]);
    expect(get().userPresets).toEqual([preset]);
  });
});
