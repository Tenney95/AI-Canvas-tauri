/**
 * Canvas 画布主组件 — React Flow 画布核心，管理节点/边渲染、拖放、连线、右键菜单、空状态
 */
import { lazy, Suspense, useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ReactFlow,
  ConnectionMode,
  SelectionMode,
  PanOnScrollMode,
  useReactFlow,
  useStoreApi,
  ReactFlowProvider,
  Panel,
  type OnSelectionChangeParams,
  type NodeChange,
  type EdgeTypes,
  type MiniMapProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import TextNode from './nodes/TextNode';
import ImageNode from './nodes/ImageNode';
import VideoNode from './nodes/VideoNode';
import AudioNode from './nodes/AudioNode';
import AnimationNode from './nodes/AnimationNode';
import MarkdownNode from './nodes/MarkdownNode';
import StoryboardNode from './nodes/StoryboardNode';
import ShotlistNode from './nodes/ShotlistNode';
import GroupNode from './nodes/GroupNode';
import CanvasNoteNode from './noteNodes/CanvasNoteNode';
import PluginNode from './nodes/PluginNode';
import AiAppNode from './nodes/AiAppNode';
import NodeRenderBoundary from './nodes/shared/NodeRenderBoundary';
import { CanvasHandleFilter } from './nodes/shared/GooeyBtn';
import CanvasNodeLodBoundary from './nodes/shared/CanvasNodeLodBoundary';
import { CanvasNodeLodContext } from '../hooks/useCanvasNodeLod';
import { createCanvasNodeLodRuntime } from '../services/canvasNodeLodRuntime';
import { getPerformanceModeEnabled, subscribePerformanceMode } from '../services/performanceModeRuntime';
import { waitForCanvasFirstPaint } from '../services/canvasReadyService';
import { isEditableTarget } from '../utils/textSelection';
import { playNodeFocusPulse } from '../utils/nodeAnimations';
import ConnectionMenu from './canvas/ConnectionMenu';
import CanvasContextMenu from './canvas/CanvasContextMenu';
import NodeContextMenu from './canvas/NodeContextMenu';
import CanvasToolbar from './canvas/CanvasToolbar';
import { CanvasGrid, ConnectionDropPreview, SnapLinesOverlay } from './canvas/CanvasGuides';
import { useCanvasViewportInteraction } from './canvas/useCanvasViewportInteraction';
import EpisodeWorkbench from './canvas/EpisodeWorkbench';
import CanvasDrawingToolbar from './canvas/CanvasDrawingToolbar';
import CanvasNoteStylePanel from './canvas/CanvasNoteStylePanel';
import RoundedMiniMapMask from './canvas/RoundedMiniMapMask';
import MiniMapNodeStats from './canvas/MiniMapNodeStats';
import MultiSelectToolbar from './canvas/MultiSelectToolbar';
import SelectionConnectionHandle from './canvas/SelectionConnectionNode';
import CanvasEmptyState from './canvas/CanvasEmptyState';
import HistoryTimelinePanel from './canvas/HistoryTimelinePanel';
import SelectedNodeFlowEdge from './canvas/SelectedNodeFlowEdge';
import CanvasEdgeLayer from './canvas/CanvasEdgeLayer';
import CanvasFarNodeLayer from './canvas/CanvasFarNodeLayer';
import { installCanvasFarNodeBenchmark } from '../services/canvasFarNodeBenchmark';
import { canUseCanvasFarNodeLayer } from '../services/canvasFarNodeMode';
import { CanvasEdgePanePointerContext, useCanvasEdgePanePointer } from '../hooks/useCanvasEdgePanePointer';
import CanvasRadialMenu, { CanvasLongPressIndicator } from './canvas/CanvasRadialMenu';
import NodePluginToolDialog from './nodes/shared/toolbar/NodePluginToolDialog';
import NodeOutputDownloadDialog from './shared/NodeOutputDownloadDialog';
import { useConnectionDropMenu } from '../hooks/useConnectionDropMenu';
import { useCanvasContextMenu } from '../hooks/useCanvasContextMenu';
import { useNodeContextMenu } from '../hooks/useNodeContextMenu';
import { useCanvasSecondaryClickMenu } from '../hooks/useCanvasSecondaryClickMenu';
import { useCanvasLongPressRadialMenu } from '../hooks/useCanvasLongPressRadialMenu';
import { useAppStore } from '../store/useAppStore';
import { createFrameCoalescer } from '../utils/frameCoalescer';
import { createNodeDuplicateDrag, filterHiddenCanvasElements, isBatchConnectableNode, isCanvasConnectionValid } from '../store/store.nodes';
import {
  createCanvasEdgeProjection,
  createCanvasNodeProjectionCache,
  getCanvasNodeById,
  hydrateCanvasNodeChanges,
  hydrateCanvasNodeData,
  projectCanvasNodesForReactFlow,
  projectSelectedCanvasEdges,
  projectTransientCanvasNode,
  syncCanvasNodeIndex,
} from '../utils/canvasRenderProjection';
import { useNodeCreation } from '../hooks/useNodeCreation';
import { useCanvasDrawing } from '../hooks/useCanvasDrawing';
import { useCanvasViewportPreferences } from '../hooks/useCanvasViewportPreferences';
import ViewportImage from './shared/ViewportImage';
import type { BaseNodeData } from '../types';
import type { CanvasEdgeDisplayMode } from '../types/canvasEdges';
import { isWsagentSharedImagesNode } from '../types/wsagentShared';
import { isShotRowBlank, SHOTLIST_FRAME_SOURCE_TYPES, STORYBOARD_CELL_SOURCE_TYPES } from '../types';
import type { Node as RFNode, NodeProps, NodeTypes } from '@xyflow/react';
import { useNodeSnap, ResizeSnapContext } from '../hooks/useNodeSnap';
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

const CharacterAssetDialog = lazy(() => import('./CharacterAssetDialog'));

// ── Node types mapping ──
/**
 * 给每个节点组件包一层错误边界：单个节点渲染抛错（脏数据、导入文件、旧版迁移残留）
 * 只降级成一张占位卡，画布其余部分继续可用。
 * 只在模块顶层调用一次 —— React Flow 要求 nodeTypes 与其中的组件身份保持稳定。
 */
function withNodeRenderBoundaries(types: NodeTypes): NodeTypes {
  return Object.fromEntries(Object.entries(types).map(([typeName, NodeComponent]) => {
    const mediaLod = typeName === 'ai-image' || typeName === 'source-image'
      || typeName === 'ai-video' || typeName === 'source-video';
    const Bounded = (props: NodeProps) => {
      const liveData = useAppStore((state) => getCanvasNodeById(state.nodes, props.id)?.data);
      const data = liveData ?? props.data;
      return (
        <NodeRenderBoundary nodeId={props.id} typeName={typeName} data={data}>
          {mediaLod ? (
            <CanvasNodeLodBoundary node={props} data={data as BaseNodeData} video={typeName.endsWith('video')}>
              <NodeComponent {...props} data={data} />
            </CanvasNodeLodBoundary>
          ) : <NodeComponent {...props} data={data} />}
        </NodeRenderBoundary>
      );
    };
    Bounded.displayName = `NodeBoundary(${typeName})`;
    return [typeName, Bounded] as const;
  }));
}

const nodeTypes: NodeTypes = withNodeRenderBoundaries({
  'ai-text': TextNode,
  'ai-image': ImageNode,
  'ai-video': VideoNode,
  'ai-audio': AudioNode,
  'ai-animation': AnimationNode,
  'ai-panorama': PanoramaNode,
  'ai-markdown': MarkdownNode,
  'ai-storyboard': StoryboardNode,
  'ai-shotlist': ShotlistNode,
  'ai-director': DirectorDeskNode,
  'source-text': TextNode,
  'source-image': ImageNode,
  'source-video': VideoNode,
  'source-audio': AudioNode,
  comment: TextNode,
  group: GroupNode,
  'canvas-note': CanvasNoteNode,
  'plugin-node': PluginNode,
  'ai-app': AiAppNode,
});

const sharedEdgeType = Object.assign(SelectedNodeFlowEdge, { renderLayer: CanvasEdgeLayer });
if (canUseCanvasFarNodeLayer()) Object.assign(nodeTypes['source-image'], { renderFarLayer: CanvasFarNodeLayer });
const edgeTypes: EdgeTypes = {
  default: sharedEdgeType,
  smoothstep: SelectedNodeFlowEdge,
  'selected-node-flow': SelectedNodeFlowEdge,
};

// Unmount edge visuals and geometry subscriptions while keeping Flow's connection index.
function HiddenCanvasEdges() { return null; }
const hiddenEdgeType = Object.assign(HiddenCanvasEdges, { renderLayer: HiddenCanvasEdges });
const hiddenEdgeTypes: EdgeTypes = {
  default: hiddenEdgeType,
  smoothstep: hiddenEdgeType,
  'selected-node-flow': hiddenEdgeType,
};

// ── Stable ReactFlow props (hoisted to avoid new identities every render,
//    which makes React Flow re-run internal effects and drop frames on drag) ──
const PRO_OPTIONS = { hideAttribution: true };
const PAN_ON_DRAG_DEFAULT = [1, 2]; // 默认交互：右键(2) + 中键(1) 拖拽平移
const PAN_ON_DRAG_CLASSIC = [0];    // 传统交互：左键(0) 拖拽平移
const DEFAULT_EDGE_STYLE = { stroke: 'var(--canvas-edge)', strokeWidth: 1.5 };
const isMacDesktop = typeof window !== 'undefined' && '__TAURI__' in window
  && typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent);
const easeOutCubic = (progress: number) => 1 - (1 - progress) ** 3;
// ── 交互模式预设（冻结对象，避免每次 render 产生新身份，导致 React Flow 内部 effect 重跑、拖拽掉帧）──
const DEFAULT_INTERACTION = Object.freeze({
  // Mac 双指滑动继续平移；普通鼠标由原生层识别后单独交给缩放 Hook。
  panOnScroll: isMacDesktop,
  zoomOnScroll: !isMacDesktop,
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
const INLINE_EDIT_DOUBLE_CLICK_DELAY_MS = 280;

interface CanvasProps {
  onReady?: (projectId: string) => void;
}

function CanvasInner({ onReady }: CanvasProps) {
  useEffect(() => {
    if (import.meta.env.DEV) return installCanvasFarNodeBenchmark();
  }, []);
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const renderableGraph = useMemo(
    () => filterHiddenCanvasElements(nodes, edges),
    [edges, nodes],
  );
  const selectedNodeIds = useAppStore((s) => s.selectedNodeIds);
  const connectableSelectionCount = useMemo(() => {
    if (selectedNodeIds.length < 2) return 0;
    const selected = new Set(selectedNodeIds);
    const collapsed = new Set(nodes.filter((node) => node.data.groupCollapsed).map((node) => node.id));
    return nodes.filter((node) => selected.has(node.id) && isBatchConnectableNode(node)
      && !(node.parentId && collapsed.has(node.parentId))).length;
  }, [nodes, selectedNodeIds]);
  const connectNode = useAppStore((s) => s.onConnect);
  const setEdges = useAppStore((s) => s.setEdges);
  const setSelectedNodeIds = useAppStore((s) => s.setSelectedNodeIds);
  const applyStableNodeChanges = useAppStore((s) => s.onNodesChange);
  const handleEdgesChange = useAppStore((s) => s.onEdgesChange);
  const clearGroupedSelection = useAppStore((s) => s.clearGroupedSelection);
  const settleNodeGroupingOnDragStop = useAppStore((s) => s.settleNodeGroupingOnDragStop);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const minimapVisible = useAppStore((s) => s.minimapVisible);
  const closeNodeDialog = useAppStore((s) => s.closeNodeDialog);
  const interactionMode = useAppStore((s) => s.config.interactionMode ?? 'default');
  const canvasBackground = useAppStore((s) => s.config.canvasBackground ?? 'default');
  const appearance = useAppStore((s) => s.config.appearance);
  const appearancePreview = useAppStore((s) => s.appearancePreview);
  const defaultDarkBackgroundShade = useAppStore((s) => s.config.defaultDarkBackgroundShade ?? 20);
  const offWhiteBackgroundColor = useAppStore((s) => s.config.offWhiteBackgroundColor ?? '#F4F6FB');
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const canvasNoteToolbarVisible = useAppStore((s) => s.config.canvasNoteToolbarVisible !== false);
  const [nodeProjectionCache] = useState(createCanvasNodeProjectionCache);
  const interaction = interactionMode === 'classic' ? CLASSIC_INTERACTION : DEFAULT_INTERACTION;
  // 右键 effect 用 ref 读取模式，避免把 interactionMode 加进 effect 依赖而导致监听器重挂
  const interactionModeRef = useRef(interactionMode);
  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);
  useEffect(() => {
    syncCanvasNodeIndex(nodes);
  }, [nodes]);
  const reactFlowInstance = useReactFlow();
  const flowStore = useStoreApi();
  const wheelZoomCancelRef = useRef<(() => void) | null>(null);
  const canvasRootRef = useRef<HTMLDivElement>(null);
  const viewportPreferences = useCanvasViewportPreferences(canvasRootRef, wheelZoomCancelRef);
  const {
    fitView: fitCanvasView,
    autoFit: autoFitCanvas,
    beginUserMove,
    endUserMove,
    restoreInitialView,
    markViewportReady,
      } = viewportPreferences;
  const readyProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!viewportPreferences.hydrated || !currentProjectId || readyProjectRef.current === currentProjectId
      || !reactFlowInstance.viewportInitialized) return;
    // 不依赖节点数组：测量写回会持续替换数组，不能反复取消、重启首帧等待。
    return waitForCanvasFirstPaint(
      restoreInitialView,
      () => {
        readyProjectRef.current = currentProjectId;
        markViewportReady();
        onReady?.(currentProjectId);
      },
    );
  }, [currentProjectId, onReady, reactFlowInstance, restoreInitialView, markViewportReady, viewportPreferences.hydrated]);
  const lodSession = useMemo(() => ({
    projectId: currentProjectId,
    runtime: createCanvasNodeLodRuntime(reactFlowInstance.getViewport().zoom, undefined, getPerformanceModeEnabled()),
  }), [currentProjectId, reactFlowInstance]);
  const nodeLodRuntime = lodSession.runtime;
  useEffect(() => {
    nodeLodRuntime.setPerformanceMode(getPerformanceModeEnabled());
    return subscribePerformanceMode(() => nodeLodRuntime.setPerformanceMode(getPerformanceModeEnabled()));
  }, [nodeLodRuntime]);
  const {
    activeCanvasPanRef, beginCanvasInteraction, endCanvasInteraction,
    handleCanvasViewportMove, handleCanvasViewportMoveStart, handleCanvasViewportMoveEnd,
  } = useCanvasViewportInteraction({
    reactFlowInstance, flowStore, viewportPreferences, nodeLodRuntime, canvasRootRef,
    wheelZoomCancelRef, interactionMode, isMacDesktop, currentProjectId,
  });

  const {
    isDragOver,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onDoubleClick,
  } = useNodeCreation();

  const {
    activeTool: activeDrawingTool,
    chooseTool: chooseDrawingTool,
    selectedNoteNode,
    panelNote,
    pendingImage,
    draftNode,
    applyNotePatch,
    beginNoteChange,
    endNoteChange,
    duplicateSelectedNote,
    deleteSelectedNote,
    moveSelectedNoteLayer,
    requestCrop,
    handlePointerDownCapture: handleDrawingPointerDown,
    handlePointerMoveCapture: handleDrawingPointerMove,
    handlePointerUpCapture: handleDrawingPointerUp,
    handlePointerCancelCapture: handleDrawingPointerCancel,
  } = useCanvasDrawing();

  useEffect(() => {
    if (!canvasNoteToolbarVisible && activeDrawingTool !== 'select') {
      chooseDrawingTool('select');
    }
  }, [activeDrawingTool, canvasNoteToolbarVisible, chooseDrawingTool]);

  const drawingActive = activeDrawingTool !== 'select';
  const drawingInteraction = useMemo(() => ({
    ...interaction,
    ...(drawingActive ? {
      panOnDrag: false,
      selectionOnDrag: false,
    } : {}),
    // React Flow 会忽略变回 undefined 的受控属性，因此结束绘图时必须显式恢复。
    nodesDraggable: !drawingActive,
    elementsSelectable: !drawingActive,
  }), [drawingActive, interaction]);

  // ── UI toggles (persisted to localStorage) ──
  const [showGrid, setShowGrid] = useState(() => localStorage.getItem('canvas-showGrid') !== 'false');
  const darkShade = Math.min(58, Math.max(0, defaultDarkBackgroundShade));
  const lightColor = /^#[0-9a-f]{6}$/i.test(offWhiteBackgroundColor) ? offWhiteBackgroundColor : '#F4F6FB';
  const lightDotColor = `rgb(${[1, 3, 5].map((start) => (
    Math.max(0, parseInt(lightColor.slice(start, start + 2), 16) - 72)
  )).join(' ')})`;
  const appearanceCanvas = (appearancePreview ?? appearance)?.canvas;
  const gridDotColor = appearanceCanvas?.gridColor ?? (canvasBackground === 'default'
    ? `rgb(${darkShade + 68} ${darkShade + 68} ${darkShade + 84})`
    : canvasBackground === 'off-white' ? lightDotColor : 'var(--theme-hover)');
  const appearanceGridVisible = appearanceCanvas?.gridVisible ?? true;
  const [edgeDisplayMode, setEdgeDisplayMode] = useState<CanvasEdgeDisplayMode>(() => {
    const saved = localStorage.getItem('canvas-edgeDisplayMode');
    if (saved === 'orthogonal' || saved === 'curved' || saved === 'hidden') return saved;
    return localStorage.getItem('canvas-smoothLine') === 'false' ? 'curved' : 'orthogonal';
  });
  const smoothLine = edgeDisplayMode === 'orthogonal';
  const edgePanePointer = useCanvasEdgePanePointer(!drawingActive && edgeDisplayMode !== 'hidden');
  const {
    position: radialMenuPosition,
    holdPosition: radialMenuHoldPosition,
    close: closeRadialMenu,
  } = useCanvasLongPressRadialMenu(canvasRootRef, !drawingActive, edgePanePointer.isEdgeAtPoint);

  useEffect(() => { localStorage.setItem('canvas-showGrid', String(showGrid)); }, [showGrid]);
  useEffect(() => { localStorage.setItem('canvas-edgeDisplayMode', edgeDisplayMode); }, [edgeDisplayMode]);
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

      const toolbar = e.target instanceof Element
        ? e.target.closest<HTMLElement>('.node-floating-toolbar')
        : null;
      if (toolbar) {
        const rect = toolbar.getBoundingClientRect();
        toolbar.style.setProperty('--toolbar-pointer-x', `${((e.clientX - rect.left) / rect.width) * 100}%`);
        toolbar.style.setProperty('--toolbar-pointer-y', `${((e.clientY - rect.top) / rect.height) * 100}%`);
      }
    },
    [reactFlowInstance],
  );

  const cancelClickConnection = useCallback(() => {
    if (flowStore.getState().connectionClickStartHandle) {
      flowStore.setState({ connectionClickStartHandle: null });
    }
  }, [flowStore]);

  useEffect(() => {
    cancelClickConnection();
  }, [cancelClickConnection, currentProjectId]);

  const handleCanvasPaneClick = useCallback(() => {
    cancelClickConnection();
    closeNodeDialog();
  }, [cancelClickConnection, closeNodeDialog]);

  const toggleGrid = useCallback(() => setShowGrid((v) => !v), []);
  const toggleLine = useCallback(() => {
    setEdgeDisplayMode((mode) => mode === 'orthogonal' ? 'curved'
      : mode === 'curved' ? 'hidden' : 'orthogonal');
  }, []);
  const handleMiniMapClick = useCallback<NonNullable<MiniMapProps['onClick']>>((event, position) => {
    const state = useAppStore.getState();
    if (event.button !== 0 || !state.configHydrated || state.currentProjectId !== currentProjectId
      || !reactFlowInstance.viewportInitialized) return;
    wheelZoomCancelRef.current?.();
    beginUserMove();
    // 小地图已返回画布坐标；显式保留倍率，避免 setCenter 默认放大。
    void reactFlowInstance.setCenter(position.x, position.y, {
      zoom: reactFlowInstance.getZoom(),
    }).finally(endUserMove);
  }, [beginUserMove, currentProjectId, endUserMove, reactFlowInstance]);

  // ── Connection drop menu ──
  const {
    menu: connectionMenu,
    menuRef: connectionMenuRef,
    handleConnectEnd,
    handleSelect: handleConnectionMenuSelect,
    connectionMenuMap,
    sourceNode,
    openSelectionMenu,
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
    handleRename,
    showRename,
    handleToggleLock,
    isNodeLocked,
    handleConvertImage,
    showImageConversion,
    imageConversionLabel,
    handleUngroup,
    handleOpenGroupFolder,
    handleDelete,
    handleShowInFolder,
    showInFolder,
    handleCopyFilePath,
    handleSaveAs,
    showSaveAs,
    cancelSaveAsDownload,
    handleOpenInPS,
    showOpenInPS,
    handleEditVideo,
    showEditVideo,
    editVideoLabel,
    handleOpenInJianying,
    handleOpenInPremiere,
    showOpenInVideoEditor,
    handleCopyMedia,
    showCopyMedia,
    copyMediaLabel,
    characterCaptureNodeId,
    handleAddToCharacter,
    closeCharacterCapture,
    showAddToCharacter,
    pluginTools,
    handlePluginTool,
    pendingPluginTool,
    closePluginToolDialog,
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
    addPluginNodeAtCtxPos,
    pluginNodes,
    handleUndo: handleCtxUndo,
    handleRedo: handleCtxRedo,
    handlePaste: handleCtxPaste,
    handleCreateFolder: handleCtxCreateFolder,
    handleDelete: handleCtxDelete,
    handleCopyNodes: handleCtxCopyNodes,
    handleCopyFiles: handleCtxCopyFiles,
    handleOpenProjectDir: handleCtxOpenProjectDir,
    hasSelection: ctxHasSelection,
    showSubmenu,
    hideSubmenu,
  } = useCanvasContextMenu();

  useCanvasSecondaryClickMenu({
    interactionModeRef,
    openNodeMenu: openNodeCtxMenu,
    openCanvasMenu: openCtxMenu,
  });

  // ── External clipboard paste (native paste event → DataTransfer) ──
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      if (useAppStore.getState().projectWorkspaceView === 'script') return;
      // Skip if user is editing an input
      if (isEditableTarget(e.target)) return;
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
    let frame = 0;
    const handler = (event: Event) => {
      wheelZoomCancelRef.current?.();
      // Wait one frame for React to finish rendering new nodes/edges
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const source = (event as CustomEvent<{ source?: string }>).detail?.source;
        if (source === 'user') autoFitCanvas();
        else void restoreInitialView();
      });
    };
    window.addEventListener('canvas-fit-view', handler);
    return () => {
      window.removeEventListener('canvas-fit-view', handler);
      cancelAnimationFrame(frame);
    };
  }, [autoFitCanvas, restoreInitialView]);

  // ── Keep anchored overlays visible by panning the whole canvas ──
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<CanvasPanByDetail>).detail;
      if (!detail) return;
      const { deltaX, deltaY, duration = CANVAS_PAN_DURATION_MS } = detail;
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

      wheelZoomCancelRef.current?.();
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
  }, [activeCanvasPanRef, reactFlowInstance]);

  // ── Focus node events (history / Agent-created node batch) ──
  useEffect(() => {
    const scheduledFrames = new Set<number>();
    const scheduledTimers = new Set<number>();
    const focusNodes = (
      nodeIds: string[],
      options?: { padding?: number; maxZoom?: number; duration?: number; pulse?: boolean },
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
          const duration = reduceMotion ? 0 : (options?.duration ?? 420);
          void fitCanvasView({
            nodes: targetNodes,
            padding: options?.padding ?? (targetNodes.length === 1 ? 0.45 : 0.3),
            minZoom: targetNodes.length > 6 ? 0.18 : 0.28,
            maxZoom: options?.maxZoom ?? (targetNodes.length === 1 ? 1.1 : 0.95),
            duration,
          });
          // 单个节点定位后补一记「放大 → 回弹」脉冲，等镜头停稳再播
          if (options?.pulse && nodeIds.length === 1 && !reduceMotion) {
            const [nodeId] = nodeIds;
            const timer = window.setTimeout(() => {
              scheduledTimers.delete(timer);
              playNodeFocusPulse(nodeId);
            }, duration + 90);
            scheduledTimers.add(timer);
          }
        });
        scheduledFrames.add(secondFrame);
      });
      scheduledFrames.add(firstFrame);
    };
    const handleSingleNodeFocus = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId: string; pulse?: boolean }>).detail;
      if (detail?.nodeId) {
        focusNodes([detail.nodeId], { maxZoom: 1, duration: 400, pulse: detail.pulse });
      }
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
      for (const timerId of scheduledTimers) window.clearTimeout(timerId);
    };
  }, [reactFlowInstance, fitCanvasView]);

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
      const liveNode = hydrateCanvasNodeData(node, useAppStore.getState().nodes);
      if (inlineEditClickTimerRef.current !== null) {
        window.clearTimeout(inlineEditClickTimerRef.current);
        inlineEditClickTimerRef.current = null;
      }
      // Shift+click is for multi-select, don't open dialog
      if (e.shiftKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const isEmptyTextEditTrigger = target?.closest('[data-inline-edit-trigger]')
        && liveNode.data?.type === 'ai-text'
        && liveNode.data?.role !== 'source';
      if (isEmptyTextEditTrigger) {
        // 第一次点击先让 React Flow 完成选中；第二次点击会取消弹窗并交给 TextNode 的双击编辑。
        if (e.detail > 1) return;
        inlineEditClickTimerRef.current = window.setTimeout(() => {
          inlineEditClickTimerRef.current = null;
          const latestNode = getCanvasNodeById(useAppStore.getState().nodes, liveNode.id);
          if (!latestNode?.selected || latestNode.data.output) return;
          openDialogForNode(latestNode);
        }, INLINE_EDIT_DOUBLE_CLICK_DELAY_MS);
        return;
      }
      // 硬边界：这几类节点没有任何可用的 AI 对话框。
      // group / ai-markdown 与空格键（useKeyboardShortcuts.ts）的 canOpen 规则一致；
      // canvas-note 的 data.type 是 'canvas-note'，一旦唤起会让 AINodeDialog 给 PromptPanel 传入
      // 未知 nodeType，所以点击路径上一律不打开，只能走它自己的绘图/文本交互。
      const isNeverDialogNode =
        liveNode.type === 'group' ||
        liveNode.type === 'canvas-note' ||
        liveNode.data?.type === 'ai-markdown' ||
        isWsagentSharedImagesNode(liveNode.data);
      if (isNeverDialogNode) {
        // 用户已经切换了选中节点，关闭可能仍停留在上一个节点上的对话框，避免浮层卡在错处。
        closeNodeDialog();
        return;
      }

      // 帧动画单击只选中，双击由节点打开编辑器；生成通过节点按钮或空格键进入。
      if (liveNode.data?.type === 'ai-animation') {
        closeNodeDialog();
        return;
      }

      // 已有内容的节点单击只选中，即使之前已有对话框；按空格或显式生成按钮再打开。
      const isSilentOnClick =
        liveNode.data?.role === 'source' ||
        (liveNode.data?.type === 'ai-text' && liveNode.data?.output) ||
        (liveNode.data?.type === 'ai-image' && liveNode.data?.imageUrl) ||
        (liveNode.data?.type === 'ai-panorama' && liveNode.data?.imageUrl) ||
        (liveNode.data?.type === 'ai-video' && liveNode.data?.videoUrl) ||
        (liveNode.data?.type === 'ai-audio' && liveNode.data?.audioUrl) ||
        (liveNode.data?.type === 'ai-shotlist' && liveNode.data.shotlistRows?.some((row) => !isShotRowBlank(row)));
      if (isSilentOnClick) {
        closeNodeDialog();
        return;
      }

      openDialogForNode(liveNode);
    },
    [openDialogForNode, closeNodeDialog],
  );

  // ── Selection sync ──
  const onSelectionChange = useCallback(
    (changes: OnSelectionChangeParams) => {
      // 框选及项目恢复也可能选中边，隐藏时始终保留节点选区、取消不可见的边选区。
      if (edgeDisplayMode === 'hidden' && changes.edges.length) {
        handleEdgesChange(changes.edges.map((edge) => ({ id: edge.id, type: 'select', selected: false })));
      }
      const sel = changes.nodes;
      const nonGroup = sel.filter((n) => n.type !== 'group');
      // 框选忽略分组节点：与其它节点一同被选中时，store 选区剔除分组（删除/分组不波及容器）；
      // 单独点击分组仍保留（便于删除/解散）。RF 视觉去选在 onSelectionEnd 处理。
      const next = nonGroup.length > 0 ? nonGroup : sel;
      setSelectedNodeIds(next.map((n) => n.id));
    },
    [edgeDisplayMode, handleEdgesChange, setSelectedNodeIds],
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

  const duplicateDrag = useRef<ReturnType<typeof createNodeDuplicateDrag> | null>(null);

  // Alt 拖出副本，兼容已有 Ctrl/⌘ 手势；原节点及其引用留在原位。
  const handleNodeDragStart = useCallback(
    (evt: React.MouseEvent, node: RFNode<BaseNodeData>) => {
      const liveNode = hydrateCanvasNodeData(node, useAppStore.getState().nodes);
      beginCanvasInteraction('node');
      if (liveNode.type === 'canvas-note') commitToHistory();
      onNodeDragStart(evt, liveNode);
      duplicateDrag.current = (evt.altKey || evt.ctrlKey || evt.metaKey) && liveNode.type !== 'group'
        ? createNodeDuplicateDrag(useAppStore.getState, liveNode.id)
        : null;
    },
    [beginCanvasInteraction, commitToHistory, onNodeDragStart],
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

  const projectedCanvasNodes = useMemo(
    () => projectCanvasNodesForReactFlow(renderableGraph.nodes, nodeProjectionCache),
    [nodeProjectionCache, renderableGraph.nodes],
  );
  const renderedCanvasNodes = useMemo(
    () => draftNode ? [...projectedCanvasNodes, projectTransientCanvasNode(draftNode)] : projectedCanvasNodes,
    [draftNode, projectedCanvasNodes],
  );

  // 仅派生渲染状态，不把隐藏和节点选中效果写回可持久化的边数据。
  const edgeProjection = useMemo(
    () => createCanvasEdgeProjection(renderableGraph.edges),
    [renderableGraph.edges],
  );
  const renderedEdges = useMemo(() => {
    return projectSelectedCanvasEdges(edgeProjection, selectedNodeIds, smoothLine);
  }, [edgeProjection, selectedNodeIds, smoothLine]);

  // ── Node change handler ──
  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode<BaseNodeData>>[]) => {
      const currentNodes = useAppStore.getState().nodes;
      const hydratedChanges = hydrateCanvasNodeChanges(changes, currentNodes);
      const unlockedChanges = hydratedChanges.filter(
        (change) => change.type !== 'position' || getCanvasNodeById(currentNodes, change.id)?.draggable !== false,
      );
      if (unlockedChanges.length === 0) return;

      // 把吸附后的位置直接注入 React Flow 的变更管线
      // （成为唯一真相源，避免二次 setNodes 覆盖导致的漂移/橡皮筋）。
      // 注意：松手那一帧 dragging=false 也要吸附，否则会弹回原始落点（位移）。
      // applySnap 在非拖拽期（dragCtx 为空）是无副作用直通，故无需判断 dragging。
      const draggingPosChanges = unlockedChanges.filter(
        (c) => c.type === 'position' && c.position,
      );
      let snapped = unlockedChanges;
      if (draggingPosChanges.length > 0) {
        const dc = draggingPosChanges[0];
        if (dc.type === 'position' && dc.position) {
          const snappedPos = applySnap(dc.id, dc.position);
          const correctionX = snappedPos.x - dc.position.x;
          const correctionY = snappedPos.y - dc.position.y;
          const draggedIds = new Set(
            draggingPosChanges.flatMap((change) => change.type === 'position' ? [change.id] : []),
          );
          snapped = unlockedChanges.map((change) => {
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

      if (duplicateDrag.current) snapped = duplicateDrag.current.mapChanges(snapped);

      // Store Action 基于最新节点应用位移，并统一处理分组删除。
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
  const shotlistDropTarget = useRef<HTMLElement | null>(null);

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

  const clearShotlistDropTarget = useCallback(() => {
    shotlistDropTarget.current?.classList.remove('shot-frame--drop-target');
    shotlistDropTarget.current = null;
  }, []);

  // 拖到折叠分组（文件夹）上：文件夹打开，被拖节点缩小并微微倾斜
  const folderDropTarget = useRef<HTMLElement | null>(null);
  const folderDropNode = useRef<HTMLElement | null>(null);
  const clearFolderDropTarget = useCallback(() => {
    folderDropTarget.current?.classList.remove('is-folder-drop-target');
    folderDropTarget.current = null;
    folderDropNode.current?.classList.remove('folder-drop-shrink');
    folderDropNode.current = null;
  }, []);

  /**
   * 命中分镜表的画面格。
   * 与宫格不同，已绑定的格子也接受放置——直接换绑，比先解绑再拖一次顺手。
   */
  const findShotlistDropHit = useCallback((
    node: RFNode,
    stack: readonly Element[],
  ): HTMLElement | null => {
    if (!SHOTLIST_FRAME_SOURCE_TYPES.includes(node.type ?? '')) return null;
    for (const el of stack) {
      const shotlist = el.closest<HTMLElement>('.shotlist-node');
      if (!shotlist) continue;
      if (shotlist.closest(`.react-flow__node[data-id="${node.id}"]`)) continue;
      const cell = el.closest<HTMLElement>('[data-shot-frame-row], [data-shot-video-row]');
      if (cell?.dataset.shotVideoRow && node.type !== 'ai-video' && node.type !== 'source-video') return null;
      return cell?.closest('.shotlist-node') === shotlist ? cell : null;
    }
    return null;
  }, []);

  // 按鼠标位置命中宫格节点与真实空格，兼容缩放和非均匀自定义宫格。
  const findStoryboardDropHit = useCallback((
    node: RFNode,
    stack: readonly Element[],
  ): { storyboard: HTMLElement; emptyCell: HTMLElement | null } | null => {
    if (!STORYBOARD_CELL_SOURCE_TYPES.includes(node.type ?? '')) return null;
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

  const updateDragPreview = useCallback(
    ({ clientX, clientY, node: draggedNode, projectId }: { clientX: number; clientY: number; node: RFNode; projectId: string | null }) => {
      const state = useAppStore.getState();
      if (state.currentProjectId !== projectId || !getCanvasNodeById(state.nodes, draggedNode.id)) return;
      let node = draggedNode;
      if (duplicateDrag.current?.sourceId === node.id) {
        const clone = duplicateDrag.current.getNode();
        if (!clone) return;
        node = clone;
      }
      const liveNode = hydrateCanvasNodeData(
        node as RFNode<BaseNodeData>,
        useAppStore.getState().nodes,
      );
      const stack = node.type === 'group' ? [] : document.elementsFromPoint(clientX, clientY);
      const folder = node.type === 'group'
        ? null
        : stack
          .map((el) => el.closest<HTMLElement>('.canvas-group-folder'))
          .find((el): el is HTMLElement => el != null) ?? null;
      if (folder !== folderDropTarget.current) {
        clearFolderDropTarget();
        if (folder) {
          folder.classList.add('is-folder-drop-target');
          folderDropTarget.current = folder;
          const dragged = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${node.id}"]`);
          dragged?.classList.add('folder-drop-shrink');
          folderDropNode.current = dragged;
        }
      }

      const hit = findStoryboardDropHit(node, stack);
      const cell = hit?.emptyCell ?? null;
      if (cell !== sbDropTarget.current) {
        clearSbDropTarget();
        if (cell) { cell.classList.add('sb-cell--drop-target'); sbDropTarget.current = cell; }
      }
      // 进入宫格节点后隐藏真实节点；空格上倾斜表示可放置，占用区域保持水平。
      const url = (liveNode.data?.imageUrl || liveNode.data?.thumbnailUrl) as string | undefined;
      if (hit && url) {
        setDropGhost({ url, x: clientX, y: clientY, canDrop: cell != null });
        if (ghostNodeId.current !== node.id) {
          clearGhostNodeHidden();
          document.querySelector(`.react-flow__node[data-id="${node.id}"]`)?.classList.add('sb-drop-hidden');
          ghostNodeId.current = node.id;
        }
      } else {
        setDropGhost(null);
        clearGhostNodeHidden();
      }

      // 分镜表画面格：只做高亮，不隐藏被拖的节点——绑定后它仍要留在画布上
      const frameCell = findShotlistDropHit(node, stack);
      if (frameCell !== shotlistDropTarget.current) {
        clearShotlistDropTarget();
        if (frameCell) {
          frameCell.classList.add('shot-frame--drop-target');
          shotlistDropTarget.current = frameCell;
        }
      }
    },
    [findStoryboardDropHit, clearSbDropTarget, clearGhostNodeHidden, findShotlistDropHit, clearShotlistDropTarget, clearFolderDropTarget],
  );

  const dragPreview = useMemo(() => createFrameCoalescer<() => void>((preview) => preview()), []);
  const handleNodeDrag = useCallback((event: React.MouseEvent, node: RFNode) => {
    const input = { clientX: event.clientX, clientY: event.clientY, node,
      projectId: useAppStore.getState().currentProjectId };
    dragPreview.schedule(() => updateDragPreview(input));
  }, [dragPreview, updateDragPreview]);
  useEffect(() => {
    const reset = () => {
      dragPreview.cancel();
      clearSbDropTarget(); clearShotlistDropTarget(); clearFolderDropTarget(); clearGhostNodeHidden();
      setDropGhost(null);
    };
    window.addEventListener('blur', reset);
    return () => { window.removeEventListener('blur', reset); reset(); };
  }, [currentProjectId, dragPreview, clearSbDropTarget, clearShotlistDropTarget, clearFolderDropTarget, clearGhostNodeHidden]);

  // ── Auto group/ungroup on drag stop ──
  const handleNodeDragStop = useCallback(
    (event: React.MouseEvent, node: RFNode, draggedNodes: RFNode[]) => {
      dragPreview.cancel();
      endCanvasInteraction('node');
      const stack = document.elementsFromPoint(event.clientX, event.clientY);
      const cell = findStoryboardDropHit(node, stack)?.emptyCell ?? null;
      const frameCell = findShotlistDropHit(node, stack);
      clearSbDropTarget();
      clearShotlistDropTarget();
      clearFolderDropTarget();
      setDropGhost(null);
      clearGhostNodeHidden();
      const duplication = duplicateDrag.current;
      if (duplication?.sourceId === node.id) {
        duplicateDrag.current = null;
        onNodeDragStop();
        void duplication.finish().then((clone) => {
          if (!clone) return;
          const shotlistId = frameCell?.closest('.react-flow__node')?.getAttribute('data-id');
          const rowId = frameCell?.dataset.shotVideoRow ?? frameCell?.dataset.shotFrameRow;
          if (shotlistId && rowId) {
            const state = useAppStore.getState();
            if (frameCell?.dataset.shotVideoRow) state.bindShotlistVideo(shotlistId, rowId, clone.id);
            else state.bindShotlistFrame(shotlistId, rowId, clone.id);
            return;
          }
          const sbId = cell?.closest('.react-flow__node')?.getAttribute('data-id');
          const idx = Number(cell?.dataset.sbCellIdx);
          if (sbId && !Number.isNaN(idx)) {
            useAppStore.getState().fillStoryboardCell(sbId, idx, clone.id);
            return;
          }
          settleNodeGroupingOnDragStop(clone);
        });
        return;
      }
      if (frameCell) {
        const shotlistId = frameCell.closest('.react-flow__node')?.getAttribute('data-id');
        const rowId = frameCell.dataset.shotVideoRow ?? frameCell.dataset.shotFrameRow;
        if (shotlistId && shotlistId !== node.id && rowId) {
          const state = useAppStore.getState();
          if (frameCell.dataset.shotVideoRow) state.bindShotlistVideo(shotlistId, rowId, node.id);
          else state.bindShotlistFrame(shotlistId, rowId, node.id);
          onNodeDragStop();
          return;
        }
      }
      if (cell) {
        const sbId = cell.closest('.react-flow__node')?.getAttribute('data-id');
        const idx = Number(cell.dataset.sbCellIdx);
        if (sbId && sbId !== node.id && !Number.isNaN(idx)) {
          useAppStore.getState().fillStoryboardCell(sbId, idx, node.id);
          onNodeDragStop();
          return;
        }
      }
      const currentNodes = useAppStore.getState().nodes;
      settleNodeGroupingOnDragStop(draggedNodes.map((dragged) => hydrateCanvasNodeData(
        dragged as RFNode<BaseNodeData>, currentNodes,
      )));
      onNodeDragStop();
    },
    [dragPreview, onNodeDragStop, settleNodeGroupingOnDragStop, findStoryboardDropHit, clearSbDropTarget, clearGhostNodeHidden, endCanvasInteraction, findShotlistDropHit, clearShotlistDropTarget, clearFolderDropTarget],
  );

  return (
    <CanvasNodeLodContext.Provider value={nodeLodRuntime}>
    <ResizeSnapContext.Provider value={resizeSnapApi}>
    <CanvasEdgePanePointerContext.Provider value={edgePanePointer.bridge}>
    <div
      ref={canvasRootRef}
      className={`absolute inset-0 canvas-drawing-root is-interaction-${interactionMode} is-tool-${activeDrawingTool}${connectableSelectionCount > 1 ? ' is-multi-selected' : ''}`}
      onPointerDownCapture={handleDrawingPointerDown}
      onPointerMoveCapture={handleDrawingPointerMove}
      onPointerUpCapture={handleDrawingPointerUp}
      onPointerCancelCapture={handleDrawingPointerCancel}
      onLostPointerCaptureCapture={handleDrawingPointerCancel}
    >
      <ReactFlow
        nodes={renderedCanvasNodes}
        edges={renderedEdges}
        onConnect={connectNode}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isCanvasConnectionValid}
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
        edgeTypes={edgeDisplayMode === 'hidden' ? hiddenEdgeTypes : edgeTypes}
        zIndexMode="manual"
        connectionMode={ConnectionMode.Loose}
        connectionRadius={64}
        onlyRenderVisibleElements
        fitView={viewportPreferences.initialFit}
        defaultViewport={viewportPreferences.defaultViewport}
        fitViewOptions={viewportPreferences.initialFitOptions}
        minZoom={viewportPreferences.minZoom}
        maxZoom={viewportPreferences.maxZoom}
        defaultEdgeOptions={defaultEdgeOptions}
        proOptions={PRO_OPTIONS}
        {...drawingInteraction}
        {...edgePanePointer.handlers}
        zoomOnScroll={!viewportPreferences.locked && interaction.zoomOnScroll}
        zoomOnPinch={!viewportPreferences.locked}
        zoomOnDoubleClick={!viewportPreferences.locked && interactionMode !== 'classic'}
        zoomActivationKeyCode={viewportPreferences.locked ? null : interactionMode === 'classic' ? 'Control' : 'Meta'}
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
        {snapLines.length > 0 && <SnapLinesOverlay lines={snapLines} />}

        {/* Grid background */}
        {showGrid && appearanceGridVisible && <CanvasGrid color={gridDotColor} />}


        {/* Mini Map — interactive navigator, toggle with M key */}
        {minimapVisible && (
          <>
            <MiniMapNodeStats onClick={handleMiniMapClick} />
            <RoundedMiniMapMask />
          </>
        )}

        {/* 操作记录 — 撤销 / 还原 + 可回溯的操作列表 */}
        <Panel position="top-right" className="canvas-history-slot">
          <HistoryTimelinePanel />
        </Panel>

        {canvasNoteToolbarVisible && (
          <Panel position="bottom-left" className="canvas-drawing-toolbar-slot canvas-drawing-ui">
            <CanvasDrawingToolbar
              activeTool={activeDrawingTool}
              interactionMode={interactionMode}
              imageReady={Boolean(pendingImage)}
              onSelectTool={chooseDrawingTool}
            />
          </Panel>
        )}

        {panelNote && (
          <Panel position="top-left" className="canvas-note-style-panel-slot canvas-drawing-ui">
            <CanvasNoteStylePanel
              key={selectedNoteNode?.id ?? activeDrawingTool}
              note={panelNote}
              selected={Boolean(selectedNoteNode)}
              onPatch={(patch) => { applyNotePatch(patch); }}
              onTransientPatch={(patch) => { applyNotePatch(patch, true); }}
              onBeginChange={beginNoteChange}
              onEndChange={endNoteChange}
              onDuplicate={() => { duplicateSelectedNote(); }}
              onDelete={() => { deleteSelectedNote(); }}
              onMoveLayer={(direction) => { moveSelectedNoteLayer(direction); }}
              onCrop={requestCrop}
            />
          </Panel>
        )}

        {/* Toolbar */}
        <Panel position="bottom-right" className="flex items-center gap-2">
          <CanvasToolbar
            showGrid={showGrid}
            edgeDisplayMode={edgeDisplayMode}
            onToggleGrid={toggleGrid}
            onToggleLine={toggleLine}
            mode={viewportPreferences.mode}
            disabled={!viewportPreferences.hydrated}
            minZoom={viewportPreferences.minZoom}
            maxZoom={viewportPreferences.maxZoom}
            onAutoFit={autoFitCanvas}
            onZoomChange={viewportPreferences.setZoom}
            onStepZoom={viewportPreferences.stepZoom}
            onToggleLock={viewportPreferences.toggleLock}
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
      <EpisodeWorkbench key={currentProjectId} />

      <SelectionConnectionHandle rootRef={canvasRootRef} onBlankDrop={openSelectionMenu} />

      {connectionMenu.visible && connectionMenu.previewSources?.length ? (
        <ConnectionDropPreview
          sources={connectionMenu.previewSources}
          position={connectionMenu.position}
          direction={connectionMenu.direction}
        />
      ) : null}

      {radialMenuHoldPosition && (
        <CanvasLongPressIndicator position={radialMenuHoldPosition} />
      )}
      {radialMenuPosition && (
        <CanvasRadialMenu position={radialMenuPosition} onClose={closeRadialMenu} />
      )}

      {/* Connection drop menu */}
      <ConnectionMenu
        visible={connectionMenu.visible}
        position={connectionMenu.position}
        sourceNodeType={connectionMenu.sourceNodeType}
        direction={connectionMenu.direction}
        sourceNode={sourceNode}
        selectionCount={connectionMenu.sourceNodeIds?.length}
        menuRef={connectionMenuRef}
        onSelect={handleConnectionMenuSelect}
        connectionMenuMap={connectionMenuMap}
      />

      {/* 挂到 body，避免画布的 contain: paint 将右键菜单压在节点对话框下方。 */}
      {createPortal(<CanvasContextMenu
        visible={ctxMenu.visible}
        position={ctxMenu.position}
        hoverMenu={ctxMenu.hoverMenu}
        menuRef={ctxMenuRef}
        submenuRef={ctxSubmenuRef}
        onAddNode={addNodeAtCtxPos}
        onAddPluginNode={addPluginNodeAtCtxPos}
        pluginNodes={pluginNodes}
        onUndo={handleCtxUndo}
        onRedo={handleCtxRedo}
        onPaste={handleCtxPaste}
        onCreateFolder={handleCtxCreateFolder}
        onDelete={handleCtxDelete}
        onCopyNodes={handleCtxCopyNodes}
        onCopyFiles={handleCtxCopyFiles}
        hasSelection={ctxHasSelection}
        onOpenProjectDir={handleCtxOpenProjectDir}
        onShowSubmenu={showSubmenu}
        onHideSubmenu={hideSubmenu}
      />, document.body)}

      {/* Node context menu */}
      {createPortal(<NodeContextMenu
        visible={nodeCtxMenu.visible}
        position={nodeCtxMenu.position}
        menuRef={nodeCtxMenuRef}
        onCopy={handleCopy}
        onCut={handleCut}
        hasTextSelection={nodeCtxMenu.textSelection != null}
        onCopyText={handleCopyText}
        onCutText={handleCutText}
        onDuplicate={handleDuplicate}
        onRename={showRename ? handleRename : undefined}
        onToggleLock={handleToggleLock}
        isLocked={isNodeLocked}
        onConvertImage={showImageConversion ? handleConvertImage : undefined}
        imageConversionLabel={imageConversionLabel}
        onAddToCharacter={showAddToCharacter ? handleAddToCharacter : undefined}
        onUngroup={isGroupNode ? handleUngroup : undefined}
        onOpenGroupFolder={isGroupNode ? handleOpenGroupFolder : undefined}
        onDelete={handleDelete}
        onShowInFolder={showInFolder ? handleShowInFolder : undefined}
        onCopyFilePath={showInFolder ? handleCopyFilePath : undefined}
        onSaveAs={showSaveAs ? handleSaveAs : undefined}
        onOpenInPS={showOpenInPS ? handleOpenInPS : undefined}
        onEditVideo={showEditVideo ? handleEditVideo : undefined}
        editVideoLabel={editVideoLabel}
        onOpenInJianying={showOpenInVideoEditor ? handleOpenInJianying : undefined}
        onOpenInPremiere={showOpenInVideoEditor ? handleOpenInPremiere : undefined}
        onCopyMedia={showCopyMedia ? handleCopyMedia : undefined}
        copyMediaLabel={copyMediaLabel}
        pluginTools={pluginTools}
        onPluginTool={handlePluginTool}
      />, document.body)}

      <NodeOutputDownloadDialog onCancel={cancelSaveAsDownload} />

      {pendingPluginTool ? (
        <NodePluginToolDialog
          pluginTool={pendingPluginTool.tool}
          nodeId={pendingPluginTool.nodeId}
          onClose={closePluginToolDialog}
        />
      ) : null}

      {characterCaptureNodeId ? createPortal(
        <Suspense fallback={null}>
          <CharacterAssetDialog
            isOpen
            sourceNodeId={characterCaptureNodeId}
            onClose={closeCharacterCapture}
          />
        </Suspense>,
        document.body,
      ) : null}

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
          <ViewportImage eager src={dropGhost.url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      </div>,
      document.body,
    )}
    </CanvasEdgePanePointerContext.Provider>
    </ResizeSnapContext.Provider>
    </CanvasNodeLodContext.Provider>
  );
}

export default function Canvas({ onReady }: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasHandleFilter>
        <CanvasInner onReady={onReady} />
      </CanvasHandleFilter>
    </ReactFlowProvider>
  );
}
