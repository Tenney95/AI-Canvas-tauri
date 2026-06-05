/**
 * useNodeRename — 统一的节点重命名 hook，消除 4 个节点组件中的重复代码
 */
import { useCallback } from 'react';
import type { BaseNodeData } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';

export function useNodeRename(id: string, data: BaseNodeData, fallback: string) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);

  const displayLabel = data.fileName || data.label || fallback;

  const handleRename = useCallback(
    (newName: string) => {
      const payload: Partial<BaseNodeData> = { label: newName };
      if (data.fileName) (payload as Record<string, unknown>).fileName = newName;
      updateNodeData(id, payload);
    },
    [id, updateNodeData, data.fileName],
  );

  return { displayLabel, handleRename };
}
