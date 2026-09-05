/** UI Kit 内的真实吉祥物预览；仅在预览区域可见时加载并挂载 WebGL。 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import LazyLoadBoundary from '../shared/LazyLoadBoundary';
import type { MascotHandle, MascotStatus } from '../shared/mascot/Mascot';
import { MASCOT_CLIPS, type MascotClipId } from '../shared/mascot/mascotClips';

const Mascot = lazy(() => import('../shared/mascot/Mascot'));

type PreviewChoice =
  | { kind: 'status'; id: MascotStatus; label: string }
  | { kind: 'clip'; id: MascotClipId; label: string };

const STATUS_CHOICES: readonly PreviewChoice[] = [
  { kind: 'status', id: 'idle', label: '待机' },
  { kind: 'status', id: 'thinking', label: '思考' },
  { kind: 'status', id: 'success', label: '成功' },
  { kind: 'status', id: 'error', label: '失败' },
];
const CLIP_CHOICES: readonly PreviewChoice[] = [
  { kind: 'clip', id: 'excited', label: '兴奋' },
  { kind: 'clip', id: 'surprised', label: '惊讶' },
  { kind: 'clip', id: 'suspicious', label: '怀疑' },
  { kind: 'clip', id: 'angry', label: '生气' },
  { kind: 'clip', id: 'remind', label: '提醒' },
  { kind: 'clip', id: 'sleepy', label: '困倦' },
  { kind: 'clip', id: 'sleep', label: '睡眠' },
  { kind: 'clip', id: 'wake', label: '醒来' },
  { kind: 'clip', id: 'rest', label: '休息' },
];
const DEMO_CHOICES = [...STATUS_CHOICES, ...CLIP_CHOICES];

interface MascotPlaybackProps {
  choice: PreviewChoice;
  theme: 'dark' | 'light';
  reduceMotion: boolean;
}

/** 随 Mascot 一起放在 Suspense 内，确保播放指令发出时，真实组件的句柄已经就绪。 */
function MascotPlayback({ choice, theme, reduceMotion }: MascotPlaybackProps) {
  const handleRef = useRef<MascotHandle | null>(null);
  const [status, setStatus] = useState<MascotStatus>('idle');

  useEffect(() => {
    if (choice.kind === 'clip') {
      handleRef.current?.playClip(choice.id);
      return;
    }
    // 先挂载待机，再切到目标状态，成功/失败才能走真实的状态转场反应。
    const frame = requestAnimationFrame(() => setStatus(choice.id));
    return () => cancelAnimationFrame(frame);
  }, [choice]);

  return (
    <Mascot
      handleRef={handleRef}
      theme={theme}
      status={status}
      loading={status === 'thinking'}
      reduceMotion={reduceMotion}
    />
  );
}

export default function StyleGuideMascot({ theme }: { theme: 'dark' | 'light' }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [choice, setChoice] = useState<PreviewChoice>(STATUS_CHOICES[0]);
  const [playbackId, setPlaybackId] = useState(0);
  const [small, setSmall] = useState(false);
  const [looping, setLooping] = useState(false);
  const [manualReduceMotion, setManualReduceMotion] = useState(false);
  const systemReduceMotion = useReducedMotion();
  const reduceMotion = Boolean(systemReduceMotion) || manualReduceMotion;
  const active = inView && pageVisible;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin: '48px',
    });
    observer.observe(stage);
    const handleVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (!looping || !active || reduceMotion) return;
    const duration = choice.kind === 'clip' ? MASCOT_CLIPS[choice.id].duration : 2.2;
    // 给一次性反应留出回落时间，困倦则播完一整次点头再切换。
    const holdSeconds = Number.isFinite(duration)
      ? duration + 0.9
      : choice.id === 'sleepy' ? 6.2 : 3.6;
    const timer = window.setTimeout(() => {
      const index = DEMO_CHOICES.findIndex((item) => item.kind === choice.kind && item.id === choice.id);
      setChoice(DEMO_CHOICES[(index + 1) % DEMO_CHOICES.length]);
      setPlaybackId((value) => value + 1);
    }, holdSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [active, choice, looping, reduceMotion]);

  const selectChoice = (next: PreviewChoice) => {
    setLooping(false);
    setChoice(next);
    // 重建仅限预览实例，让任意片段都能重播，不修改实际业务的片段优先级。
    setPlaybackId((value) => value + 1);
  };
  const isSelected = (item: PreviewChoice) => item.kind === choice.kind && item.id === choice.id;

  return (
    <div className="ui-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-canvas-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="ui-card__title">动画预览</h3>
          <span className="ui-badge ui-badge--primary">{choice.label}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="ui-segmented" role="group" aria-label="预览尺寸">
            <button
              type="button"
              className={`ui-segmented__item${small ? ' is-active' : ''}`}
              aria-pressed={small}
              onClick={() => setSmall(true)}
            >
              实际 100px
            </button>
            <button
              type="button"
              className={`ui-segmented__item${small ? '' : ' is-active'}`}
              aria-pressed={!small}
              onClick={() => setSmall(false)}
            >
              放大查看
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-canvas-text-secondary">减少动态</span>
            <button
              type="button"
              role="switch"
              className="ui-switch"
              aria-label="减少动态"
              aria-checked={reduceMotion}
              disabled={Boolean(systemReduceMotion)}
              onClick={() => setManualReduceMotion((value) => !value)}
            />
          </div>
        </div>
      </div>

      <div ref={stageRef} className="flex h-72 items-center justify-center bg-canvas-surface">
        <div
          className={small ? 'h-[100px] w-[100px]' : 'h-60 w-60'}
          role="img"
          aria-label={`吉祥物预览：${choice.label}`}
        >
          {active ? (
            <LazyLoadBoundary label="吉祥物预览">
              <Suspense fallback={<p className="text-center text-xs text-canvas-text-muted">正在加载吉祥物…</p>}>
                <MascotPlayback key={playbackId} choice={choice} theme={theme} reduceMotion={reduceMotion} />
              </Suspense>
            </LazyLoadBoundary>
          ) : null}
        </div>
      </div>

      <div className="ui-card__body ui-stack">
        {[
          { label: '助手状态', choices: STATUS_CHOICES },
          { label: '表情片段', choices: CLIP_CHOICES },
        ].map((group) => (
          <div key={group.label} className="flex flex-wrap items-center gap-2" role="group" aria-label={group.label}>
            <span className="w-16 shrink-0 text-xs text-canvas-text-muted">{group.label}</span>
            {group.choices.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`ui-btn ui-btn--sm${isSelected(item) ? ' is-active' : ''}`}
                aria-pressed={isSelected(item)}
                onClick={() => selectChoice(item)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-canvas-text-muted">播放控制</span>
          <button
            type="button"
            className={`ui-btn ui-btn--sm${looping && !reduceMotion ? ' is-active' : ''}`}
            aria-pressed={looping && !reduceMotion}
            disabled={reduceMotion}
            onClick={() => setLooping((value) => !value)}
          >
            循环演示
          </button>
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => selectChoice(choice)}>
            重新播放
          </button>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => selectChoice(STATUS_CHOICES[0])}>
            回到待机
          </button>
        </div>
        <p className="m-0 text-xs leading-relaxed text-canvas-text-muted">
          {systemReduceMotion
            ? '系统已开启减少动态，预览保留静态表情。'
            : reduceMotion
              ? '已开启减少动态，预览保留静态表情。'
              : '移动鼠标查看眼神与身体跟随；思考状态可查看加载彩带。'}
          {' '}明暗主题跟随窗口右上角切换。
        </p>
      </div>
    </div>
  );
}
