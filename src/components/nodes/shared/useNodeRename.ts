/**
 * useNodeRename — 统一的节点重命名 hook，消除 4 个节点组件中的重复代码
 */
import { useCallback } from 'react';
import type { BaseNodeData } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { buildNodeFileName, getAssetUrlFromPath, renameProjectFileToLabel } from '../../../services/fileService';

export function useNodeRename(id: string, data: BaseNodeData, fallback: string) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);

  const displayLabel = data.displayLabel || data.fileName || data.label || fallback;

  const handleRename = useCallback(
    (newName: string) => {
      if (data.type === 'ai-markdown') {
        // Markdown 的自动保存会排队；执行改名时读取最新文件关联，不能使用旧渲染的路径。
        const state = useAppStore.getState();
        const node = state.nodes.find((entry) => entry.id === id);
        if (node?.data.type !== 'ai-markdown') return;
        const filePath = node.data.filePath;
        if (!filePath) {
          state.updateNodeData(id, { label: newName, fileName: buildNodeFileName(newName.replace(/\.md$/i, ''), '.md', 'markdown'),
            ...(node.data.displayLabel ? { displayLabel: newName } : {}) });
          return;
        }
        if (!state.currentProjectId) return;
        // 复用资源库改名 Action：扩展名、资产身份、历史引用和失败回滚沿用同一套规则。
        return state.renameAssetFile({ name: filePath.split(/[/\\]/).pop() || 'markdown.md', path: filePath,
          assetId: node.data.assetId, size: 0, category: 'text', source: 'project' }, newName, state.currentProjectId)
          .then((result) => { if (result.warning) useAppStore.getState().showToast(result.warning, 'error'); })
          .catch((reason) => { useAppStore.getState().showToast(reason instanceof Error ? reason.message : 'Markdown 文件改名失败，原文件名已保留', 'error'); });
      }
      const payload: Partial<BaseNodeData> = { label: newName };
      if (data.displayLabel) payload.displayLabel = newName;
      if (data.fileName) (payload as Record<string, unknown>).fileName = newName;
      updateNodeData(id, payload);

      // 媒体节点：把项目目录内的底层文件一并重命名，并更新 filePath / 媒体 URL
      const filePath = data.filePath;
      const hasMedia = !!(data.imageUrl || data.videoUrl || data.audioUrl);
      if (filePath && hasMedia) {
        const projectId = useAppStore.getState().currentProjectId;
        if (!projectId) return;
        void (async () => {
          const oldAssetUrl = await getAssetUrlFromPath(filePath);
          const renamed = await renameProjectFileToLabel(filePath, newName, projectId);
          if (!renamed) return;

          const store = useAppStore.getState();
          const cur = store.nodes.find((n) => n.id === id)?.data as BaseNodeData | undefined;
          if (!cur) return;
          const patch: Record<string, unknown> = { filePath: renamed.filePath };
          for (const key of ['imageUrl', 'videoUrl', 'audioUrl'] as const) {
            if (cur[key] && cur[key] === oldAssetUrl) patch[key] = renamed.assetUrl;
          }
          store.updateNodeDataTransient(id, patch as Partial<BaseNodeData>);
          // 文件已重命名（fileService 已派发磁盘变更事件），useAutoSave 会静默落盘
        })();
      }
    },
    [id, updateNodeData, data.type, data.displayLabel, data.fileName, data.filePath, data.imageUrl, data.videoUrl, data.audioUrl],
  );

  return { displayLabel, handleRename };
}
