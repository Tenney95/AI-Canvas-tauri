/**
 * Canvas 画布主组件 — React Flow 画布核心，管理节点/边渲染、拖放、连线、右键菜单、空状态
 */
import { lazy, Suspense, useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  ConnectionMode,
  SelectionMode,
  useReactFlow,
  useViewport,
  useUpdateNodeInternals,
  ReactFlowProvider,
  Panel,
  applyNodeChanges,
  type OnSelectionChangeParams,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import TextNode from './nodes/TextNode';
import ImageNode from './nodes/ImageNode';
import VideoNode from './nodes/VideoNode';
import AudioNode from './nodes/AudioNode';
import MarkdownNode from './nodes/MarkdownNode';
import GroupNode from './nodes/GroupNode';
import ConnectionMenu from './canvas/ConnectionMenu';
import CanvasContextMenu from './canvas/CanvasContextMenu';
import NodeContextMenu from './canvas/NodeContextMenu';
import CanvasToolbar from './canvas/CanvasToolbar';
import MultiSelectToolbar from './canvas/MultiSelectToolbar';
import CanvasEmptyState from './canvas/CanvasEmptyState';
import { useConnectionDropMenu } from '../hooks/useConnectionDropMenu';
import { useCanvasContextMenu } from '../hooks/useCanvasContextMenu';
import { useNodeContextMenu } from '../hooks/useNodeContextMenu';
import { useAppStore } from '../store/useAppStore';
import { useNodeCreation } from '../hooks/useNodeCreation';
import type { BaseNodeData } from '../types';
import type { Node as RFNode, NodeTypes, Connection, Edge } from '@xyflow/react';
import { useNodeSnap, ResizeSnapContext, type SnapLine } from '../hooks/useNodeSnap';

// 懒加载：全景节点引入 three（体积大户），画布上出现全景节点时才加载
const PanoramaNodeLazy = lazy(() => import('./nodes/PanoramaNode'));
function PanoramaNode(props: { id: string; data: BaseNodeData; selected?: boolean }) {
  return <Suspense fallback={null}><PanoramaNodeLazy {...props} /></Suspense>;
}

// ── Node types mapping ──
const nodeTypes: NodeTypes = {
  'ai-text': TextNode,
  'ai-image': ImageNode,
  'ai-video': VideoNode,
  'ai-audio': AudioNode,
  'ai-panorama': PanoramaNode,
  'ai-markdown': MarkdownNode,
  group: GroupNode,
};

// ── Stable ReactFlow props (hoisted to avoid new identities every render,
//    which makes React Flow re-run internal effects and drop frames on drag) ──
const FIT_VIEW_OPTIONS = { padding: 0.2 };
const PRO_OPTIONS = { hideAttribution: true };
const PAN_ON_DRAG = [1, 2];
const DEFAULT_EDGE_STYLE = { stroke: '#33334a', strokeWidth: 1.5 };
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const isMacOS = typeof navigator !== 'undefined'
  && /Macintosh|Mac OS X/.test(navigator.userAgent);
const shouldUseMacTrackpadPan = isTauri && isMacOS;
const MINIMAP_STYLE = {
  width: 180,
  height: 120,
  border: '1px solid var(--theme-border)',
  borderRadius: '8px',
};
const isValidConnection = (conn: Connection | Edge) => conn.source !== conn.target;
const minimapNodeColor = (node: RFNode) => {
  switch (node.type) {
    case 'ai-text': return 'color-mix(in srgb, var(--node-text-light) 50%, transparent)';
    case 'ai-image': return 'color-mix(in srgb, var(--node-image-light) 50%, transparent)';
    case 'ai-video': return 'color-mix(in srgb, var(--node-video-light) 50%, transparent)';
    case 'ai-audio': return 'color-mix(in srgb, var(--node-audio-light) 50%, transparent)';
    case 'ai-panorama': return 'color-mix(in srgb, var(--node-panorama) 50%, transparent)';
    case 'ai-markdown': return 'color-mix(in srgb, var(--node-markdown-light) 50%, transparent)';
    case 'group': return '#4b556380';
    default: return '#6b728080';
  }
};

// ── Snap lines overlay ──
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
        {lines.map((line, i) =>
          line.type === 'horizontal' ? (
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
          )
        )}
      </svg>
    </div>
  );
}

function CanvasInner() {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const onConnect = useAppStore((s) => s.onConnect);
  const setEdges = useAppStore((s) => s.setEdges);
  const setSelectedNodeIds = useAppStore((s) => s.setSelectedNodeIds);
  const setLastCanvasMousePos = useAppStore((s) => s.setLastCanvasMousePos);
  const applyStableNodeChanges = useAppStore((s) => s.onNodesChange);
  const handleEdgesChange = useAppStore((s) => s.onEdgesChange);
  const clearGroupedSelection = useAppStore((s) => s.clearGroupedSelection);
  const settleNodeGroupingOnDragStop = useAppStore((s) => s.settleNodeGroupingOnDragStop);
  const duplicateNode = useAppStore((s) => s.duplicateNode);
  const minimapVisible = useAppStore((s) => s.minimapVisible);
  const reactFlowInstance = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

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

  // ── Zoom ──
  const [zoomPercent, setZoomPercent] = useState(100);

  const handleMove = useCallback(
    (_event: MouseEvent | TouchEvent | null, { zoom }: Viewport) => {
      setZoomPercent(Math.round(zoom * 100));
    },
    [],
  );

  // Track mouse position on canvas for node creation at cursor (on left-button release)
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const flowPos = reactFlowInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setLastCanvasMousePos(flowPos);
    },
    [reactFlowInstance, setLastCanvasMousePos],
  );

  const toggleGrid = useCallback(() => setShowGrid((v) => !v), []);

  const handleZoomSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      reactFlowInstance.zoomTo(Number(e.target.value) / 100);
    },
    [reactFlowInstance],
  );

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
      if (drag.moved) return; // 发生了拖拽平移 → 不弹菜单

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
        reactFlowInstance.fitView({ padding: 0.2 });
      });
    };
    window.addEventListener('canvas-fit-view', handler);
    return () => window.removeEventListener('canvas-fit-view', handler);
  }, [reactFlowInstance]);

  // ── Focus node event (history panel "查看节点") ──
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId: string }>).detail;
      if (!detail?.nodeId || !reactFlowInstance) return;
      const node = useAppStore.getState().nodes.find((n) => n.id === detail.nodeId);
      if (!node) return;
      requestAnimationFrame(() => {
        reactFlowInstance.setCenter(node.position.x, node.position.y, { zoom: 1, duration: 400 });
      });
    };
    window.addEventListener('canvas-focus-node', handler);
    return () => window.removeEventListener('canvas-focus-node', handler);
  }, [reactFlowInstance]);

  // ── Node click → AI dialog ──
  const openNodeDialog = useAppStore((s) => s.openNodeDialog);
  const onNodeClick = useCallback(
    (e: React.MouseEvent, node: RFNode<BaseNodeData>) => {
      // Shift+click is for multi-select, don't open dialog
      if (e.shiftKey) return;
      // Group / Markdown / source nodes have no AI dialog
      if (node.type === 'group') return;
      if (node.data?.type === 'ai-markdown') return;
      if (node.data?.role === 'source') return;
      if (node.data?.type === 'ai-text' && node.data?.output) return;
      if (node.data?.type === 'ai-image' && node.data?.imageUrl) return;
      if (node.data?.type === 'ai-panorama' && node.data?.imageUrl) return;
      if (node.data?.type === 'ai-video' && node.data?.videoUrl) return;

      const el = document.querySelector(`.react-flow__node[data-id="${node.id}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        openNodeDialog(node.id, { x: rect.left + rect.width / 2, y: rect.bottom });
      } else {
        openNodeDialog(node.id);
      }
    },
    [openNodeDialog],
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
      if ((evt.ctrlKey || evt.metaKey) && node.type !== 'group') {
        duplicateNode(node.id);
      }
      onNodeDragStart(evt, node);
    },
    [duplicateNode, onNodeDragStart],
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

  // ── Node change handler ──
  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode<BaseNodeData>>[]) => {
      // 单节点拖拽时，把吸附后的位置直接注入 React Flow 的变更管线
      // （成为唯一真相源，避免二次 setNodes 覆盖导致的漂移/橡皮筋）。
      // 注意：松手那一帧 dragging=false 也要吸附，否则会弹回原始落点（位移）。
      // applySnap 在非拖拽期（dragCtx 为空）是无副作用直通，故无需判断 dragging。
      // 多选拖拽不吸附，以保持选中节点之间的相对位置。
      const draggingPosChanges = changes.filter(
        (c) => c.type === 'position' && c.position,
      );
      let snapped = changes;
      if (draggingPosChanges.length === 1) {
        const dc = draggingPosChanges[0];
        if (dc.type === 'position' && dc.position) {
          const snappedPos = applySnap(dc.id, dc.position);
          snapped = changes.map((c) => (c === dc ? { ...c, position: snappedPos } : c));
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

  // ── Auto group/ungroup on drag stop ──
  const handleNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: RFNode) => {
      settleNodeGroupingOnDragStop(node as RFNode<BaseNodeData>);
      onNodeDragStop();
    },
    [onNodeDragStop, settleNodeGroupingOnDragStop],
  );

  return (
    <ResizeSnapContext.Provider value={resizeSnapApi}>
    <div className="absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onConnect={onConnect}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onNodeClick={onNodeClick}
        onDoubleClick={onDoubleClick}
        onSelectionChange={onSelectionChange}
        onSelectionEnd={onSelectionEnd}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.1}
        maxZoom={5}
        defaultEdgeOptions={defaultEdgeOptions}
        onMove={handleMove}
        proOptions={PRO_OPTIONS}
        panOnScroll={shouldUseMacTrackpadPan}
        zoomOnScroll={!shouldUseMacTrackpadPan}
        zoomOnPinch
        panOnDrag={PAN_ON_DRAG}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode="Shift"
        deleteKeyCode={null}
        onContextMenu={(e) => e.preventDefault()}
        onMouseUp={handleMouseUp}
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
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
          nodeColor={minimapNodeColor}
          nodeStrokeColor="var(--theme-border)"
          nodeStrokeWidth={1.5}
          nodeBorderRadius={35}
          bgColor="var(--theme-surface)"
          maskColor="rgba(10, 10, 15, 0.75)"
          maskStrokeColor="var(--brand)"
          maskStrokeWidth={1}
          style={MINIMAP_STYLE}
          className="!bottom-12 !right-1"
        />
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
            zoomPercent={zoomPercent}
            smoothLine={smoothLine}
            onToggleGrid={toggleGrid}
            onToggleLine={() => setSmoothLine((v) => !v)}
            onZoomChange={handleZoomSlider}
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
      />

      {/* Multi-select toolbar */}
      <MultiSelectToolbar />
    </div>
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
