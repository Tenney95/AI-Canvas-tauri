/**
 * useAutoSave — 文件层级变化时自动静默保存（无 Toast 提示）
 *
 * 监听 nodes / edges / groups 的结构变化（增删、拖入分组等），
 * 2 秒防抖后自动调用 saveCurrentProjectSilent。
 * 不响应选中、拖拽位置等非结构性变化。
 */
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';

/** 计算结构指纹：节点 ID + 边 ID + 分组 ID/成员 */
function structureFingerprint(
  nodeIds: string[],
  edgeIds: string[],
  groupHash: string,
): string {
  return `${nodeIds.join(',')}|${edgeIds.join(',')}|${groupHash}`;
}

export function useAutoSave() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fingerprintRef = useRef<string>('');
  // 跳过初始加载阶段
  const readyRef = useRef(false);

  useEffect(() => {
    const unsub = useAppStore.subscribe((state) => {
      // 等 store 初始化完成后才开始监听
      if (!state.currentProjectId) return;

      const nodeIds = state.nodes.map((n) => n.id).sort();
      const edgeIds = state.edges.map((e) => e.id).sort();
      const groupHash = state.groups
        .map((g) => `${g.id}:${[...g.nodeIds].sort().join('+')}`)
        .sort()
        .join(',');

      const fp = structureFingerprint(nodeIds, edgeIds, groupHash);
      if (fp === fingerprintRef.current) return;

      // 首次计算出指纹后标记就绪
      if (!readyRef.current) {
        readyRef.current = true;
        fingerprintRef.current = fp;
        return;
      }

      fingerprintRef.current = fp;

      // 防抖 2 秒
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        useAppStore.getState().saveCurrentProjectSilent();
      }, 2000);
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      unsub();
    };
  }, []);
}
