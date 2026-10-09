import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../store/useAppStore';
import type { DirectorPrevisScene, DirectorPrevisView, PrevisCameraKeyframe, PrevisVector } from '../../types/directorPrevis';
import { createDefaultPrevisScene, normalizeDirectorPrevisScene, PREVIS_MAX_DURATION } from '../../services/directorPrevisSchema';
import { cancelDirectorPrevisGeneration, generateDirectorPrevis, loadDirectorPrevisScene, saveDirectorPrevisScene, saveDirectorPrevisOutput } from '../../services/directorPrevisService';
import { samplePrevisCamera, type DirectorPrevisRenderer } from '../../services/directorPrevisRenderer';
import { isTauriEnv } from '../../services/fileService';
import { parseProjectModelRef } from '../../services/projectSettingsService';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';
import ModelSelector from '../nodes/shared/ModelSelector';
import MentionEditor, { type MentionEditorHandle } from '../nodes/shared/MentionEditor';
import ConnectedNodesPreview from '../nodes/shared/ConnectedNodesPreview';
import NumberStepper from '../shared/NumberStepper';
import DirectorPrevisViewport from './DirectorPrevisViewport';

const EXAMPLE = '人物穿过走廊，摄影机从背后跟拍，最后绕到正面，8 秒，35mm 起步，结尾 50mm 中近景。';
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }

export default function DirectorPrevisDialog({ nodeId, initialAction = 'editor', onClose }: {
  nodeId: string; initialAction?: 'editor' | 'frame' | 'video'; onClose: () => void;
}) {
  const data = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data);
  const projectId = useAppStore((state) => state.currentProjectId);
  const projectModelRef = useAppStore((state) => state.projects.find((project) => project.id === state.currentProjectId)?.settings?.defaultModels?.text);
  const projectModel = parseProjectModelRef(projectModelRef);
  const theme = useAppStore((state) => state.config.theme);
  const reference = data?.directorPrevisScene;
  const [scene, setScene] = useState(createDefaultPrevisScene);
  const [dirty, setDirty] = useState(!reference);
  const [description, setDescription] = useState(data?.prompt || data?.directorPrevisPrompt || EXAMPLE);
  const [model, setModel] = useState(data?.model || data?.directorPrevisModel || projectModel?.model || '');
  const [provider, setProvider] = useState(data?.provider || data?.directorPrevisProvider || projectModel?.provider || '');
  const editor = useRef<MentionEditorHandle | null>(null);
  const [view, setView] = useState<DirectorPrevisView>('camera');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState(0);
  const [busy, setBusy] = useState(reference ? '载入预演…' : '');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const renderer = useRef<DirectorPrevisRenderer | null>(null);
  const operation = useRef<AbortController | null>(null);
  const savedHash = useRef<string | undefined>(undefined);
  const initialRequest = useRef(initialAction !== 'editor');
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const renderTime = useRef(time);
  const originalProject = useRef(projectId);
  const originalInstance = useRef(data?.directorInstanceId);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; renderTime.current = time; }, [onClose, time]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); };
  }, []);
  useEffect(() => {
    if (projectId !== originalProject.current || !data || data.directorRuntimeKind !== 'ai-threejs'
      || data.directorInstanceId !== originalInstance.current) {
      operation.current?.abort();
      closeRef.current();
    }
  }, [projectId, data]);

  useEffect(() => {
    if (!reference) {
      if (savedHash.current || operation.current) {
        operation.current?.abort(); operation.current = null; busyRef.current = false; savedHash.current = undefined;
        queueMicrotask(() => { if (mounted.current) { setScene(createDefaultPrevisScene()); setDirty(true); setTime(0); setPlaying(false); setSelectedFrame(0); setBusy(''); } });
      }
      return;
    }
    if (!projectId || reference.sha256 === savedHash.current) return;
    let stale = false;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    busyRef.current = true;
    queueMicrotask(() => { if (!stale) { setBusy('载入预演…'); setPlaying(false); } });
    void loadDirectorPrevisScene(projectId, reference).then((loaded) => {
      if (stale) return;
      savedHash.current = reference.sha256;
      setScene(loaded); setDirty(false); setTime(0); setPlaying(false); setSelectedFrame(0); setError('');
    }).catch(() => {
      if (!stale) {
        setDirty(true);
        initialRequest.current = false;
        setError('预演场景读取或校验失败，请检查项目文件；可重新生成场景');
      }
    }).finally(() => {
      if (!stale && operation.current === controller) { operation.current = null; busyRef.current = false; setBusy(''); }
    });
    return () => { stale = true; controller.abort(); };
  }, [reference, projectId]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const startTime = performance.now();
    const startPosition = renderTime.current >= scene.duration ? 0 : renderTime.current;
    const tick = (now: number) => {
      const next = Math.min(scene.duration, startPosition + (now - startTime) / 1000);
      setTime(next);
      if (next >= scene.duration) { setPlaying(false); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, scene.duration]);

  const onReady = useCallback((value: DirectorPrevisRenderer | null) => { renderer.current = value; setReady(!!value); }, []);
  const generating = data?.status === 'loading';
  const controlsBusy = !!busy || generating;
  const run = useCallback(async (label: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(label); setError(''); setPlaying(false); setProgress(0);
    try { await action(controller.signal); }
    catch (failure) {
      if (mounted.current) {
        const suggestion = label === '生成镜头预演…' ? '模型配置或项目存储' :
          label === '导出参考视频…' ? '项目存储或视频编码支持' : '项目存储';
        setError(isAbort(failure) ? '操作已取消或画布发生变化，未写回结果' :
          failure instanceof Error && failure.message.startsWith('预演场景数据无效：') ? failure.message :
            `${label.replace(/…$/, '')}失败，请检查${suggestion}后重试`);
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        busyRef.current = false;
        if (mounted.current) setBusy('');
      }
    }
  }, []);

  const exportOutput = useCallback((kind: 'image' | 'video') => {
    const instance = renderer.current;
    if (!instance || dirty || !reference) return;
    return run(kind === 'image' ? '同步当前镜头…' : '导出参考视频…', async (signal) => {
      await saveDirectorPrevisOutput(nodeId, kind,
        kind === 'image' ? async () => instance.capture(renderTime.current) :
          (operationSignal) => instance.exportVideo(operationSignal, (value) => { if (mounted.current) setProgress(value); }), signal);
      if (mounted.current) useAppStore.getState().showToast(kind === 'image' ? '当前镜头已同步到导演节点' : '运镜参考视频已导出，并在旁边创建视频节点');
    });
  }, [dirty, nodeId, reference, run]);

  const canGenerate = !controlsBusy && isTauriEnv() && !!model && !!provider && !!description.trim() && description.length <= 12000;
  const generate = () => {
    if (!canGenerate) return;
    void run('生成镜头预演…', async (signal) => {
      const generated = await generateDirectorPrevis({ nodeId, description, model, provider, previous: reference ? scene : undefined, signal });
      if (!mounted.current || signal.aborted) return;
      savedHash.current = useAppStore.getState().nodes.find((node) => node.id === nodeId)?.data.directorPrevisScene?.sha256;
      setScene(generated); setDirty(false); setTime(0); setSelectedFrame(0);
    });
  };

  useEffect(() => {
    if (!initialRequest.current || controlsBusy || !ready || dirty || !reference) return;
    initialRequest.current = false;
    void exportOutput(initialAction === 'video' ? 'video' : 'image');
  }, [initialAction, controlsBusy, ready, dirty, reference, exportOutput]);

  const apply = (next: DirectorPrevisScene) => {
    try {
      const normalized = normalizeDirectorPrevisScene(next);
      setScene(normalized); setDirty(true); setPlaying(false); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '关键帧数据无效'); }
  };
  const updateFrame = (patch: Partial<PrevisCameraKeyframe>) => {
    const frames = scene.camera.keyframes.map((frame, index) => index === selectedFrame ? { ...frame, ...patch } : frame);
    apply({ ...scene, camera: { keyframes: frames } });
  };
  const resizeDuration = (duration: number) => {
    if (!Number.isFinite(duration) || duration < 1 || duration > PREVIS_MAX_DURATION) return;
    const ratio = duration / scene.duration;
    apply({ ...scene, duration, camera: { keyframes: scene.camera.keyframes.map((frame, index, frames) => ({ ...frame, time: index === frames.length - 1 ? duration : frame.time * ratio })) },
      objects: scene.objects.map((object) => ({ ...object, keyframes: object.keyframes.map((frame) => ({ ...frame, time: frame.time * ratio })) })) });
    setTime(Math.min(duration, time * ratio));
  };
  const currentFrame = scene.camera.keyframes[Math.min(selectedFrame, scene.camera.keyframes.length - 1)];
  const currentCamera = samplePrevisCamera(scene, time);
  const desktop = isTauriEnv();
  const canOutput = desktop && ready && !controlsBusy && !dirty && !!reference;

  return (
    <ModalOverlay isOpen onClose={() => { operation.current?.abort(); onClose(); }} ariaLabel="AI 镜头预演"
      className="h-[min(820px,calc(100dvh-32px))] w-[min(1180px,calc(100vw-32px))]" motionPreset="quick">
      <header className="flex shrink-0 items-center gap-2 border-b border-canvas-border px-2.5 py-2">
        <Icon icon="lucide:clapperboard" width={18} className="text-canvas-text-secondary" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-canvas-text">AI 镜头预演</h2>
          <p className="ui-hint">空间 · 简模 · 人物走位 · 摄影机运动</p>
        </div>
        <span className="ui-hint">{dirty ? reference ? '有未保存调整' : '示例 · 尚未保存' : '已保存'}</span>
        <PopupCloseButton
          ariaLabel="关闭镜头预演"
          onClick={() => { operation.current?.abort(); onClose(); }}
        />
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
        <section className="flex min-h-[340px] min-w-0 flex-col gap-2 p-3 lg:min-h-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm text-canvas-text">{scene.title}</h3>
            <div className="ui-btn-group" role="group" aria-label="预演视角">
              {([['camera', '镜头'], ['space', '空间'], ['top', '俯视']] as const).map(([value, label]) => (
                <button key={value} type="button" className={`ui-btn ui-btn--sm ${view === value ? 'is-active' : ''}`}
                  aria-pressed={view === value} disabled={controlsBusy} onClick={() => setView(value)}>{label}</button>
              ))}
            </div>
          </div>
          <DirectorPrevisViewport scene={scene} time={time} view={view} theme={theme} onReady={onReady} />
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="ui-icon-btn" disabled={controlsBusy || !ready} aria-label={playing ? '暂停运镜' : '播放运镜'} onClick={() => setPlaying(!playing)}>
              <Icon icon={playing ? 'lucide:pause' : 'lucide:play'} width={16} />
            </button>
            <button type="button" className="ui-icon-btn" disabled={controlsBusy} aria-label="回到起点" onClick={() => { setPlaying(false); setTime(0); }}>
              <Icon icon="lucide:rotate-ccw" width={16} />
            </button>
            <input type="range" aria-label="镜头时间轴" className="min-w-0 flex-1" min={0} max={scene.duration} step={1 / 24} value={time} disabled={controlsBusy}
              onChange={(event) => { setPlaying(false); setTime(Number(event.target.value)); }} />
            <output className="shrink-0 text-xs tabular-nums text-canvas-text-secondary">{time.toFixed(1)} / {scene.duration.toFixed(1)}s</output>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="ui-hint">{scene.aspectRatio} · {Math.round(currentCamera.focalLength)} mm · {scene.objects.length} 个简模 · {scene.camera.keyframes.length} 个相机关键帧</p>
            <div className="flex gap-2">
              <button type="button" className="ui-btn ui-btn--sm" disabled={!canOutput} onClick={() => { void exportOutput('image'); }}>同步当前镜头</button>
              <button type="button" className="ui-btn ui-btn--sm" disabled={!canOutput} onClick={() => { void exportOutput('video'); }}>导出参考视频</button>
            </div>
          </div>
          <p className="ui-hint">{view === 'space' ? '拖动旋转，滚轮缩放，右键平移；轨迹和摄影机标记仅用于观察。' : '截图与视频按摄影机视角输出，辅助标记不会进入画面。'}</p>
        </section>
        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-t border-canvas-border p-3 lg:border-l lg:border-t-0">
          {!desktop && <p className="ui-hint">网页模式可查看和调整示例；模型生成、保存及节点输出需要桌面版。</p>}
          <fieldset disabled={controlsBusy} inert={controlsBusy} className="ui-field">
            <label className="ui-label">文本模型</label>
            <ModelSelector nodeType="ai-text" selectedModel={model} selectedProvider={provider}
              onSelect={(option) => { setModel(option.value); setProvider(option.provider); }} />
          </fieldset>
          <div className="ui-field">
            <span id={`previs-prompt-label-${nodeId}`} className="ui-label">场景与运镜描述</span>
            <fieldset disabled={controlsBusy} inert={controlsBusy} className="min-w-0 [&_.connected-nodes-float]:w-full [&_.connected-nodes-float]:max-w-full [&_.connected-nodes-float]:px-0 [&_.connected-nodes-strip]:flex-wrap">
              <ConnectedNodesPreview nodeId={nodeId} onInsertMention={(mention) => {
                const match = /^@\{([^:}]+):([^}]*)\}$/.exec(mention);
                if (match) editor.current?.insertMentionAtCursor(match[1], match[2]);
              }} />
              <div className="ui-textarea focus-within:border-[var(--border-focus)] focus-within:ring-2 focus-within:ring-[var(--brand-alpha-12)] [&_.mention-dropdown]:static [&_.mention-dropdown]:mt-2 [&_.mention-dropdown]:w-full [&_.mention-dropdown]:max-w-full" role="group" aria-labelledby={`previs-prompt-label-${nodeId}`}>
                <MentionEditor ref={editor} nodeId={nodeId} value={description} onChange={setDescription}
                  onSubmit={generate} canSubmit={canGenerate} submitOnShiftEnter placeholder={`${EXAMPLE}\n按 @ 引用连线素材，Shift+Enter 生成。`}
                  className="[&_.prompt-editor]:min-h-[104px] [&_.prompt-editor]:max-h-48 [&_.prompt-editor]:overflow-y-auto" />
              </div>
            </fieldset>
            <p className="ui-hint">按 @ 或点击素材引用图片、完整分镜表；仅连线不发送。参考图片需选择支持视觉输入的文本模型（最多 6 张）。</p>
            {description.length > 12000 && <p className="ui-error">场景与运镜描述最多 12000 字符</p>}
            <button type="button" className="ui-btn ui-btn--primary" disabled={!canGenerate} onClick={generate}>
              <Icon icon="lucide:sparkles" width={14} />{reference ? '按描述修改预演' : '生成镜头预演'}
            </button>
          </div>
          <fieldset disabled={controlsBusy} className="flex flex-col gap-2">
            <legend className="ui-label mb-2">镜头设置</legend>
            <div className="grid grid-cols-2 gap-2">
              <div className="ui-field"><label htmlFor={`previs-duration-${nodeId}`} className="ui-label">片长（秒）</label>
                <NumberStepper id={`previs-duration-${nodeId}`} aria-label="片长微调" className="w-full" size="sm" unit="s"
                  min={1} max={PREVIS_MAX_DURATION} step={1} precision={2} value={scene.duration} disabled={controlsBusy} onChange={resizeDuration} />
              </div>
              <label className="ui-field"><span className="ui-label">画幅</span>
                <Select value={scene.aspectRatio} onChange={(value) => apply({ ...scene, aspectRatio: value as DirectorPrevisScene['aspectRatio'] })} size="sm">
                  <option value="16:9">16:9</option><option value="9:16">9:16</option><option value="2.39:1">2.39:1</option>
                </Select>
              </label>
              <label className="ui-field"><span className="ui-label">运动速度</span>
                <Select value={scene.easing} onChange={(value) => apply({ ...scene, easing: value as DirectorPrevisScene['easing'] })} size="sm">
                  <option value="linear">匀速</option><option value="smooth">分段缓入缓出</option>
                </Select>
              </label>
              <div className="ui-field"><label htmlFor={`previs-lens-${nodeId}`} className="ui-label">统一焦距（mm）</label>
                <NumberStepper id={`previs-lens-${nodeId}`} aria-label="统一焦距微调" className="w-full" size="sm" unit="mm"
                  min={12} max={200} step={1} precision={1} value={scene.camera.keyframes[0].focalLength} disabled={controlsBusy}
                  onChange={(focalLength) => apply({ ...scene, camera: { keyframes: scene.camera.keyframes.map((frame) => ({ ...frame, focalLength })) } })} />
              </div>
            </div>
          </fieldset>
          <fieldset disabled={controlsBusy} className="flex flex-col gap-2">
            <legend className="ui-label mb-2">摄影机关键帧</legend>
            <Select value={String(selectedFrame)} size="sm" onChange={(value) => { const index = Number(value); setSelectedFrame(index); setTime(scene.camera.keyframes[index].time); setPlaying(false); }} aria-label="选择摄影机关键帧">
              {scene.camera.keyframes.map((frame, i) => <option key={i} value={i}>{i + 1} · {frame.time.toFixed(2)}s · {frame.focalLength}mm</option>)}
            </Select>
            <div className="grid grid-cols-3 gap-2">
              {(['time', 'focalLength', 'roll'] as const).map((key) => (
                <div className="ui-field" key={key}><label htmlFor={`previs-frame-${key}-${nodeId}`} className="ui-label">{key === 'time' ? '时间（s）' : key === 'roll' ? '横滚（°）' : '焦距（mm）'}</label>
                  <NumberStepper id={`previs-frame-${key}-${nodeId}`} aria-label={`${key === 'time' ? '关键帧时间' : key === 'roll' ? '横滚' : '焦距'}微调`}
                    className="w-full" size="sm" unit={key === 'time' ? 's' : key === 'roll' ? '°' : 'mm'}
                    min={key === 'time' ? 0 : key === 'roll' ? -180 : 12} max={key === 'time' ? scene.duration : key === 'roll' ? 180 : 200}
                    step={key === 'time' ? 0.1 : 1} precision={key === 'time' ? 2 : 1} value={currentFrame[key]}
                    disabled={controlsBusy || (key === 'time' && (selectedFrame === 0 || selectedFrame === scene.camera.keyframes.length - 1))}
                    onChange={(value) => updateFrame({ [key]: value })} />
                </div>
              ))}
            </div>
            {(['position', 'target'] as const).map((key) => (
              <div key={key} className="ui-field">
                <span className="ui-label">{key === 'position' ? '摄影机位置（米）' : '注视目标（米）'}</span>
                <div className="grid grid-cols-3 gap-2">
                  {(['X', 'Y', 'Z'] as const).map((axis, index) => (
                    <div className="ui-field" key={axis}><label htmlFor={`previs-${key}-${axis}-${nodeId}`} className="ui-hint">{axis}</label>
                      <NumberStepper id={`previs-${key}-${axis}-${nodeId}`} aria-label={`${key === 'position' ? '摄影机位置' : '注视目标'} ${axis} 微调`}
                        className="w-full" size="sm" unit="m" min={-500} max={500} step={0.1} precision={2} value={currentFrame[key][index]} disabled={controlsBusy}
                        onChange={(value) => {
                          const vector: PrevisVector = [...currentFrame[key]]; vector[index] = value; updateFrame({ [key]: vector });
                        }} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex gap-2">
              <button type="button" className="ui-btn ui-btn--sm flex-1" disabled={scene.camera.keyframes.length >= 64 || scene.camera.keyframes.some((frame) => Math.abs(frame.time - time) < 0.01)}
                onClick={() => {
                  const frames = [...scene.camera.keyframes, samplePrevisCamera(scene, time)].sort((a, b) => a.time - b.time);
                  apply({ ...scene, camera: { keyframes: frames } }); setSelectedFrame(frames.findIndex((frame) => frame.time === time));
                }}>在当前时间插帧</button>
              <button type="button" className="ui-btn ui-btn--sm" disabled={selectedFrame === 0 || selectedFrame === scene.camera.keyframes.length - 1}
                onClick={() => { apply({ ...scene, camera: { keyframes: scene.camera.keyframes.filter((_, i) => i !== selectedFrame) } }); setSelectedFrame(Math.max(0, selectedFrame - 1)); }}>删除</button>
            </div>
          </fieldset>
          <button type="button" className="ui-btn ui-btn--secondary shrink-0" disabled={controlsBusy || !desktop || !dirty}
            onClick={() => { void run('保存镜头调整…', async (signal) => {
              const saved = await saveDirectorPrevisScene(nodeId, scene, signal);
              if (!mounted.current || signal.aborted) return;
              savedHash.current = useAppStore.getState().nodes.find((node) => node.id === nodeId)?.data.directorPrevisScene?.sha256;
              setScene(saved); setDirty(false);
            }); }}>保存镜头调整</button>
          <p className="ui-hint">简模用于判断空间与构图；请在空间视图检查轨迹和遮挡。</p>
        </aside>
      </div>
      {(controlsBusy || error) && <footer className="flex shrink-0 items-center gap-2 border-t border-canvas-border p-2" role={error ? 'alert' : 'status'} aria-live="polite">
        <p className={`${error ? 'ui-error' : 'ui-hint'} min-w-0 flex-1`}>{error || `${busy || '生成镜头预演…'}${progress > 0 ? ` ${Math.round(progress * 100)}%` : ''}`}</p>
        {(generating || (busy && busy !== '载入预演…')) && <button type="button" className="ui-btn ui-btn--sm" onClick={() => { operation.current?.abort(); cancelDirectorPrevisGeneration(nodeId); }}>取消</button>}
      </footer>}
    </ModalOverlay>
  );
}
