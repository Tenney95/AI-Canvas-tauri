/**
 * Canvas 画布主组件 — React Flow 画布核心，管理节点/边渲染、拖放、连线、右键菜单、空状态
 */
import { lazy, Suspense, useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  ConnectionMode,
  SelectionMode,
  PanOnScrollMode,
  useReactFlow,
  useViewport,
  useUpdateNodeInternals,
  ReactFlowProvider,
  Panel,
  applyNodeChanges,
  type OnSelectionChangeParams,
  type NodeChange,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import TextNode from './nodes/TextNode';
import ImageNode from './nodes/ImageNode';
import VideoNode from './nodes/VideoNode';
import AudioNode from './nodes/AudioNode';
import AnimationNode from './nodes/AnimationNode';
import MarkdownNode from './nodes/MarkdownNode';
import StoryboardNode from './nodes/StoryboardNode';
import GroupNode from './nodes/GroupNode';
import ConnectionMenu from './canvas/ConnectionMenu';
import CanvasContextMenu from './canvas/CanvasContextMenu';
import NodeContextMenu from './canvas/NodeContextMenu';
import CanvasToolbar from './canvas/CanvasToolbar';
import RoundedMiniMapMask from './canvas/RoundedMiniMapMask';
import MultiSelectToolbar from './canvas/MultiSelectToolbar';
import CanvasEmptyState from './canvas/CanvasEmptyState';
import SelectedNodeFlowEdge from './canvas/SelectedNodeFlowEdge';
import { useConnectionDropMenu } from '../hooks/useConnectionDropMenu';
import { useCanvasContextMenu } from '../hooks/useCanvasContextMenu';
import { useNodeContextMenu } from '../hooks/useNodeContextMenu';
import { useAppStore } from '../store/useAppStore';
import { useNodeCreation } from '../hooks/useNodeCreation';
import type { BaseNodeData } from '../types';
import type { Node as RFNode, NodeTypes, Connection, Edge, OnMove } from '@xyflow/react';
import { useNodeSnap, ResizeSnapContext, type SnapLine } from '../hooks/useNodeSnap';
import { setCanvasPointerPosition } from '../services/canvasPointerService';
import {
  CANVAS_PAN_BY_EVENT,
  CANVAS_PAN_DURATION_MS,
  type CanvasPanByDetail,
} from '../services/canvasViewportService';

// 懒加载：全景节点引入 three（体积大户），画布上出现全景节点时才加载
const PanoramaNodeLazy = lazy(() => import('./nodes/PanoramaNode'));
function PanoramaNode(props: { id: string; data: BaseNodeData; selected?: boolean }) {
  return <Suspense fallback={null}><PanoramaNodeLazy {...props} /></Suspense>;
}

// 懒加载：3D 导演台节点按需连接本地 Tauri 独立窗口
const DirectorDeskNodeLazy = lazy(() => import('./nodes/DirectorDeskNode'));
function DirectorDeskNode(props: { id: string; data: BaseNodeData; selected?: boolean }) {
  return <Suspense fallback={null}><DirectorDeskNodeLazy {...props} /></Suspense>;
}

// ── Node types mapping ──
const nodeTypes: NodeTypes = {
  'ai-text': TextNode,
  'ai-image': ImageNode,
  'ai-video': VideoNode,
  'ai-audio': AudioNode,
  'ai-animation': AnimationNode,
  'ai-panorama': PanoramaNode,
  'ai-markdown': MarkdownNode,
  'ai-storyboard': StoryboardNode,
  'ai-director': DirectorDeskNode,
  'source-text': TextNode,
  'source-image': ImageNode,
  'source-video': VideoNode,
  'source-audio': AudioNode,
  comment: TextNode,
  group: GroupNode,
};

const edgeTypes: EdgeTypes = {
  'selected-node-flow': SelectedNodeFlowEdge,
};

// ── Stable ReactFlow props (hoisted to avoid new identities every render,
//    which makes React Flow re-run internal effects and drop frames on drag) ──
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1 };
const PRO_OPTIONS = { hideAttribution: true };
const PAN_ON_DRAG_DEFAULT = [1, 2]; // 默认交互：右键(2) + 中键(1) 拖拽平移
const PAN_ON_DRAG_CLASSIC = [0];    // 传统交互：左键(0) 拖拽平移
const DEFAULT_EDGE_STYLE = { stroke: '#33334a', strokeWidth: 1.5 };
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const isMacOS = typeof navigator !== 'undefined'
  && /Macintosh|Mac OS X/.test(navigator.userAgent);
const shouldUseMacTrackpadPan = isTauri && isMacOS;
const easeOutCubic = (progress: number) => 1 - (1 - progress) ** 3;
const CANVAS_INTERACTING_CLASS = 'canvas-interacting';

// ── 交互模式预设（冻结对象，避免每次 render 产生新身份，导致 React Flow 内部 effect 重跑、拖拽掉帧）──
const DEFAULT_INTERACTION = Object.freeze({
  panOnScroll: shouldUseMacTrackpadPan,
  zoomOnScroll: !shouldUseMacTrackpadPan,
  zoomOnPinch: true,
  panOnDrag: PAN_ON_DRAG_DEFAULT,
  selectionOnDrag: true,
  selectionMode: SelectionMode.Partial,
  multiSelectionKeyCode: 'Shift',
  deleteKeyCode: null,
});

const CLASSIC_INTERACTION = Object.freeze({
  panOnScroll: true,
  panOnScrollMode: PanOnScrollMode.Free, // Free 才能兼顾 Shift+滚轮水平平移与普通滚轮垂直平移
  panOnScrollSpeed: 0.5,
  zoomOnScroll: false,
  zoomOnPinch: true,
  zoomOnDoubleClick: false, // 关闭双击缩放，避免与「双击空白创建文本节点」冲突
  zoomActivationKeyCode: 'Control', // Ctrl+滚轮缩放
  panOnDrag: PAN_ON_DRAG_CLASSIC,
  selectionOnDrag: false,
  selectionKeyCode: 'Shift', // Shift+左键拖拽 → 框选
  multiSelectionKeyCode: 'Shift',
  selectionMode: SelectionMode.Partial,
  deleteKeyCode: null,
});
const MINIMAP_STYLE = {
  width: 180,
  height: 120,
  border: '1px solid var(--theme-border)',
  borderRadius: '8px',
};
const INLINE_EDIT_DOUBLE_CLICK_DELAY_MS = 280;
const isValidConnection = (conn: Connection | Edge) => conn.source !== conn.target;
const minimapNodeColor = (node: RFNode) => {
  switch (node.type) {
    case 'ai-text':
    case 'source-text':
    case 'comment': return 'color-mix(in srgb, var(--node-text-light) 50%, transparent)';
    case 'ai-image':
    case 'source-image':
    case 'ai-storyboard': return 'color-mix(in srgb, var(--node-image-light) 50%, transparent)';
    case 'ai-video':
    case 'source-video': return 'color-mix(in srgb, var(--node-video-light) 50%, transparent)';
    case 'ai-audio':
    case 'source-audio': return 'color-mix(in srgb, var(--node-audio-light) 50%, transparent)';
    case 'ai-animation': return 'color-mix(in srgb, var(--brand) 50%, transparent)';
    case 'ai-panorama': return 'color-mix(in srgb, var(--node-panorama) 50%, transparent)';
    case 'ai-markdown': return 'color-mix(in srgb, var(--node-markdown-light) 50%, transparent)';
    case 'ai-director': return 'color-mix(in srgb, #a78bfa 50%, transparent)';
    case 'group': return '#4b556380';
    default: return '#6b728080';
  }
};

// ── Snap lines overlay ──
type SpacingSnapLine = Extract<SnapLine, { kind: 'spacing' }>;

function formatSpacingDistance(distance: number): string {
  return Number.isInteger(distance) ? String(distance) : distance.toFixed(1);
}

function SpacingGuideMarks({ line, index }: { line: SpacingSnapLine; index: number }) {
  const label = formatSpacingDistance(line.distance);
  return (
    <g key={`spacing-${line.type}-${index}`}>
      {line.segments.map((segment, segmentIndex) => {
        const middle = (segment.start + segment.end) / 2;
        return line.type === 'horizontal' ? (
          <g key={`horizontal-gap-${segmentIndex}`}>
            <line
              x1={segment.start}
              y1={line.crossPosition}
              x2={segment.end}
              y2={line.crossPosition}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={segment.start}
              y1={line.crossPosition - 4}
              x2={segment.start}
              y2={line.crossPosition + 4}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={segment.end}
              y1={line.crossPosition - 4}
              x2={segment.end}
              y2={line.crossPosition + 4}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={middle}
              y={line.crossPosition - 6}
              fill="var(--brand)"
              stroke="var(--theme-bg)"
              strokeWidth={3}
              paintOrder="stroke"
              fontSize={11}
              fontWeight={600}
              textAnchor="middle"
            >
              {label}
            </text>
          </g>
        ) : (
          <g key={`vertical-gap-${segmentIndex}`}>
            <line
              x1={line.crossPosition}
              y1={segment.start}
              x2={line.crossPosition}
              y2={segment.end}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={line.crossPosition - 4}
              y1={segment.start}
              x2={line.crossPosition + 4}
              y2={segment.start}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={line.crossPosition - 4}
              y1={segment.end}
              x2={line.crossPosition + 4}
              y2={segment.end}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={line.crossPosition - 6}
              y={middle}
              fill="var(--brand)"
              stroke="var(--theme-bg)"
              strokeWidth={3}
              paintOrder="stroke"
              fontSize={11}
              fontWeight={600}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function SnapLinesOverlay({ lines }: { lines: SnapLine[] }) {
  const { x, y, zoom } = useViewport();
  if (lines.length === 0) return null;
  return (
    <div
      className="pointer-events-none"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 999,
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
        transformOrigin: '0 0',
      }}
    >
      <svg
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          overflow: 'visible',
        }}
      >
        {lines.map((line, i) => {
          if (line.kind === 'spacing') {
            return <SpacingGuideMarks key={`spacing-${line.type}-${i}`} line={line} index={i} />;
          }
          return line.type === 'horizontal' ? (
            <line
              key={`h-${i}`}
              x1={-99999}
              y1={line.position}
              x2={99999}
              y2={line.position}
              stroke="var(--brand)"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.7}
            />
          ) : (
            <line
              key={`v-${i}`}
              x1={line.position}
              y1={-99999}
              x2={line.position}
              y2={99999}
              stroke="var(--brand)"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.7}
            />
          );
        })}
      </svg>
    </div>
  );
}

function CanvasInner() {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const selectedNodeIds = useAppStore((s) => s.selectedNodeIds);
  const onConnect = useAppStore((s) => s.onConnect);
  const setEdges = useAppStore((s) => s.setEdges);
  const setSelectedNodeIds = useAppStore((s) => s.setSelectedNodeIds);
  const applyStableNodeChanges = useAppStore((s) => s.onNodesChange);
  const handleEdgesChange = useAppStore((s) => s.onEdgesChange);
  const clearGroupedSelection = useAppStore((s) => s.clearGroupedSelection);
  const settleNodeGroupingOnDragStop = useAppStore((s) => s.settleNodeGroupingOnDragStop);
  const duplicateNode = useAppStore((s) => s.duplicateNode);
  const minimapVisible = useAppStore((s) => s.minimapVisible);
  const closeNodeDialog = useAppStore((s) => s.closeNodeDialog);
  const interactionMode = useAppStore((s) => s.config.interactionMode ?? 'default');
  const interaction = interactionMode === 'classic' ? CLASSIC_INTERACTION : DEFAULT_INTERACTION;
  // 右键 effect 用 ref 读取模式，避免把 interactionMode 加进 effect 依赖而导致监听器重挂
  const interactionModeRef = useRef(interactionMode);
  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);
  const reactFlowInstance = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const activeCanvasPanRef = useRef<{
    startX: number;
    startY: number;
    detail: CanvasPanByDetail;
  } | null>(null);
  const activeInteractionsRef = useRef(new Set<'node' | 'viewport'>());

  const setCanvasInteraction = useCallback((kind: 'node' | 'viewport', active: boolean) => {
    if (active) activeInteractionsRef.current.add(kind);
    else activeInteractionsRef.current.delete(kind);
    document.documentElement.classList.toggle(
      CANVAS_INTERACTING_CLASS,
      activeInteractionsRef.current.size > 0,
    );
  }, []);

  useEffect(() => () => {
    document.documentElement.classList.remove(CANVAS_INTERACTING_CLASS);
  }, []);

  const handleCanvasViewportMoveStart = useCallback<OnMove>(() => {
    setCanvasInteraction('viewport', true);
  }, [setCanvasInteraction]);

  const handleCanvasViewportMoveEnd = useCallback<OnMove>(() => {
    setCanvasInteraction('viewport', false);
  }, [setCanvasInteraction]);

  const handleCanvasViewportMove = useCallback<OnMove>((_, viewport) => {
    const activePan = activeCanvasPanRef.current;
    if (!activePan) return;
    activePan.detail.onProgress?.({
      deltaX: viewport.x - activePan.startX,
      deltaY: viewport.y - activePan.startY,
    });
  }, []);

  // 节点进场动画（translateY）会让 React Flow 在挂载瞬间测得偏移的 handle 锚点并缓存，
  // 导致连线起止点错位。进场动画结束（落位 translateY:0）后重新测量该节点的 handle。
  useEffect(() => {
    const onAnimEnd = (e: AnimationEvent) => {
      if (e.animationName !== 'nodeIn') return;
      const el = (e.target as HTMLElement | null)?.closest?.('.react-flow__node');
      const id = el?.getAttribute('data-id');
      if (id) updateNodeInternals(id);
    };
    document.addEventListener('animationend', onAnimEnd);
    return () => document.removeEventListener('animationend', onAnimEnd);
  }, [updateNodeInternals]);

  const {
    isDragOver,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onDoubleClick,
  } = useNodeCreation();

  // ── UI toggles (persisted to localStorage) ──
  const [showGrid, setShowGrid] = useState(() => localStorage.getItem('canvas-showGrid') !== 'false');
  const [smoothLine, setSmoothLine] = useState(() => localStorage.getItem('canvas-smoothLine') !== 'false');

  useEffect(() => { localStorage.setItem('canvas-showGrid', String(showGrid)); }, [showGrid]);
  useEffect(() => { localStorage.setItem('canvas-smoothLine', String(smoothLine)); }, [smoothLine]);

  // Sync existing edges when line type changes
  useEffect(() => {
    setEdges(edges.map((e) => ({ ...e, type: smoothLine ? 'smoothstep' : 'default' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smoothLine]);

  // Track the live canvas pointer so keyboard-created nodes can place their top-left corner here.
  const handleCanvasPointer = useCallback(
    (e: React.MouseEvent) => {
      const flowPos = reactFlowInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setCanvasPointerPosition(flowPos);
    },
    [reactFlowInstance],
  );

  const handleCanvasPaneClick = useCallback(() => {
    closeNodeDialog();
  }, [closeNodeDialog]);

  const toggleGrid = useCallback(() => setShowGrid((v) => !v), []);

  // ── Connection drop menu ──
  const {
    menu: connectionMenu,
    menuRef: connectionMenuRef,
    handleConnectEnd,
    handleSelect: handleConnectionMenuSelect,
    connectionMenuMap,
    sourceNode,
  } = useConnectionDropMenu(smoothLine);

  // ── Node context menu ──
  const {
    menu: nodeCtxMenu,
    menuRef: nodeCtxMenuRef,
    openMenu: openNodeCtxMenu,
    handleCopy,
    handleCut,
    handleCopyText,
    handleCutText,
    handleDuplicate,
    handleUngroup,
    handleDelete,
    handleShowInFolder,
    showInFolder,
    handleSaveAs,
    showSaveAs,
    handleOpenInPS,
    showOpenInPS,
    handleOpenInJianying,
    handleOpenInPremiere,
    showOpenInVideoEditor,
    handleCopyMedia,
    showCopyMedia,
    copyMediaLabel,
  } = useNodeContextMenu();
  const isGroupNode = nodeCtxMenu.nodeId
    ? nodes.find((n) => n.id === nodeCtxMenu.nodeId && n.type === 'group') != null
    : false;

  // ── Canvas context menu ──
  const {
    menu: ctxMenu,
    menuRef: ctxMenuRef,
    submenuRef: ctxSubmenuRef,
    openMenu: openCtxMenu,
    addNodeAtCtxPos,
    handleUndo: handleCtxUndo,
    handleRedo: handleCtxRedo,
    handlePaste: handleCtxPaste,
    handleDelete: handleCtxDelete,
    handleCopyNodes: handleCtxCopyNodes,
    handleCopyFiles: handleCtxCopyFiles,
    handleOpenProjectDir: handleCtxOpenProjectDir,
    hasSelection: ctxHasSelection,
    showSubmenu,
    hideSubmenu,
  } = useCanvasContextMenu();

  // ── 右键菜单：统一在「指针抬起且未拖拽」时弹出 ──
  // Windows：右键拖拽平移后松开才触发 contextmenu；macOS：双指（次级点击）按下瞬间即触发。
  // 两端时机不一致，故不依赖原生 contextmenu 开菜单，改为自行追踪右键 pointer：
  // 按下记录起点 → 抬起时若位移超阈值视为平移（不弹），否则按落点判定节点/画布空白再弹。
  // 同时通过 shouldPreventNativeMenu 标志，在全局 contextmenu 事件中阻止浏览器原生右键菜单，
  // 解决窗口底部等 ReactFlow 覆盖不到的区域两个菜单同时出现的问题。
  const shouldPreventNativeMenu = useRef(false);
  useEffect(() => {
    const drag = { x: 0, y: 0, moved: false, down: false };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 2) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved = false;
      drag.down = true;
    };
    const onMove = (e: PointerEvent) => {
      if (!drag.down) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (dx * dx + dy * dy > 25) drag.moved = true; // 位移 > 5px 视为拖拽平移
    };
    const onCancel = () => { drag.down = false; };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 2 || !drag.down) return;
      drag.down = false;
      if (drag.moved && interactionModeRef.current === 'default') return; // 默认交互：右键拖拽平移 → 不弹菜单；传统交互：右键不平移，始终弹菜单

      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el) return;

      const nodeEl = el.closest('.react-flow__node');
      if (nodeEl) {
        const id = nodeEl.getAttribute('data-id');
        if (!id) return;
        shouldPreventNativeMenu.current = true; // 弹出自定义菜单 → 阻止原生菜单
        const syn = {
          preventDefault() {}, stopPropagation() {},
          clientX: e.clientX, clientY: e.clientY, target: el,
        } as unknown as React.MouseEvent;
        openNodeCtxMenu(syn, { id } as RFNode<BaseNodeData>);
        return;
      }

      const paneEl = el.closest('.react-flow__pane');
      if (paneEl) {
        shouldPreventNativeMenu.current = true; // 弹出自定义菜单 → 阻止原生菜单
        const syn = {
          preventDefault() {},
          clientX: e.clientX, clientY: e.clientY, target: paneEl,
        } as unknown as React.MouseEvent;
        openCtxMenu(syn);
      }
    };
    // 全局 contextmenu 监听：若自定义菜单将要弹出，则阻止浏览器原生右键菜单
    const onContextMenu = (e: MouseEvent) => {
      if (shouldPreventNativeMenu.current) {
        e.preventDefault();
        shouldPreventNativeMenu.current = false;
      }
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
  }, [openCtxMenu, openNodeCtxMenu]);

  // ── External clipboard paste (native paste event → DataTransfer) ──
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      // Skip if user is editing an input
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.contentEditable === 'true') return;
      // Skip if internal clipboard has nodes (handled by keyboard shortcut)
      if (useAppStore.getState().clipboard.nodes.length > 0) return;

      e.preventDefault();
      e.stopPropagation();

      const vp = reactFlowInstance.getViewport();
      const centerX = (window.innerWidth / 2 - vp.x) / vp.zoom;
      const centerY = (window.innerHeight / 2 - vp.y) / vp.zoom;
      useAppStore.getState().pasteExternalFromDataTransfer(e.clipboardData, { x: centerX, y: centerY });
    };
    window.addEventListener('paste', handler, true);
    return () => window.removeEventListener('paste', handler, true);
  }, [reactFlowInstance]);

  // ── Fit view event (project switch / F key) ──
  useEffect(() => {
    const handler = () => {
      // Wait one frame for React to finish rendering new nodes/edges
      requestAnimationFrame(() => {
        void reactFlowInstance.fitView(FIT_VIEW_OPTIONS);
      });
    };
    window.addEventListener('canvas-fit-view', handler);
    return () => window.removeEventListener('canvas-fit-view', handler);
  }, [reactFlowInstance]);

  // ── Keep anchored overlays visible by panning the whole canvas ──
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<CanvasPanByDetail>).detail;
      if (!detail) return;
      const { deltaX, deltaY, duration = CANVAS_PAN_DURATION_MS } = detail;
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

      const viewport = reactFlowInstance.getViewport();
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const activePan = {
        startX: viewport.x,
        startY: viewport.y,
        detail,
      };
      activeCanvasPanRef.current = activePan;

      void reactFlowInstance.setViewport(
        {
          x: viewport.x + deltaX,
          y: viewport.y + deltaY,
          zoom: viewport.zoom,
        },
        {
          duration: reduceMotion ? 0 : duration,
          ease: easeOutCubic,
          interpolate: 'linear',
        },
      ).finally(() => {
        if (activeCanvasPanRef.current !== activePan) return;
        const finalViewport = reactFlowInstance.getViewport();
        const progress = {
          deltaX: finalViewport.x - activePan.startX,
          deltaY: finalViewport.y - activePan.startY,
        };
        detail.onProgress?.(progress);
        detail.onComplete?.(progress);
        activeCanvasPanRef.current = null;
      });
    };

    window.addEventListener(CANVAS_PAN_BY_EVENT, handler);
    return () => {
      activeCanvasPanRef.current = null;
      window.removeEventListener(CANVAS_PAN_BY_EVENT, handler);
    };
  }, [reactFlowInstance]);

  // ── Focus node events (history / Agent-created node batch) ──
  useEffect(() => {
    const scheduledFrames = new Set<number>();
    const focusNodes = (
      nodeIds: string[],
      options?: { padding?: number; maxZoom?: number; duration?: number },
    ) => {
      if (nodeIds.length === 0) return;
      const firstFrame = requestAnimationFrame(() => {
        scheduledFrames.delete(firstFrame);
        const secondFrame = requestAnimationFrame(() => {
          scheduledFrames.delete(secondFrame);
          const targetIds = new Set(nodeIds);
          const targetNodes = reactFlowInstance.getNodes().filter((node) => targetIds.has(node.id));
          if (targetNodes.length === 0) return;
          const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          void reactFlowInstance.fitView({
            nodes: targetNodes,
            padding: options?.padding ?? (targetNodes.length === 1 ? 0.45 : 0.3),
            minZoom: targetNodes.length > 6 ? 0.18 : 0.28,
            maxZoom: options?.maxZoom ?? (targetNodes.length === 1 ? 1.1 : 0.95),
            duration: reduceMotion ? 0 : (options?.duration ?? 420),
          });
        });
        scheduledFrames.add(secondFrame);
      });
      scheduledFrames.add(firstFrame);
    };
    const handleSingleNodeFocus = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId: string }>).detail;
      if (detail?.nodeId) focusNodes([detail.nodeId], { maxZoom: 1, duration: 400 });
    };
    const handleNodeBatchFocus = (e: Event) => {
      const detail = (e as CustomEvent<{
        nodeIds: string[];
        padding?: number;
        maxZoom?: number;
        duration?: number;
      }>).detail;
      if (detail?.nodeIds?.length) focusNodes(detail.nodeIds, detail);
    };
    window.addEventListener('canvas-focus-node', handleSingleNodeFocus);
    window.addEventListener('canvas-focus-nodes', handleNodeBatchFocus);
    return () => {
      window.removeEventListener('canvas-focus-node', handleSingleNodeFocus);
      window.removeEventListener('canvas-focus-nodes', handleNodeBatchFocus);
      for (const frameId of scheduledFrames) cancelAnimationFrame(frameId);
    };
  }, [reactFlowInstance]);

  // ── Node click → AI dialog ──
  const openNodeDialog = useAppStore((s) => s.openNodeDialog);
  const inlineEditClickTimerRef = useRef<number | null>(null);
  const openDialogForNode = useCallback(
    (node: RFNode<BaseNodeData>) => {
      const el = document.querySelector(`.react-flow__node[data-id="${node.id}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        openNodeDialog(node.id, { x: rect.left + rect.width / 2, y: rect.bottom });
        return;
      }
      openNodeDialog(node.id);
    },
    [openNodeDialog],
  );

  useEffect(() => () => {
    if (inlineEditClickTimerRef.current !== null) {
      window.clearTimeout(inlineEditClickTimerRef.current);
    }
  }, []);

  const onNodeClick = useCallback(
    (e: React.MouseEvent, node: RFNode<BaseNodeData>) => {
      if (inlineEditClickTimerRef.current !== null) {
        window.clearTimeout(inlineEditClickTimerRef.current);
        inlineEditClickTimerRef.current = null;
      }
      // Shift+click is for multi-select, don't open dialog
      if (e.shiftKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const isEmptyTextEditTrigger = target?.closest('[data-inline-edit-trigger]')
        && node.data?.type === 'ai-text'
        && node.data?.role !== 'source';
      if (isEmptyTextEditTrigger) {
        // 第一次点击先让 React Flow 完成选中；第二次点击会取消弹窗并交给 TextNode 的双击编辑。
        if (e.detail > 1) return;
        inlineEditClickTimerRef.current = window.setTimeout(() => {
          inlineEditClickTimerRef.current = null;
          const latestNode = useAppStore.getState().nodes.find((item) => item.id === node.id);
          if (!latestNode?.selected || latestNode.data.output) return;
          openDialogForNode(latestNode);
        }, INLINE_EDIT_DOUBLE_CLICK_DELAY_MS);
        return;
      }
      // Group / Markdown / source nodes have no AI dialog
      if (node.type === 'group') return;
      if (node.data?.type === 'ai-markdown') return;
      if (node.data?.role === 'source') return;
      if (node.data?.type === 'ai-text' && node.data?.output) return;
      if (node.data?.type === 'ai-image' && node.data?.imageUrl) return;
      if (node.data?.type === 'ai-animation' && node.data?.imageUrl) return;
      if (node.data?.type === 'ai-panorama' && node.data?.imageUrl) return;
      if (node.data?.type === 'ai-video' && node.data?.videoUrl) return;

      openDialogForNode(node);
    },
    [openDialogForNode],
  );

  // ── Selection sync ──
  const onSelectionChange = useCallback(
    (changes: OnSelectionChangeParams) => {
      const sel = changes.nodes;
      const nonGroup = sel.filter((n) => n.type !== 'group');
      // 框选忽略分组节点：与其它节点一同被选中时，store 选区剔除分组（删除/分组不波及容器）；
      // 单独点击分组仍保留（便于删除/解散）。RF 视觉去选在 onSelectionEnd 处理。
      const next = nonGroup.length > 0 ? nonGroup : sel;
      setSelectedNodeIds(next.map((n) => n.id));
    },
    [setSelectedNodeIds],
  );

  // 框选结束后：若分组节点与其它节点一同被框中，取消分组节点的选中，避免随后被一起拖动
  const onSelectionEnd = useCallback(() => {
    clearGroupedSelection();
  }, [clearGroupedSelection]);

  // ── Node snap ──
  const {
    snapLines,
    onNodeDragStart,
    applySnap,
    onNodeDragStop,
    onResizeStart,
    applyResizeSnap,
    onResizeStop,
  } = useNodeSnap();

  // 缩放吸附桥接：稳定引用透传给节点内的 ResizeHandle（经 Context）
  const resizeSnapApi = useMemo(
    () => ({ onResizeStart, applyResizeSnap, onResizeStop }),
    [onResizeStart, applyResizeSnap, onResizeStop],
  );

  // 按住 Ctrl/⌘ 开始拖拽 → 在原位复制一个节点（拖动的仍是原节点，等于"拖出一个副本"）
  const handleNodeDragStart = useCallback(
    (evt: React.MouseEvent, node: RFNode<BaseNodeData>) => {
      setCanvasInteraction('node', true);
      if ((evt.ctrlKey || evt.metaKey) && node.type !== 'group') {
        duplicateNode(node.id);
      }
      onNodeDragStart(evt, node);
    },
    [duplicateNode, onNodeDragStart, setCanvasInteraction],
  );

  // 仅在线型切换时重建，避免每帧新对象触发 React Flow 内部更新
  const defaultEdgeOptions = useMemo(
    () => ({
      type: smoothLine ? 'smoothstep' : 'default',
      style: DEFAULT_EDGE_STYLE,
      animated: false,
    }),
    [smoothLine],
  );

  // 仅派生渲染状态，不把节点选中效果写回可持久化的边数据。
  const renderedEdges = useMemo(() => {
    if (selectedNodeIds.length === 0) return edges;

    const selectedIds = new Set(selectedNodeIds);
    return edges.map((edge) => {
      if (!selectedIds.has(edge.source) && !selectedIds.has(edge.target)) return edge;
      return {
        ...edge,
        type: 'selected-node-flow',
        data: {
          ...edge.data,
          selectedNodeFlowBaseType: edge.type === 'smoothstep' || (!edge.type && smoothLine)
            ? 'smoothstep'
            : 'default',
        },
      };
    });
  }, [edges, selectedNodeIds, smoothLine]);

  // ── Node change handler ──
  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode<BaseNodeData>>[]) => {
      // 把吸附后的位置直接注入 React Flow 的变更管线
      // （成为唯一真相源，避免二次 setNodes 覆盖导致的漂移/橡皮筋）。
      // 注意：松手那一帧 dragging=false 也要吸附，否则会弹回原始落点（位移）。
      // applySnap 在非拖拽期（dragCtx 为空）是无副作用直通，故无需判断 dragging。
      const draggingPosChanges = changes.filter(
        (c) => c.type === 'position' && c.position,
      );
      let snapped = changes;
      if (draggingPosChanges.length > 0) {
        const dc = draggingPosChanges[0];
        if (dc.type === 'position' && dc.position) {
          const snappedPos = applySnap(dc.id, dc.position);
          const correctionX = snappedPos.x - dc.position.x;
          const correctionY = snappedPos.y - dc.position.y;
          const draggedIds = new Set(
            draggingPosChanges.flatMap((change) => change.type === 'position' ? [change.id] : []),
          );
          snapped = changes.map((change) => {
            if (change.type !== 'position' || !change.position || !draggedIds.has(change.id)) return change;
            return {
              ...change,
              position: {
                x: change.position.x + correctionX,
                y: change.position.y + correctionY,
              },
            };
          });
        }
      }

      // Detect group node removals — convert to ungroup
      const removedIds = snapped
        .filter((c) => c.type === 'remove')
        .map((c) => c.id);

      // 快速路径：纯拖拽/选择变更（无删除）—— 用函数式更新，始终基于最新
      // store.nodes，避免快速拖动时闭包 nodes 过期导致的抖动卡顿。
      if (removedIds.length === 0) {
        useAppStore.setState((s) => ({
          nodes: applyNodeChanges(snapped, s.nodes) as RFNode<BaseNodeData>[],
        }));
        return;
      }

      applyStableNodeChanges(snapped);
    },
    [applySnap, applyStableNodeChanges],
  );

  // ── 拖入宫格分镜：进入节点范围显示缩略图，只有空格允许放置 ──
  const sbDropTarget = useRef<HTMLElement | null>(null);
  const [dropGhost, setDropGhost] = useState<{
    url: string;
    x: number;
    y: number;
    canDrop: boolean;
  } | null>(null);
  const ghostNodeId = useRef<string | null>(null);

  const clearGhostNodeHidden = useCallback(() => {
    if (ghostNodeId.current) {
      document.querySelector(`.react-flow__node[data-id="${ghostNodeId.current}"]`)?.classList.remove('sb-drop-hidden');
      ghostNodeId.current = null;
    }
  }, []);

  const clearSbDropTarget = useCallback(() => {
    sbDropTarget.current?.classList.remove('sb-cell--drop-target');
    sbDropTarget.current = null;
  }, []);

  // 按鼠标位置命中宫格节点与真实空格，兼容缩放和非均匀自定义宫格。
  const findStoryboardDropHit = useCallback((
    node: RFNode,
    clientX: number,
    clientY: number,
  ): { storyboard: HTMLElement; emptyCell: HTMLElement | null } | null => {
    if (node.type !== 'ai-image') return null;
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const el of stack) {
      const storyboard = el.closest<HTMLElement>('.storyboard-node');
      if (!storyboard) continue;
      if (storyboard.closest(`.react-flow__node[data-id="${node.id}"]`)) continue;
      const cell = el.closest<HTMLElement>('[data-sb-cell-idx]');
      const emptyCell = cell?.closest('.storyboard-node') === storyboard
        && cell.classList.contains('sb-cell--empty')
        ? cell
        : null;
      return { storyboard, emptyCell };
    }
    return null;
  }, []);

  const handleNodeDrag = useCallback(
    (e: React.MouseEvent, node: RFNode) => {
      const hit = findStoryboardDropHit(node, e.clientX, e.clientY);
      const cell = hit?.emptyCell ?? null;
      if (cell !== sbDropTarget.current) {
        clearSbDropTarget();
        if (cell) { cell.classList.add('sb-cell--drop-target'); sbDropTarget.current = cell; }
      }
      // 进入宫格节点后隐藏真实节点；空格上倾斜表示可放置，占用区域保持水平。
      const url = (node.data?.imageUrl || node.data?.thumbnailUrl) as string | undefined;
      if (hit && url) {
        setDropGhost({ url, x: e.clientX, y: e.clientY, canDrop: cell != null });
        if (ghostNodeId.current !== node.id) {
          clearGhostNodeHidden();
          document.querySelector(`.react-flow__node[data-id="${node.id}"]`)?.classList.add('sb-drop-hidden');
          ghostNodeId.current = node.id;
        }
      } else {
        setDropGhost(null);
        clearGhostNodeHidden();
      }
    },
    [findStoryboardDropHit, clearSbDropTarget, clearGhostNodeHidden],
  );

  // ── Auto group/ungroup on drag stop ──
  const handleNodeDragStop = useCallback(
    (event: React.MouseEvent, node: RFNode) => {
      setCanvasInteraction('node', false);
      const cell = findStoryboardDropHit(node, event.clientX, event.clientY)?.emptyCell ?? null;
      clearSbDropTarget();
      setDropGhost(null);
      clearGhostNodeHidden();
      if (cell) {
        const sbId = cell.closest('.react-flow__node')?.getAttribute('data-id');
        const idx = Number(cell.dataset.sbCellIdx);
        if (sbId && sbId !== node.id && !Number.isNaN(idx)) {
          useAppStore.getState().fillStoryboardCell(sbId, idx, node.id);
          onNodeDragStop();
          return;
        }
      }
      settleNodeGroupingOnDragStop(node as RFNode<BaseNodeData>);
      onNodeDragStop();
    },
    [onNodeDragStop, settleNodeGroupingOnDragStop, findStoryboardDropHit, clearSbDropTarget, clearGhostNodeHidden, setCanvasInteraction],
  );

  return (
    <ResizeSnapContext.Provider value={resizeSnapApi}>
    <div className="absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={renderedEdges}
        onConnect={onConnect}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onNodeClick={onNodeClick}
        onDoubleClick={onDoubleClick}
        onSelectionChange={onSelectionChange}
        onSelectionEnd={onSelectionEnd}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        onlyRenderVisibleElements
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.1}
        maxZoom={5}
        defaultEdgeOptions={defaultEdgeOptions}
        proOptions={PRO_OPTIONS}
        {...interaction}
        onContextMenu={(e) => e.preventDefault()}
        onMove={handleCanvasViewportMove}
        onMoveStart={handleCanvasViewportMoveStart}
        onMoveEnd={handleCanvasViewportMoveEnd}
        onPaneClick={handleCanvasPaneClick}
        onMouseMove={handleCanvasPointer}
        onMouseUp={handleCanvasPointer}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Snap alignment lines */}
        <SnapLinesOverlay lines={snapLines} />

        {/* Grid background */}
        {showGrid && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="var(--theme-hover)"
          />
        )}


        {/* Mini Map — interactive navigator, toggle with M key */}
        {minimapVisible && (
          <>
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeColor={minimapNodeColor}
              nodeStrokeColor="var(--theme-border)"
              nodeStrokeWidth={1.5}
              nodeBorderRadius={35}
              bgColor="var(--theme-surface)"
              maskColor="var(--minimap-mask)"
              maskStrokeColor="var(--brand)"
              maskStrokeWidth={2}
              style={MINIMAP_STYLE}
              className="!bottom-12 !right-1"
            />
            <RoundedMiniMapMask />
          </>
        )}

        {/* Canvas Controls */}
        <Controls
          className="canvas-controls !bg-canvas-card !border-canvas-border !shadow-lg !rounded-xl overflow-hidden"
          showInteractive={false}
        />

        {/* Toolbar */}
        <Panel position="bottom-right" className="flex items-center gap-2">
          <CanvasToolbar
            showGrid={showGrid}
            smoothLine={smoothLine}
            onToggleGrid={toggleGrid}
            onToggleLine={() => setSmoothLine((v) => !v)}
          />
        </Panel>

        {/* Empty state */}
        {nodes.length === 0 && <CanvasEmptyState />}

        {/* Drop zone overlay */}
        {isDragOver && (
          <Panel position="top-left" className="!m-0 !inset-0 pointer-events-none z-50">
            <div className="absolute inset-0 border-2 border-dashed border-indigo-400/60 rounded-2xl m-3 flex items-center justify-center">
            </div>
          </Panel>
        )}

      </ReactFlow>

      {/* Connection drop menu */}
      <ConnectionMenu
        visible={connectionMenu.visible}
        position={connectionMenu.position}
        sourceNodeType={connectionMenu.sourceNodeType}
        sourceNode={sourceNode}
        menuRef={connectionMenuRef}
        onSelect={handleConnectionMenuSelect}
        connectionMenuMap={connectionMenuMap}
      />

      {/* Context menu */}
      <CanvasContextMenu
        visible={ctxMenu.visible}
        position={ctxMenu.position}
        hoverMenu={ctxMenu.hoverMenu}
        menuRef={ctxMenuRef}
        submenuRef={ctxSubmenuRef}
        onAddNode={addNodeAtCtxPos}
        onUndo={handleCtxUndo}
        onRedo={handleCtxRedo}
        onPaste={handleCtxPaste}
        onDelete={handleCtxDelete}
        onCopyNodes={handleCtxCopyNodes}
        onCopyFiles={handleCtxCopyFiles}
        hasSelection={ctxHasSelection}
        onOpenProjectDir={handleCtxOpenProjectDir}
        onShowSubmenu={showSubmenu}
        onHideSubmenu={hideSubmenu}
      />

      {/* Node context menu */}
      <NodeContextMenu
        visible={nodeCtxMenu.visible}
        position={nodeCtxMenu.position}
        menuRef={nodeCtxMenuRef}
        onCopy={handleCopy}
        onCut={handleCut}
        hasTextSelection={nodeCtxMenu.textSelection != null}
        onCopyText={handleCopyText}
        onCutText={handleCutText}
        onDuplicate={handleDuplicate}
        onUngroup={isGroupNode ? handleUngroup : undefined}
        onDelete={handleDelete}
        onShowInFolder={showInFolder ? handleShowInFolder : undefined}
        onSaveAs={showSaveAs ? handleSaveAs : undefined}
        onOpenInPS={showOpenInPS ? handleOpenInPS : undefined}
        onOpenInJianying={showOpenInVideoEditor ? handleOpenInJianying : undefined}
        onOpenInPremiere={showOpenInVideoEditor ? handleOpenInPremiere : undefined}
        onCopyMedia={showCopyMedia ? handleCopyMedia : undefined}
        copyMediaLabel={copyMediaLabel}
      />

      {/* Multi-select toolbar */}
      <MultiSelectToolbar />
    </div>

    {/* 拖入宫格：节点范围内显示缩略图，空格上倾斜表示可放置 */}
    {dropGhost && createPortal(
      <div
        className={`sb-drag-ghost${dropGhost.canDrop ? '' : ' sb-drag-ghost--over-storyboard'}`}
        style={{ left: dropGhost.x, top: dropGhost.y }}
      >
        <div className="sb-drag-ghost-clip">
          <img src={dropGhost.url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      </div>,
      document.body,
    )}
    </ResizeSnapContext.Provider>
  );
}

export default function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
