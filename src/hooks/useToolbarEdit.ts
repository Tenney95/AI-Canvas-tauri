/**
 * useToolbarEdit — Toolbar 编辑态状态管理
 *
 * 管理：
 * - 编辑态开关（长按触发）
 * - 正常模式：显示 Store 中的布局（或默认布局）
 * - 编辑模式：本地缓冲区修改，退出时保存到 Store
 * - 按钮增/删/移/Zone 操作
 */
import { useState, useCallback, useRef, useMemo } from 'react';
import type { ToolbarLayout, ToolbarButtonDef } from '../types';
import { useAppStore } from '../store/useAppStore';
import { getButtonRegistry, getDefaultLayout, migrateToolbarLayout } from '../components/nodes/shared/toolbar/toolbarRegistry';

const LONG_PRESS_MS = 600;

interface UseToolbarEditOptions {
  nodeType: string;
}

export interface UseToolbarEditReturn {
  isEditing: boolean;
  /** 当前有效布局：编辑态 = 本地缓冲，正常态 = Store */
  layout: ToolbarLayout;

  /** 退出编辑态并保存 */
  exitEdit: () => void;

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

  const registry = useMemo(() => getButtonRegistry(nodeType), [nodeType]);

  const [isEditing, setIsEditing] = useState(false);
  const [dirtyLayout, setDirtyLayout] = useState<ToolbarLayout | null>(null);
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

  const handlePressStart = useCallback(() => {
    pressHandled.current = false;
    pressTimer.current = setTimeout(() => {
      pressHandled.current = true;
      setIsEditing((v) => {
        if (!v) {
          // 进入编辑态：初始化本地缓冲
          setDirtyLayout(structuredClone(resolvedLayout));
        }
        return !v;
      });
    }, LONG_PRESS_MS);
  }, [resolvedLayout]);

  const handlePressEnd = useCallback(() => {
    clearPressTimer();
  }, [clearPressTimer]);

  const exitEdit = useCallback(() => {
    setIsEditing(false);
    if (dirtyLayout) {
      setToolbarLayout(nodeType, dirtyLayout);
    }
    setDirtyLayout(null);
  }, [dirtyLayout, nodeType, setToolbarLayout]);

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
  }, []);

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
  }, []);

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
    [],
  );

  // ── Zone 操作 ──
  const addZone = useCallback(() => {
    setDirtyLayout((prev) => {
      if (!prev) return prev;
      const id = `zone-${Date.now()}`;
      return { ...prev, zones: [...prev.zones, { id, name: '新分区', buttonKeys: [] }] };
    });
  }, []);

  const removeZone = useCallback((zoneId: string) => {
    setDirtyLayout((prev) => {
      if (!prev) return prev;
      const filtered = prev.zones.filter((z) => z.id !== zoneId || z.buttonKeys.length > 0);
      if (filtered.length === 0) {
        return { ...prev, zones: [{ id: 'zone-0', name: '常用', buttonKeys: [] }] };
      }
      return { ...prev, zones: filtered };
    });
  }, []);

  const renameZone = useCallback((zoneId: string, name: string) => {
    setDirtyLayout((prev) => {
      if (!prev) return prev;
      return { ...prev, zones: prev.zones.map((z) => (z.id === zoneId ? { ...z, name } : z)) };
    });
  }, []);

  const setToolbarLayoutLocal = useCallback((layout: ToolbarLayout) => {
    setDirtyLayout(structuredClone(layout));
  }, []);

  const resetLayout = useCallback(() => {
    const defaultLayout = getDefaultLayout(nodeType);
    setDirtyLayout(structuredClone(defaultLayout));
  }, [nodeType]);

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
