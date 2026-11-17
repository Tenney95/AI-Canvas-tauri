/**
 * useAutoSave — 结构变化或磁盘内容变化时自动静默保存（无 Toast 提示）
 *
 * 1) 监听 nodes / edges / groups 的结构与节点内容变化（增删、内容更新、拖入分组等）；
 * 2) 监听 project-disk-changed 事件 —— 项目目录文件的增删改（生成、上传、
 *    重命名、删除等），即使节点结构指纹未变也会触发保存。
 * 首次变更开启固定 2 秒合并窗口，到时保存最新状态，后续事件不会推迟保存。
 * 选中、拖拽位置等非持久内容变化本身不触发保存。
 *
 * 保存前基线（指纹 / data 引用）已前移，失败必须保留 dirty。
 * 持久错误立即暂停，其余连续自动失败最多三次；暂停后由手动保存成功解除。
 */
import { useEffect, useRef } from 'react';
import { useAppStore, type AppState } from '../store/useAppStore';
import { PROJECT_DISK_CHANGED_EVENT, type ProjectDiskChangedDetail } from '../services/fileService';
import { subscribeManualProjectSaveSuccess, waitForPendingProjectSaves } from '../store/store.projects';
import { t } from '../i18n';

interface AutoSaveAttempt {
  projectId: string;
  session: object;
  fingerprint: string;
  dataRefs: ReadonlyMap<string, object>;
  operation?: Promise<string | undefined>;
  settled?: { savedId?: string; rejected?: boolean };
}

interface AutoSaveOwner {
  flush: (projectId: string) => Promise<boolean>;
  onSaveSettled: (attempt: AutoSaveAttempt, savedId: string | undefined, rejected?: boolean) => void;
  onManualSaveSucceeded: (projectId: string) => void;
}
interface AutoSaveRuntime {
  owner?: AutoSaveOwner;
  flushing?: { owner: AutoSaveOwner; projectId: string; promise: Promise<boolean> };
}
const autoSaveRuntime: AutoSaveRuntime = import.meta.hot?.data.autoSaveRuntime ?? {};
if (import.meta.hot) import.meta.hot.data.autoSaveRuntime = autoSaveRuntime;

/** 只刷新现有改动并等待提交；没有主窗口保存宿主时不能承诺内容已保存。 */
export function flushPendingAutoSave(expectedProjectId: string): Promise<boolean> {
  const owner = autoSaveRuntime.owner;
  if (!owner) return Promise.resolve(false);
  const existing = autoSaveRuntime.flushing;
  if (existing?.owner === owner && existing.projectId === expectedProjectId) return existing.promise;
  const flushing = { owner, projectId: expectedProjectId,
    promise: Promise.resolve().then(() => owner.flush(expectedProjectId)).catch(() => false) };
  autoSaveRuntime.flushing = flushing;
  void flushing.promise.then(() => {
    if (autoSaveRuntime.flushing === flushing) autoSaveRuntime.flushing = undefined;
  });
  return flushing.promise;
}

/** 位置和选中不影响指纹；父分组和分组名称会改变文件归档位置。 */
function structureFingerprint(state: Pick<AppState, 'nodes' | 'edges' | 'groups'>): string {
  return JSON.stringify([
    state.nodes.map((node) => JSON.stringify([node.id, node.parentId])).sort(),
    state.edges.map((edge) => edge.id).sort(),
    state.groups.map((group) => JSON.stringify([group.id, group.name, [...group.nodeIds].sort()])).sort(),
  ]);
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

/** 非持久错误只在前两次失败后退避；第三次失败即暂停。 */
const SAVE_RETRY_BASE_MS = 5_000;
const MAX_AUTO_SAVE_FAILURES = 3;

function mustPauseAfterFailure(failure: AppState['autoSaveFailure']): boolean {
  return !!failure && (failure.kind === 'quota' || failure.kind === 'disk-full' || failure.kind === 'load-error'
    || failure.reason === '新项目素材目录不可用或归属未能确认，原有文件已保留');
}

export function useAutoSave() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fingerprintRef = useRef<string>('');
  const dataRefsRef = useRef<ReadonlyMap<string, object>>(new Map());
  const projectIdRef = useRef<string | null>(null);
  // 磁盘内容变更（增删改文件）触发的强制保存标记 —— 结构指纹不变也要保存
  const forceSaveRef = useRef(false);
  const baselineInitializedRef = useRef(false);
  const retryAtRef = useRef<number | null>(null);
  const pausedProjectRef = useRef<string | null>(null);
  const failureCountRef = useRef(0);
  const sessionRef = useRef<object>({});
  const attemptRef = useRef<AutoSaveAttempt | null>(null);
  const diskVersionRef = useRef(0);
  // 缓存上一次 nodes/edges/groups 引用，无关 state 变更（toast/config/拖拽以外）直接短路
  const prevRefs = useRef<{ nodes: unknown; edges: unknown; groups: unknown }>({
    nodes: null,
    edges: null,
    groups: null,
  });

  useEffect(() => {
    let active = true;
    const owner: AutoSaveOwner = {
      flush: flushCurrentProject,
      onManualSaveSucceeded: (projectId) => {
        if (!active || projectIdRef.current !== projectId || useAppStore.getState().currentProjectId !== projectId) return;
        // 手动提交已确认成功，撤销此前自动尝试的回调，迟到失败不能再次上锁。
        resetFailureSession();
        if (retryAtRef.current !== null && timerRef.current) clearTimeout(timerRef.current);
        if (retryAtRef.current !== null) timerRef.current = null;
        retryAtRef.current = null;
        // 手动保存开始后可能又有编辑，不把成功时的最新状态直接标为已保存。
        const state = useAppStore.getState();
        if (timerRef.current === null && (forceSaveRef.current || structureFingerprint(state) !== fingerprintRef.current
          || hasNodeDataReferenceChanges(state.nodes, dataRefsRef.current))) timerRef.current = setTimeout(checkAndSave, 2000);
      },
      onSaveSettled: (attempt, savedId, rejected = false) => {
        if (!active || attempt.session !== sessionRef.current || attemptRef.current !== attempt
          || useAppStore.getState().currentProjectId !== attempt.projectId) return;
        attemptRef.current = null;
        if (savedId === attempt.projectId) {
          failureCountRef.current = 0;
          const state = useAppStore.getState();
          if (structureFingerprint(state) !== attempt.fingerprint
            || hasNodeDataReferenceChanges(state.nodes, attempt.dataRefs)) forceSaveRef.current = true;
          if (!pausedProjectRef.current && timerRef.current === null && forceSaveRef.current) {
            timerRef.current = setTimeout(checkAndSave, 2000);
          }
          return;
        }
        const failure = useAppStore.getState().autoSaveFailure;
        if (!failure && !rejected) return; // 没有当前项目/没有可保存记录，不是失败
        forceSaveRef.current = true;
        failureCountRef.current += 1;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        retryAtRef.current = null;
        if (pausedProjectRef.current || mustPauseAfterFailure(failure) || failureCountRef.current >= MAX_AUTO_SAVE_FAILURES) {
          if (pausedProjectRef.current !== attempt.projectId) {
            pausedProjectRef.current = attempt.projectId;
            useAppStore.getState().showToast(t('自动保存已暂停，未保存内容已保留。请修复保存问题后按 Ctrl+S 重试'), 'error');
          }
          return;
        }
        const delay = SAVE_RETRY_BASE_MS * 2 ** (failureCountRef.current - 1);
        retryAtRef.current = Date.now() + delay;
        timerRef.current = setTimeout(checkAndSave, delay);
      },
    };

    function saveAndRetryOnFailure() {
      const state = useAppStore.getState();
      const projectId = state.currentProjectId;
      if (!projectId) return Promise.resolve(undefined);
      const attempt: AutoSaveAttempt = { projectId, session: sessionRef.current,
        fingerprint: structureFingerprint(state), dataRefs: captureNodeDataReferences(state.nodes) };
      attemptRef.current = attempt;
      const operation = state.saveCurrentProjectSilent();
      attempt.operation = operation;
      // 热更新后由当前宿主接收旧请求的完成通知，不能把失败重试留在旧闭包里。
      void operation.then(
        (savedId) => {
          attempt.settled = { savedId };
          autoSaveRuntime.owner?.onSaveSettled(attempt, savedId);
        },
        () => {
          attempt.settled = { rejected: true };
          autoSaveRuntime.owner?.onSaveSettled(attempt, undefined, true);
        },
      );
      return operation;
    }

    // 真正的结构指纹计算 + 保存判断，只在合并窗口到时执行一次，
    // 拖拽期间每帧只做一次极廉价的引用比较（见下方 subscribe 回调），
    // 不再每帧 map/sort/join 分配数组（消除 GC 抖动）。
    function checkAndSave() {
      timerRef.current = null;
      retryAtRef.current = null;
      const state = useAppStore.getState();
      if (!state.currentProjectId) return;

      if (state.currentProjectId !== projectIdRef.current) {
        projectIdRef.current = state.currentProjectId;
        fingerprintRef.current = structureFingerprint(state);
        dataRefsRef.current = captureNodeDataReferences(state.nodes);
        forceSaveRef.current = false;
        resetFailureSession();
        void state.syncGroupFiles();
        return;
      }

      if (pausedProjectRef.current === state.currentProjectId) return;

      const structFp = structureFingerprint(state);
      const structChanged = structFp !== fingerprintRef.current;
      const dataChanged = hasNodeDataReferenceChanges(state.nodes, dataRefsRef.current);

      // 同项目只保留一份在途自动保存；新编辑和磁盘事件合并为待保存内容。
      if (attemptRef.current) {
        if (forceSaveRef.current || structChanged || dataChanged) forceSaveRef.current = true;
        return attemptRef.current.operation;
      }

      // 磁盘内容发生增删改：即使结构指纹未变也要保存
      if (forceSaveRef.current) {
        forceSaveRef.current = false;
        fingerprintRef.current = structFp;
        dataRefsRef.current = captureNodeDataReferences(state.nodes);
        void state.syncGroupFiles();
        return saveAndRetryOnFailure();
      }

      // 结构和数据都没变 → 无需保存
      if (!structChanged && !dataChanged) return;

      fingerprintRef.current = structFp;
      dataRefsRef.current = captureNodeDataReferences(state.nodes);
      void state.syncGroupFiles();
      return saveAndRetryOnFailure();
    }

    async function flushCurrentProject(projectId: string): Promise<boolean> {
      const state = useAppStore.getState();
      if (!active || autoSaveRuntime.owner !== owner || state.currentProjectId !== projectId
        || projectIdRef.current !== projectId || state.projectLoadStatus !== 'ready'
        || retryAtRef.current !== null || pausedProjectRef.current === projectId) return false;
      const fingerprint = structureFingerprint(state);
      const dataRefs = captureNodeDataReferences(state.nodes);
      const diskVersion = diskVersionRef.current;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      const saving = checkAndSave();
      if (saving && await saving.catch(() => undefined) !== projectId) return false;
      const afterSave = useAppStore.getState();
      // 点击前已存在的新输入可以接在旧在途保存后提交；等待中新来的编辑仍交回合并窗口。
      if (active && autoSaveRuntime.owner === owner && afterSave.currentProjectId === projectId
        && pausedProjectRef.current !== projectId && retryAtRef.current === null && forceSaveRef.current
        && diskVersionRef.current === diskVersion && structureFingerprint(afterSave) === fingerprint
        && !hasNodeDataReferenceChanges(afterSave.nodes, dataRefs)) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        const latestSave = checkAndSave();
        if (latestSave && await latestSave.catch(() => undefined) !== projectId) return false;
      }
      if (!await waitForPendingProjectSaves(projectId)) return false;
      const latest = useAppStore.getState();
      // 等待中新来的改动留给原定时器，旧点击不能一边追存一边打开重预览。
      return active && autoSaveRuntime.owner === owner && latest.currentProjectId === projectId
        && latest.projectLoadStatus === 'ready' && !latest.autoSaveFailure && retryAtRef.current === null && pausedProjectRef.current !== projectId
        && !forceSaveRef.current && diskVersionRef.current === diskVersion
        && structureFingerprint(latest) === fingerprint && !hasNodeDataReferenceChanges(latest.nodes, dataRefs);
    }

    function resetFailureSession() {
      pausedProjectRef.current = null;
      failureCountRef.current = 0;
      sessionRef.current = {};
      attemptRef.current = null;
    }

    // 挂载时立即建立当前项目基线，避免第一次用户操作被误认为初始化加载。
    const initialState = useAppStore.getState();
    if (!baselineInitializedRef.current || projectIdRef.current !== initialState.currentProjectId) {
      projectIdRef.current = initialState.currentProjectId;
      fingerprintRef.current = structureFingerprint(initialState);
      dataRefsRef.current = captureNodeDataReferences(initialState.nodes);
      forceSaveRef.current = false;
      retryAtRef.current = null;
      resetFailureSession();
      baselineInitializedRef.current = true;
    }
    prevRefs.current = { nodes: initialState.nodes, edges: initialState.edges, groups: initialState.groups };
    autoSaveRuntime.owner = owner;
    const settledAttempt = attemptRef.current;
    if (settledAttempt?.settled) owner.onSaveSettled(settledAttempt, settledAttempt.settled.savedId, settledAttempt.settled.rejected);
    const unsubManualSave = subscribeManualProjectSaveSuccess(owner.onManualSaveSucceeded);

    // 磁盘增删改事件：标记强制保存，沿用已有的合并或退避计时器。
    const onDiskChanged = (event: Event) => {
      // 保存自身的媒体物化仍刷新目录展示，但不是新的待保存输入。
      // 普通磁盘事件（包括保存期间发生的事件）继续保留 dirty。
      if ((event as CustomEvent<ProjectDiskChangedDetail | undefined>).detail?.source === 'save-materialization') return;
      if (!useAppStore.getState().currentProjectId) return;
      diskVersionRef.current++;
      forceSaveRef.current = true;
      if (pausedProjectRef.current === projectIdRef.current) return;
      if (timerRef.current === null) timerRef.current = setTimeout(checkAndSave, 2000);
    };
    window.addEventListener(PROJECT_DISK_CHANGED_EVENT, onDiskChanged);

    const unsub = useAppStore.subscribe((state) => {
      if (!state.currentProjectId) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        projectIdRef.current = null;
        forceSaveRef.current = false;
        retryAtRef.current = null;
        resetFailureSession();
        return;
      }

      if (state.currentProjectId !== projectIdRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        projectIdRef.current = state.currentProjectId;
        fingerprintRef.current = structureFingerprint(state);
        dataRefsRef.current = captureNodeDataReferences(state.nodes);
        prevRefs.current = { nodes: state.nodes, edges: state.edges, groups: state.groups };
        forceSaveRef.current = false;
        retryAtRef.current = null;
        resetFailureSession();
        void state.syncGroupFiles();
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

      if (pausedProjectRef.current === state.currentProjectId) {
        // 暂停期间继续保留新编辑，后台进度、规范化和磁盘变化都不能自行解锁。
        if (structureFingerprint(state) !== fingerprintRef.current
          || hasNodeDataReferenceChanges(state.nodes, dataRefsRef.current)) forceSaveRef.current = true;
        return;
      }

      // 首次变化开启固定合并窗口；后续操作只更新状态，不推迟已排队的保存。
      if (timerRef.current === null) timerRef.current = setTimeout(checkAndSave, 2000);
    });
    // 初次打开也恢复未完成迁移；之后先确认有持久化改动，再走归档检查。
    if (initialState.currentProjectId && pausedProjectRef.current !== initialState.currentProjectId) void initialState.syncGroupFiles();
    // StrictMode 或热更新重放 effect 时沿用基线与退避期限，不把待保存内容当作已保存。
    if (initialState.currentProjectId && timerRef.current === null && pausedProjectRef.current !== initialState.currentProjectId) {
      if (retryAtRef.current !== null) timerRef.current = setTimeout(checkAndSave, Math.max(0, retryAtRef.current - Date.now()));
      else if (forceSaveRef.current || structureFingerprint(initialState) !== fingerprintRef.current
        || hasNodeDataReferenceChanges(initialState.nodes, dataRefsRef.current)) timerRef.current = setTimeout(checkAndSave, 2000);
    }

    return () => {
      active = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      if (autoSaveRuntime.owner === owner) autoSaveRuntime.owner = undefined;
      window.removeEventListener(PROJECT_DISK_CHANGED_EVENT, onDiskChanged);
      unsubManualSave();
      unsub();
    };
  }, []);
}
