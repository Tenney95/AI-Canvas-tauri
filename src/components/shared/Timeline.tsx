import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { MoveHorizontal, PanelBottom, RotateCcw, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { buildTicks, clampTime, clampZoom, fitZoom, formatTimelineTime, MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND, pickTickStep, sampleTimelineThumbnails, type TimelineThumbnailOptions } from './timelineGeometry';

interface TimelineRulerProps {
  duration: number;
  playhead: number;
  pixelsPerSecond: number;
  label: string;
  disabled?: boolean;
  onScrub: (event: PointerEvent<HTMLDivElement>) => void;
  onSeek?: (time: number) => void;
}

/** 对向括号表示在播放头处切开；编辑器和插件使用同一图形。 */
export function TimelineSplitIcon() {
  return <svg className="ui-timeline__split-icon" width={20} height={20} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 4h5v16H5M19 4h-5v16h5" />
  </svg>;
}

/** 多轨编辑器与独立时间轴共用的刻度尺；吸附/拖拽由调用方决定。 */
export const TimelineRuler = memo(function TimelineRuler({ duration, playhead, pixelsPerSecond,
  label, disabled = false, onScrub, onSeek }: TimelineRulerProps) {
  const step = pickTickStep(duration, pixelsPerSecond);
  return <div className="ui-timeline__ruler" onPointerDown={disabled ? undefined : onScrub}
    role="slider" aria-label={label} aria-valuenow={playhead} aria-valuemin={0} aria-valuemax={duration}
    aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onKeyDown={(event) => {
      if (disabled || !onSeek) return;
      const time = keyboardTime(event, playhead, duration);
      if (time !== null) { event.preventDefault(); event.stopPropagation(); onSeek(time); }
    }}>
    {buildTicks(duration, step).map((tick, index) => <span key={index}
      className={`ui-timeline__tick${tick.major ? ' is-major' : ''}`} style={{ left: tick.time * pixelsPerSecond }}>
      {tick.major && <em className="ui-timeline__tick-label">{formatTimelineTime(tick.time, step)}</em>}
    </span>)}
    <div className="ui-timeline__ruler-handle" style={{ left: playhead * pixelsPerSecond }} />
  </div>;
});

export const TimelineThumbnails = memo(function TimelineThumbnails(props: TimelineThumbnailOptions) {
  const frames = useMemo(() => sampleTimelineThumbnails(props), [props]);
  return <div className="ui-timeline__thumbnails" aria-hidden="true">
    {frames.map((url, index) => url ? <img key={index} src={url} alt="" draggable={false} />
      : <span key={index} className="ui-timeline__thumbnail-blank" />)}
  </div>;
});

export interface TimelineMarker { id: string; time: number }
export interface TimelineSegment { id: string; start: number; end: number; label: string }
export interface TimelineViewState { pixelsPerSecond: number | null; scrollLeft: number; selectedMarkerId?: string }
export interface TimelineLabels {
  title: string; playhead: string; track: string; segments: string; addMarker: string; removeMarker: string;
  resetMarkers: string; zoomIn: string; zoomOut: string; fit: string; position: string; marker: string;
}
export interface TimelineProps {
  duration: number;
  playhead: number;
  thumbnails: readonly string[];
  timestamps?: readonly number[];
  markers: readonly TimelineMarker[];
  segments: readonly TimelineSegment[];
  labels: TimelineLabels;
  disabled?: boolean;
  viewState?: TimelineViewState;
  onViewChange?: (view: TimelineViewState) => void;
  onSeek: (time: number) => void;
  onAddMarker?: (time: number) => void;
  onMoveMarker?: (id: string, time: number) => void;
  onRemoveMarker?: (id: string) => void;
  onResetMarkers?: () => void;
  toolbar?: ReactNode;
}

function keyboardTime(event: KeyboardEvent, time: number, duration: number): number | null {
  const delta = event.shiftKey ? 1 : 0.1;
  if (event.key === 'ArrowLeft') return clampTime(time - delta, duration);
  if (event.key === 'ArrowRight') return clampTime(time + delta, duration);
  if (event.key === 'Home') return 0;
  if (event.key === 'End') return duration;
  return null;
}

/** 受控单轨时间轴；不读取文件，不管理工程/分段规则，不访问 Store。 */
export default function Timeline({ duration: durationInput, playhead: playheadInput, thumbnails, timestamps,
  markers, segments, labels, disabled = false, viewState, onViewChange, onSeek, onAddMarker,
  onMoveMarker, onRemoveMarker, onResetMarkers, toolbar }: TimelineProps) {
  const duration = Number.isFinite(durationInput) ? Math.max(0, durationInput) : 0;
  const playhead = clampTime(playheadInput, duration);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cleanupDrag = useRef<(() => void) | null>(null);
  const suppressMarkerClick = useRef(false);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(viewState?.pixelsPerSecond ?? 40);
  const [autoFit, setAutoFit] = useState(viewState?.pixelsPerSecond == null);
  const [selectedMarkerId, setSelectedMarkerId] = useState(viewState?.selectedMarkerId);
  const [drag, setDrag] = useState<{ id: string; time: number } | null>(null);
  const blocked = disabled || duration <= 0;
  const selected = markers.find((marker) => marker.id === selectedMarkerId);
  const currentView = useRef({ pixelsPerSecond: autoFit ? null : pixelsPerSecond,
    scrollLeft: viewState?.scrollLeft ?? 0, selectedMarkerId });
  const initialScrollLeft = useRef(viewState?.scrollLeft ?? 0);
  useLayoutEffect(() => {
    currentView.current = { ...currentView.current, pixelsPerSecond: autoFit ? null : pixelsPerSecond, selectedMarkerId };
    onViewChange?.(currentView.current);
  }, [autoFit, pixelsPerSecond, selectedMarkerId, onViewChange]);
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollLeft = initialScrollLeft.current; }, []);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !autoFit || duration <= 0) return;
    const fit = () => setPixelsPerSecond(fitZoom(duration, scroll.clientWidth - 16));
    fit();
    const observer = new ResizeObserver(fit); observer.observe(scroll);
    return () => observer.disconnect();
  }, [autoFit, duration]);
  useEffect(() => () => cleanupDrag.current?.(), []);
  useEffect(() => { if (blocked) cleanupDrag.current?.(); }, [blocked]);
  const timeAt = useCallback((clientX: number) => {
    const scroll = scrollRef.current;
    return scroll ? clampTime((clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft) / pixelsPerSecond, duration) : 0;
  }, [duration, pixelsPerSecond]);
  const zoom = (factor: number) => { setAutoFit(false); setPixelsPerSecond((value) => clampZoom(value * factor)); };
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const offset = event.clientX - scroll.getBoundingClientRect().left;
        const anchor = (offset + scroll.scrollLeft) / pixelsPerSecond;
        const delta = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 30);
        const next = clampZoom(pixelsPerSecond * Math.exp(-delta / 180));
        setAutoFit(false); setPixelsPerSecond(next);
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { scroll.scrollLeft = Math.max(0, anchor * next - offset); });
      } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault(); scroll.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      }
    };
    scroll.addEventListener('wheel', wheel, { passive: false });
    return () => { scroll.removeEventListener('wheel', wheel); cancelAnimationFrame(frame); };
  }, [pixelsPerSecond]);

  const startDrag = (event: PointerEvent<HTMLElement>, marker?: TimelineMarker) => {
    if (blocked || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); cleanupDrag.current?.();
    const target = event.currentTarget;
    suppressMarkerClick.current = false;
    target.setPointerCapture(event.pointerId);
    const origin = timeAt(event.clientX);
    let time = marker?.time ?? origin;
    if (marker) { setSelectedMarkerId(marker.id); setDrag({ id: marker.id, time }); }
    else { setDrag(null); setSelectedMarkerId(undefined); onSeek(time); }
    const move = (moveEvent: globalThis.PointerEvent) => {
      time = marker ? clampTime(marker.time + timeAt(moveEvent.clientX) - origin, duration) : timeAt(moveEvent.clientX);
      if (marker) setDrag({ id: marker.id, time }); else onSeek(time);
    };
    const cleanup = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', cancel); target.removeEventListener('lostpointercapture', cancel);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      cleanupDrag.current = null;
    };
    const finish = () => {
      cleanup(); setDrag(null);
      if (marker && Math.abs(time - marker.time) >= 0.0005) {
        suppressMarkerClick.current = true;
        onMoveMarker?.(marker.id, Math.round(time * 1000) / 1000);
      }
    };
    const cancel = () => { cleanup(); setDrag(null); };
    cleanupDrag.current = cancel;
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', cancel); target.addEventListener('lostpointercapture', cancel);
  };

  return <section className="ui-timeline" aria-label={labels.title} onKeyDown={(event) => {
    if (blocked || (event.target as HTMLElement).closest('input, textarea, select')) return;
    if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation(); onAddMarker?.(playhead);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      event.preventDefault(); event.stopPropagation(); onRemoveMarker?.(selected.id);
    }
  }}>
    <div className="ui-timeline__toolbar">
      <span className="ui-timeline__title" title={labels.title} aria-label={labels.title}>
        <PanelBottom size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
      {onAddMarker && <button type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool" disabled={blocked}
        aria-label={labels.addMarker} title={`${labels.addMarker} · S`} data-action="timeline-add-marker"
        aria-keyshortcuts="S" onClick={() => onAddMarker(playhead)}><TimelineSplitIcon /></button>}
      {onRemoveMarker && <button type="button" className="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--danger ui-timeline__tool" disabled={blocked || !selected}
        aria-label={labels.removeMarker} title={`${labels.removeMarker} · Delete / Backspace`}
        onClick={() => selected && onRemoveMarker(selected.id)}><Trash2 size={20} strokeWidth={1.75} aria-hidden="true" /></button>}
      {onResetMarkers && <button type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool" disabled={blocked || !markers.length}
        aria-label={labels.resetMarkers} title={labels.resetMarkers} data-action="timeline-reset-markers"
        onClick={onResetMarkers}><RotateCcw size={20} strokeWidth={1.75} aria-hidden="true" /></button>}
      {toolbar}
      <div className="ui-timeline__zoom">
        <button type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool" aria-label={labels.zoomOut}
          title={labels.zoomOut} onClick={() => zoom(1 / 1.4)}><ZoomOut size={20} strokeWidth={1.75} aria-hidden="true" /></button>
        <input type="range" className="ui-slider" min={MIN_PIXELS_PER_SECOND} max={MAX_PIXELS_PER_SECOND}
          value={pixelsPerSecond} aria-label={`${labels.title} · ${labels.zoomIn}`} onChange={(event) => {
            setAutoFit(false); setPixelsPerSecond(clampZoom(Number(event.target.value)));
          }} />
        <button type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool" aria-label={labels.zoomIn}
          title={labels.zoomIn} onClick={() => zoom(1.4)}><ZoomIn size={20} strokeWidth={1.75} aria-hidden="true" /></button>
        <button type="button" className="ui-icon-btn ui-icon-btn--ghost ui-timeline__tool" aria-label={labels.fit}
          title={labels.fit} aria-pressed={autoFit} onClick={() => setAutoFit(true)}><MoveHorizontal size={20} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
    </div>
    <div className="ui-timeline__position">
      <label className="ui-row text-xs text-canvas-text-secondary">{labels.position}
        <input className="ui-input ui-input--sm" type="number" min={0} max={duration} step={0.001}
          data-field="timeline-position" value={Number(playhead.toFixed(3))} disabled={blocked}
          onChange={(event) => onSeek(clampTime(Number(event.target.value), duration))} />
      </label>
      <span className="text-xs text-canvas-text-muted">{playhead.toFixed(3)} / {duration.toFixed(3)}s</span>
    </div>
    <div ref={scrollRef} className="ui-timeline__scroll" onScroll={(event) => {
      currentView.current.scrollLeft = event.currentTarget.scrollLeft; onViewChange?.({ ...currentView.current });
    }}>
      <div className="ui-timeline__canvas" style={{ width: duration * pixelsPerSecond + 16 }}>
        <TimelineRuler duration={duration} playhead={playhead} pixelsPerSecond={pixelsPerSecond}
          label={labels.playhead} disabled={blocked} onScrub={startDrag} onSeek={onSeek} />
        <div className="ui-timeline__track" onPointerDown={startDrag} onDoubleClick={(event) => {
          if (!blocked) onAddMarker?.(timeAt(event.clientX));
        }} aria-label={labels.track}>
          <div className="ui-timeline__film" style={{ width: duration * pixelsPerSecond }}>
            <TimelineThumbnails thumbnails={thumbnails} timestamps={timestamps} sourceDuration={duration}
              duration={duration} pixelsPerSecond={pixelsPerSecond} />
            <span className="ui-timeline__track-name">{labels.track}</span>
          </div>
        </div>
        <div className="ui-timeline__segments" aria-label={labels.segments}>
          {segments.map((segment) => <button type="button" key={segment.id} className="ui-timeline__segment"
            style={{ left: segment.start * pixelsPerSecond, width: (segment.end - segment.start) * pixelsPerSecond }}
            disabled={blocked} onClick={() => onSeek(segment.start)} title={segment.label}>
            {segment.label}
          </button>)}
        </div>
        {markers.map((marker) => <button type="button" key={marker.id} disabled={blocked}
          className={`ui-timeline__marker${selectedMarkerId === marker.id ? ' is-selected' : ''}`}
          style={{ left: (drag?.id === marker.id ? drag.time : marker.time) * pixelsPerSecond }}
          aria-label={`${labels.marker} ${marker.time.toFixed(3)}s`} aria-pressed={selectedMarkerId === marker.id}
          title={`${labels.marker} ${marker.time.toFixed(3)}s`} onPointerDown={(event) => startDrag(event, marker)}
          onFocus={() => setSelectedMarkerId(marker.id)}
          onClick={() => {
            if (suppressMarkerClick.current) { suppressMarkerClick.current = false; return; }
            setSelectedMarkerId(marker.id); onSeek(marker.time);
          }} onKeyDown={(event) => {
            const time = keyboardTime(event, marker.time, duration);
            if (!blocked && time !== null) { event.preventDefault(); event.stopPropagation(); onMoveMarker?.(marker.id, Math.round(time * 1000) / 1000); }
          }}><span aria-hidden="true">◆</span></button>)}
        <div className="ui-timeline__playhead" style={{ left: playhead * pixelsPerSecond }} aria-hidden="true" />
      </div>
    </div>
  </section>;
}
