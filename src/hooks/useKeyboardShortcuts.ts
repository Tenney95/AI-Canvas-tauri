/**
 * useKeyboardShortcuts 全局键盘快捷键 Hook — 注册 Ctrl+S 保存、Ctrl+Z 撤销、Ctrl+Shift+Z 重做、Delete 删除、F 自适应等快捷键
 * Tauri 环境优先使用 tauri-plugin-global-shortcut 原生拦截，Web 环境退化为 document keydown 捕获
 */
import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import * as fileService from '../services/fileService';
import { openAssetSearchWindow } from '../utils/assetSearchWindow';
import { playNodeExit } from '../utils/nodeAnimations';
import { hasActiveTextSelection } from '../utils/textSelection';
import { cancelNodePolling } from '../services/pollManager';
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

      // Ctrl+Shift+Space: 打开资源搜索窗口（Win+Space 被系统占用时的可靠备选；不与输入法冲突）
      if (e.ctrlKey && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        openAssetSearchWindow();
        return;
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
                data?.type === 'ai-markdown'
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

        // Cancel any active polling for all deleted nodes
        for (const id of allIds) {
          cancelNodePolling(id);
        }

        // Delete associated local files —— 跳过仍被存活节点引用的共享文件（复制节点场景）
        const keepPaths = new Set(
          state.nodes.filter((n) => !allIds.includes(n.id))
            .map((n) => (n.data as BaseNodeData).filePath)
            .filter((p): p is string => !!p),
        );
        for (const node of state.nodes.filter((n) => allIds.includes(n.id))) {
          fileService.deleteNodeFile(node.data as BaseNodeData, keepPaths).catch(() => {});
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
    // Register on focus, unregister on blur — so shortcuts only work in this app.
    const GLB_SHORTCUTS = [
      { key: 'CommandOrControl+S', action: () => useAppStore.getState().saveCurrentProject() },
      { key: 'Alt+S', action: () => useAppStore.getState().saveCurrentProject() },
      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y are handled by the JS keydown handler above;
      // registering them as native shortcuts would double-fire undo/redo.
    ];

    // Alt+Space：打开资源搜索窗口 — 真全局监听，不随窗口失焦而注销（Win+Space 被系统保留无法抢注）。

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

        // Alt+Space：注册一次，常驻到组件卸载，不受聚焦状态影响
        try {
          await shortcutModule.register('Alt+Space', (event) => {
            if (event?.state && event.state !== 'Pressed') return;
            openAssetSearchWindow();
          });
        } catch (err) {
          console.warn('[shortcut] 注册失败: Alt+Space', err);
        }

        // Register all shortcuts
        const registerAll = async () => {
          if (!active || !shortcutModule) return;
          // 先清理旧注册，避免重复注册（HMR / 窗口重新聚焦时可能残留）
          // 只清 GLB_SHORTCUTS 自己的 key，不用 unregisterAll —— 那会连 Alt+Space 常驻注册一起清掉
          for (const s of GLB_SHORTCUTS) {
            try { await shortcutModule.unregister(s.key); } catch { /* ignore */ }
          }
          for (const s of GLB_SHORTCUTS) {
            try {
              // 仅在按下时触发（插件会同时回调 Pressed / Released，避免重复执行）
              await shortcutModule.register(s.key, (event) => {
                if (event?.state && event.state !== 'Pressed') return;
                s.action();
              });
            } catch (err) {
              // 重复注册会抛错；Win+Space 等被系统保留的组合也可能注册失败
              console.warn(`[shortcut] 注册失败: ${s.key}`, err);
            }
          }
        };

        // Unregister the focus-scoped shortcuts (Alt+Space stays armed)
        const unregisterAll = async () => {
          if (!shortcutModule) return;
          for (const s of GLB_SHORTCUTS) {
            try { await shortcutModule.unregister(s.key); } catch { /* ignore */ }
          }
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
