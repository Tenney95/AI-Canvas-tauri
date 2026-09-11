/**
 * useToolbarEdit — Toolbar 编辑态状态管理
 *
 * 管理：
 * - 编辑态开关（长按触发）
 * - 正常模式：显示 Store 中的布局（或默认布局）
 * - 编辑模式：本地缓冲区修改，退出时保存到 Store
 * - 按钮增/删/移/Zone 操作
 */
import { useState, useCallback, useRef, useMemo, useEffect, type SetStateAction } from 'react';
import type { ToolbarLayout, ToolbarButtonDef } from '../types';
import { useAppStore } from '../store/useAppStore';
import { isSettingsClosing, registerSettingsProducer } from '../services/configPersistenceQueue';
import {
  getButtonRegistry,
  getDefaultLayout,
  getPluginToolbarButtonRegistry,
  migrateToolbarLayout,
} from '../components/nodes/shared/toolbar/toolbarRegistry';

const LONG_PRESS_MS = 600;

interface UseToolbarEditOptions {
  nodeType: string;
}

export interface UseToolbarEditReturn {
  isEditing: boolean;
  /** 当前有效布局：编辑态 = 本地缓冲，正常态 = Store */
  layout: ToolbarLayout;

  /** 退出编辑态并保存 */
  exitEdit: () => Promise<void>;

  /** 长按事件处理器 — 绑定到 Toolbar 容器上 */
  longPressHandlers: {
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseUp: (e: React.MouseEvent) => void;
    onMouseLeave: () => void;
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
  };

  // ── 按钮操作 ──
  removeButton: (zoneId: string, buttonKey: string) => void;
  addButton: (zoneId: string, buttonKey: string) => void;
  moveButtonAcross: (fromZoneId: string, fromIndex: number, toZoneId: string, toIndex: number) => void;

  // ── Zone 操作 ──
  addZone: () => void;
  removeZone: (zoneId: string) => void;
  renameZone: (zoneId: string, name: string) => void;

  /** 直接写入 layout（用于分区排序等整体操作） */
  setToolbarLayout: (layout: ToolbarLayout) => void;

  // ── 布局操作 ──
  resetLayout: () => void;

  // ── 查询 ──
  registry: ToolbarButtonDef[];
  activeButtonKeys: Set<string>;
  removedButtons: ToolbarButtonDef[];
}

export function useToolbarEdit({ nodeType }: UseToolbarEditOptions): UseToolbarEditReturn {
  const savedLayout = useAppStore((s) => s.toolbarLayouts[nodeType]);
  const setToolbarLayout = useAppStore((s) => s.setToolbarLayout);
  const installedPlugins = useAppStore((s) => s.installedPlugins);

  const registry = useMemo(() => [
    ...getButtonRegistry(nodeType),
    ...getPluginToolbarButtonRegistry(installedPlugins, nodeType),
  ], [installedPlugins, nodeType]);

  const [isEditing, setIsEditing] = useState(false);
  const [dirtyLayout, setDirtyLayoutState] = useState<ToolbarLayout | null>(null);
  const draft = useRef<ToolbarLayout | null>(null);
  const editBaseline = useRef<ToolbarLayout | null>(null);
  const saving = useRef(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const entering = useRef(false);
  const mounted = useRef(false);
  const setDirtyLayout = useCallback((update: SetStateAction<ToolbarLayout | null>) => {
    const next = typeof update === 'function' ? update(draft.current) : update;
    draft.current = next;
    setDirtyLayoutState(next);
  }, []);
  const resolvedLayout = useMemo(
    () => migrateToolbarLayout(nodeType, savedLayout ?? getDefaultLayout(nodeType)),
    [nodeType, savedLayout],
  );

  // 有效布局：编辑态用本地缓冲，正常态用 Store
  const layout = isEditing && dirtyLayout
    ? dirtyLayout
    : resolvedLayout;

  // ── 长按检测 ──
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressHandled = useRef(false);

  const clearPressTimer = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearPressTimer(); };
  }, [clearPressTimer]);

  const handlePressStart = useCallback(() => {
    clearPressTimer();
    if (isEditing || saving.current || entering.current) return;
    pressHandled.current = false;
    pressTimer.current = setTimeout(() => {
      pressHandled.current = true;
      void (async () => {
        entering.current = true;
        try {
          const store = useAppStore.getState();
          if (!store.toolbarLayoutsHydrated) await store.loadToolbarLayouts();
          if (!useAppStore.getState().toolbarLayoutsHydrated || !mounted.current) return;
          const latest = useAppStore.getState().toolbarLayouts[nodeType] ?? getDefaultLayout(nodeType);
          editBaseline.current = structuredClone(useAppStore.getState().toolbarLayouts[nodeType] ?? null);
          setDirtyLayout(structuredClone(migrateToolbarLayout(nodeType, latest)));
          setIsEditing(true);
        } finally {
          entering.current = false;
        }
      })();
    }, LONG_PRESS_MS);
  }, [clearPressTimer, isEditing, nodeType, setDirtyLayout]);

  const handlePressEnd = useCallback(() => {
    clearPressTimer();
  }, [clearPressTimer]);

  const exitEdit = useCallback(async () => {
    const snapshot = draft.current;
    if (!snapshot || saving.current) return;
    saving.current = true;
    try {
      pendingSave.current = setToolbarLayout(nodeType, snapshot, { baseline: editBaseline.current });
      if (!await pendingSave.current) {
        if (mounted.current && !isSettingsClosing() && useAppStore.getState().toolbarSaveErrors?.[nodeType] === 'conflict') {
          const { ask } = await import('@tauri-apps/plugin-dialog');
          const reload = await ask('其他窗口已修改此工具栏。重新加载会放弃本次布局编辑，是否继续？', {
            title: '工具栏设置冲突', kind: 'warning', okLabel: '重新加载', cancelLabel: '保留编辑',
          }).catch(() => false);
          if (reload && mounted.current && await useAppStore.getState().reloadToolbarLayout(nodeType) && mounted.current) {
            editBaseline.current = structuredClone(useAppStore.getState().toolbarLayouts[nodeType] ?? null);
            setDirtyLayout(structuredClone(migrateToolbarLayout(nodeType, editBaseline.current ?? getDefaultLayout(nodeType))));
          }
        }
        return;
      }
      editBaseline.current = snapshot;
      // 保存期间继续编辑的内容仍未保存，旧完成回调不能关闭新草稿。
      if (mounted.current && draft.current === snapshot) {
        setIsEditing(false);
        setDirtyLayout(null);
      }
    } finally {
      saving.current = false;
      pendingSave.current = null;
    }
  }, [nodeType, setToolbarLayout, setDirtyLayout]);

  useEffect(() => {
    if (!isEditing) return;
    return registerSettingsProducer(async () => {
      if (pendingSave.current && !await pendingSave.current) throw new Error('工具栏未保存');
      if (draft.current) await exitEdit();
      if (draft.current) throw new Error('工具栏仍有未保存的编辑');
    });
  }, [isEditing, exitEdit]);

  // ── 按钮操作（操作 dirtyLayout）──
  const removeButton = useCallback((zoneId: string, buttonKey: string) => {
    setDirtyLayout((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        zones: prev.zones.map((z) =>
          z.id === zoneId
            ? { ...z, buttonKeys: z.buttonKeys.filter((k) => k !== buttonKey) }
            : z,
        ),
      };
    });
  }, [setDirtyLayout]);

  const addButton = useCallback((zoneId: string, buttonKey: string) => {
    setDirtyLayout((prev) => {
      if (!prev) return prev;
      // 防止重复添加
      const already = prev.zones.some((z) => z.buttonKeys.includes(buttonKey));
      if (already) return prev;
      return {
        ...prev,
        zones: prev.zones.map((z) =>
          z.id === zoneId
            ? { ...z, buttonKeys: [...z.buttonKeys, buttonKey] }
            : z,
        ),
      };
    });
  }, [setDirtyLayout]);

  const moveButtonAcross = useCallback(
    (fromZoneId: string, fromIndex: number, toZoneId: string, toIndex: number) => {
      setDirtyLayout((prev) => {
        if (!prev) return prev;
        if (fromZoneId === toZoneId) {
          const zoneIdx = prev.zones.findIndex((z) => z.id === fromZoneId);
          if (zoneIdx === -1) return prev;
          const zone = prev.zones[zoneIdx];
          const keys = [...zone.buttonKeys];
          const [moved] = keys.splice(fromIndex, 1);
          keys.splice(toIndex, 0, moved);
          const newZones = [...prev.zones];
          newZones[zoneIdx] = { ...zone, buttonKeys: keys };
          return { ...prev, zones: newZones };
        }
        const fromZone = prev.zones.find((z) => z.id === fromZoneId);
        if (!fromZone) return prev;
        const movedKey = fromZone.buttonKeys[fromIndex];
        if (!movedKey) return prev;
        const newZones = prev.zones.map((z) => {
          if (z.id === fromZoneId) {
            const keys = [...z.buttonKeys];
            keys.splice(fromIndex, 1);
            return { ...z, buttonKeys: keys };
          }
          if (z.id === toZoneId) {
            const keys = [...z.buttonKeys];
            keys.splice(toIndex, 0, movedKey);
            return { ...z, buttonKeys: keys };
          }
          return z;
        });
        const filtered = newZones.filter((z) => z.buttonKeys.length > 0 || z.id === fromZoneId || z.id === toZoneId);
        return { ...prev, zones: filtered };
      });
    },
    [setDirtyLayout],
  );

  // ── Zone 操作 ──
  const addZone = useCallback(() => {
    setDirtyLayout((prev) => {
      if (!prev) return prev;
      const id = `zone-${Date.now()}`;
      return { ...prev, zones: [...prev.zones, { id, name: '新分区', buttonKeys: [] }] };
    });
  }, [setDirtyLayout]);

  const removeZone = useCallback((zoneId: string) => {
    setDirtyLayout((prev) => {
      if (!prev) return prev;
      const filtered = prev.zones.filter((z) => z.id !== zoneId || z.buttonKeys.length > 0);
      if (filtered.length === 0) {
        return { ...prev, zones: [{ id: 'zone-0', name: '常用', buttonKeys: [] }] };
      }
      return { ...prev, zones: filtered };
    });
  }, [setDirtyLayout]);

  const renameZone = useCallback((zoneId: string, name: string) => {
    setDirtyLayout((prev) => {
      if (!prev) return prev;
      return { ...prev, zones: prev.zones.map((z) => (z.id === zoneId ? { ...z, name } : z)) };
    });
  }, [setDirtyLayout]);

  const setToolbarLayoutLocal = useCallback((layout: ToolbarLayout) => {
    setDirtyLayout(structuredClone(layout));
  }, [setDirtyLayout]);

  const resetLayout = useCallback(() => {
    const defaultLayout = getDefaultLayout(nodeType);
    setDirtyLayout(structuredClone(defaultLayout));
  }, [nodeType, setDirtyLayout]);

  // ── 派生数据 ──
  const activeButtonKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const z of layout.zones) {
      for (const k of z.buttonKeys) keys.add(k);
    }
    return keys;
  }, [layout]);

  const removedButtons = useMemo(() => {
    return registry.filter((def) => !activeButtonKeys.has(def.key));
  }, [registry, activeButtonKeys]);

  const longPressHandlers = useMemo(
    () => ({
      onMouseDown: handlePressStart,
      onMouseUp: handlePressEnd,
      onMouseLeave: handlePressEnd,
      onTouchStart: handlePressStart as unknown as (e: React.TouchEvent) => void,
      onTouchEnd: handlePressEnd,
    }),
    [handlePressStart, handlePressEnd],
  );

  return {
    isEditing,
    layout,
    exitEdit,
    longPressHandlers,
    removeButton,
    addButton,
    moveButtonAcross,
    addZone,
    removeZone,
    renameZone,
    setToolbarLayout: setToolbarLayoutLocal,
    resetLayout,
    registry,
    activeButtonKeys,
    removedButtons,
  };
}
