/**
 * useKeyboardShortcuts 全局键盘快捷键 Hook — 注册 Ctrl+S 保存、Ctrl+Z 撤销、Ctrl+Shift+Z 重做、Delete 删除、F 自适应等快捷键
 * Tauri 环境优先使用 tauri-plugin-global-shortcut 原生拦截，Web 环境退化为 document keydown 捕获
 */
import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import * as fileService from '../services/fileService';
import { playNodeExit } from '../utils/nodeAnimations';
import { hasActiveTextSelection } from '../utils/textSelection';
import type { BaseNodeData } from '../types';
export function useKeyboardShortcuts() {
  useEffect(() => {
    let active = true; // guard against callbacks firing after unmount / HMR reload

    // ── Web fallback: JS keyboard events ──
    async function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isEditing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.contentEditable === 'true';

      // Ctrl+S / Alt+S — always allow save even in inputs
      if ((e.ctrlKey || e.metaKey || e.altKey) && e.key === 's') {
        e.preventDefault();
        e.stopPropagation();
        await useAppStore.getState().saveCurrentProject();
        return;
      }

      // F12: 开关开发者工具（通过 Rust 命令实现 toggle）
      if (e.key === 'F12') {
        e.preventDefault();
        e.stopPropagation();
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('toggle_devtools');
        } catch { /* 非 Tauri 环境 */ }
        return;
      }

      if (isEditing) return;

      // Ctrl+C: 仅当「文本节点选中模式」内有有效选区时走原生文本复制，否则复制选中节点
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (hasActiveTextSelection()) {
          // 交给浏览器原生复制选中文本；清空节点剪贴板，避免之后 Ctrl+V 误粘节点
          useAppStore.setState({ clipboard: { nodes: [], groups: [] } });
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
      if ((e.ctrlKey || e.metaKey) && e.key === 'Z' && e.shiftKey) {
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
        // 立即清空选择 → 即时反馈，并避免退场动画期间再次按 Delete 重复触发删除
        useAppStore.setState({ selectedNodeIds: [] });

        // Expand to include descendants of any selected group nodes
        const expandedIds = new Set(nodeIds);
        const q = [...nodeIds];
        while (q.length > 0) {
          const pid = q.shift()!;
          state.nodes.filter((n) => n.parentId === pid).forEach((c) => {
            expandedIds.add(c.id);
            q.push(c.id);
          });
        }
        const allIds = Array.from(expandedIds);

        // Delete associated local files
        for (const node of state.nodes.filter((n) => allIds.includes(n.id))) {
          fileService.deleteNodeFile(node.data as BaseNodeData).catch(() => {});
        }

        // Single commit — undo always goes back to the real pre-delete state
        useAppStore.getState().commitToHistory();
        // 先播放退场动画，结束后再真正移除节点
        playNodeExit(allIds).then(() => {
          useAppStore.setState((s) => ({
            nodes: s.nodes.filter((n) => !expandedIds.has(n.id)),
            edges: s.edges.filter(
              (ed) => !expandedIds.has(ed.source) && !expandedIds.has(ed.target) && !selectedEdgeIds.includes(ed.id)
            ),
            groups: s.groups
              .filter((g) => !expandedIds.has(g.id))
              .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((nid) => !expandedIds.has(nid)) })),
            selectedNodeIds: [],
          }));
        });
        return;
      }

      // F: Fit view
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        window.dispatchEvent(new CustomEvent('canvas-fit-view'));
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
    // Register on focus, unregister on blur — so shortcuts only work in this app.
    const GLB_SHORTCUTS = [
      { key: 'CommandOrControl+S', action: () => useAppStore.getState().saveCurrentProject() },
      { key: 'Alt+S', action: () => useAppStore.getState().saveCurrentProject() },
      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y are handled by the JS keydown handler above;
      // registering them as native shortcuts would double-fire undo/redo.
    ];

    let unlistenFocus: (() => void) | undefined;
    let unlistenBlur: (() => void) | undefined;
    let shortcutModule: typeof import('@tauri-apps/plugin-global-shortcut') | null = null;

    (async () => {
      try {
        shortcutModule = await import('@tauri-apps/plugin-global-shortcut');
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();

        // Clean up leftover registrations from HMR
        try { await shortcutModule.unregisterAll(); } catch { /* ignore */ }

        // Register all shortcuts
        const registerAll = async () => {
          if (!active || !shortcutModule) return;
          for (const s of GLB_SHORTCUTS) {
            try { await shortcutModule.register(s.key, s.action); } catch { /* dup may throw */ }
          }
        };

        // Unregister all shortcuts
        const unregisterAll = async () => {
          if (!shortcutModule) return;
          try { await shortcutModule.unregisterAll(); } catch { /* ignore */ }
        };

        // Register on initial focus state
        const focused = await win.isFocused();
        if (focused) await registerAll();

        // Listen for focus/blur to toggle registration
        unlistenFocus = await win.onFocusChanged(async (ev) => {
          if (!active) return;
          if (ev.payload) {
            await registerAll();
          } else {
            await unregisterAll();
            // Clear stale internal clipboard — when the user switches away,
            // they may have copied external content. If we don't clear, the
            // next Ctrl+V will still paste the old in-app copied nodes.
            useAppStore.setState({ clipboard: { nodes: [], groups: [] } });
          }
        });

        // Store blob cleanup
        unlistenBlur = unlistenFocus; // onFocusChanged returns single unlisten for both
      } catch {
        // Not in Tauri env — fall back to JS keyboard events only
      }
    })();

    return () => {
      active = false;
      document.removeEventListener('keydown', handleKeyDown, true);

      // Unlisten focus events
      unlistenFocus?.();
      unlistenBlur?.();

      // Unregister all shortcuts
      import('@tauri-apps/plugin-global-shortcut')
        .then(({ unregisterAll }) => unregisterAll())
        .catch(() => {});
    };
  }, []);
}
