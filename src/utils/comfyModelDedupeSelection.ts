import type { ComfyDuplicateModelGroup, ComfyModelDedupeGroupRequest, ComfyModelDedupeGroupSelection } from '../types/comfyModelDedupe';

export const MAX_COMFY_MODEL_DEDUPE_TARGETS = 256;

export function defaultComfyModelSelection(group: ComfyDuplicateModelGroup, keeperId?: string): ComfyModelDedupeGroupSelection {
  const keeper = group.files.find((file) => file.id === keeperId)
    ?? group.files.find((file) => file.alreadyShared)
    ?? group.files.find((file) => file.relativePath.startsWith('models/')) ?? group.files[0];
  return {
    keeperId: keeper?.id ?? '',
    targetIds: group.files.filter((file) => file.id !== keeper?.id && !file.alreadyShared).slice(0, MAX_COMFY_MODEL_DEDUPE_TARGETS).map((file) => file.id),
    linkType: 'hardlink',
  };
}

export function selectedComfyModelGroups(groups: ComfyDuplicateModelGroup[], selections: Record<string, ComfyModelDedupeGroupSelection>): ComfyModelDedupeGroupRequest[] {
  return groups.flatMap((group) => {
    const selection = selections[group.id] ?? defaultComfyModelSelection(group);
    if (!group.files.some((file) => file.id === selection.keeperId)) return [];
    const selected = new Set(selection.targetIds);
    const targetIds = group.files.filter((file) => selected.has(file.id) && file.id !== selection.keeperId && !file.alreadyShared).map((file) => file.id);
    return targetIds.length ? [{ groupId: group.id, ...selection, targetIds }] : [];
  });
}
