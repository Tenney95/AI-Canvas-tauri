/**
 * useKeyboardShortcuts 全局键盘快捷键 Hook — 注册 Ctrl+S 保存、Ctrl+Z 撤销、Ctrl+Shift+Z 重做、Delete 删除、F 自适应等快捷键
 * Tauri 环境优先使用 tauri-plugin-global-shortcut 原生拦截，Web 环境退化为 document keydown 捕获
 */
import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import * as fileService from '../services/fileService';
import type { BaseNodeData } from '../types';
export function useKeyboardShortcuts() {
  const { undo, redo, saveCurrentProject, copySelectedNodes, pasteNodes } = useAppStore();

  useEffect(() => {
    let active = true; // guard against callbacks firing after unmount / HMR reload

    // ── Web fallback: JS keyboard events ──
    async function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isEditing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.contentEditable === 'true';

      // Ctrl+S / Alt+S — always allow save even in inputs
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        e.stopPropagation();
        await saveCurrentProject();
        return;
      }
      if (e.altKey && e.key === 's') {
        e.preventDefault();
        e.stopPropagation();
        await saveCurrentProject();
        return;
      }
      if (isEditing) return;

      // Ctrl+C: Copy selected nodes to clipboard
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        copySelectedNodes();
        return;
      }

      // Ctrl+V: Paste nodes from clipboard
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        const { clipboard } = useAppStore.getState();
        if (clipboard.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          // Paste near center of viewport
          pasteNodes({ x: 300, y: 300 });
        }
        // When internal clipboard is empty, let the native paste event fire —
        // the paste listener in Canvas.tsx handles external clipboard content.
        return;
      }

      // Ctrl+Z: Undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        undo();
        return;
      }

      // Ctrl+Shift+Z: Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'Z' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        redo();
        return;
      }

      // Ctrl+Y: Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        redo();
        return;
      }

      // Delete / Backspace
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const state = useAppStore.getState();
        const ids = state.selectedNodeIds;
        if (ids.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          // Delete associated local files
          const nodesToDelete = state.nodes.filter((n) => ids.includes(n.id));
          for (const node of nodesToDelete) {
            fileService.deleteNodeFile(node.data as BaseNodeData).catch(() => {});
          }
          useAppStore.getState().commitToHistory();
          useAppStore.setState((s) => ({
            nodes: s.nodes.filter((n) => !ids.includes(n.id)),
            edges: s.edges.filter(
              (ed) => !ids.includes(ed.source) && !ids.includes(ed.target)
            ),
            selectedNodeIds: [],
          }));
        }
        return;
      }

      // F: Fit view
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        window.dispatchEvent(new CustomEvent('canvas-fit-view'));
        return;
      }

      // Escape
      if (e.key === 'Escape') {
        useAppStore.getState().hideNodeMenu();
        useAppStore.getState().setSettingsOpen(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);

    // ── Tauri native: global-shortcut plugin ──
    // Register on focus, unregister on blur — so shortcuts only work in this app.
    const GLB_SHORTCUTS = [
      { key: 'CommandOrControl+S', action: () => useAppStore.getState().saveCurrentProject() },
      { key: 'Alt+S', action: () => useAppStore.getState().saveCurrentProject() },
      { key: 'CommandOrControl+Z', action: () => useAppStore.getState().undo() },
      { key: 'CommandOrControl+Shift+Z', action: () => useAppStore.getState().redo() },
      { key: 'CommandOrControl+Y', action: () => useAppStore.getState().redo() },
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
  }, [undo, redo, saveCurrentProject, copySelectedNodes, pasteNodes]);
}
