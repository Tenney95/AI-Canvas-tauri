/**
 * VideoEditorWindow — 独立「视频编辑器」窗口（由视频节点右键「编辑视频」唤起）
 *
 * 与资源搜索窗口同构：不依赖主窗口 zustand store，直接复用 fileService /
 * IndexedDB（同源共享），自行应用 data-theme 并自绘标题栏。
 *
 * 时间轴支持多片段（多选打开、分割），导出走关键帧对齐的无损直通。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import {
  loadConfig,
  loadProjectData,
  loadProjectsList,
  listExternalFolderFiles,
  listGlobalFiles,
  listProjectFiles,
  registerProjectFolders,
  setBaseDataDir,
  syncAuthorizedDirectories,
  saveBinaryToLocalFile,
  saveBinaryToProjectData,
  buildNodeFileName,
  uploadSourceFileToProject,
  type AssetFileEntry,
} from '../../services/fileService';
import {
  buildVideoEditorProjectId,
  getVideoEditorProject,
  saveVideoEditorProject,
} from '../../services/indexedDbService';
import {
  createVideoInput,
  exportComposite,
  exportLosslessConcat,
  VideoExportCanceledError,
  type ConcatSegment,
} from '../../services/videoEditorMediaService';
import {
  createClipRenderSource,
  renderFrameAt,
  type ClipRenderSource,
} from '../../services/videoCompositor';
import type { Input } from 'mediabunny';
import {
  postVideoEditorAiTransitionRequest,
  postVideoEditorExported,
  postVideoEditorFrameExported,
  postVideoEditorModelsRequest,
  postVideoEditorReady,
  subscribeVideoEditorHost,
  type VideoEditorAiTransitionResult,
  type VideoEditorModelOption,
} from '../../services/videoEditorWindowService';
import {
  computeTimelineDuration,
  DEFAULT_IMAGE_CLIP_DURATION,
  DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM,
  findClipAtTime,
  getVideoTrack,
  hasMixedSources,
  needsCompositing,
  relayoutSequential,
  splitClipsAt,
  type VideoEditorCanvasSize,
  type VideoEditorClip,
  type VideoEditorProjectRecord,
  type VideoEditorProjectImageSource,
  type VideoEditorTextStyle,
  type VideoEditorTrack,
} from '../../types/videoEditor';
import type { AppConfig } from '../../types';
import VideoEditorTimeline from './VideoEditorTimeline';
import VideoEditorPreview from './VideoEditorPreview';
import VideoEditorMediaPanel from './VideoEditorMediaPanel';
import VideoEditorInspector, { type VideoEditorInspectorTab } from './VideoEditorInspector';
import { resolveClipUrl, useVideoEditorSources } from './useVideoEditorSources';
import { useTimelineHistory } from './useTimelineHistory';
import { setLocale, useT } from '../../i18n';
import {
  createTrack,
  duplicateClipInTracks,
  isClipLocked,
  isTrackLocked,
  moveClipTo,
  moveTrack,
  removeClipsFromTracks,
  updateClipInTracks,
} from './timelineOps';

type EditorPhase = 'loading' | 'ready' | 'error';
type ExportDestination = 'canvas' | 'local';

/** 取边界帧时往片段内部让开的时间量：正好落在边界上会取到相邻片段 */
const BOUNDARY_FRAME_EPSILON = 0.02;

function collectProjectImages(nodes: unknown): VideoEditorProjectImageSource[] {
  if (!Array.isArray(nodes)) return [];
  const images: VideoEditorProjectImageSource[] = [];
  for (const candidate of nodes) {
    if (!candidate || typeof candidate !== 'object') continue;
    const node = candidate as Record<string, unknown>;
    const data = node.data;
    if (!data || typeof data !== 'object') continue;
    const nodeData = data as Record<string, unknown>;
    if (nodeData.type !== 'ai-image') continue;
    const sourceUrl = [nodeData.imageUrl, nodeData.thumbnailUrl, nodeData.output]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (!sourceUrl) continue;
    images.push({
      nodeId: typeof node.id === 'string' ? node.id : `image-${images.length + 1}`,
      label: typeof nodeData.label === 'string' && nodeData.label.trim()
        ? nodeData.label.trim()
        : `图片 ${images.length + 1}`,
      sourceUrl,
      filePath: typeof nodeData.filePath === 'string' ? nodeData.filePath : undefined,
      assetId: typeof nodeData.assetId === 'string' ? nodeData.assetId : undefined,
    });
  }
  return images;
}

function appendToEditorOverlayTrack(
  tracks: VideoEditorTrack[],
  clip: VideoEditorClip,
): VideoEditorTrack[] {
  const trackName = clip.kind === 'text' ? '文字' : '贴图';
  const existingIndex = tracks.findIndex((track) => (
    track.kind === 'video'
    && track.overlay
    && (
      track.name === trackName
      || (track.name === '文字与贴图'
        && track.clips.every((existingClip) => existingClip.kind === clip.kind))
    )
  ));
  if (existingIndex >= 0) {
    return tracks.map((track, index) => (
      index === existingIndex ? { ...track, clips: [...track.clips, clip] } : track
    ));
  }
  const overlay = createTrack('video', tracks);
  overlay.name = trackName;
  overlay.clips = [clip];
  return [...tracks, overlay];
}

/** 独立窗口开不了 devtools，错误详情必须能在界面上直接看到并复制 */
interface EditorFailure {
  stage: string;
  message: string;
  detail: string;
}

function describeFailure(stage: string, reason: unknown): EditorFailure {
  if (reason instanceof Error) {
    return {
      stage,
      // WebKit 的 fetch 失败只会给出 "Type error"，必须带上 name 才能分辨
      message: `${reason.name}: ${reason.message}`,
      detail: reason.stack || `${reason.name}: ${reason.message}`,
    };
  }
  return { stage, message: String(reason), detail: String(reason) };
}

/** 给某个阶段的异步操作打上标签，失败时能立刻知道断在哪一步 */
async function withStage<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (reason) {
    if (reason instanceof VideoExportCanceledError) throw reason;
    const failure = describeFailure(stage, reason);
    const error = new Error(`${stage}：${failure.message}`);
    error.stack = failure.detail;
    throw error;
  }
}

/** 把失败详情摊在界面上并支持一键复制——这个窗口开不了 devtools */
function FailureReport({ failure, fallback, copyDetailsLabel, stackLabel, failedSuffix }: {
  failure: EditorFailure | null;
  fallback: string;
  copyDetailsLabel: string;
  stackLabel: string;
  failedSuffix: string;
}) {
  if (!failure) return <span>{fallback}</span>;

  const full = `[${failure.stage}] ${failure.message}\n${failure.detail}`;
  return (
    <div className="video-editor-failure">
      <div className="video-editor-failure-line">
        <strong>{failure.stage}{failedSuffix}</strong>{failure.message}
        <button
          type="button"
          className="video-editor-failure-copy"
          onClick={() => { void navigator.clipboard?.writeText(full).catch(() => {}); }}
        >
          {copyDetailsLabel}
        </button>
      </div>
      {failure.detail && failure.detail !== failure.message && (
        <details className="video-editor-failure-detail">
          <summary>{stackLabel}</summary>
          <pre>{failure.detail}</pre>
        </details>
      )}
    </div>
  );
}

interface SessionParams {
  instanceId: string;
  projectId: string;
  nodeId: string;
  theme: 'dark' | 'light';
}

function readSessionParams(): SessionParams | null {
  const params = new URLSearchParams(window.location.search);
  const instanceId = params.get('instanceId')?.trim();
  const projectId = params.get('projectId')?.trim();
  const nodeId = params.get('nodeId')?.trim();
  if (!instanceId || !projectId || !nodeId) return null;
  return {
    instanceId,
    projectId,
    nodeId,
    theme: params.get('theme') === 'light' ? 'light' : 'dark',
  };
}

export default function VideoEditorWindow() {
  const t = useT();
  const session = useMemo(() => readSessionParams(), []);

  // 会话参数缺失是渲染前就能判定的，直接作为初始状态，不必绕一圈 effect
  const [phase, setPhase] = useState<EditorPhase>(session ? 'loading' : 'error');
  const [failure, setFailure] = useState<EditorFailure | null>(
    session ? null : { stage: '启动', message: t('缺少必要的会话参数，无法打开编辑器'), detail: '' },
  );
  const [record, setRecord] = useState<VideoEditorProjectRecord | null>(null);
  const [projectImages, setProjectImages] = useState<VideoEditorProjectImageSource[]>([]);
  const [libraryAssets, setLibraryAssets] = useState<AssetFileEntry[]>([]);
  const [addingMedia, setAddingMedia] = useState(false);
  const [uploadingSticker, setUploadingSticker] = useState(false);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [playhead, setPlayhead] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStage, setExportStage] = useState<string | null>(null);
  const [exportFrameRate, setExportFrameRate] = useState(30);
  const [exportingFrame, setExportingFrame] = useState(false);
  // 输出分辨率相对源尺寸的倍率；4K 编码不通时可降到 1080p/720p
  const [outputScale, setOutputScale] = useState(1);
  const exportAbortRef = useRef<AbortController | null>(null);
  // AI 转场：模型目录由主窗口下发，生成也在主窗口跑，这里只保留请求状态
  const [aiModels, setAiModels] = useState<VideoEditorModelOption[]>([]);
  const [aiTransitionStatus, setAiTransitionStatus] = useState<string | null>(null);
  const [aiTransitionError, setAiTransitionError] = useState<string | null>(null);
  const [aiTransitionBusy, setAiTransitionBusy] = useState(false);
  const aiTransitionRef = useRef<{ requestId: string; beforeClipId: string } | null>(null);
  // 检查器标签受控：时间轴上点接缝要能直接把右侧切到「转场」
  const [inspectorTab, setInspectorTab] = useState<VideoEditorInspectorTab>('properties');

  const tracks = useMemo(() => record?.tracks ?? [], [record]);
  const videoTrack = getVideoTrack(tracks);
  const clips = useMemo(() => videoTrack?.clips ?? [], [videoTrack]);
  // 素材面板要显示所有视频轨的片段（主轨 + 叠加轨），否则导入多轨会看上去消失
  const allClips = useMemo(
    () => tracks.filter((track) => track.kind === 'video').flatMap((track) => track.clips),
    [tracks],
  );
  const sourceClips = useMemo(() => allClips.filter((clip) => clip.kind !== 'text'), [allClips]);
  const allTimelineClips = useMemo(() => tracks.flatMap((track) => track.clips), [tracks]);

  const persistTracks = useCallback((nextTracks: VideoEditorTrack[]) => {
    setRecord((previous) => {
      if (!previous) return previous;
      const next = { ...previous, tracks: nextTracks, updatedAt: Date.now() };
      void saveVideoEditorProject(next).catch((reason) => {
        console.error('[videoEditor] 工程保存失败:', reason);
      });
      return next;
    });
  }, []);

  const updateTracks = useCallback((
    mutate: (tracks: VideoEditorTrack[]) => VideoEditorTrack[],
  ) => {
    setRecord((previous) => {
      if (!previous) return previous;
      const nextTracks = mutate(previous.tracks);
      if (nextTracks === previous.tracks) return previous;
      const next = { ...previous, tracks: nextTracks, updatedAt: Date.now() };
      void saveVideoEditorProject(next).catch((reason) => {
        console.error('[videoEditor] 工程保存失败:', reason);
      });
      return next;
    });
  }, []);

  // 节点上没带 videoDuration 的片段出点初始为 0，探测到真实时长后回填。
  // 叠加轨必须保持自由时间位置，不能借用主轨的顺排更新函数。
  const handleSourceProbed = useCallback((url: string, probe: { duration: number }) => {
    if (probe.duration <= 0) return;
    setRecord((previous) => {
      if (!previous) return previous;
      let changed = false;
      const nextTracks = previous.tracks.map((track) => {
        if (track.kind !== 'video') return track;
        let trackChanged = false;
        const nextClips = track.clips.map((clip) => {
          if (clip.sourceOut > 0 || resolveClipUrl(clip) !== url) return clip;
          changed = true;
          trackChanged = true;
          return { ...clip, sourceOut: probe.duration };
        });
        if (!trackChanged) return track;
        return {
          ...track,
          clips: track.overlay ? nextClips : relayoutSequential(nextClips),
        };
      });
      if (!changed) return previous;
      const next = { ...previous, tracks: nextTracks, updatedAt: Date.now() };
      void saveVideoEditorProject(next).catch((reason) => {
        console.error('[videoEditor] 工程保存失败:', reason);
      });
      return next;
    });
  }, []);

  const { getSource } = useVideoEditorSources(sourceClips, handleSourceProbed);

  const timelineDuration = computeTimelineDuration(tracks);
  const activeClip = findClipAtTime(clips, playhead)?.clip ?? clips[0] ?? null;
  const activeClipUrl = activeClip ? resolveClipUrl(activeClip) : '';
  const activeSourceProbe = activeClip ? (getSource(activeClip)?.probe ?? null) : null;
  const selectedClip = allTimelineClips.find((clip) => clip.id === selectedClipIds[0]) ?? null;
  const inspectorClip = selectedClip ?? activeClip;
  const inspectorLocked = inspectorClip ? isClipLocked(tracks, inspectorClip.id) : false;
  const activeProbe = inspectorClip ? (getSource(inspectorClip)?.probe ?? null) : null;
  // AI 转场插在选中片段与它前一段之间：主轨首段和叠加层都没有「前一段」
  const inspectorMainIndex = inspectorClip
    ? clips.findIndex((clip) => clip.id === inspectorClip.id)
    : -1;
  const canGenerateAiTransition = inspectorMainIndex > 0 && !videoTrack?.locked;

  // 合成画布尺寸取主轨首个可解码片段的分辨率，退回 1080p。
  // 计算极轻，直接派生即可，不值得为它维护一份 memo 依赖
  const firstSized = clips
    .map((clip) => getSource(clip)?.probe)
    .find((probe) => probe && probe.width > 0 && probe.height > 0);
  const canvasWidth = firstSized?.width || 1920;
  const canvasHeight = firstSized?.height || 1080;
  const canvasSize: VideoEditorCanvasSize = useMemo(
    () => (outputScale === 1
      ? { width: canvasWidth, height: canvasHeight }
      // 编码器对尺寸有偶数要求，缩放后向下取偶
      : {
        width: Math.max(2, Math.round((canvasWidth * outputScale) / 2) * 2),
        height: Math.max(2, Math.round((canvasHeight * outputScale) / 2) * 2),
      }),
    [canvasHeight, canvasWidth, outputScale],
  );

  // 素材编码/分辨率不一致时无法直通拼接，必须走合成归一到同一张画布
  const mixedSources = hasMixedSources(clips.map((clip) => {
    const probe = getSource(clip)?.probe;
    return probe && { codec: probe.videoCodec, width: probe.width, height: probe.height };
  }));
  const compositing = needsCompositing(tracks) || mixedSources;

  // ── 载入：配置 → 工程 ──
  useEffect(() => {
    if (!session) return;

    let active = true;
    void (async () => {
      try {
        const config = (await loadConfig()) as AppConfig | null;
        document.documentElement.setAttribute(
          'data-theme',
          config?.theme === 'light' ? 'light' : session.theme,
        );
        document.documentElement.toggleAttribute('data-native-cursor', config?.customCursor === false);
        setLocale(config?.language);
        setBaseDataDir(config?.baseDataDir);
        await syncAuthorizedDirectories(config ?? {});
        // 独立窗口有自己的模块实例：不注册项目文件夹名，
        // resolveProjectFolder 会退化成用 projectId 当目录名，导出就会落错目录
        const projects = await loadProjectsList();
        registerProjectFolders(projects as { id: string; dataFolder?: string }[]);
        if (!active) return;

        const [projectData, projectFiles, globalFiles, folderFiles] = await Promise.all([
          loadProjectData(session.projectId),
          listProjectFiles(session.projectId),
          listGlobalFiles(),
          listExternalFolderFiles(config?.assetFolders ?? []),
        ]);
        if (!active) return;
        setProjectImages(collectProjectImages(projectData?.nodes));
        const seenAssetPaths = new Set<string>();
        setLibraryAssets([...projectFiles, ...globalFiles, ...folderFiles].filter((asset) => {
          if (asset.category !== 'image' && asset.category !== 'video') return false;
          if (!asset.path || seenAssetPaths.has(asset.path)) return false;
          seenAssetPaths.add(asset.path);
          return true;
        }));

        // 工程由主窗口在开窗前写入共享库，这里只按 ID 取回
        const projectRecordId = buildVideoEditorProjectId(session.projectId, session.nodeId);
        const loaded = await getVideoEditorProject(projectRecordId);
        if (!loaded) throw new Error('未找到该节点的剪辑工程');
        if (!active) return;

        setRecord(loaded);
        setPhase('ready');
        void postVideoEditorReady(session.instanceId).catch(() => {});
      } catch (reason) {
        if (!active) return;
        setFailure(describeFailure('载入', reason));
        setPhase('error');
        console.error('[videoEditor] 载入失败:', reason);
      }
    })();

    return () => { active = false; };
  }, [session]);

  // ── 撤销重做：改动前落一个轨道快照 ──
  const history = useTimelineHistory();
  const historyBegin = history.begin;
  const historyEnd = history.end;
  const historyCommit = history.commit;
  const tracksRef = useRef(tracks);
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);

  const beginInteraction = useCallback(() => {
    historyBegin(tracksRef.current);
  }, [historyBegin]);

  const endInteraction = useCallback(() => {
    historyEnd();
  }, [historyEnd]);

  const commitChange = useCallback(() => {
    historyCommit(tracksRef.current);
  }, [historyCommit]);

  const handleUndo = useCallback(() => {
    const restored = history.undo(tracksRef.current);
    if (restored) persistTracks(restored);
  }, [history, persistTracks]);

  const handleRedo = useCallback(() => {
    const restored = history.redo(tracksRef.current);
    if (restored) persistTracks(restored);
  }, [history, persistTracks]);

  const handleTrimClip = useCallback((clipId: string, sourceIn: number, sourceOut: number) => {
    if (isClipLocked(tracksRef.current, clipId)) return;
    updateTracks((current) => updateClipInTracks(current, clipId, (clip) => ({
      ...clip,
      sourceIn,
      sourceOut,
    })));
  }, [updateTracks]);

  const handleSplit = useCallback(() => {
    if (!videoTrack) return;
    if (videoTrack.locked) {
      setNotice(t('轨道已锁定，无法分割片段'));
      return;
    }
    const split = splitClipsAt(videoTrack.clips, playhead);
    if (!split) {
      setNotice(t('当前播放头不在可分割的位置'));
      return;
    }
    setNotice(null);
    commitChange();
    updateTracks((current) => current.map((track) => (
      track.id === videoTrack.id ? { ...track, clips: split } : track
    )));
  }, [commitChange, playhead, t, updateTracks, videoTrack]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedClipIds.length === 0) return;
    const deletableIds = selectedClipIds.filter((clipId) => !isClipLocked(tracksRef.current, clipId));
    if (deletableIds.length === 0) {
      setNotice(t('选中片段所在轨道已锁定'));
      return;
    }
    const deletable = new Set(deletableIds);
    const remainingVideoCount = allClips
      .filter((clip) => clip.kind !== 'text' && !deletable.has(clip.id)).length;
    if (remainingVideoCount === 0) {
      setNotice(t('至少要保留一个片段'));
      return;
    }
    setNotice(null);
    commitChange();
    updateTracks((current) => removeClipsFromTracks(current, deletableIds));
    setSelectedClipIds((current) => current.filter((clipId) => !deletable.has(clipId)));
  }, [allClips, commitChange, selectedClipIds, t, updateTracks]);

  const handleDuplicateClip = useCallback((clipId: string) => {
    if (isClipLocked(tracksRef.current, clipId)) {
      setNotice(t('轨道已锁定，无法复制片段'));
      return;
    }
    setNotice(null);
    commitChange();
    updateTracks((current) => duplicateClipInTracks(current, clipId));
  }, [commitChange, t, updateTracks]);

  /** 改选中片段的某个属性；这些改动都会让导出切到合成路径 */
  const patchSelectedClip = useCallback((patch: (clip: VideoEditorClip) => VideoEditorClip) => {
    const targetId = selectedClipIds[0] ?? activeClip?.id;
    if (!targetId) return;
    if (isClipLocked(tracksRef.current, targetId)) return;
    updateTracks((current) => updateClipInTracks(current, targetId, patch));
  }, [activeClip?.id, selectedClipIds, updateTracks]);

  /** 按 ID 修改片段属性，用于画面上直接拖拽叠加层 */
  const patchClipById = useCallback((clipId: string, patch: (clip: VideoEditorClip) => VideoEditorClip) => {
    if (isClipLocked(tracksRef.current, clipId)) return;
    updateTracks((current) => updateClipInTracks(current, clipId, patch));
  }, [updateTracks]);

  const createOverlayTiming = useCallback(() => {
    const total = Math.max(0.1, timelineDuration);
    const start = Math.min(Math.max(0, playhead), Math.max(0, total - 0.1));
    return {
      timelineStart: start,
      sourceIn: 0,
      sourceOut: Math.max(0.1, Math.min(DEFAULT_IMAGE_CLIP_DURATION, total - start)),
    };
  }, [playhead, timelineDuration]);

  const handleAddText = useCallback(() => {
    const id = `text-${Date.now().toString(36)}`;
    const clip: VideoEditorClip = {
      id,
      kind: 'text',
      fileName: DEFAULT_TEXT_STYLE.content,
      ...createOverlayTiming(),
      transform: { ...DEFAULT_TRANSFORM },
      textStyle: { ...DEFAULT_TEXT_STYLE },
    };
    commitChange();
    updateTracks((current) => appendToEditorOverlayTrack(current, clip));
    setSelectedClipIds([id]);
  }, [commitChange, createOverlayTiming, updateTracks]);

  const handleAddSticker = useCallback((source: VideoEditorProjectImageSource) => {
    const id = `sticker-${Date.now().toString(36)}`;
    const clip: VideoEditorClip = {
      id,
      kind: 'image',
      fileName: source.label,
      nodeId: source.nodeId,
      sourceUrl: source.sourceUrl,
      filePath: source.filePath,
      assetId: source.assetId,
      ...createOverlayTiming(),
      transform: { ...DEFAULT_TRANSFORM, scale: 0.32 },
    };
    commitChange();
    updateTracks((current) => appendToEditorOverlayTrack(current, clip));
    setSelectedClipIds([id]);
  }, [commitChange, createOverlayTiming, updateTracks]);

  const handleUploadSticker = useCallback(async () => {
    if (!record || uploadingSticker) return;
    setUploadingSticker(true);
    setNotice(null);
    try {
      const uploaded = await uploadSourceFileToProject('.png,.jpg,.jpeg,.webp,.gif', record.projectId);
      if (!uploaded) return;
      const source: VideoEditorProjectImageSource = {
        nodeId: `local-${Date.now().toString(36)}`,
        label: uploaded.fileName,
        sourceUrl: uploaded.dataUrl,
        filePath: uploaded.filePath,
      };
      setProjectImages((current) => [source, ...current]);
      handleAddSticker(source);
    } catch (reason) {
      setNotice(reason instanceof Error ? t('贴图导入失败：{message}', { message: reason.message }) : t('贴图导入失败'));
    } finally {
      setUploadingSticker(false);
    }
  }, [handleAddSticker, record, t, uploadingSticker]);

  const handleAddVideoSource = useCallback((source: {
    fileName: string;
    filePath?: string;
    sourceUrl?: string;
    assetId?: string;
  }) => {
    const id = `media-${Date.now().toString(36)}`;
    const clip: VideoEditorClip = {
      id,
      kind: 'video',
      fileName: source.fileName,
      filePath: source.filePath,
      sourceUrl: source.sourceUrl,
      assetId: source.assetId,
      timelineStart: 0,
      sourceIn: 0,
      sourceOut: 0,
    };
    commitChange();
    updateTracks((current) => {
      const mainTrack = getVideoTrack(current);
      if (!mainTrack) return current;
      return current.map((track) => (
        track.id === mainTrack.id
          ? { ...track, clips: relayoutSequential([...track.clips, clip]) }
          : track
      ));
    });
    setSelectedClipIds([id]);
  }, [commitChange, updateTracks]);

  const handleAddLibraryAsset = useCallback((asset: AssetFileEntry) => {
    setNotice(null);
    if (asset.category === 'image') {
      handleAddSticker({
        nodeId: `asset-${asset.assetId ?? Date.now().toString(36)}`,
        label: asset.name,
        sourceUrl: asset.assetUrl ?? '',
        filePath: asset.path,
        assetId: asset.assetId,
      });
      return;
    }
    handleAddVideoSource({
      fileName: asset.name,
      filePath: asset.path,
      sourceUrl: asset.assetUrl,
      assetId: asset.assetId,
    });
  }, [handleAddSticker, handleAddVideoSource]);

  const handleAddLocalMedia = useCallback(async () => {
    if (!record || addingMedia) return;
    setAddingMedia(true);
    setNotice(null);
    try {
      const uploaded = await uploadSourceFileToProject(
        '.mp4,.mov,.m4v,.webm,.avi,.mkv,.png,.jpg,.jpeg,.webp,.gif',
        record.projectId,
      );
      if (!uploaded) return;
      const isImage = /\.(?:png|jpe?g|webp|gif)$/i.test(uploaded.fileName);
      if (isImage) {
        handleAddSticker({
          nodeId: `local-${Date.now().toString(36)}`,
          label: uploaded.fileName,
          sourceUrl: uploaded.dataUrl,
          filePath: uploaded.filePath,
        });
      } else {
        handleAddVideoSource({
          fileName: uploaded.fileName,
          filePath: uploaded.filePath,
          sourceUrl: uploaded.dataUrl,
        });
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? t('素材导入失败：{message}', { message: reason.message }) : t('素材导入失败'));
    } finally {
      setAddingMedia(false);
    }
  }, [addingMedia, handleAddSticker, handleAddVideoSource, record, t]);

  const handlePatchText = useCallback((patch: Partial<VideoEditorTextStyle>) => {
    patchSelectedClip((clip) => {
      if (clip.kind !== 'text') return clip;
      const nextStyle = { ...DEFAULT_TEXT_STYLE, ...clip.textStyle, ...patch };
      return { ...clip, fileName: nextStyle.content.trim() || '文字', textStyle: nextStyle };
    });
  }, [patchSelectedClip]);

  const handleAddTrack = useCallback((kind: 'video' | 'audio') => {
    commitChange();
    persistTracks([...tracksRef.current, createTrack(kind, tracksRef.current)]);
  }, [commitChange, persistTracks]);

  const handleMoveTrack = useCallback((trackId: string, direction: -1 | 1) => {
    if (isTrackLocked(tracksRef.current, trackId)) {
      setNotice(t('请先解锁轨道再调整层级'));
      return;
    }
    setNotice(null);
    commitChange();
    persistTracks(moveTrack(tracksRef.current, trackId, direction));
  }, [commitChange, persistTracks, t]);

  const handleMoveClip = useCallback((clipId: string, targetIndex: number) => {
    if (!videoTrack) return;
    if (videoTrack.locked || isClipLocked(tracksRef.current, clipId)) return;
    updateTracks((current) => current.map((track) => (
      track.id === videoTrack.id
        ? { ...track, clips: moveClipTo(track.clips, clipId, targetIndex) }
        : track
    )));
  }, [updateTracks, videoTrack]);

  /** 跨轨道移动片段 */
  const handleMoveClipToTrack = useCallback((
    clipId: string,
    sourceTrackId: string,
    targetTrackId: string,
    position: number,
  ) => {
    setRecord((previous) => {
      if (!previous) return previous;
      const sourceTrack = previous.tracks.find((t) => t.id === sourceTrackId);
      const targetTrack = previous.tracks.find((t) => t.id === targetTrackId);
      if (!sourceTrack || !targetTrack) return previous;
      if (sourceTrack.locked || targetTrack.locked) return previous;

      const clipIndex = sourceTrack.clips.findIndex((c) => c.id === clipId);
      if (clipIndex < 0) return previous;
      const clip = sourceTrack.clips[clipIndex];

      const nextTracks = previous.tracks.map((track) => {
        if (track.id === sourceTrackId) {
          // 从源轨道移除，主轨做磁吸压实
          const nextClips = track.clips.filter((c) => c.id !== clipId);
          return {
            ...track,
            clips: track.overlay ? nextClips : relayoutSequential(nextClips),
          };
        }
        if (track.id === targetTrackId) {
          if (track.overlay) {
            // 叠加轨：自由放置，position 是时间轴时间
            return {
              ...track,
              clips: [...track.clips, { ...clip, timelineStart: Math.max(0, position) }],
            };
          }
          // 主轨：position 是插入序号，做磁吸重排
          const nextClips = [...track.clips];
          nextClips.splice(Math.min(position, nextClips.length), 0, clip);
          return { ...track, clips: relayoutSequential(nextClips) };
        }
        return track;
      });

      const next = { ...previous, tracks: nextTracks, updatedAt: Date.now() };
      void saveVideoEditorProject(next).catch((reason) => {
        console.error('[videoEditor] 工程保存失败:', reason);
      });
      return next;
    });
  }, []);

  /** 叠加轨内移动：更新时间轴位置 */
  const handleMoveClipInOverlay = useCallback((
    clipId: string,
    trackId: string,
    timelineStart: number,
  ) => {
    setRecord((previous) => {
      if (!previous) return previous;
      if (isTrackLocked(previous.tracks, trackId)) return previous;
      const nextTracks = previous.tracks.map((track) => {
        if (track.id !== trackId) return track;
        return {
          ...track,
          clips: track.clips.map((clip) => (
            clip.id === clipId ? { ...clip, timelineStart: Math.max(0, timelineStart) } : clip
          )),
        };
      });
      const next = { ...previous, tracks: nextTracks, updatedAt: Date.now() };
      void saveVideoEditorProject(next).catch((reason) => {
        console.error('[videoEditor] 工程保存失败:', reason);
      });
      return next;
    });
  }, []);

  /** 拖到空白区域时创建新叠加轨并把片段移过去 */
  const handleCreateTrackAndMove = useCallback((
    clipId: string,
    sourceTrackId: string,
    timelineStart: number,
  ) => {
    setRecord((previous) => {
      if (!previous) return previous;
      const sourceTrack = previous.tracks.find((t) => t.id === sourceTrackId);
      if (!sourceTrack) return previous;
      if (sourceTrack.locked) return previous;

      const clipIndex = sourceTrack.clips.findIndex((c) => c.id === clipId);
      if (clipIndex < 0) return previous;
      const clip = sourceTrack.clips[clipIndex];

      // 创建新的叠加轨
      const newTrack = createTrack('video', previous.tracks);

      const nextTracks = previous.tracks.map((track) => {
        if (track.id === sourceTrackId) {
          const nextClips = track.clips.filter((c) => c.id !== clipId);
          return {
            ...track,
            clips: track.overlay ? nextClips : relayoutSequential(nextClips),
          };
        }
        return track;
      });

      // 把片段放入新轨道
      newTrack.clips = [{ ...clip, timelineStart: Math.max(0, timelineStart) }];

      const next = {
        ...previous,
        tracks: [...nextTracks, newTrack],
        updatedAt: Date.now(),
      };
      void saveVideoEditorProject(next).catch((reason) => {
        console.error('[videoEditor] 工程保存失败:', reason);
      });
      return next;
    });
  }, []);

  const canSplit = !!videoTrack && !videoTrack.locked && !!findClipAtTime(clips, playhead);

  // 快捷键：空格播放、S 分割、Del 删除、Ctrl+D 复制、Ctrl+Z/Y 撤销重做、←→ 逐帧
  useEffect(() => {
    if (phase !== 'ready') return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) return;
      const modifier = event.metaKey || event.ctrlKey;

      if (modifier && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) handleRedo(); else handleUndo();
        return;
      }
      if (modifier && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault();
        handleRedo();
        return;
      }
      if (modifier && (event.key === 'd' || event.key === 'D')) {
        event.preventDefault();
        if (selectedClipIds[0]) handleDuplicateClip(selectedClipIds[0]);
        return;
      }
      if (modifier && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault();
        setSelectedClipIds(tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
        return;
      }
      if (modifier) return;

      if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        handleSplit();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        handleDeleteSelected();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPlayhead((current) => Math.max(0, current - (event.shiftKey ? 1 : 1 / 30)));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setPlayhead((current) => Math.min(timelineDuration, current + (event.shiftKey ? 1 : 1 / 30)));
      } else if (event.key === 'Home') {
        event.preventDefault();
        setPlayhead(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setPlayhead(timelineDuration);
      } else if (event.key === 'Escape') {
        setSelectedClipIds([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    handleDeleteSelected, handleDuplicateClip, handleRedo, handleSplit,
    handleUndo, phase, selectedClipIds, timelineDuration,
    tracks,
  ]);

  const handleExport = useCallback(async (destination: ExportDestination) => {
    if (!session || !record) return;
    const allClips = tracks.flatMap((track) => (track.hidden ? [] : track.clips));
    if (allClips.length === 0) return;

    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExporting(true);
    setExportProgress(0);
    setFailure(null);
    setNotice(null);
    setExportStage(null);

    const opened: Input[] = [];
    try {
      // 打开每个片段的素材；同一素材只开一次
      const inputsByUrl = new Map<string, Input>();
      await withStage('打开素材', async () => {
        for (const clip of allClips) {
          if (clip.kind === 'text' || clip.kind === 'image') continue;
          const url = resolveClipUrl(clip);
          if (!url || inputsByUrl.has(url)) continue;
          const input = await createVideoInput(url);
          inputsByUrl.set(url, input);
          opened.push(input);
        }
      });
      const inputFor = (clip: VideoEditorClip) => inputsByUrl.get(resolveClipUrl(clip));

      let bytes: Uint8Array;
      const notes: string[] = [];

      let audioNote: string | null = null;

      /** 逐帧渲染 + 重编码；直通做不到时也走这里 */
      const runComposite = async () => {
        // 合成路径：逐帧渲染 + 重编码，支持叠加、画中画、转场与混音
        const renderSources = new Map<string, ClipRenderSource>();
        await withStage('准备合成', async () => {
          for (const [url, input] of inputsByUrl) {
            const source = await createClipRenderSource(input);
            if (source) renderSources.set(url, source);
          }
          // 图片片段用位图直接绘制
          for (const clip of allClips) {
            if (clip.kind !== 'image') continue;
            const url = resolveClipUrl(clip);
            if (!url || renderSources.has(url)) continue;
            const response = await fetch(url);
            const bitmap = await createImageBitmap(await response.blob());
            renderSources.set(url, {
              bitmap,
              width: bitmap.width,
              height: bitmap.height,
            });
          }
        });

        return withStage('合成导出', () => exportComposite({
          tracks,
          duration: timelineDuration,
          canvas: canvasSize,
          frameRate: exportFrameRate,
          resolveVideo: (clip) => renderSources.get(resolveClipUrl(clip)),
          resolveAudio: inputFor,
          onProgress: setExportProgress,
          onStage: setExportStage,
          onAudioMode: (mode, reason) => {
            audioNote = mode === 'encode'
              ? t('音频已重新混流（AAC）')
              : mode === 'copy'
                ? t('音频以原始分组直通保留，未重编码')
                : mode === 'pcm'
                  ? t('音频已混流为未压缩 PCM 音轨：{reason}', { reason: reason ?? '' })
                  : t('未输出音轨：{reason}', { reason: reason ?? t('无可用音频') });
          },
          signal: controller.signal,
        }));
      };

      if (compositing) {
        bytes = await runComposite();
        notes.push(t('已合成导出 {count} 个片段 · {width}×{height} · {fps}fps', {
          count: allClips.length, width: canvasSize.width, height: canvasSize.height, fps: exportFrameRate,
        }));
        if (mixedSources) notes.push(t('素材分辨率或编码不一致，已归一到同一画布'));
        notes.push(t('画面经过一次重编码'));
        if (audioNote) notes.push(audioNote);
      } else {
        // 简单时间轴走无损直通，避免无谓的画质损失
        const segments: ConcatSegment[] = clips.map((clip) => ({
          input: inputFor(clip)!,
          start: clip.sourceIn,
          end: clip.sourceOut,
          label: clip.fileName,
        }));
        try {
          const result = await withStage('无损裁剪导出', () => exportLosslessConcat({
            segments,
            onProgress: setExportProgress,
            signal: controller.signal,
          }));
          bytes = result.bytes;

          const drift = clips[0].sourceIn - result.actualStart;
          notes.push(t('已无损导出 {count} 个片段，共 {time}s', {
            count: clips.length, time: timelineDuration.toFixed(2),
          }));
          if (drift > 0.05) {
            notes.push(t('首段按关键帧对齐，实际入点 {actual}s（比设定早 {drift}s）', {
              actual: result.actualStart.toFixed(2), drift: drift.toFixed(2),
            }));
          }
          notes.push(result.audioKept
            ? t('音轨已按原始分组直通保留')
            : t('未输出音轨：{reason}', { reason: result.audioDropReason ?? t('未知原因') }));
        } catch (reason) {
          if (reason instanceof VideoExportCanceledError) throw reason;
          // 直通做不到（例如素材参数不一致）不该把死路甩给用户，自动改走合成
          console.warn('[videoEditor] 无损直通不可用，改走合成:', reason);
          setExportProgress(0);
          bytes = await runComposite();
          notes.push(t('无损直通不可用，已改用合成导出 · {width}×{height} · {fps}fps', {
            width: canvasSize.width, height: canvasSize.height, fps: exportFrameRate,
          }));
          if (audioNote) notes.push(audioNote);
          notes.push(reason instanceof Error ? reason.message : String(reason));
        }
      }

      const fileName = buildNodeFileName(record.name, 'mp4', 'edited');
      if (destination === 'local') {
        const savedPath = await withStage('保存到本地', () => saveBinaryToLocalFile(bytes, fileName));
        if (!savedPath) {
          setNotice(t('已取消保存到本地'));
          return;
        }
        notes.push(t('已保存到本地：{fileName}', { fileName }));
      } else {
        const saved = await withStage('写入项目目录', async () => {
          const result = await saveBinaryToProjectData(bytes, record.projectId, fileName);
          if (!result) throw new Error('项目数据目录不可写');
          return result;
        });

        await withStage('输出到画布', () => postVideoEditorExported(session.instanceId, {
          videoUrl: saved.assetUrl,
          filePath: saved.filePath,
          fileName,
          duration: timelineDuration,
          // 合成路径按画布尺寸出片，直通路径保持源尺寸
          width: compositing ? canvasSize.width : (firstSized?.width ?? 0),
          height: compositing ? canvasSize.height : (firstSized?.height ?? 0),
        }));
        notes.push(t('已创建画布视频节点'));
      }

      setNotice(notes.join('；'));
    } catch (reason) {
      if (!(reason instanceof VideoExportCanceledError)) {
        setFailure(describeFailure('导出', reason));
        console.error('[videoEditor] 导出失败:', reason);
      }
    } finally {
      opened.forEach((input) => input.dispose());
      exportAbortRef.current = null;
      setExporting(false);
      setExportProgress(0);
      setExportStage(null);
    }
  }, [
    canvasSize, clips, compositing, exportFrameRate, firstSized?.height, firstSized?.width,
    mixedSources, record, session, t, timelineDuration, tracks,
  ]);

  /**
   * 把时间轴某一时刻按合成路径渲染成 PNG 字节。
   * 「导出当前帧」和 AI 转场取首/尾帧共用同一条渲染路径，保证所见即所得。
   */
  const renderTimelineFramePng = useCallback(async (
    time: number,
    stageLabel: string,
    /** 覆盖用的轨道快照；取转场首尾帧时用它屏蔽掉已有转场的淡入淡出 */
    tracksOverride?: VideoEditorTrack[],
  ): Promise<Uint8Array> => {
    const frameTracks = tracksOverride ?? tracksRef.current;
    const frameClips = frameTracks.flatMap((track) => (track.hidden ? [] : track.clips));
    if (frameClips.length === 0) throw new Error('时间轴上没有可渲染的片段');

    const opened: Input[] = [];
    try {
      // 只准备这一帧用得到的素材：解码整条时间轴没有意义
      const renderSources = new Map<string, ClipRenderSource>();
      await withStage(`准备${stageLabel}`, async () => {
        for (const clip of frameClips) {
          if (clip.kind === 'text') continue;
          const url = resolveClipUrl(clip);
          if (!url || renderSources.has(url)) continue;
          if (clip.kind === 'image') {
            const response = await fetch(url);
            const bitmap = await createImageBitmap(await response.blob());
            renderSources.set(url, { bitmap, width: bitmap.width, height: bitmap.height });
            continue;
          }
          const input = await createVideoInput(url);
          opened.push(input);
          const source = await createClipRenderSource(input);
          if (source) renderSources.set(url, source);
        }
      });

      const canvas = document.createElement('canvas');
      canvas.width = canvasSize.width;
      canvas.height = canvasSize.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('画布上下文不可用');

      await withStage(`渲染${stageLabel}`, () => renderFrameAt(
        context,
        canvasSize,
        frameTracks,
        time,
        (clip) => renderSources.get(resolveClipUrl(clip)),
      ));

      return await withStage(`编码${stageLabel}`, async () => {
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob((result) => resolve(result), 'image/png');
        });
        if (!blob) throw new Error(`${stageLabel}编码失败`);
        return new Uint8Array(await blob.arrayBuffer());
      });
    } finally {
      opened.forEach((input) => input.dispose());
    }
  }, [canvasSize]);

  /** 把播放头所在的一帧按合成路径渲染出来，回传主窗口建图片节点 */
  const handleExportFrame = useCallback(async () => {
    if (!session || !record || exporting || exportingFrame) return;
    if (allTimelineClips.length === 0) return;

    setExportingFrame(true);
    setFailure(null);
    setNotice(null);

    try {
      const bytes = await renderTimelineFramePng(playhead, '当前帧');

      // 同一工程会反复导帧，文件名带上时刻才不至于全靠去重后缀区分
      const stamp = `${Math.round(playhead * 1000)}ms`;
      const fileName = buildNodeFileName(`${record.name} 帧${stamp}`, 'png', `frame-${stamp}`);
      const saved = await withStage('写入项目目录', async () => {
        const result = await saveBinaryToProjectData(bytes, record.projectId, fileName);
        if (!result) throw new Error('项目数据目录不可写');
        return result;
      });

      await withStage('输出到画布', () => postVideoEditorFrameExported(session.instanceId, {
        imageUrl: saved.assetUrl,
        filePath: saved.filePath,
        fileName,
        time: playhead,
        width: canvasSize.width,
        height: canvasSize.height,
      }));
      setNotice(t('已导出 {time}s 的画面为图片节点 · {width}×{height}', {
        time: playhead.toFixed(2), width: canvasSize.width, height: canvasSize.height,
      }));
    } catch (reason) {
      setFailure(describeFailure('导出当前帧', reason));
      console.error('[videoEditor] 导出当前帧失败:', reason);
    } finally {
      setExportingFrame(false);
    }
  }, [
    allTimelineClips.length, canvasSize, exporting, exportingFrame, playhead,
    record, renderTimelineFramePng, session, t,
  ]);

  /** 主窗口回传的 AI 转场落到主轨上：插在触发它的片段之前 */
  const insertAiTransitionClip = useCallback((beforeClipId: string, media: {
    videoUrl: string;
    filePath?: string;
    fileName: string;
  }): boolean => {
    const mainTrack = getVideoTrack(tracksRef.current);
    if (!mainTrack || mainTrack.locked) return false;
    if (!mainTrack.clips.some((clip) => clip.id === beforeClipId)) return false;

    const clip: VideoEditorClip = {
      id: `ai-transition-${Date.now().toString(36)}`,
      kind: 'video',
      fileName: media.fileName,
      filePath: media.filePath,
      sourceUrl: media.videoUrl,
      timelineStart: 0,
      sourceIn: 0,
      // 请求时长只是给模型的期望值，成片长度未必一致（有的模型直接忽略它）。
      // 留 0 交给 handleSourceProbed 用探测到的真实时长回填，避免片段被错误裁切。
      sourceOut: 0,
    };

    commitChange();
    updateTracks((current) => current.map((track) => {
      if (track.id !== mainTrack.id) return track;
      const index = track.clips.findIndex((candidate) => candidate.id === beforeClipId);
      if (index < 0) return track;
      const nextClips = [...track.clips];
      nextClips.splice(index, 0, clip);
      return { ...track, clips: relayoutSequential(nextClips) };
    }));
    setSelectedClipIds([clip.id]);
    return true;
  }, [commitChange, updateTracks]);

  // 主窗口下发的模型目录与转场结果
  useEffect(() => {
    if (!session) return;

    const unsubscribe = subscribeVideoEditorHost(session.instanceId, (message) => {
      if (message.type === 'storyai:video-editor-models') {
        const models = message.payload?.models;
        setAiModels(Array.isArray(models) ? (models as VideoEditorModelOption[]) : []);
        return;
      }
      if (message.type !== 'storyai:video-editor-ai-transition-result') return;

      const payload = (message.payload ?? {}) as Partial<VideoEditorAiTransitionResult>;
      const pending = aiTransitionRef.current;
      if (!pending || payload.requestId !== pending.requestId) return;
      aiTransitionRef.current = null;
      setAiTransitionBusy(false);
      setAiTransitionStatus(null);

      if (payload.error || !payload.videoUrl) {
        setAiTransitionError(payload.error || t('AI 转场生成失败'));
        return;
      }
      const inserted = insertAiTransitionClip(pending.beforeClipId, {
        videoUrl: payload.videoUrl,
        filePath: typeof payload.filePath === 'string' ? payload.filePath : undefined,
        fileName: payload.fileName || 'AI 转场',
      });
      setAiTransitionError(inserted ? null : t('转场已生成，但原片段已不在主轨上，未能插入'));
      if (inserted) setNotice(t('AI 转场已插入主轨'));
    });

    void postVideoEditorModelsRequest(session.instanceId).catch((reason) => {
      console.error('[videoEditor] 请求视频模型列表失败:', reason);
    });
    return unsubscribe;
  }, [insertAiTransitionClip, session, t]);

  /**
   * 时间轴接缝上的按钮：没有转场先补一个默认交叠淡入，已有的直接跳去编辑。
   * 两种情况都选中该片段并切到「转场」标签，点完就能接着调。
   */
  const handleEditTransition = useCallback((clipId: string) => {
    const clip = tracksRef.current.flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clipId);
    if (!clip) return;
    const existing = clip.transitionIn;
    if (!existing || existing.kind === 'none' || existing.duration <= 0) {
      commitChange();
      updateTracks((current) => updateClipInTracks(current, clipId, (target) => ({
        ...target,
        transitionIn: { kind: 'dissolve', duration: 0.5 },
      })));
    }
    setSelectedClipIds([clipId]);
    setInspectorTab('transition');
  }, [commitChange, updateTracks]);

  const handleRefreshAiModels = useCallback(() => {
    if (!session) return;
    void postVideoEditorModelsRequest(session.instanceId).catch((reason) => {
      setAiTransitionError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [session]);

  /**
   * 按「前一段尾帧 → 本段首帧 + 提示词」生成一段过渡视频。
   *
   * 帧在本窗口渲染并落盘，模型调用交给主窗口；结果回来后插到两段之间。
   */
  const handleGenerateAiTransition = useCallback(async (options: {
    prompt: string;
    model: string;
    provider: string;
    duration: number;
  }) => {
    if (!session || !record || aiTransitionBusy) return;

    const mainTrack = getVideoTrack(tracksRef.current);
    const targetId = selectedClipIds[0] ?? activeClip?.id;
    const index = mainTrack ? mainTrack.clips.findIndex((clip) => clip.id === targetId) : -1;
    if (!mainTrack || index < 0) {
      setAiTransitionError(t('请先在主轨上选中一个片段'));
      return;
    }
    if (index === 0) {
      setAiTransitionError(t('首个片段之前没有画面可衔接，请选中第二段及之后的片段'));
      return;
    }
    if (mainTrack.locked) {
      setAiTransitionError(t('主轨已锁定，无法插入转场'));
      return;
    }

    const target = mainTrack.clips[index];
    setAiTransitionBusy(true);
    setAiTransitionError(null);
    setFailure(null);
    setAiTransitionStatus(t('正在取首尾帧…'));

    try {
      // 已有的预设转场会让边界附近的画面处在淡入中，取到的参考帧就是半透明的。
      // 采样时先摘掉转场，拿到两段各自的干净画面。
      const cleanTracks = tracksRef.current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => (
          clip.transitionIn ? { ...clip, transitionIn: undefined } : clip
        )),
      }));

      // 主轨磁吸相接：边界前一点是前一段的尾帧，后一点是本段的首帧
      const boundary = target.timelineStart;
      const firstFrame = await renderTimelineFramePng(
        Math.max(0, boundary - BOUNDARY_FRAME_EPSILON),
        '转场首帧',
        cleanTracks,
      );
      const lastFrame = await renderTimelineFramePng(
        boundary + BOUNDARY_FRAME_EPSILON,
        '转场尾帧',
        cleanTracks,
      );

      const stamp = Date.now().toString(36);
      setAiTransitionStatus(t('正在暂存首尾帧…'));
      const savedFirst = await saveBinaryToProjectData(
        firstFrame, record.projectId, `AI转场首帧-${stamp}.png`,
      );
      const savedLast = await saveBinaryToProjectData(
        lastFrame, record.projectId, `AI转场尾帧-${stamp}.png`,
      );
      if (!savedFirst || !savedLast) throw new Error('项目数据目录不可写，无法暂存首尾帧');

      const requestId = `ait-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
      aiTransitionRef.current = { requestId, beforeClipId: target.id };
      setAiTransitionStatus(t('已提交主窗口，正在生成转场…'));
      await postVideoEditorAiTransitionRequest(session.instanceId, {
        requestId,
        prompt: options.prompt,
        model: options.model,
        provider: options.provider,
        duration: options.duration,
        firstFrameUrl: savedFirst.assetUrl,
        firstFrameFilePath: savedFirst.filePath,
        lastFrameUrl: savedLast.assetUrl,
        lastFrameFilePath: savedLast.filePath,
      });
    } catch (reason) {
      aiTransitionRef.current = null;
      setAiTransitionBusy(false);
      setAiTransitionStatus(null);
      setAiTransitionError(reason instanceof Error ? reason.message : String(reason));
      console.error('[videoEditor] AI 转场提交失败:', reason);
    }
  }, [
    activeClip?.id, aiTransitionBusy, record, renderTimelineFramePng,
    selectedClipIds, session, t,
  ]);

  const closeWindow = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  }, []);

  const minimizeWindow = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  }, []);

  return (
    <div className="video-editor-root">
      <header className="video-editor-header" data-tauri-drag-region>
        <h1 className="video-editor-title">{record?.name || t('视频编辑器')}</h1>
          {activeProbe && (
            <span className="video-editor-meta">
              {activeProbe.width}×{activeProbe.height} · {allClips.length}{t('个片段')} ·{' '}
              {timelineDuration.toFixed(2)}s
            </span>
          )}
        <div className="video-editor-winctrls">
          {exporting ? (
            <>
              <span className="video-editor-progress">
                {exportStage ?? t('导出中')} {Math.round(exportProgress * 100)}%
              </span>
              <button
                type="button"
                className="video-editor-btn"
                onClick={() => exportAbortRef.current?.abort()}
              >
                {t('取消')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="video-editor-btn"
                onClick={() => { void handleExportFrame(); }}
                disabled={phase !== 'ready' || allClips.length === 0 || exportingFrame}
                title={t('把播放头所在的画面导出为画布图片节点')}
              >
                <Icon icon="lucide:image-down" width={13} height={13} />
                {exportingFrame ? t('导出当前帧…') : t('导出当前帧')}
              </button>
              <button
                type="button"
                className="video-editor-btn"
                onClick={() => { void handleExport('local'); }}
                disabled={phase !== 'ready' || allClips.length === 0 || exportingFrame}
              >
                <Icon icon="lucide:download" width={13} height={13} />
                {t('导出到本地')}
              </button>
              <button
                type="button"
                className="video-editor-btn primary"
                onClick={() => { void handleExport('canvas'); }}
                disabled={phase !== 'ready' || allClips.length === 0 || exportingFrame}
              >
                <Icon icon="lucide:upload" width={13} height={13} />
                {t('导出为新节点')}
              </button>
            </>
          )}
          <button
            type="button"
            className="video-editor-winbtn"
            onClick={() => { void minimizeWindow(); }}
            aria-label={t('最小化')}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0" y="5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="video-editor-winbtn close"
            onClick={() => { void closeWindow(); }}
            aria-label={t('关闭')}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
              <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </header>

      {phase === 'error' && (
        <div className="video-editor-error">
          <FailureReport failure={failure} fallback={t('编辑器加载失败')} copyDetailsLabel={t('复制详情')} stackLabel={t('调用栈')} failedSuffix={t('失败：')} />
        </div>
      )}

      {phase === 'loading' && <div className="video-editor-loading">{t('正在载入素材…')}</div>}

      {phase === 'ready' && record && (
        <>
          {failure && (
            <div className="video-editor-error inline">
              <FailureReport failure={failure} fallback={t('导出失败')} copyDetailsLabel={t('复制详情')} stackLabel={t('调用栈')} failedSuffix={t('失败：')} />
            </div>
          )}
          {notice && <div className="video-editor-notice">{notice}</div>}
          <div className="video-editor-body">
            <VideoEditorMediaPanel
              clips={sourceClips}
              getSource={getSource}
              selectedClipId={selectedClipIds[0] ?? null}
              libraryAssets={libraryAssets}
              projectImages={projectImages}
              addingMedia={addingMedia}
              uploadingSticker={uploadingSticker}
              onSelectClip={(clipId) => setSelectedClipIds([clipId])}
              onAddLocal={() => { void handleAddLocalMedia(); }}
              onAddLibraryAsset={handleAddLibraryAsset}
              onAddCanvasImage={handleAddSticker}
              onUploadSticker={() => { void handleUploadSticker(); }}
            />
            <VideoEditorPreview
              clip={activeClip}
              clipUrl={activeClipUrl}
              playhead={playhead}
              timelineDuration={timelineDuration}
              tracks={tracks}
              selectedClipIds={selectedClipIds}
              canvasSize={canvasSize}
              sourceSize={activeSourceProbe
                ? { width: activeSourceProbe.width, height: activeSourceProbe.height }
                : null}
              onPlayheadChange={setPlayhead}
              onSelectClips={setSelectedClipIds}
              onBeginInteraction={beginInteraction}
              onEndInteraction={endInteraction}
              onTransformChange={(clipId, patch) => patchClipById(clipId, (clip) => ({
                ...clip,
                transform: { ...DEFAULT_TRANSFORM, ...clip.transform, ...patch },
              }))}
            />
            <VideoEditorInspector
              clip={selectedClip ?? activeClip}
              locked={inspectorLocked}
              probe={activeProbe}
              clipCount={allClips.length}
              timelineDuration={timelineDuration}
              canvasSize={canvasSize}
              compositing={compositing}
              mixedSources={mixedSources}
              frameRate={exportFrameRate}
              onFrameRateChange={setExportFrameRate}
              outputScale={outputScale}
              onOutputScaleChange={setOutputScale}
              onBeginInteraction={beginInteraction}
              onEndInteraction={endInteraction}
              onTransformChange={(patch) => patchSelectedClip((clip) => ({
                ...clip,
                transform: { ...DEFAULT_TRANSFORM, ...clip.transform, ...patch },
              }))}
              onTransitionChange={(kind, duration) => patchSelectedClip((clip) => ({
                ...clip,
                transitionIn: { kind, duration },
              }))}
              onVolumeChange={(volume) => patchSelectedClip((clip) => ({ ...clip, volume }))}
              onAddText={handleAddText}
              onPatchText={handlePatchText}
              activeTab={inspectorTab}
              onActiveTabChange={setInspectorTab}
              aiModels={aiModels}
              aiTransitionBusy={aiTransitionBusy}
              aiTransitionStatus={aiTransitionStatus}
              aiTransitionError={aiTransitionError}
              canGenerateAiTransition={canGenerateAiTransition}
              onRefreshAiModels={handleRefreshAiModels}
              onGenerateAiTransition={(options) => { void handleGenerateAiTransition(options); }}
            />
          </div>
          <VideoEditorTimeline
            tracks={tracks}
            duration={timelineDuration}
            playhead={playhead}
            selectedClipIds={selectedClipIds}
            getSource={getSource}
            snapEnabled={snapEnabled}
            onToggleSnap={() => setSnapEnabled((value) => !value)}
            onPlayheadChange={setPlayhead}
            onSelectClips={setSelectedClipIds}
            onTrimClip={handleTrimClip}
            onMoveClip={handleMoveClip}
            onMoveClipToTrack={handleMoveClipToTrack}
            onMoveClipInOverlay={handleMoveClipInOverlay}
            onCreateTrackAndMove={handleCreateTrackAndMove}
            onSplit={handleSplit}
            onDeleteSelected={handleDeleteSelected}
            onDuplicateClip={handleDuplicateClip}
            onEditTransition={handleEditTransition}
            onTracksChange={persistTracks}
            onAddTrack={handleAddTrack}
            onMoveTrack={handleMoveTrack}
            onBeginInteraction={beginInteraction}
            onEndInteraction={endInteraction}
            canSplit={canSplit}
            canUndo={history.canUndo}
            canRedo={history.canRedo}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
        </>
      )}
    </div>
  );
}
