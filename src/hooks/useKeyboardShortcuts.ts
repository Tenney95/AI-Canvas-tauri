/**
 * useKeyboardShortcuts 全局键盘快捷键 Hook — 注册 Ctrl+S 保存、Ctrl+Z 撤销、Ctrl+Shift+Z 重做、Delete 删除、F 自适应等快捷键
 * Tauri 环境优先使用 tauri-plugin-global-shortcut 原生拦截，Web 环境退化为 document keydown 捕获
 */
import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { openAssetSearchWindow } from '../utils/assetSearchWindow';
import { hasActiveTextSelection, isEditableTarget } from '../utils/textSelection';
import { getCanvasPointerPosition } from '../services/canvasPointerService';
import type { Node as RFNode } from '@xyflow/react';
import type { BaseNodeData, NodeType } from '../types';
import { isWsagentSharedImagesNode } from '../types/wsagentShared';
import { invoke } from '@tauri-apps/api/core';
import { startNodeRename } from '../utils/nodeRename';
import { getPreferredNodeModel } from '../services/modelPreferenceService';
import { createUiNodeData } from '../services/uiNodeCreationData';

interface NodeShortcutDefinition {
  type: NodeType;
  label: string;
}

const GENERATOR_NODE_SHORTCUTS: NodeShortcutDefinition[] = [
  { type: 'ai-text', label: '生成文本' },
  { type: 'ai-image', label: '生成图像' },
  { type: 'ai-video', label: '生成视频' },
  { type: 'ai-audio', label: '生成音频' },
  { type: 'ai-panorama', label: '生成360全景' },
  { type: 'ai-animation', label: '帧动画' },
  { type: 'ai-director', label: '3D 导演台' },
];

const SOURCE_NODE_SHORTCUTS: NodeShortcutDefinition[] = [
  { type: 'ai-text', label: '文本' },
  { type: 'ai-image', label: '图像' },
  { type: 'ai-video', label: '视频' },
  { type: 'ai-audio', label: '音频' },
  { type: 'ai-markdown', label: 'Markdown' },
  { type: 'ai-shotlist', label: '分镜表' },
];

function createNodeFromNumberShortcut(shortcutIndex: number, isSource: boolean) {
  const definition = (isSource ? SOURCE_NODE_SHORTCUTS : GENERATOR_NODE_SHORTCUTS)[shortcutIndex];
  if (!definition) return false;

  const { type, label } = definition;
  const nodeRole = isSource || type === 'ai-director' ? 'source' : 'generator';
  const state = useAppStore.getState();
  const defaultModel = nodeRole === 'source' ? null : getPreferredNodeModel(type, state);
  const position = getCanvasPointerPosition();

  const node: RFNode<BaseNodeData> = {
    id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    position: { ...position },
    data: {
      ...createUiNodeData(type, label, nodeRole),
      ...(type === 'ai-panorama' && !isSource ? { previewMode: 'image' } : {}),
      ...(defaultModel ?? {}),
    },
  };

  state.addNode(node);
  return true;
}

// The main window can remount before the previous native registration has settled.
let nativeShortcutLifecycle = Promise.resolve();

export function useKeyboardShortcuts() {
  useEffect(() => {
    let active = true; // guard against callbacks firing after unmount / HMR reload
    const assetSearchKey = 'Ctrl+Shift+Space';
    let nativeOwnsAssetSearchKey = false;
    let mainWindowFocused = false;
    const isNavigating = (state: ReturnType<typeof useAppStore.getState>) => state.switchingProjectName != null
      || state.isCreatingProject || state.isReturningToStartPage || state.projectLoadStatus === 'loading';
    const saveActiveWorkspace = () => {
      const state = useAppStore.getState();
      if (isNavigating(state) || state.projectLoadStatus === 'readonly') return;
      if (state.projectWorkspaceView === 'script') {
        window.dispatchEvent(new Event('script-workbench-save'));
        return;
      }
      return state.saveCurrentProject();
    };

    const isKeyBlockedByEditor = (target: Element | null): boolean =>
      !!document.querySelector?.('[aria-modal="true"], dialog[open]') || !!target?.closest?.('.animation-editor');

    // ── Web fallback: JS keyboard events ──
    async function handleKeyDown(e: KeyboardEvent) {
      // 加载遮罩期间，捕获阶段的全局监听也不能操作底下的画布。
      const state = useAppStore.getState();
      if (e.key !== 'F12' && isNavigating(state)) return;
      const target = e.target as HTMLElement;
      const isEditing = isEditableTarget(target);
      if (state.projectLoadStatus === 'readonly' && e.key !== 'F12') return;
      // 剧本整页保留编辑器原生按键，保存交由工作台当前页签；不操作未显示的画布。
      if (state.projectWorkspaceView === 'script') {
        if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          e.stopPropagation();
          saveActiveWorkspace();
          return;
        }
        if (e.key !== 'F12') return;
      }

      // Tab 在画布表面开关资产抽屉；抽屉内的滚动区和控件获得焦点后仍可收起。
      if (e.key === 'Tab' && !e.defaultPrevented && !e.isComposing
        && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const state = useAppStore.getState();
        const isCanvasTarget = target === document.body || target === document.documentElement
          || !!target.closest?.('.react-flow');
        const isDrawerTarget = state.assetsPanelOpen && state.assetsPanelMode === 'drawer'
          && !!target.closest?.('.assets-panel--drawer');
        const isControl = !!target.closest?.(
          'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="tab"], [role="combobox"], [role="slider"], [role="menu"], [role="listbox"], [role="dialog"]',
        );
        const hasBlockingPanel = state.settingsOpen || state.projectLibraryOpen || state.helpOpen
          || state.characterLibraryOpen || state.characterActionLibraryOpen || state.historyPanelOpen
          || state.workflowPanelOpen || state.chatOpen || state.activeNodeId !== null
          || state.nodePickerOpen || state.nodeMenuVisible || state.avatarMenuOpen
          || !!state.reversePromptRequest || !!state.presetRunRequest
          || (state.assetsPanelOpen && state.assetsPanelMode !== 'drawer')
          || !!document.querySelector('[aria-modal="true"], dialog[open]');
        if (((isCanvasTarget && !isControl && !isEditing) || isDrawerTarget)
          && !hasBlockingPanel && document.querySelector('.react-flow')) {
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat) state.setAssetsPanelOpen(!state.assetsPanelOpen, 'drawer');
          return;
        }
      }

      // Ctrl+S / Alt+S — always allow save even in inputs
      if ((e.ctrlKey || e.metaKey || e.altKey) && e.key === 's') {
        e.preventDefault();
        e.stopPropagation();
        await saveActiveWorkspace();
        return;
      }

      // F12: 开关开发者工具（通过 Rust 命令实现 toggle）
      if (e.key === 'F12') {
        e.preventDefault();
        e.stopPropagation();
        try {
          await invoke('toggle_devtools');
        } catch { /* 非 Tauri 环境 */ }
        return;
      }

      // 弹窗和动画编辑器保留各自的原生按键。
      if (isKeyBlockedByEditor(target)) return;

      // Native owns this exact combination when its registration succeeds.
      if (e.ctrlKey && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat && (!nativeOwnsAssetSearchKey || e.altKey || e.metaKey)) {
          void openAssetSearchWindow();
        }
        return;
      }

      // 启动页保留应用入口快捷键，禁止创建、粘贴或撤销画布内容。
      if (useAppStore.getState().currentProjectId === null) {
        if (e.key === 'Escape') useAppStore.getState().setSettingsOpen(false);
        const togglesMascot = (e.ctrlKey || e.metaKey) && e.shiftKey
          && (e.code === 'KeyM' || e.key === 'm' || e.key === 'M');
        if (!togglesMascot) return;
      }
      // Space: 选中节点时弹出 AI 对话框（在 isEditing 守卫之前，防止 React Flow 内部拦截 Space 事件）
      if ((e.key === ' ' || e.code === 'Space') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat) {
        if (!isEditing) {
          const state = useAppStore.getState();
          const ids = state.selectedNodeIds;
          if (ids.length === 1) {
            const nodeId = ids[0];
            const node = state.nodes.find((n) => n.id === nodeId);
            if (node) {
              const data = node.data as BaseNodeData;
              const canOpen = !(
                node.type === 'group' ||
                data?.type === 'ai-markdown' ||
                isWsagentSharedImagesNode(data)
              );
              if (canOpen) {
                e.preventDefault();
                e.stopPropagation();
                const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
                if (el) {
                  const rect = el.getBoundingClientRect();
                  state.openNodeDialog(nodeId, { x: rect.left + rect.width / 2, y: rect.bottom });
                } else {
                  state.openNodeDialog(nodeId);
                }
                return;
              }
            }
          }
        }
      }

      if (isEditing) return;

      // F2: rename the single selected node through the shared NodeLabel editor.
      if (e.key === 'F2' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const state = useAppStore.getState();
        if (state.selectedNodeIds.length === 1 && startNodeRename(state.selectedNodeIds[0])) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // 1–7: 创建内容节点；Alt+1–5: 创建源节点。节点左上角落在当前鼠标位置。
      const digitMatch = /^(?:Digit|Numpad)([1-7])$/.exec(e.code);
      if (digitMatch && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const handled = createNodeFromNumberShortcut(Number(digitMatch[1]) - 1, e.altKey);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Ctrl+C: 仅当「文本节点选中模式」内有有效选区时走原生文本复制，否则复制选中节点
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (hasActiveTextSelection()) {
          // 交给浏览器原生复制选中文本；清空节点剪贴板，避免之后 Ctrl+V 误粘节点
          useAppStore.setState({ clipboard: { nodes: [], groups: [], projectId: null } });
          return;
        }
        if (useAppStore.getState().selectedNodeIds.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          useAppStore.getState().copySelectedNodes();
        }
        return;
      }

      // Ctrl+V: Paste nodes from clipboard
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        const { clipboard } = useAppStore.getState();
        if (clipboard.nodes.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          // Paste near center of viewport
          useAppStore.getState().pasteNodes({ x: 300, y: 300 });
        }
        // When internal clipboard is empty, let the native paste event fire —
        // the paste listener in Canvas.tsx handles external clipboard content.
        return;
      }

      // Ctrl+Z: Undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        useAppStore.getState().undo();
        return;
      }

      // Ctrl+Shift+Z: Redo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        useAppStore.getState().redo();
        return;
      }

      // Ctrl+Y: Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        useAppStore.getState().redo();
        return;
      }

      // Delete / Backspace — batch edge+node deletion in a single commit
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const state = useAppStore.getState();
        const nodeIds = state.selectedNodeIds;
        const selectedEdgeIds = state.edges.filter((ed) => ed.selected).map((ed) => ed.id);

        if (selectedEdgeIds.length === 0 && nodeIds.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        state.deleteSelectedCanvasElements();
        return;
      }

      // F: Fit view
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('canvas-fit-view', { detail: { source: 'user' } }));
        return;
      }

      // 显示比例快捷键；编辑器、菜单与弹窗仍由上面的焦点守卫处理。
      if (!e.ctrlKey && !e.metaKey && !e.altKey && ['+', '=', '-', '_'].includes(e.key)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('canvas-zoom-step', {
          detail: { direction: e.key === '+' || e.key === '=' ? 1 : -1 },
        }));
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey && e.code === 'KeyL') {
        e.preventDefault();
        if (!e.repeat) window.dispatchEvent(new Event('canvas-toggle-zoom-lock'));
        return;
      }

      // M: Toggle MiniMap
      if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        useAppStore.getState().toggleMinimap();
        return;
      }

      // Escape
      if (e.key === 'Escape') {
        useAppStore.getState().hideNodeMenu();
        useAppStore.getState().setSettingsOpen(false);
      }

      // Ctrl+Shift+M: 切换吉祥物显示（避开 Alt 键，避免被系统菜单栏拦截）
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'KeyM' || e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        e.stopPropagation();
        const store = useAppStore.getState();
        store.updateConfig({ mascotVisible: !store.config.mascotVisible });
        const next = useAppStore.getState().config.mascotVisible;
        useAppStore.getState().showToast(next ? '吉祥物已显示' : '吉祥物已隐藏');
        store.saveConfig();
        return;
      }

      // Ctrl+G / Alt+G: Group / Ungroup
      if ((e.ctrlKey || e.metaKey || e.altKey) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        e.stopPropagation();
        const st = useAppStore.getState();
        const ids = st.selectedNodeIds;
        if (ids.length === 0) {
          st.showToast('请先选中节点', 'error');
          return;
        }
        // groupSelectedNodes auto-detects: if any selected node is in a group
        // or is a group node, it delegates to ungroupSelectedNodes.
        st.groupSelectedNodes();
        return;
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);

    // ── Tauri native: global-shortcut plugin ──
    let unlistenFocus: (() => void) | undefined;
    let focusShortcuts = Promise.resolve();
    let focusRevision = 0;
    let shortcutModule: typeof import('@tauri-apps/plugin-global-shortcut') | undefined;

    nativeShortcutLifecycle = nativeShortcutLifecycle.then(async () => {
      if (!active) return;
      try {
        const native = await import('@tauri-apps/plugin-global-shortcut');
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        if (!active) return;
        shortcutModule = native;

        const openFocusedAssetSearch = async () => {
          if (!active || !mainWindowFocused) return;
          const revision = focusRevision;
          if (!await win.isFocused()) return;
          const state = useAppStore.getState();
          if (!active || revision !== focusRevision || isNavigating(state)
            || state.projectLoadStatus === 'readonly' || state.projectWorkspaceView === 'script'
            || isKeyBlockedByEditor(document.activeElement)) return;
          void openAssetSearchWindow();
        };
        const shortcuts = [
          { key: 'CommandOrControl+S', action: saveActiveWorkspace },
          { key: 'Alt+S', action: saveActiveWorkspace },
          { key: assetSearchKey, action: () => { void openFocusedAssetSearch().catch(() => {}); } },
          // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y stay in the keydown handler to avoid double-firing.
        ];

        // Clean up leftover registrations from HMR.
        try { await native.unregisterAll(); } catch { /* ignore */ }
        if (!active) return;

        // Alt+Space remains available even when this window loses focus.
        try {
          await native.register('Alt+Space', (event) => {
            if (!active || (event?.state && event.state !== 'Pressed')) return;
            openAssetSearchWindow();
          });
        } catch (err) {
          console.warn('[shortcut] 注册失败: Alt+Space', err);
        }
        if (!active) return;

        const updateFocusShortcuts = (focused: boolean) => {
          if (mainWindowFocused !== focused) focusRevision++;
          mainWindowFocused = focused;
          focusShortcuts = focusShortcuts.then(async () => {
            for (const shortcut of shortcuts) {
              try { await native.unregister(shortcut.key); } catch { /* ignore */ }
              if (shortcut.key === assetSearchKey) nativeOwnsAssetSearchKey = false;
            }
            for (const shortcut of shortcuts) {
              if (!active || !mainWindowFocused) break;
              const isAssetSearch = shortcut.key === assetSearchKey;
              if (isAssetSearch) nativeOwnsAssetSearchKey = true;
              try {
                await native.register(shortcut.key, (event) => {
                  if (!active || !mainWindowFocused || (event?.state && event.state !== 'Pressed')) return;
                  shortcut.action();
                });
              } catch (err) {
                if (isAssetSearch) nativeOwnsAssetSearchKey = false;
                console.warn(`[shortcut] 注册失败: ${shortcut.key}`, err);
              }
            }
          });
          return focusShortcuts;
        };

        let observedFocus = false;
        const stopFocus = await win.onFocusChanged((event) => {
          if (!active) return;
          observedFocus = true;
          const updated = updateFocusShortcuts(event.payload);
          if (!event.payload) {
            // 外部复制过内容后，不再粘贴离开前保存的节点。
            useAppStore.setState({ clipboard: { nodes: [], groups: [], projectId: null } });
          }
          return updated;
        });
        if (!active) {
          stopFocus();
          return;
        }
        unlistenFocus = stopFocus;
        const focused = await win.isFocused();
        if (active && !observedFocus && focused) await updateFocusShortcuts(true);
      } catch {
        // Not in Tauri env — fall back to JS keyboard events only
      }
    });

    return () => {
      active = false;
      mainWindowFocused = false;
      document.removeEventListener('keydown', handleKeyDown, true);
      unlistenFocus?.();

      // Let an in-flight focus registration finish before removing all shortcuts.
      nativeShortcutLifecycle = nativeShortcutLifecycle.then(async () => {
        await focusShortcuts;
        await shortcutModule?.unregisterAll();
      }).catch(() => {});
    };
  }, []);
}
