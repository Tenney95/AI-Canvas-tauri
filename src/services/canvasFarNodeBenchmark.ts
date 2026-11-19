import { isTauri } from '@tauri-apps/api/core';
import { useAppStore } from '../store/useAppStore';
import { getCanvasViewportController, type CanvasViewportController } from './canvasViewportService';
import { probeHtmlInCanvas as runHtmlInCanvasProbe } from './htmlInCanvasProbe';

const MODE_KEY = 'canvas-far-layer-benchmark';
const MODE_EVENT = 'ai-canvas:far-layer-benchmark';
const FAR_LAYER = '[data-canvas-far-layer]';
const START_ZOOM = 0.11486761710794298;
const PHASES = [[190, 0, 1], [-140, 120, 1], [120, 60, 1.4], [0, 0, 1]] as const;
const PHASE_MS = 650;
const LONG_FRAME_MS = 50;
const READY_TIMEOUT_MS = 30_000;
type Mode = 'dom' | 'canvas' | 'webgpu';
type Viewport = Parameters<CanvasViewportController['setViewport']>[0];

function assertMode(mode: Mode) {
  if (mode !== 'dom' && mode !== 'canvas' && mode !== 'webgpu') throw new Error('请选择 dom、canvas 或 webgpu');
}

function selectMode(mode: Mode) {
  assertMode(mode);
  sessionStorage.setItem(MODE_KEY, mode);
  window.dispatchEvent(new Event(MODE_EVENT));
}

function status() {
  const state = useAppStore.getState();
  const layer = document.querySelector<HTMLCanvasElement>(FAR_LAYER);
  const root = layer?.closest('.react-flow') ?? document.querySelector('.react-flow');
  const viewport = getCanvasViewportController()?.getSnapshot();
  return {
    requestedMode: sessionStorage.getItem(MODE_KEY) ?? 'canvas',
    backend: layer?.dataset.canvasFarBackend ?? (layer ? null : 'dom'),
    webgpuStatus: layer?.dataset.webgpuStatus ?? null,
    webgpuReason: layer?.dataset.webgpuReason ?? null,
    nodeCount: state.nodes.length,
    edgeCount: state.edges.length,
    mountedNodeCount: root?.querySelectorAll('.react-flow__node').length ?? 0,
    mountedHandleCount: root?.querySelectorAll('.react-flow__handle').length ?? 0,
    canvasCards: Number(layer?.dataset.renderedNodeCount ?? 0),
    previewReady: layer ? Number(layer.dataset.previewReadyCount ?? 0)
      : root?.querySelectorAll('.canvas-node-lod-image.is-ready').length ?? 0,
    previewTarget: layer ? Number(layer.dataset.previewTargetCount ?? 0)
      : root?.querySelectorAll('[data-canvas-node-lod="preview"]').length ?? 0,
    bitmapRasters: Number(layer?.dataset.bitmapRasterCount ?? 0),
    zoom: viewport?.zoom ?? null,
    width: root?.clientWidth ?? window.innerWidth,
    height: root?.clientHeight ?? window.innerHeight,
    dpr: window.devicePixelRatio,
    theme: document.documentElement.dataset.theme ?? null,
    minimap: root?.querySelector('[data-minimap-renderer]')?.getAttribute('data-minimap-renderer') ?? null,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints,
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function expectedBackend(mode: Mode) {
  return mode === 'canvas' ? 'canvas2d' : mode;
}

function matchesBackend(mode: Mode, snapshot: ReturnType<typeof status>) {
  return snapshot.backend === expectedBackend(mode) && (mode !== 'webgpu' || snapshot.webgpuStatus === 'active');
}

async function waitForPreviews(mode: Mode, assertCurrent: () => void) {
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    assertCurrent();
    const snapshot = status();
    if (mode === 'webgpu' && (snapshot.webgpuStatus === 'unsupported' || snapshot.webgpuStatus === 'failed')) {
      throw new Error(`WebGPU 未启用，当前渲染为 ${snapshot.backend}（${snapshot.webgpuReason ?? snapshot.webgpuStatus}）`);
    }
    if (matchesBackend(mode, snapshot) && snapshot.previewTarget > 0
      && snapshot.previewReady >= Math.ceil(snapshot.previewTarget * 0.9)) return;
    await wait(100);
  }
  const snapshot = status();
  throw new Error(`远景预热超时，当前渲染为 ${snapshot.backend}（${snapshot.webgpuReason ?? snapshot.webgpuStatus ?? '无 GPU 状态'}），缩略图就绪 ${snapshot.previewReady}/${snapshot.previewTarget}。请清空节点选中并关闭弹窗后重试。`);
}

function summarize(gaps: number[]) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? null;
  return {
    frames: gaps.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
    over50: gaps.filter((gap) => gap > LONG_FRAME_MS).length,
    excess50: gaps.reduce((total, gap) => total + Math.max(0, gap - LONG_FRAME_MS), 0),
  };
}

async function runTrajectory(controller: CanvasViewportController, origin: Viewport, assertCurrent: () => void) {
  const phaseGaps: number[][] = PHASES.map(() => []);
  let phase = 0;
  let lastPhase = 0;
  let lastFrame: number | undefined;
  const collect = (now: number) => {
    if (lastFrame !== undefined) phaseGaps[lastPhase].push(now - lastFrame);
    lastFrame = now;
    lastPhase = phase;
    frame = requestAnimationFrame(collect);
  };
  let frame = requestAnimationFrame(collect);
  const started = performance.now();
  try {
    for (const [index, [dx, dy, scale]] of PHASES.entries()) {
      assertCurrent();
      phase = index;
      const zoom = origin.zoom * scale;
      await controller.setViewport({ x: origin.x + dx, y: origin.y + dy, zoom }, PHASE_MS);
      if (Math.abs(controller.getSnapshot().zoom - zoom) > 0.001) {
        throw new Error('画布缩放已锁定或超出允许范围，请解除锁定后重试');
      }
    }
    assertCurrent();
  } finally {
    cancelAnimationFrame(frame);
  }
  const gaps = phaseGaps.flat();
  const pan = summarize(phaseGaps.slice(0, 2).flat());
  const zoom = summarize(phaseGaps.slice(2).flat());
  if (!pan.frames || !zoom.frames) throw new Error('帧样本不足，请让测试窗口保持前台');
  return { elapsed: performance.now() - started, ...summarize(gaps), pan, zoom, gaps, phaseGaps };
}

/** 开发版桌面窗口的 DevTools 入口。只读取项目并临时改变视口和渲染模式。 */
export function installCanvasFarNodeBenchmark(): () => void {
  if (!import.meta.env.DEV || !isTauri()) return () => {};

  let running = false;
  let disposed = false;
  let probing: ReturnType<typeof runHtmlInCanvasProbe> | undefined;
  const api = {
    status,
    setMode(mode: Mode) {
      if (running || probing) throw new Error('请等待当前基准测试或能力探测完成');
      selectMode(mode);
    },
    probeHtmlInCanvas() {
      if (running) throw new Error('请等待当前基准测试完成');
      probing ??= runHtmlInCanvasProbe().finally(() => { probing = undefined; });
      return probing;
    },
    async run(mode: Mode) {
      assertMode(mode);
      if (running || probing) throw new Error('请等待当前基准测试或能力探测完成');
      if (mode !== 'dom' && navigator.maxTouchPoints > 0) throw new Error('此原型在具备触屏能力的设备保留 DOM 路径');
      const controller = getCanvasViewportController();
      const { currentProjectId, nodes, edges, selectedNodeIds, activeNodeId } = useAppStore.getState();
      if (!controller || !currentProjectId || nodes.length !== 600 || edges.length !== 1353) {
        throw new Error('请打开 600 节点、1353 条连线的桌面测试项目');
      }
      if (selectedNodeIds.length || activeNodeId || edges.some((edge) => edge.selected)
        || document.querySelector('[aria-modal="true"]:not([hidden])')) {
        throw new Error('请清空画布选中并关闭弹窗后重试');
      }
      const initial = controller.getSnapshot();
      const isCurrent = () => !disposed && getCanvasViewportController() === controller
        && useAppStore.getState().currentProjectId === currentProjectId;
      let foreground = document.visibilityState === 'visible';
      const onVisibility = () => { if (document.visibilityState !== 'visible') foreground = false; };
      const assertCurrent = () => {
        if (!isCurrent()) throw new Error('测试项目已切换');
        if (!foreground || document.visibilityState !== 'visible') throw new Error('请让测试窗口保持前台');
      };
      assertCurrent();
      running = true;
      document.addEventListener('visibilitychange', onVisibility);
      try {
        selectMode(mode);
        await controller.fitView();
        assertCurrent();
        const fit = controller.getSnapshot();
        const centerX = fit.visibleBounds.x + fit.visibleBounds.width / 2;
        const centerY = fit.visibleBounds.y + fit.visibleBounds.height / 2;
        const origin = {
          x: fit.x + centerX * (fit.zoom - START_ZOOM),
          y: fit.y + centerY * (fit.zoom - START_ZOOM),
          zoom: START_ZOOM,
        };
        await controller.setViewport(origin);
        if (Math.abs(controller.getSnapshot().zoom - origin.zoom) > 0.001) {
          throw new Error('画布缩放已锁定或超出允许范围，请解除锁定后重试');
        }
        await waitForPreviews(mode, assertCurrent);
        await runTrajectory(controller, origin, assertCurrent);
        await waitForPreviews(mode, assertCurrent);
        const before = status();
        const measurements = await runTrajectory(controller, origin, assertCurrent);
        const after = status();
        if (!matchesBackend(mode, before) || !matchesBackend(mode, after)) {
          throw new Error(`运行期间渲染后端发生变化，结束时为 ${after.backend}（${after.webgpuReason ?? after.webgpuStatus ?? '无 GPU 状态'}）`);
        }
        if (before.width !== after.width || before.height !== after.height || before.dpr !== after.dpr
          || before.theme !== after.theme || before.minimap !== after.minimap) {
          throw new Error('运行期间画布窗口或主题发生变化，请保持环境一致后重试');
        }
        return { mode, phases: PHASES, durationPerPhaseMs: PHASE_MS, origin, before, after, ...measurements };
      } finally {
        document.removeEventListener('visibilitychange', onVisibility);
        try {
          if (isCurrent()) await controller.setViewport({ x: initial.x, y: initial.y, zoom: initial.zoom });
        } finally { running = false; }
      }
    },
  };

  window.canvasFarNodeBenchmark = api;
  return () => {
    disposed = true;
    if (window.canvasFarNodeBenchmark === api) delete window.canvasFarNodeBenchmark;
  };
}

declare global {
  interface Window {
    canvasFarNodeBenchmark?: {
      status: typeof status;
      setMode: (mode: Mode) => void;
      probeHtmlInCanvas: typeof runHtmlInCanvasProbe;
      run: (mode: Mode) => Promise<unknown>;
    };
  }
}
