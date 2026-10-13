import type { NodeType, PresetFolder, UserPreset } from '../types';

export const UNGROUPED_PRESET_FOLDER_ID = '__ungrouped__';

export function normalizePresetFolderName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error('请输入文件夹名称');
  if (normalized.length > 80) throw new Error('文件夹名称最多 80 个字符');
  if (normalized === '未分组') throw new Error('“未分组”是保留名称，请使用其他名称');
  return normalized;
}

export function resolvePresetFolderId(preset: Pick<UserPreset, 'nodeType' | 'folderId'>, folders: PresetFolder[]): string | undefined {
  return folders.some((folder) => folder.id === preset.folderId && folder.nodeType === preset.nodeType)
    ? preset.folderId : undefined;
}

/** 空文件夹保留入口；旧记录、跨类型或孤立引用统一回到未分组。 */
export function groupPresetsByFolder(nodeType: NodeType, presets: UserPreset[], folders: PresetFolder[]) {
  const matchingFolders = folders.filter((folder) => folder.nodeType === nodeType);
  const groups = [
    { id: UNGROUPED_PRESET_FOLDER_ID, name: '未分组', presets: [] as UserPreset[] },
    ...matchingFolders.map((folder) => ({ ...folder, presets: [] as UserPreset[] })),
  ];
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const preset of presets) {
    if (preset.nodeType !== nodeType) continue;
    const group = byId.get(preset.folderId ?? '') ?? groups[0];
    group.presets.push(preset);
  }
  return groups;
}
