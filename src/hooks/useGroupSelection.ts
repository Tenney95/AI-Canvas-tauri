/**
 * useGroupSelection 多选+分组 Hook — 支持鼠标框选、Shift+点选多节点，Alt+G / Ctrl+G 创建/解散分组
 */
import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';

export function useGroupSelection() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isEditing =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.contentEditable === 'true';
      if (isEditing) return;

      // Alt+G: 分组/取消分组
      if (e.altKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        e.stopPropagation();
        toggleGroup();
        return;
      }

      // Ctrl+G: 分组/取消分组（与 Alt+G 行为一致）
      if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        e.stopPropagation();
        toggleGroup();
        return;
      }
    };

    /** Determines whether to group or ungroup based on current selection state */
    function toggleGroup() {
      const state = useAppStore.getState();
      const ids = state.selectedNodeIds;
      const allGroups = state.groups;

      if (ids.length < 2) {
        state.showToast('请至少框选 2 个节点', 'error');
        return;
      }

      // Check if all selected nodes belong to the same group
      const foundGroup = allGroups.find((g) => {
        const set = new Set(g.nodeIds);
        return ids.every((id) => set.has(id));
      });

      if (foundGroup) {
        // All selected nodes are in the same group → ungroup
        state.ungroupSelectedNodes();
      } else {
        // Nodes are not all grouped together → create group
        state.groupSelectedNodes();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
