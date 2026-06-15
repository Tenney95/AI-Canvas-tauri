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
  // 缓存上一次 nodes/edges/groups 引用，无关 state 变更（toast/config/拖拽以外）直接短路
  const prevRefs = useRef<{ nodes: unknown; edges: unknown; groups: unknown }>({
    nodes: null,
    edges: null,
    groups: null,
  });

  useEffect(() => {
    // 真正的结构指纹计算 + 保存判断，仅在防抖稳定后执行一次，
    // 拖拽期间每帧只做一次极廉价的引用比较（见下方 subscribe 回调），
    // 不再每帧 map/sort/join 分配数组（消除 GC 抖动）。
    const checkAndSave = () => {
      const state = useAppStore.getState();
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
      useAppStore.getState().saveCurrentProjectSilent();
    };

    const unsub = useAppStore.subscribe((state) => {
      if (!state.currentProjectId) return;

      // 极廉价的引用比较：nodes/edges/groups 引用都没变 → 直接忽略
      const p = prevRefs.current;
      if (
        state.nodes === p.nodes &&
        state.edges === p.edges &&
        state.groups === p.groups
      ) {
        return;
      }
      prevRefs.current = { nodes: state.nodes, edges: state.edges, groups: state.groups };

      // 仅重置防抖计时器（不做任何重活）；指纹计算延后到 2 秒静默后
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(checkAndSave, 2000);
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      unsub();
    };
  }, []);
}
