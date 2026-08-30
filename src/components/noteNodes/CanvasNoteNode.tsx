/**
 * noteNodes/CanvasNoteNode — 画布笔记节点容器。
 * 组合形状、文本、图片三个子渲染层，处理选中态、尺寸缩放、曲线控制点、图片嵌入与裁剪，
 * 几何计算统一走 canvasNoteGeometry，图片落盘走 fileService。
 */
import { lazy, memo, Suspense, useCallback, useEffect, useState } from 'react';
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useStore, type ReactFlowState } from '@xyflow/react';
import type { BaseNodeData } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import {
  clearCanvasNoteCurveControl,
  getCanvasNoteCurveHandle,
  hasCanvasNoteCurveControl,
  scaleCanvasNotePoints,
  setCanvasNoteCurveHandle,
} from '../../utils/canvasNoteGeometry';
import { buildNodeFileName, saveDataUrlToProjectData } from '../../services/fileService';
import ResizeHandle from '../nodes/shared/ResizeHandle';
import CanvasNoteShape from './CanvasNoteShape';
import CanvasNoteText from './CanvasNoteText';
import CanvasNoteImage from './CanvasNoteImage';

const CropEditor = lazy(() => import('../nodes/shared/image/CropEditor'));
const selectZoom = (state: ReactFlowState) => state.transform[2];

interface CanvasNoteNodeProps {
  id: string;
  data: BaseNodeData;
  selected?: boolean;
}

function CanvasNoteNode({ id, data, selected = false }: CanvasNoteNodeProps) {
  const note = data.note;
  const updateCanvasNote = useAppStore((state) => state.updateCanvasNote);
  const updateCanvasNoteTransient = useAppStore((state) => state.updateCanvasNoteTransient);
  const updateNodeDataTransient = useAppStore((state) => state.updateNodeDataTransient);
  const commitToHistory = useAppStore((state) => state.commitToHistory);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const showToast = useAppStore((state) => state.showToast);
  const zoom = useStore(selectZoom);
  const [cropOpen, setCropOpen] = useState(false);

  useEffect(() => {
    const handleCropRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: string }>).detail;
      if (detail?.nodeId === id && note?.kind === 'image' && data.imageUrl) setCropOpen(true);
    };
    window.addEventListener('canvas-note-crop', handleCropRequest);
    return () => window.removeEventListener('canvas-note-crop', handleCropRequest);
  }, [data.imageUrl, id, note?.kind]);

  const handleResize = useCallback((width: number, height: number) => {
    if (!note) return;
    const points = note.points?.length
      ? scaleCanvasNotePoints(note.points, note, { width, height })
      : undefined;
    updateCanvasNoteTransient(id, { width, height, ...(points ? { points } : {}) });
  }, [id, note, updateCanvasNoteTransient]);

  const handleTextCommit = useCallback((text: string) => {
    updateCanvasNote(id, { text });
  }, [id, updateCanvasNote]);

  const handlePointPointerDown = useCallback((
    pointIndex: number,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => {
    if (!note?.points?.[pointIndex]) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const original = note.points.map((point) => ({ ...point }));
    commitToHistory();

    const handleMove = (moveEvent: PointerEvent) => {
      const points = original.map((point) => ({ ...point }));
      points[pointIndex] = {
        ...points[pointIndex],
        x: Math.min(note.width, Math.max(0, original[pointIndex].x + (moveEvent.clientX - start.x) / Math.max(zoom, 0.01))),
        y: Math.min(note.height, Math.max(0, original[pointIndex].y + (moveEvent.clientY - start.y) / Math.max(zoom, 0.01))),
      };
      updateCanvasNoteTransient(id, { points });
    };
    const handleUp = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      commitToHistory();
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  }, [commitToHistory, id, note, updateCanvasNoteTransient, zoom]);

  // 曲线手柄落在曲线中点上，拖动时反推控制点，让线条跟着指针走。
  const handleCurvePointerDown = useCallback((event: ReactPointerEvent<SVGCircleElement>) => {
    const points = note?.points;
    if (!points || points.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const original = points.map((point) => ({ ...point }));
    const originHandle = getCanvasNoteCurveHandle(original);
    commitToHistory();

    const handleMove = (moveEvent: PointerEvent) => {
      const scale = Math.max(zoom, 0.01);
      updateCanvasNoteTransient(id, {
        points: setCanvasNoteCurveHandle(original, {
          x: originHandle.x + (moveEvent.clientX - start.x) / scale,
          y: originHandle.y + (moveEvent.clientY - start.y) / scale,
        }),
      });
    };
    const handleUp = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      commitToHistory();
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  }, [commitToHistory, id, note?.points, updateCanvasNoteTransient, zoom]);

  // 双击手柄恢复默认弧度。
  const handleCurveReset = useCallback((event: ReactMouseEvent<SVGCircleElement>) => {
    const points = note?.points;
    if (!points || !hasCanvasNoteCurveControl(points)) return;
    event.preventDefault();
    event.stopPropagation();
    updateCanvasNote(id, { points: clearCanvasNoteCurveControl(points) });
  }, [id, note?.points, updateCanvasNote]);

  const handleCropSave = useCallback(async (
    croppedDataUrl: string,
    metadata?: { width: number; height: number },
  ) => {
    if (!note || note.kind !== 'image') return;
    try {
      let imageUrl = croppedDataUrl;
      let filePath: string | undefined;
      if (currentProjectId && currentProjectId !== 'default') {
        const saved = await saveDataUrlToProjectData(
          croppedDataUrl,
          currentProjectId,
          buildNodeFileName(data.label || '画布图片', 'png', 'note-crop'),
        );
        if (saved?.assetUrl) {
          imageUrl = saved.assetUrl;
          filePath = saved.filePath;
        }
      }
      const ratio = metadata?.width && metadata?.height ? metadata.width / metadata.height : note.width / note.height;
      const width = note.width;
      const height = Math.max(40, width / Math.max(0.01, ratio));
      commitToHistory();
      updateNodeDataTransient(id, { imageUrl, filePath, nodeWidth: width, nodeHeight: height });
      updateCanvasNoteTransient(id, { width, height });
      setCropOpen(false);
    } catch (error) {
      console.error('[画布笔记] 图片裁剪保存失败:', error);
      showToast('图片裁剪保存失败', 'error');
    }
  }, [commitToHistory, currentProjectId, data.label, id, note, showToast, updateCanvasNoteTransient, updateNodeDataTransient]);

  if (!note) return null;

  const rootStyle = {
    width: `${note.width}px`,
    height: `${note.height}px`,
    '--canvas-note-opacity': note.style.opacity / 100,
  } as CSSProperties;
  const kindLabel = {
    rectangle: '矩形',
    diamond: '菱形',
    ellipse: '椭圆',
    arrow: '箭头',
    line: '直线',
    freehand: '手绘',
    text: '文本笔记',
    image: '图片笔记',
  }[note.kind];

  const linePoints = note.points && note.points.length >= 2 ? note.points : null;
  const curveHandle = linePoints && note.style.lineType === 'curved'
    ? {
      handle: getCanvasNoteCurveHandle(linePoints),
      chordMiddle: {
        x: (linePoints[0].x + linePoints[linePoints.length - 1].x) / 2,
        y: (linePoints[0].y + linePoints[linePoints.length - 1].y) / 2,
      },
    }
    : null;

  return (
    <>
      <div
        className={`canvas-note-node canvas-note-node--${note.kind} ${selected ? 'is-selected' : ''}`}
        style={rootStyle}
        role="group"
        aria-label={kindLabel}
        data-canvas-note-id={id}
        data-note-kind={note.kind}
      >
        {note.kind === 'text' ? (
          <CanvasNoteText nodeId={id} note={note} onCommit={handleTextCommit} />
        ) : note.kind === 'image' ? (
          <CanvasNoteImage note={note} imageUrl={data.imageUrl} label={data.label} />
        ) : (
          <CanvasNoteShape note={note} />
        )}
        {selected && (note.kind === 'arrow' || note.kind === 'line') && note.points && (
          <svg
            className="canvas-note-point-handles nodrag nopan"
            viewBox={`0 0 ${Math.max(1, note.width)} ${Math.max(1, note.height)}`}
            aria-label="拖动线条端点"
          >
            {curveHandle && (
              <g>
                <line
                  className="canvas-note-curve-guide"
                  x1={curveHandle.chordMiddle.x}
                  y1={curveHandle.chordMiddle.y}
                  x2={curveHandle.handle.x}
                  y2={curveHandle.handle.y}
                />
                <circle
                  className="is-curve-handle"
                  cx={curveHandle.handle.x}
                  cy={curveHandle.handle.y}
                  r={5}
                  onPointerDown={handleCurvePointerDown}
                  onDoubleClick={handleCurveReset}
                >
                  <title>拖动调节曲率，双击恢复默认</title>
                </circle>
              </g>
            )}
            {[0, note.points.length - 1].map((pointIndex) => (
              <circle
                key={pointIndex}
                cx={note.points?.[pointIndex].x}
                cy={note.points?.[pointIndex].y}
                r={5}
                onPointerDown={(event) => handlePointPointerDown(pointIndex, event)}
              />
            ))}
          </svg>
        )}
        {selected && (
          <ResizeHandle
            nodeId={id}
            currentWidth={note.width}
            currentHeight={note.height}
            minWidth={note.kind === 'text' ? 80 : 20}
            minHeight={note.kind === 'text' ? 36 : 20}
            lockAspectRatio={note.kind === 'image'}
            onResizeStart={commitToHistory}
            onResizeEnd={commitToHistory}
            onResize={handleResize}
          />
        )}
      </div>
      {note.kind === 'image' && data.imageUrl && (
        <Suspense fallback={null}>
          <CropEditor
            isOpen={cropOpen}
            imageUrl={data.imageUrl}
            operationKey={`canvas-note:${id}`}
            onClose={() => setCropOpen(false)}
            onSave={handleCropSave}
          />
        </Suspense>
      )}
    </>
  );
}

export default memo(CanvasNoteNode);
