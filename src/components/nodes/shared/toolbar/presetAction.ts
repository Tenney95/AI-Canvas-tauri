/**
 * presetAction.ts — 快捷指令/预设按钮的查找与点击处理
 */
import type { NodeType, UserPreset } from '../../../../types';
import { getSlashCommands, fillTemplate } from '../slashCommands';

export interface ResolvedPreset {
  label: string;
  icon: string;
  filledPrompt: string;
  shouldTrigger: boolean;
  override?: {
    model?: string;
    provider?: string;
    imageSize?: string;
    aspectRatio?: string;
  };
}

/**
 * 根据 key 返回快捷指令/预设的显示信息（标签 + 图标），不做 prompt 填充
 */
export function resolvePresetDef(
  key: string,
  nodeType: NodeType,
  userPresets: UserPreset[],
): { label: string; icon: string } | null {
  const commands = getSlashCommands(nodeType);
  const walk = (items: typeof commands): { id: string; title: string; icon: string } | null => {
    for (const item of items) {
      if (item.id === key) return { id: item.id, title: item.title, icon: item.icon };
      if (item.children) {
        const found = walk(item.children);
        if (found) return found;
      }
    }
    return null;
  };
  const builtin = walk(commands);
  if (builtin) return { label: builtin.title, icon: builtin.icon };

  const preset = userPresets.find((p) => p.id === key && p.nodeType === nodeType);
  if (preset) return { label: preset.name, icon: preset.icon || 'mdi:star' };

  return null;
}

/**
 * 根据 key 查找内置快捷指令或用户预设，返回填充后的 prompt
 */
export function resolvePresetAction(
  key: string,
  nodeType: NodeType,
  currentPrompt: string,
  userPresets: UserPreset[],
): ResolvedPreset | null {
  const commands = getSlashCommands(nodeType);
  const allFlat: { id: string; title: string; icon: string; promptTemplate: string; imageSize?: string; aspectRatio?: string }[] = [];
  const walk = (items: typeof commands) => {
    for (const item of items) {
      if (item.promptTemplate) {
        allFlat.push(item);
      }
      if (item.children) walk(item.children);
    }
  };
  walk(commands);
  const builtin = allFlat.find((c) => c.id === key);
  if (builtin) {
    return {
      label: builtin.title,
      icon: builtin.icon,
      filledPrompt: fillTemplate(builtin.promptTemplate!, currentPrompt),
      shouldTrigger: true,
      override: builtin.imageSize || builtin.aspectRatio ? {
        imageSize: builtin.imageSize,
        aspectRatio: builtin.aspectRatio,
      } : undefined,
    };
  }

  const preset = userPresets.find((p) => p.id === key && p.nodeType === nodeType);
  if (preset) {
    const filled = fillTemplate(preset.promptTemplate, currentPrompt);
    return {
      label: preset.name,
      icon: preset.icon || 'mdi:star',
      filledPrompt: preset.triggerMode === 'direct' ? filled : (currentPrompt ? `${currentPrompt}\n${filled}` : filled),
      shouldTrigger: preset.triggerMode === 'direct',
      override: {
        model: preset.model,
        provider: preset.provider,
        imageSize: preset.imageSize,
        aspectRatio: preset.aspectRatio,
      },
    };
  }

  return null;
}
