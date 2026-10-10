/** 时间轴显示计算；不依赖编辑器工程、Store 或媒体读取能力。 */
export const MIN_PIXELS_PER_SECOND = 2;
export const MAX_PIXELS_PER_SECOND = 400;
export const TIMELINE_THUMBNAIL_WIDTH = 64;
const MAX_TIMELINE_THUMBNAILS = 360;
const STEP_CANDIDATES = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function clampZoom(pixelsPerSecond: number): number {
  return Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, pixelsPerSecond));
}

export function fitZoom(duration: number, availableWidth: number): number {
  if (duration <= 0 || availableWidth <= 0) return 40;
  return clampZoom(availableWidth / duration);
}

export function clampTime(time: number, duration: number): number {
  return Number.isFinite(time) ? Math.min(Math.max(0, duration), Math.max(0, time)) : 0;
}

export function pickTickStep(duration: number, pixelsPerSecond?: number): number {
  if (duration <= 0) return 1;
  const ideal = pixelsPerSecond && pixelsPerSecond > 0 ? 72 / pixelsPerSecond : duration / 8;
  return STEP_CANDIDATES.find((candidate) => candidate >= ideal) ?? 600;
}

export function formatTickLabel(time: number, step: number): string {
  if (time >= 60) return `${Math.floor(time / 60)}:${(time % 60).toFixed(0).padStart(2, '0')}`;
  return step < 1 ? time.toFixed(1) : String(Math.round(time));
}

/** 紧凑刻度统一显示时间码；放大到亚秒刻度时保留十分之一秒。 */
export function formatTimelineTime(time: number, step: number): string {
  const precision = step < 1 ? 10 : 1;
  const units = Math.round((Number.isFinite(time) ? Math.max(0, time) : 0) * precision);
  const seconds = Math.floor(units / precision);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${hours ? `${pad(hours)}:` : ''}${pad(minutes)}:${pad(seconds % 60)}${precision === 10 ? `.${units % 10}` : ''}`;
}

export interface RulerTick { time: number; major: boolean }
export function buildTicks(duration: number, step: number): RulerTick[] {
  if (duration <= 0 || step <= 0 || !Number.isFinite(duration) || !Number.isFinite(step)) return [];
  const ticks: RulerTick[] = [];
  const minorStep = step / 5;
  for (let index = 0; index * minorStep <= duration + 1e-6; index += 1) {
    const time = index * minorStep;
    ticks.push({ time, major: Math.abs(time / step - Math.round(time / step)) < 1e-6 });
  }
  return ticks;
}

export interface TimelineThumbnailOptions {
  thumbnails: readonly string[];
  /** 可选真实抽帧时间；不传时沿用编辑器的等间隔源帧索引。 */
  timestamps?: readonly number[];
  sourceDuration: number;
  sourceIn?: number;
  duration: number;
  pixelsPerSecond: number;
  still?: boolean;
}

export function sampleTimelineThumbnails({ thumbnails, timestamps, sourceDuration, sourceIn = 0,
  duration, pixelsPerSecond, still = false }: TimelineThumbnailOptions): string[] {
  if (!thumbnails.length || duration <= 0 || (!still && sourceDuration <= 0)) return [];
  const count = Math.max(1, Math.min(MAX_TIMELINE_THUMBNAILS,
    Math.ceil(duration * pixelsPerSecond / TIMELINE_THUMBNAIL_WIDTH)));
  return Array.from({ length: count }, (_, index) => {
    if (still) return thumbnails[0];
    const time = sourceIn + (index + 0.5) / count * duration;
    let frameIndex = Math.min(thumbnails.length - 1, Math.max(0, Math.floor(time / sourceDuration * thumbnails.length)));
    if (timestamps?.length === thumbnails.length) {
      frameIndex = timestamps.reduce((nearest, candidate, candidateIndex) => (
        Math.abs(candidate - time) < Math.abs(timestamps[nearest] - time) ? candidateIndex : nearest
      ), 0);
    }
    return thumbnails[frameIndex];
  });
}
