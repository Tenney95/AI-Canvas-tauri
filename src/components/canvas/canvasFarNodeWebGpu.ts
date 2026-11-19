/// <reference types="@webgpu/types" />

export interface FarNodeGpuCard {
  x: number;
  y: number;
  width: number;
  height: number;
  textureKey: string;
  image?: HTMLImageElement;
}

interface FarNodeGpuDraw {
  width: number;
  height: number;
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  styleToken: object;
  cards: readonly FarNodeGpuCard[];
}

type PaintCard = (context: CanvasRenderingContext2D, card: FarNodeGpuCard) => void;

export interface FarNodeWebGpu {
  draw(input: FarNodeGpuDraw, paint: PaintCard): void;
  destroy(): void;
}

const ATLAS_SIDE = 2048;
const ATLAS_LAYERS = 2;
const MAX_ATLAS_TILES = 4096;
const MAX_VISIBLE_CARDS = 10_000;
const TILE_PADDING = 1;
const INSTANCE_FLOATS = 9;
const INSTANCE_STRIDE = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

interface AtlasTile { x: number; y: number; layer: number }
interface AtlasShelf { y: number; height: number; nextX: number }
interface AtlasLayer { shelves: AtlasShelf[]; nextY: number }

function reserveTile(layers: AtlasLayer[], side: number, width: number, height: number): AtlasTile | undefined {
  let best: { shelf: AtlasShelf; layer: number } | undefined;
  for (let layer = 0; layer < layers.length; layer++) {
    for (const shelf of layers[layer].shelves) {
      if (shelf.height >= height && shelf.nextX + width <= side && (!best || shelf.height < best.shelf.height)) {
        best = { shelf, layer };
      }
    }
  }
  if (best) {
    const { shelf, layer } = best;
    const x = shelf.nextX;
    shelf.nextX += width;
    return { x, y: shelf.y, layer };
  }
  const layer = layers.findIndex((item) => item.nextY + height <= side);
  if (layer < 0) return;
  const page = layers[layer];
  const y = page.nextY;
  page.shelves.push({ y, height, nextX: width });
  page.nextY += height;
  return { x: 0, y, layer };
}

const shaderCode = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
}

@group(0) @binding(0) var<uniform> viewport: vec4f;
@group(0) @binding(1) var atlas: texture_2d_array<f32>;
@group(0) @binding(2) var atlasSampler: sampler;

@vertex fn vertex(
  @builtin(vertex_index) index: u32,
  @location(0) bounds: vec4f,
  @location(1) textureRect: vec4f,
  @location(2) layer: f32,
) -> VertexOutput {
  let corner = vec2f(f32(index & 1u), f32(index >> 1u));
  let pixel = bounds.xy + corner * bounds.zw;
  let position = pixel / viewport.xy * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  return VertexOutput(vec4f(position, 0.0, 1.0), mix(textureRect.xy, textureRect.zw, corner), u32(layer));
}

@fragment fn fragment(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(atlas, atlasSampler, input.uv, i32(input.layer));
}
`;

export async function createFarNodeWebGpu(
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  onFailure: () => void,
): Promise<FarNodeWebGpu> {
  signal.throwIfAborted();
  const gpu = canvas.ownerDocument.defaultView?.navigator.gpu;
  if (!gpu) throw new Error('WebGPU is unavailable');
  const adapter = await gpu.requestAdapter();
  signal.throwIfAborted();
  if (!adapter) throw new Error('WebGPU adapter is unavailable');
  const device = await adapter.requestDevice();
  let context: GPUCanvasContext | null = null;
  let atlas: GPUTexture | undefined;
  let uniform: GPUBuffer | undefined;
  let instanceBuffer: GPUBuffer | undefined;
  let staging: HTMLCanvasElement | undefined;
  let disposed = false;

  const destroy = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', destroy);
    device.removeEventListener('uncapturederror', fail);
    context?.unconfigure();
    instanceBuffer?.destroy();
    uniform?.destroy();
    atlas?.destroy();
    device.destroy();
    if (staging) staging.width = staging.height = 0;
  };
  const fail = () => {
    if (disposed) return;
    destroy();
    onFailure();
  };

  signal.addEventListener('abort', destroy, { once: true });
  device.addEventListener('uncapturederror', fail);
  void device.lost.then(fail);

  try {
    signal.throwIfAborted();
    const format = gpu.getPreferredCanvasFormat();
    const tileCanvas = canvas.ownerDocument.createElement('canvas');
    staging = tileCanvas;
    const tileContext = tileCanvas.getContext('2d');
    if (!tileContext) throw new Error('Atlas staging canvas is unavailable');

    const side = Math.min(ATLAS_SIDE, device.limits.maxTextureDimension2D);
    const layerCount = Math.min(ATLAS_LAYERS, device.limits.maxTextureArrayLayers);
    const atlasTexture = device.createTexture({
      size: [side, side, layerCount],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    atlas = atlasTexture;
    const viewportBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM });
    uniform = viewportBuffer;
    const shader = device.createShaderModule({ code: shaderCode });
    const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } as const;
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: {
        module: shader, entryPoint: 'vertex',
        buffers: [{
          arrayStride: INSTANCE_STRIDE,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
            { shaderLocation: 2, offset: 32, format: 'float32' },
          ],
        }],
      },
      fragment: { module: shader, entryPoint: 'fragment', targets: [{ format, blend: { color: blend, alpha: blend } }] },
      primitive: { topology: 'triangle-strip' },
    });
    signal.throwIfAborted();
    if (disposed) throw new Error('WebGPU device was lost during setup');
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: viewportBuffer } },
        { binding: 1, resource: atlasTexture.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }) },
      ],
    });

    const tiles = new Map<string, Map<string, AtlasTile>>();
    const layers: AtlasLayer[] = Array.from({ length: layerCount }, () => ({ shelves: [], nextY: 0 }));
    const imageIds = new WeakMap<HTMLImageElement, number>();
    const viewportSize = new Float32Array(4);
    let tileCount = 0;
    let nextImageId = 0;
    let instances = new Float32Array(0);
    let paintedStyle: object | undefined;
    const resetTiles = () => {
      tiles.clear();
      tileCount = 0;
      for (const layer of layers) {
        layer.shelves.length = 0;
        layer.nextY = 0;
      }
    };

    const writeInstances = (input: FarNodeGpuDraw, paint: PaintCard): boolean => {
      const { cards, left, top, scaleX, scaleY } = input;
      for (let index = 0; index < cards.length; index++) {
        const card = cards[index];
        const drawWidth = card.width * scaleX;
        const drawHeight = card.height * scaleY;
        const pixelWidth = Math.max(1, Math.ceil(drawWidth));
        const pixelHeight = Math.max(1, Math.ceil(drawHeight));
        const tileWidth = pixelWidth + 2 * TILE_PADDING;
        const tileHeight = pixelHeight + 2 * TILE_PADDING;
        if (tileWidth > side || tileHeight > side) throw new Error('Far-node tile exceeds the WebGPU atlas');
        let imageId = 0;
        if (card.image) {
          imageId = imageIds.get(card.image) ?? ++nextImageId;
          imageIds.set(card.image, imageId);
        }
        // Keep even a data URL source as a map key. Avoid copying it into composite keys every frame.
        let variants = tiles.get(card.textureKey);
        const variant = [card.width, card.height, pixelWidth, pixelHeight, imageId].join('/');
        let tile = variants?.get(variant);
        if (!tile) {
          if (tileCount >= MAX_ATLAS_TILES) return false;
          tile = reserveTile(layers, side, tileWidth, tileHeight);
          if (!tile) return false;
          if (tileCanvas.width !== tileWidth) tileCanvas.width = tileWidth;
          if (tileCanvas.height !== tileHeight) tileCanvas.height = tileHeight;
          tileContext.resetTransform();
          tileContext.clearRect(0, 0, tileWidth, tileHeight);
          tileContext.setTransform(pixelWidth / card.width, 0, 0, pixelHeight / card.height, TILE_PADDING, TILE_PADDING);
          tileContext.save();
          try { paint(tileContext, { ...card, x: 0, y: 0 }); } finally { tileContext.restore(); }
          device.queue.copyExternalImageToTexture(
            { source: tileCanvas },
            { texture: atlasTexture, origin: [tile.x, tile.y, tile.layer], premultipliedAlpha: true },
            [tileWidth, tileHeight],
          );
          if (!variants) {
            variants = new Map();
            tiles.set(card.textureKey, variants);
          }
          variants.set(variant, tile);
          tileCount++;
        }

        const textureX = tile.x + TILE_PADDING;
        const textureY = tile.y + TILE_PADDING;
        instances.set([
          (card.x - left) * scaleX, (card.y - top) * scaleY, drawWidth, drawHeight,
          textureX / side, textureY / side, (textureX + pixelWidth) / side, (textureY + pixelHeight) / side, tile.layer,
        ], index * INSTANCE_FLOATS);
      }
      return true;
    };

    return {
      draw(input, paint) {
        if (disposed) return;
        try {
          const { width, height, left, top, scaleX, scaleY, cards, styleToken } = input;
          const maxEdge = device.limits.maxTextureDimension2D;
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
            || width > maxEdge || height > maxEdge || cards.length > MAX_VISIBLE_CARDS
            || ![left, top, scaleX, scaleY].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0) {
            throw new Error('Far-node frame exceeds the WebGPU resource limits');
          }
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          // Chromium validates the canvas texture at configure time. Wait for a real raster size.
          if (!context) {
            context = canvas.getContext('webgpu');
            if (!context) throw new Error('WebGPU canvas context is unavailable');
            context.configure({ device, format, alphaMode: 'premultiplied' });
          }
          if (styleToken !== paintedStyle) {
            resetTiles();
            paintedStyle = styleToken;
          }
          if (!instanceBuffer || instances.length < cards.length * INSTANCE_FLOATS) {
            const capacity = Math.max(1, 2 ** Math.ceil(Math.log2(cards.length || 1)));
            instanceBuffer?.destroy();
            instanceBuffer = device.createBuffer({ size: capacity * INSTANCE_STRIDE,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX });
            instances = new Float32Array(capacity * INSTANCE_FLOATS);
          }
          if (!writeInstances(input, paint)) {
            // Old sizes and previews can occupy shelves. Retry once with only this frame's tiles.
            resetTiles();
            if (!writeInstances(input, paint)) throw new Error('Far nodes exceed the WebGPU atlas capacity');
          }
          viewportSize[0] = width;
          viewportSize[1] = height;
          device.queue.writeBuffer(viewportBuffer, 0, viewportSize);
          if (cards.length) device.queue.writeBuffer(instanceBuffer, 0, instances.subarray(0, cards.length * INSTANCE_FLOATS));
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [{
              view: context.getCurrentTexture().createView(),
              clearValue: [0, 0, 0, 0],
              loadOp: 'clear',
              storeOp: 'store',
            }],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindings);
          pass.setVertexBuffer(0, instanceBuffer);
          pass.draw(4, cards.length);
          pass.end();
          device.queue.submit([encoder.finish()]);
        } catch {
          fail();
        }
      },
      destroy,
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
