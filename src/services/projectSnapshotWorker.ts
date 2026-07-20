export interface ProjectSnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectSnapshotNode extends ProjectSnapshotRect {
  kind: string;
  label: string;
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

const KIND_COLORS: Record<string, string> = {
  text: '#818cf8',
  image: '#34d399',
  video: '#60a5fa',
  audio: '#fb923c',
  animation: '#c084fc',
  group: '#a78bfa',
};

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
    roundedRect(context, node, 8);
    context.fillStyle = '#1a1a26';
    context.fill();
    context.strokeStyle = '#2a2a3a';
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = KIND_COLORS[node.kind] ?? '#8888a0';
    context.fillRect(node.x, node.y, Math.max(2, 3 / scaleX), node.height);
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
    if (!node.label) continue;
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
