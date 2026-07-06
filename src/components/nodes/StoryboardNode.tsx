/**
 * StoryboardNode 宫格分镜 — 单节点内把源图按均分网格拼接展示（多图拼接）。
 *
 * 各格用「超尺寸源图 + 负偏移」呈现对应裁片（object-fit:fill）；分割线固定不可拖拽。
 * 双击进入分镜编辑：可拖拽某一格到画布，生成一个「提取分镜r-c」真实裁片图像节点，
 * 原格随即变为空占位（+）。
 */
import { memo, useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { BaseNodeData, StoryboardCellOverride } from '../../types';
import NodeLabel from './shared/NodeLabel';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import NodeError from './shared/NodeError';
import { useNodeRename } from './shared/useNodeRename';
import { useAppStore, generateId } from '../../store/useAppStore';
import { cropImageCell, cropImageByRanges, computeImageNodeDimensions } from './shared/image/imageUtils';
import { saveDataUrlToProjectData, buildNodeFileName } from '../../services/fileService';

/** 拖出判定阈值（像素）：小于此位移视为误触，不提取 */
const DRAG_THRESHOLD = 8;

function StoryboardNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const { screenToFlowPosition } = useReactFlow();
  const nodeWidth = (data.nodeWidth as number) || 280;
  const nodeHeight = (data.nodeHeight as number) || 280;
  const cols = Math.max(1, (data.storyboardCols as number) || 3);
  const rows = Math.max(1, (data.storyboardRows as number) || 3);
  const imageUrl = (data.imageUrl || data.thumbnailUrl) as string | undefined;
  const extracted = (data.storyboardExtracted as boolean[] | undefined) ?? [];
  const overrides = (data.storyboardOverrides as (StoryboardCellOverride | null)[] | undefined) ?? [];
  const rowPositions = (data.storyboardRowPositions as number[] | undefined) ?? [];
  const colPositions = (data.storyboardColPositions as number[] | undefined) ?? [];
  const isCustomGrid = rowPositions.length > 0 || colPositions.length > 0;

  // 行/列边界（含 0 和 100）
  const hRanges = useMemo(() => (isCustomGrid ? [0, ...rowPositions, 100] : []), [isCustomGrid, rowPositions]);
  const vRanges = useMemo(() => (isCustomGrid ? [0, ...colPositions, 100] : []), [isCustomGrid, colPositions]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  // 拖出中的格：{ idx, x, y } —— 用于渲染跟随光标的幽灵预览
  const [drag, setDrag] = useState<{ idx: number; x: number; y: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const handleResize = useCallback(
    (w: number, h: number) => updateNodeData(id, { nodeWidth: w, nodeHeight: h } as Partial<BaseNodeData>),
    [id, updateNodeData],
  );

  // 计算各格的定位/裁片偏移（百分比）
  const cells = useMemo(() => {
    const arr: { idx: number; r: number; c: number; corner: string; box: React.CSSProperties; img: React.CSSProperties }[] = [];
    const lastRow = rows - 1;
    const lastCol = cols - 1;

    if (isCustomGrid) {
      // 非均匀宫格：按自定义线位置计算
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cellTop = hRanges[r];
          const cellLeft = vRanges[c];
          const cellH = hRanges[r + 1] - hRanges[r];
          const cellW = vRanges[c + 1] - vRanges[c];
          const corner = r === 0 && c === 0 ? 'tl' : r === 0 && c === lastCol ? 'tr' : r === lastRow && c === 0 ? 'bl' : r === lastRow && c === lastCol ? 'br' : '';
          arr.push({
            idx: r * cols + c,
            r, c, corner,
            box: { left: `${cellLeft}%`, top: `${cellTop}%`, width: `${cellW}%`, height: `${cellH}%` },
            img: {
              width: `${(100 / cellW) * 100}%`,
              height: `${(100 / cellH) * 100}%`,
              left: `${-(cellLeft / cellW) * 100}%`,
              top: `${-(cellTop / cellH) * 100}%`,
            },
          });
        }
      }
    } else {
      // 均分宫格：原逻辑
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const corner = r === 0 && c === 0 ? 'tl' : r === 0 && c === lastCol ? 'tr' : r === lastRow && c === 0 ? 'bl' : r === lastRow && c === lastCol ? 'br' : '';
          arr.push({
            idx: r * cols + c,
            r, c, corner,
            box: { left: `${(c / cols) * 100}%`, top: `${(r / rows) * 100}%`, width: `${(1 / cols) * 100}%`, height: `${(1 / rows) * 100}%` },
            img: { width: `${cols * 100}%`, height: `${rows * 100}%`, left: `${-c * 100}%`, top: `${-r * 100}%` },
          });
        }
      }
    }
    return arr;
  }, [rows, cols, isCustomGrid, hRanges, vRanges]);

  // ── 双击进入/退出编辑 ──
  const toggleEditing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing((v) => !v);
  }, []);

  // Esc 退出编辑态
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  // 节点失去选中 → 退出编辑态
  useEffect(() => {
    if (!selected) setEditing(false);
  }, [selected]);

  // 点击节点外部 → 失焦退出编辑态
  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Element)) {
        setEditing(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [editing]);

  // ── 拖出一格 → 生成「提取分镜」图像节点 ──
  const extractCell = useCallback(
    async (idx: number, clientX: number, clientY: number) => {
      if (!imageUrl) return;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const store = useAppStore.getState();
      const flowPos = screenToFlowPosition({ x: clientX, y: clientY });
      const label = `提取分镜${r + 1}-${c + 1}`;
      const override = overrides[idx];

      // 被拖入的图：直接用它建节点（无需裁切），原格清空
      if (override) {
        const dims = await computeImageNodeDimensions(override.url).catch(() => ({ nodeWidth: 200, nodeHeight: 200 }));
        store.addNode({
          id: `node-${generateId()}`,
          type: 'ai-image',
          position: { x: flowPos.x - 100, y: flowPos.y - 100 },
          data: { label, type: 'ai-image', role: 'source', status: 'success', imageUrl: override.url, filePath: override.filePath, ...dims } as BaseNodeData,
        } as Node<BaseNodeData>);
        const nextOv = [...overrides]; nextOv[idx] = null;
        const nextEx = [...extracted]; nextEx[idx] = true;
        store.updateNodeData(id, { storyboardOverrides: nextOv, storyboardExtracted: nextEx } as Partial<BaseNodeData>);
        store.commitToHistory();
        return;
      }

      // 立即建 loading 节点 + 标记原格已提取
      const newId = `node-${generateId()}`;
      store.addNode({
        id: newId,
        type: 'ai-image',
        position: { x: flowPos.x - 100, y: flowPos.y - 100 },
        data: { label, type: 'ai-image', role: 'source', status: 'loading', nodeWidth: 200, nodeHeight: 200 } as BaseNodeData,
      } as Node<BaseNodeData>);
      const nextExtracted = [...extracted];
      nextExtracted[idx] = true;
      store.updateNodeData(id, { storyboardExtracted: nextExtracted } as Partial<BaseNodeData>);
      store.commitToHistory();

      try {
        const cell = isCustomGrid
          ? await cropImageByRanges(imageUrl, hRanges, vRanges, r, c)
          : await cropImageCell(imageUrl, c, r, cols, rows);
        let assetUrl = cell.dataUrl;
        let filePath: string | undefined;
        const projectId = store.currentProjectId;
        if (projectId && projectId !== 'default') {
          const saved = await saveDataUrlToProjectData(cell.dataUrl, projectId, buildNodeFileName(label, 'png', 'grid'));
          if (saved?.assetUrl) { assetUrl = saved.assetUrl; filePath = saved.filePath; }
        }
        const dims = await computeImageNodeDimensions(assetUrl);
        store.updateNodeData(newId, {
          imageUrl: assetUrl, filePath, status: 'success',
          imageWidth: cell.width, imageHeight: cell.height,
          nodeWidth: dims.nodeWidth, nodeHeight: dims.nodeHeight,
        } as Partial<BaseNodeData>);
      } catch (err) {
        console.error('[Storyboard] 提取失败:', err);
        store.deleteNode(newId);
        store.showToast('提取分镜失败，请重试', 'error');
        // 回滚提取标记
        const rollback = [...(useAppStore.getState().nodes.find((n) => n.id === id)?.data.storyboardExtracted as boolean[] ?? [])];
        rollback[idx] = false;
        store.updateNodeData(id, { storyboardExtracted: rollback } as Partial<BaseNodeData>);
      }
    },
    [id, imageUrl, cols, rows, isCustomGrid, hRanges, vRanges, extracted, overrides, screenToFlowPosition],
  );

  const startCellDrag = useCallback(
    (idx: number) => (e: React.PointerEvent) => {
      if (!editing || extracted[idx]) return;
      e.preventDefault();
      e.stopPropagation(); // 阻止 React Flow 拖动节点
      dragStart.current = { x: e.clientX, y: e.clientY };
      setDrag({ idx, x: e.clientX, y: e.clientY });

      const onMove = (ev: PointerEvent) => setDrag({ idx, x: ev.clientX, y: ev.clientY });
      const onUp = (ev: PointerEvent) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        setDrag(null);
        const s = dragStart.current;
        dragStart.current = null;
        if (!s) return;
        const moved = Math.hypot(ev.clientX - s.x, ev.clientY - s.y);
        if (moved >= DRAG_THRESHOLD) extractCell(idx, ev.clientX, ev.clientY);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [editing, extracted, extractCell],
  );

  const { displayLabel, handleRename } = useNodeRename(id, data, '宫格分镜');

  // 拖出中格子的裁片偏移（用于幽灵预览）
  const dragCell = drag != null ? cells[drag.idx] : null;

  return (
    <div className="node-wrapper relative" style={{ width: nodeWidth }} ref={wrapperRef}>
      <NodeLabel
        kind="ai-storyboard"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleRename}
      />
      <div
        className={`node storyboard-node ${selected ? 'selected' : ''} ${editing ? 'editing' : ''}`}
        style={{ height: nodeHeight }}
        title={editing ? undefined : '双击进入编辑'}
        onDoubleClick={toggleEditing}
      >
        <div className="storyboard-grid">
          {imageUrl ? (
            cells.map((cell) => {
              const override = overrides[cell.idx];
              const isEmpty = !override && extracted[cell.idx];
              const draggable = editing && !isEmpty; // 空格不可拖出（可作拖入目标）
              return (
                <div
                  key={cell.idx}
                  data-sb-cell-idx={cell.idx}
                  {...(cell.corner ? { 'data-sb-corner': cell.corner } : {})}
                  className={`sb-cell${isEmpty ? ' sb-cell--empty' : ''}${override ? ' sb-cell--override' : ''}${draggable ? ' sb-cell--draggable nodrag' : ''}${drag?.idx === cell.idx ? ' sb-cell--dragging' : ''}`}
                  style={cell.box}
                  onPointerDown={draggable ? startCellDrag(cell.idx) : undefined}
                >
                  {override ? (
                    <img className="sb-cell-fill" src={override.url} alt="" draggable={false} />
                  ) : isEmpty ? (
                    <span className="sb-cell-plus">+</span>
                  ) : (
                    <img className="sb-cell-img" src={imageUrl} alt="" draggable={false} style={cell.img} />
                  )}
                  <span className="sb-cell-overlay" />
                </div>
              );
            })
          ) : (
            <div className="storyboard-empty">无图像</div>
          )}

          {imageUrl && (
            <span className="storyboard-badge">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" />
              </svg>
              {rows * cols}
            </span>
          )}
        </div>

        {data.error && <NodeError nodeId={id} message={data.error} />}

        <Handle type="source" position={Position.Left} id="left" className="node-handle handle-source handle-storyboard">
          <GooeyBtn className="gooey-btn-left" hue={330} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-storyboard">
          <GooeyBtn className="gooey-btn-right" hue={330} />
        </Handle>
      </div>

      <ResizeHandle
        nodeId={id}
        currentWidth={nodeWidth}
        currentHeight={nodeHeight}
        minWidth={160}
        minHeight={120}
        onResize={handleResize}
      />

      {/* 拖出幽灵预览（portal 到 body，避免被画布 transform 影响定位）*/}
      {drag && dragCell && imageUrl &&
        createPortal(
          <div className="sb-drag-ghost" style={{ left: drag.x, top: drag.y }}>
            <div className="sb-drag-ghost-clip">
              {overrides[drag.idx] ? (
                <img src={overrides[drag.idx]!.url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <img src={imageUrl} alt="" draggable={false} style={dragCell.img} />
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export default memo(StoryboardNode);
