/**
 * 项目缩略图合成 Worker：根据节点、连线和媒体位图绘制离屏画布并返回压缩结果。
 */
export interface ProjectSnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectSnapshotNode extends ProjectSnapshotRect {
  kind: string;
  label: string;
  noteKind?: string;
}

export interface ProjectSnapshotEdge {
  points: Array<{ x: number; y: number }>;
}

export interface ProjectSnapshotMedia extends ProjectSnapshotRect {
  bitmap: ImageBitmap;
  fit: 'contain' | 'cover' | 'fill';
}

export interface ProjectSnapshotWorkerRequest {
  id: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  backgroundColor: string;
  nodes: ProjectSnapshotNode[];
  edges: ProjectSnapshotEdge[];
  media: ProjectSnapshotMedia[];
}

export type ProjectSnapshotWorkerResponse = {
  id: number;
  ok: true;
  buffer: ArrayBuffer;
  mimeType: 'image/webp';
} | {
  id: number;
  ok: false;
  error: string;
};

interface SnapshotWorkerScope {
  onmessage: ((event: MessageEvent<ProjectSnapshotWorkerRequest>) => void) | null;
  postMessage: (message: ProjectSnapshotWorkerResponse, transfer?: Transferable[]) => void;
}

const workerScope = self as unknown as SnapshotWorkerScope;
const MAX_BLOB_SIZE = 260_000;
const WEBP_QUALITIES = [0.72, 0.55, 0.4, 0.28] as const;

function roundedRect(
  context: OffscreenCanvasRenderingContext2D,
  rect: ProjectSnapshotRect,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
}

function getMediaDrawRect(media: ProjectSnapshotMedia): ProjectSnapshotRect {
  if (media.fit === 'fill' || media.bitmap.width < 1 || media.bitmap.height < 1) return media;

  const sourceRatio = media.bitmap.width / media.bitmap.height;
  const targetRatio = media.width / media.height;
  const useWidth = media.fit === 'cover' ? sourceRatio < targetRatio : sourceRatio > targetRatio;
  const width = useWidth ? media.width : media.height * sourceRatio;
  const height = useWidth ? media.width / sourceRatio : media.height;
  return {
    x: media.x + (media.width - width) / 2,
    y: media.y + (media.height - height) / 2,
    width,
    height,
  };
}

function drawCanvasNote(
  context: OffscreenCanvasRenderingContext2D,
  node: ProjectSnapshotNode,
): void {
  const inset = 2;
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  context.save();
  context.globalAlpha = 0.9;
  context.strokeStyle = '#818cf8';
  context.fillStyle = 'rgba(129, 140, 248, 0.08)';
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  switch (node.noteKind) {
    case 'rectangle':
      context.roundRect(
        node.x + inset,
        node.y + inset,
        Math.max(1, node.width - inset * 2),
        Math.max(1, node.height - inset * 2),
        8,
      );
      context.fill();
      context.stroke();
      break;
    case 'diamond':
      context.moveTo(centerX, node.y + inset);
      context.lineTo(node.x + node.width - inset, centerY);
      context.lineTo(centerX, node.y + node.height - inset);
      context.lineTo(node.x + inset, centerY);
      context.closePath();
      context.fill();
      context.stroke();
      break;
    case 'ellipse':
      context.ellipse(centerX, centerY, Math.max(1, node.width / 2 - inset), Math.max(1, node.height / 2 - inset), 0, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      break;
    case 'arrow':
    case 'line':
      context.moveTo(node.x + inset, node.y + inset);
      context.lineTo(node.x + node.width - inset, node.y + node.height - inset);
      context.stroke();
      if (node.noteKind === 'arrow') {
        context.beginPath();
        context.moveTo(node.x + node.width - 12, node.y + node.height - 3);
        context.lineTo(node.x + node.width - inset, node.y + node.height - inset);
        context.lineTo(node.x + node.width - 3, node.y + node.height - 12);
        context.stroke();
      }
      break;
    case 'freehand':
      context.moveTo(node.x + inset, centerY);
      context.bezierCurveTo(
        node.x + node.width * 0.25,
        node.y + inset,
        node.x + node.width * 0.75,
        node.y + node.height - inset,
        node.x + node.width - inset,
        centerY,
      );
      context.stroke();
      break;
    case 'text':
      context.fillStyle = '#e8e8ed';
      context.font = '500 13px sans-serif';
      context.textBaseline = 'top';
      context.fillText(node.label || '文本', node.x + 4, node.y + 4, Math.max(0, node.width - 8));
      break;
    case 'image':
      roundedRect(context, node, 6);
      context.stroke();
      break;
    default:
      break;
  }
  context.restore();
}

async function encodeSnapshot(canvas: OffscreenCanvas): Promise<ArrayBuffer> {
  let fallback: ArrayBuffer | null = null;
  for (const quality of WEBP_QUALITIES) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    const buffer = await blob.arrayBuffer();
    fallback = buffer;
    if (blob.size <= MAX_BLOB_SIZE) return buffer;
  }
  if (!fallback) throw new Error('WebP encoding failed');
  return fallback;
}

async function renderSnapshot(request: ProjectSnapshotWorkerRequest): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(request.width, request.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas 2D context unavailable');

  const scaleX = request.width / request.sourceWidth;
  const scaleY = request.height / request.sourceHeight;
  context.fillStyle = request.backgroundColor || '#0a0a0f';
  context.fillRect(0, 0, request.width, request.height);
  context.save();
  context.scale(scaleX, scaleY);

  context.strokeStyle = 'rgba(136, 136, 160, 0.42)';
  context.lineWidth = Math.max(1 / Math.min(scaleX, scaleY), 1);
  for (const edge of request.edges) {
    if (edge.points.length < 2) continue;
    context.beginPath();
    context.moveTo(edge.points[0].x, edge.points[0].y);
    for (const point of edge.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }

  for (const node of request.nodes) {
    if (node.noteKind) {
      drawCanvasNote(context, node);
      continue;
    }
    roundedRect(context, node, 8);
    context.fillStyle = '#1a1a26';
    context.fill();
    context.strokeStyle = '#2a2a3a';
    context.lineWidth = 1;
    context.stroke();
  }

  for (const media of request.media) {
    const drawRect = getMediaDrawRect(media);
    context.save();
    roundedRect(context, media, 6);
    context.clip();
    context.drawImage(media.bitmap, drawRect.x, drawRect.y, drawRect.width, drawRect.height);
    context.restore();
  }

  context.font = '600 11px sans-serif';
  context.textBaseline = 'bottom';
  for (const node of request.nodes) {
    if (!node.label || node.noteKind) continue;
    context.fillStyle = '#e8e8ed';
    const maxWidth = Math.max(0, node.width - 8);
    context.fillText(node.label, node.x + 4, node.y - 3, maxWidth);
  }

  context.restore();
  return encodeSnapshot(canvas);
}

workerScope.onmessage = (event) => {
  const request = event.data;
  void renderSnapshot(request)
    .then((buffer) => {
      workerScope.postMessage({
        id: request.id,
        ok: true,
        buffer,
        mimeType: 'image/webp',
      }, [buffer]);
    })
    .catch((error) => {
      workerScope.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      for (const media of request.media) media.bitmap.close();
    });
};
