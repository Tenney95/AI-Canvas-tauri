/**
 * useCanvasSecondaryClickMenu — 画布右键（次级点击）菜单控制器。
 * 在已选节点中按屏幕坐标做几何命中，决定弹出节点菜单还是画布菜单；
 * 多选场景下选择框覆盖在节点之上，改用矩形命中测试而非 elementFromPoint。
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Node as RFNode } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { useAppStore } from '../store/useAppStore';

interface UseCanvasSecondaryClickMenuOptions {
  interactionModeRef: MutableRefObject<string>;
  openNodeMenu: (event: React.MouseEvent, node: RFNode<BaseNodeData>) => void;
  openCanvasMenu: (event: React.MouseEvent) => void;
}

/**
 * 在已选中的节点里按屏幕坐标回查命中项。
 *
 * 多选场景下选择框覆盖在节点之上，`elementFromPoint` 只会返回覆盖层，
 * 因此改用几何命中测试；只有真正落在某个节点矩形内才算命中，
 * 点在选择框空白处一律返回 null，交给画布菜单。
 */
function findSelectedNodeAtPoint(clientX: number, clientY: number): string | null {
  const selected = Array.from(
    document.querySelectorAll<HTMLElement>('.react-flow__node.selected'),
  );
  const hit = selected.find((candidate) => {
    // 展开分组的内部是画布空白；几何回查不能重新把它吞成分组菜单。
    const target = candidate.querySelector<HTMLElement>('.canvas-group-node-wrapper')
      ? candidate.querySelector<HTMLElement>('.canvas-group-title')
      : candidate;
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
  });
  return hit?.getAttribute('data-id') ?? null;
}

/** 统一 Windows 右键拖拽与 macOS 次级点击的菜单触发时机。 */
export function useCanvasSecondaryClickMenu({
  interactionModeRef,
  openNodeMenu,
  openCanvasMenu,
}: UseCanvasSecondaryClickMenuOptions): void {
  const shouldPreventNativeMenu = useRef(false);

  useEffect(() => {
    const drag = { x: 0, y: 0, moved: false, down: false };
    const cancelForScriptPage = () => {
      if (useAppStore.getState().projectWorkspaceView !== 'script') return false;
      drag.down = false;
      drag.moved = false;
      shouldPreventNativeMenu.current = false;
      return true;
    };
    const onDown = (event: PointerEvent) => {
      if (cancelForScriptPage()) return;
      if (event.button !== 2) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.moved = false;
      drag.down = true;
    };
    const onMove = (event: PointerEvent) => {
      if (cancelForScriptPage()) return;
      if (!drag.down) return;
      const deltaX = event.clientX - drag.x;
      const deltaY = event.clientY - drag.y;
      if (deltaX * deltaX + deltaY * deltaY > 25) drag.moved = true;
    };
    const onCancel = () => {
      drag.down = false;
    };
    const onUp = (event: PointerEvent) => {
      if (cancelForScriptPage()) return;
      if (event.button !== 2 || !drag.down) return;
      drag.down = false;
      if (drag.moved && interactionModeRef.current === 'default') return;

      const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      if (!element) return;
      // 可编辑引用胶囊由编辑器处理；避免 pointerup 先打开画布/节点菜单。
      if (element.closest('.prompt-editor .prompt-chip, .mention-dropdown')) return;

      const nodeElement = element.closest('.react-flow__node');
      if (nodeElement) {
        const id = nodeElement.getAttribute('data-id');
        if (!id) return;
        shouldPreventNativeMenu.current = true;
        openNodeMenu({
          preventDefault() {},
          stopPropagation() {},
          clientX: event.clientX,
          clientY: event.clientY,
          target: element,
        } as unknown as React.MouseEvent, { id } as RFNode<BaseNodeData>);
        return;
      }

      // 多选时 React Flow 会在节点上盖一层选择框，elementFromPoint 只能拿到那层，
      // 退回画布菜单之前先按坐标回查是否落在某个已选中的节点上
      const selectedHit = findSelectedNodeAtPoint(event.clientX, event.clientY);
      if (selectedHit) {
        shouldPreventNativeMenu.current = true;
        openNodeMenu({
          preventDefault() {},
          stopPropagation() {},
          clientX: event.clientX,
          clientY: event.clientY,
          target: element,
        } as unknown as React.MouseEvent, { id: selectedHit } as RFNode<BaseNodeData>);
        return;
      }

      const paneElement = element.closest('.react-flow__pane');
      if (!paneElement) return;
      shouldPreventNativeMenu.current = true;
      openCanvasMenu({
        preventDefault() {},
        clientX: event.clientX,
        clientY: event.clientY,
        target: paneElement,
      } as unknown as React.MouseEvent);
    };
    const onContextMenu = (event: MouseEvent) => {
      if (cancelForScriptPage()) return;
      if (!shouldPreventNativeMenu.current) return;
      event.preventDefault();
      shouldPreventNativeMenu.current = false;
    };

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onCancel, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onCancel, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, [interactionModeRef, openCanvasMenu, openNodeMenu]);
}
