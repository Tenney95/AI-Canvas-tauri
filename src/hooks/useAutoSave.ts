/**
 * useAutoSave — 结构变化或磁盘内容变化时自动静默保存（无 Toast 提示）
 *
 * 1) 监听 nodes / edges / groups 的结构与节点内容变化（增删、内容更新、拖入分组等）；
 * 2) 监听 project-disk-changed 事件 —— 项目目录文件的增删改（生成、上传、
 *    重命名、删除等），即使节点结构指纹未变也会触发保存。
 * 均在 2 秒防抖后调用 saveCurrentProjectSilent。
 * 不响应选中、拖拽位置等非持久内容变化。
 *
 * 保存前基线（指纹 / data 引用）就已前移，所以保存失败必须自己退避重试，
 * 否则这批改动会被当成「已保存」，直到下一次编辑才有机会再写盘。
 */
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { PROJECT_DISK_CHANGED_EVENT } from '../services/fileService';

/** 计算结构指纹：节点 ID + 边 ID + 分组 ID/成员 */
function structureFingerprint(
  nodeIds: string[],
  edgeIds: string[],
  groupHash: string,
): string {
  return `${nodeIds.join(',')}|${edgeIds.join(',')}|${groupHash}`;
}

type NodeDataReference = { id: string; data: object };

/**
 * 节点数据通过 Store Action 不可变更新；比较 data 引用即可覆盖正文、参数和状态变化，
 * 同时避开拖拽、选中等只改变节点外层对象的高频更新。
 */
export function hasNodeDataReferenceChanges(
  nodes: NodeDataReference[],
  baseline: ReadonlyMap<string, object>,
): boolean {
  if (nodes.length !== baseline.size) return true;
  return nodes.some((node) => baseline.get(node.id) !== node.data);
}

export function captureNodeDataReferences(nodes: NodeDataReference[]): Map<string, object> {
  return new Map(nodes.map((node) => [node.id, node.data]));
}

/** 保存失败后的退避重试间隔：5s → 10s → 20s → 40s → 60s 封顶 */
const SAVE_RETRY_BASE_MS = 5_000;
const SAVE_RETRY_MAX_MS = 60_000;

export function useAutoSave() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fingerprintRef = useRef<string>('');
  const dataRefsRef = useRef<ReadonlyMap<string, object>>(new Map());
  const projectIdRef = useRef<string | null>(null);
  // 磁盘内容变更（增删改文件）触发的强制保存标记 —— 结构指纹不变也要保存
  const forceSaveRef = useRef(false);
  // 缓存上一次 nodes/edges/groups 引用，无关 state 变更（toast/config/拖拽以外）直接短路
  const prevRefs = useRef<{ nodes: unknown; edges: unknown; groups: unknown }>({
    nodes: null,
    edges: null,
    groups: null,
  });

  useEffect(() => {
    function saveAndRetryOnFailure() {
      void useAppStore.getState().saveCurrentProjectSilent().then((savedId) => {
        if (savedId !== undefined) return;
        const failure = useAppStore.getState().autoSaveFailure;
        if (!failure) return; // 没有当前项目/没有可保存记录，不是失败
        // 基线已前移，不重试这批改动就永远写不进去
        forceSaveRef.current = true;
        const delay = Math.min(
          SAVE_RETRY_MAX_MS,
          SAVE_RETRY_BASE_MS * 2 ** Math.min(failure.count - 1, 4),
        );
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(checkAndSave, delay);
      });
    }

    // 真正的结构指纹计算 + 保存判断，仅在防抖稳定后执行一次，
    // 拖拽期间每帧只做一次极廉价的引用比较（见下方 subscribe 回调），
    // 不再每帧 map/sort/join 分配数组（消除 GC 抖动）。
    function checkAndSave() {
      const state = useAppStore.getState();
      if (!state.currentProjectId) return;

      // 分组成员或分组名变化后，把节点文件搬进对应文件夹；有搬动会再触发一轮保存
      void state.syncGroupFiles();

      if (state.currentProjectId !== projectIdRef.current) {
        projectIdRef.current = state.currentProjectId;
        fingerprintRef.current = structureFingerprint(
          state.nodes.map((node) => node.id).sort(),
          state.edges.map((edge) => edge.id).sort(),
          state.groups
            .map((group) => `${group.id}:${[...group.nodeIds].sort().join('+')}`)
            .sort()
            .join(','),
        );
        dataRefsRef.current = captureNodeDataReferences(state.nodes);
        forceSaveRef.current = false;
        return;
      }

      const nodeIds = state.nodes.map((n) => n.id).sort();
      const edgeIds = state.edges.map((e) => e.id).sort();
      const groupHash = state.groups
        .map((g) => `${g.id}:${[...g.nodeIds].sort().join('+')}`)
        .sort()
        .join(',');

      const structFp = structureFingerprint(nodeIds, edgeIds, groupHash);
      const structChanged = structFp !== fingerprintRef.current;
      const dataChanged = hasNodeDataReferenceChanges(state.nodes, dataRefsRef.current);

      // 磁盘内容发生增删改：即使结构指纹未变也要保存
      if (forceSaveRef.current) {
        forceSaveRef.current = false;
        fingerprintRef.current = structFp;
        dataRefsRef.current = captureNodeDataReferences(state.nodes);
        saveAndRetryOnFailure();
        return;
      }

      // 结构和数据都没变 → 无需保存
      if (!structChanged && !dataChanged) return;

      fingerprintRef.current = structFp;
      dataRefsRef.current = captureNodeDataReferences(state.nodes);
      saveAndRetryOnFailure();
    }

    // 挂载时立即建立当前项目基线，避免第一次用户操作被误认为初始化加载。
    const initialState = useAppStore.getState();
    projectIdRef.current = initialState.currentProjectId;
    fingerprintRef.current = structureFingerprint(
      initialState.nodes.map((node) => node.id).sort(),
      initialState.edges.map((edge) => edge.id).sort(),
      initialState.groups
        .map((group) => `${group.id}:${[...group.nodeIds].sort().join('+')}`)
        .sort()
        .join(','),
    );
    dataRefsRef.current = captureNodeDataReferences(initialState.nodes);

    // 磁盘增删改事件：标记强制保存并重置防抖计时器
    const onDiskChanged = () => {
      if (!useAppStore.getState().currentProjectId) return;
      forceSaveRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(checkAndSave, 2000);
    };
    window.addEventListener(PROJECT_DISK_CHANGED_EVENT, onDiskChanged);

    const unsub = useAppStore.subscribe((state) => {
      if (!state.currentProjectId) return;

      if (state.currentProjectId !== projectIdRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current);
        projectIdRef.current = state.currentProjectId;
        const nodeIds = state.nodes.map((node) => node.id).sort();
        const edgeIds = state.edges.map((edge) => edge.id).sort();
        const groupHash = state.groups
          .map((group) => `${group.id}:${[...group.nodeIds].sort().join('+')}`)
          .sort()
          .join(',');
        fingerprintRef.current = structureFingerprint(nodeIds, edgeIds, groupHash);
        dataRefsRef.current = captureNodeDataReferences(state.nodes);
        prevRefs.current = { nodes: state.nodes, edges: state.edges, groups: state.groups };
        forceSaveRef.current = false;
        return;
      }

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
      window.removeEventListener(PROJECT_DISK_CHANGED_EVENT, onDiskChanged);
      unsub();
    };
  }, []);
}
