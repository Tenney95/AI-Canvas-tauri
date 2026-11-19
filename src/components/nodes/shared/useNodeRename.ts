/**
 * useNodeRename — 统一的节点重命名 hook，消除 4 个节点组件中的重复代码
 */
import { useCallback } from 'react';
import type { BaseNodeData } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { buildNodeFileName, getAssetUrlFromPath, getNativeProjectOwner, renameProjectFileToLabel } from '../../../services/fileService';
import { isNativeProjectMediaContentPath } from '../../../services/nativeMediaContentPath';

export function useNodeRename(id: string, data: BaseNodeData, fallback: string) {
  const displayLabel = data.displayLabel || data.fileName || data.label || fallback;

  const handleRename = useCallback(
    (newName: string) => {
      const state = useAppStore.getState();
      const current = state.nodes.find((entry) => entry.id === id)?.data;
      if (!current) return;
      const { currentProjectId: projectId } = state;
      const { filePath } = current;
      if (current.type === 'ai-markdown') {
        // Markdown 的自动保存会排队；执行改名时读取最新文件关联，不能使用旧渲染的路径。
        if (!filePath) {
          state.updateNodeData(id, { label: newName, fileName: buildNodeFileName(newName.replace(/\.md$/i, ''), '.md', 'markdown'),
            ...(current.displayLabel ? { displayLabel: newName } : {}) });
          return;
        }
        if (!projectId) return;
        // 复用资源库改名 Action：扩展名、资产身份、历史引用和失败回滚沿用同一套规则。
        return state.renameAssetFile({ name: filePath.split(/[/\\]/).pop() || 'markdown.md', path: filePath,
          assetId: current.assetId, size: 0, category: 'text', source: 'project' }, newName, projectId)
          .then((result) => { if (result.warning) useAppStore.getState().showToast(result.warning, 'error'); })
          .catch((reason) => { useAppStore.getState().showToast(reason instanceof Error ? reason.message : 'Markdown 文件改名失败，原文件名已保留', 'error'); });
      }

      if (projectId && getNativeProjectOwner(projectId) && isNativeProjectMediaContentPath(current.relativePath)) {
        state.updateNodeData(id, { label: newName, displayLabel: newName });
        return;
      }
      const payload: Partial<BaseNodeData> = { label: newName };
      if (current.displayLabel) payload.displayLabel = newName;
      if (current.fileName) payload.fileName = newName;
      state.updateNodeData(id, payload);

      // 媒体节点：把项目目录内的底层文件一并重命名，并更新 filePath / 媒体 URL
      const hasMedia = !!(current.imageUrl || current.videoUrl || current.audioUrl);
      if (projectId && filePath && hasMedia) {
        void (async () => {
          const oldAssetUrl = await getAssetUrlFromPath(filePath);
          const latest = useAppStore.getState();
          if (latest.currentProjectId !== projectId || latest.nodes.find((node) => node.id === id)?.data.filePath !== filePath) return;
          const renamed = await renameProjectFileToLabel(filePath, newName, projectId);
          if (!renamed) return;

          const store = useAppStore.getState();
          const cur = store.nodes.find((n) => n.id === id)?.data;
          if (store.currentProjectId !== projectId || cur?.filePath !== filePath) return;
          const patch: Record<string, unknown> = { filePath: renamed.filePath };
          for (const key of ['imageUrl', 'videoUrl', 'audioUrl'] as const) {
            if (cur[key] && cur[key] === oldAssetUrl) patch[key] = renamed.assetUrl;
          }
          store.updateNodeDataTransient(id, patch as Partial<BaseNodeData>);
          // 文件已重命名（fileService 已派发磁盘变更事件），useAutoSave 会静默落盘
        })();
      }
    },
    [id],
  );

  return { displayLabel, handleRename };
}
