/**
 * ShotlistNode 分镜表 —— 一行一个镜头的可编辑表格
 *
 * 与「宫格分镜」（ai-storyboard）职责不同：那个把一张成图切格取裁片，
 * 这里是前期分镜稿本身。每行的「画面」格引用画布上一个图像/视频节点，
 * 整表可以按行推成视频编辑器的时间轴。
 *
 * 画面格持有的是引用而非所有权：渲染与推送都读画布上那个节点的实时数据，
 * 源节点重新生成后画面自动跟着变；节点不在了才回落到绑定时的快照。
 *
 * 画面有三种来源：把素材节点拖进格子、从连线进来的节点里挑、直接叫 AI 生成
 * （生成出的图仍然是画布上一个正常的图像节点，表里只存引用）。
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import type { BaseNodeData, ShotFrameCandidate, ShotlistColumnKey, ShotRow } from '../../types';
import { confirmAction } from '../../services/confirmDialog';
import { getCanvasLockedZoom, normalizeCanvasZoom } from '../../utils/canvasViewportPreferences';
import {
  SHOT_CAMERA_OPTIONS,
  SHOT_SIZE_OPTIONS,
  SHOT_TRANSITION_OPTIONS,
  SHOTLIST_COLUMN_LABELS,
  SHOTLIST_COLUMN_ORDER,
  SHOTLIST_DEFAULT_COLUMNS,
  SHOTLIST_OPTIONAL_COLUMNS,
  buildShotFramePrompt,
  collectShotFrameCandidates,
  computeShotlistDuration,
  createShotRow,
  readShotFrameSource,
  resolveShotlistColumns,
} from '../../types';
import MentionEditor from './shared/MentionEditor';
import { isInsideMentionPortal } from './shared/mentionPortals';
import NodeLabel from './shared/NodeLabel';
import GooeyBtn from './shared/GooeyBtn';
import ResizeHandle from './shared/ResizeHandle';
import NodeError from './shared/NodeError';
import { useNodeRename } from './shared/useNodeRename';
import { resolveEffectiveModel } from './shared/toolbar/presetAction';
import { useAppStore, generateId } from '../../store/useAppStore';
import { generateShotlistFrames, MAX_SHOTLIST_FRAME_BATCH } from '../../services/shotlistFrameService';
import { buildShotlistAssistantPrompt } from '../../services/shotlistService';
import ShotlistRevisionDialog from './ShotlistRevisionDialog';
import ShotlistProductionDialog from './ShotlistProductionDialog';
import ShotlistStoryboardDialog from './ShotlistStoryboardDialog';
import { getMediaModelOptions } from './shared/defaultModels';
import Select from '../shared/Select';
import NumberStepper from '../shared/NumberStepper';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import FullscreenOverlay from '../shared/FullscreenOverlay';
import { useCanvasNodeLodProtection } from '../../hooks/useCanvasNodeLod';
import { useT } from '../../i18n';
import { hasShotlistTimeline, openVideoEditorForShotlist, resolveShotlistTimelineRows, resolveShotlistVoiceoverNodes } from '../../services/videoEditorService';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../services/canvasDerivationGuard';

/** 画面格实时解析出的素材 */
interface ResolvedFrame {
  url?: string;
  kind: 'image' | 'video';
  /** 源节点已不在画布上，当前显示的是绑定时的快照 */
  dangling: boolean;
}

/** 纯文本列：直接一个多行输入框 */
const TEXT_COLUMNS: ShotlistColumnKey[] = ['content', 'dialogue', 'audio', 'note'];

const FIXED_COLUMN_WIDTHS: Partial<Record<ShotlistColumnKey, number>> = { shotNo: 48, duration: 84 };
const FIXED_TABLE_WIDTH = 26 + 106 + 48 + 84;
const DEFAULT_COLUMN_WIDTHS: Record<ShotlistColumnKey, number> = {
  shotNo: 48, frame: 84, shotSize: 68, camera: 68, content: 240,
  dialogue: 240, audio: 96, transition: 68, duration: 84, note: 96,
};
const FLEXIBLE_COLUMNS = SHOTLIST_COLUMN_ORDER.filter((column) => FIXED_COLUMN_WIDTHS[column] === undefined);
const DEFAULT_WEIGHT_TOTAL = FLEXIBLE_COLUMNS.reduce((sum, column) => sum + DEFAULT_COLUMN_WIDTHS[column], 0);
const clampColumnRatio = (ratio: number) => Math.max(1, Math.min(95, ratio));
const renumberRows = (rows: ShotRow[]) => rows.map((row, index) => {
  const shotNo = String(index + 1);
  return row.shotNo === shotNo ? row : { ...row, shotNo };
});

/** 带候选值的列：下拉给建议，仍可自由输入 */
const OPTION_COLUMNS: Record<string, readonly string[]> = {
  shotSize: SHOT_SIZE_OPTIONS,
  camera: SHOT_CAMERA_OPTIONS,
  transition: SHOT_TRANSITION_OPTIONS.map((option) => option.label),
};

function ShotlistNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const t = useT();
  const config = useAppStore((s) => s.config);
  const workflows = useAppStore((s) => s.workflows);
  const imageModels = useMemo(() => getMediaModelOptions(config.generalModels ?? [], config, workflows)
    .filter((model) => model.mediaKind === 'image'), [config, workflows]);
  const updateNodeDataTransient = useAppStore((s) => s.updateNodeDataTransient);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const setSelectedNodeIds = useAppStore((s) => s.setSelectedNodeIds);
  const { setCenter, getNode } = useReactFlow();

  const nodeWidth = (data.nodeWidth as number) || 720;
  const nodeHeight = (data.nodeHeight as number) || 380;

  // 字段缺省时每次渲染都会是新数组，会让下游 useMemo 依赖恒变
  const rows = useMemo(
    () => (data.shotlistRows as ShotRow[] | undefined) ?? [],
    [data.shotlistRows],
  );
  const columns = useMemo(
    () => (data.shotlistColumns as ShotlistColumnKey[] | undefined) ?? SHOTLIST_DEFAULT_COLUMNS,
    [data.shotlistColumns],
  );

  // 常驻列不受配置影响，避免存量数据把表结构裁没了
  const visibleColumns = useMemo(() => resolveShotlistColumns(columns), [columns]);

  /**
   * 画面格实时解析：读画布上被引用节点的当前素材，源节点不在了才回落到快照。
   *
   * 选择器刻意返回 JSON 字符串而不是对象/Map——返回值按值比较，
   * 画布上任何无关节点的拖动都不会让这张表重渲染，只有被引用素材真的变了才触发。
   */
  const frameEntriesJson = useAppStore((s) => JSON.stringify(
    rows.flatMap<[string, ResolvedFrame]>((row) => {
      const frame = row.frame;
      if (!frame) return [];
      const source = s.nodes.find((candidate) => candidate.id === frame.nodeId);
      if (!source) return [[row.id, { url: frame.url, kind: frame.kind, dangling: true }]];
      const resolved = readShotFrameSource(source);
      return [[row.id, { url: resolved.url ?? frame.url, kind: resolved.kind, dangling: false }]];
    }),
  ));

  const resolvedFrames = useMemo(
    () => new Map<string, ResolvedFrame>(JSON.parse(frameEntriesJson) as [string, ResolvedFrame][]),
    [frameEntriesJson],
  );

  const totalDuration = useMemo(() => computeShotlistDuration(rows), [rows]);

  /** 整表生成中（AI 弹窗把节点 status 置为 loading），与单格出图的 busyRows 是两回事 */
  const generating = data.status === 'loading';

  const { displayLabel, handleRename } = useNodeRename(id, data, '分镜表');

  const [isFullscreen, setIsFullscreen] = useState(false);
  useCanvasNodeLodProtection(id, isFullscreen);
  const [columnMenuRequested, setColumnMenuRequested] = useState(false);
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [draftColumnRatios, setDraftColumnRatios] = useState<BaseNodeData['shotlistColumnRatios'] | null>(null);
  const columnResizeRef = useRef<{
    column: ShotlistColumnKey;
    pointerId: number;
    startX: number;
    startRatio: number;
    availableWidth: number;
    initialRatios: NonNullable<BaseNodeData['shotlistColumnRatios']>;
    ratios: NonNullable<BaseNodeData['shotlistColumnRatios']>;
    projectId: string | null;
    revision: number;
    changed: boolean;
  } | null>(null);
  /**
   * 画面挑选浮层。候选在打开那一刻从 store 快照取，不做订阅——
   * 否则这张表要跟着画布上任何节点的拖动一起重渲染。
   */
  const [picker, setPicker] = useState<
    { rowId: string; left: number; top: number; candidates: ShotFrameCandidate[] } | null
  >(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [busyRows, setBusyRows] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [frameModelRef, setFrameModelRef] = useState('');
  const [frameProgress, setFrameProgress] = useState<{ completed: number; total: number } | null>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [production, setProduction] = useState<{ rowId?: string } | null>(null);
  const [storyboardRowId, setStoryboardRowId] = useState<string | null>(null);
  const subtitleInputId = useId();
  const [includeDialogueCaptions, setIncludeDialogueCaptions] = useState(false);
  const voiceoverInputId = useId();
  const [includeVoiceovers, setIncludeVoiceovers] = useState(false);
  const [timelineBusy, setTimelineBusy] = useState(false);
  const [customOptionCells, setCustomOptionCells] = useState<string[]>([]);
  const numberScrubbingRef = useRef(false);
  const timelineRunning = useRef(false);
  const episodeScript = useAppStore((state) => state.projects.find((project) => project.id === data.shotlistScriptSource?.episodeId)?.episodeScript);
  const sourceScript = useAppStore((state) => state.nodes.find((node) => node.id === data.shotlistScriptSource?.nodeId)?.data.output);
  const scriptChanged = useMemo(() => typeof sourceScript === 'string' && sourceScript.trim() !== (episodeScript ?? '').trim(), [sourceScript, episodeScript]);
  const frameController = useRef<AbortController | null>(null);
  const emptyRows = rows.filter((row) => !row.frame && buildShotFramePrompt(row).trim());
  const pickerRef = useRef<HTMLDivElement>(null);

  const savedColumnRatios = useMemo(() => Object.fromEntries(
    FLEXIBLE_COLUMNS.map((column) => {
      const ratio = data.shotlistColumnRatios?.[column];
      const legacyWidth = data.shotlistColumnWidths?.[column];
      const width = typeof legacyWidth === 'number' && Number.isFinite(legacyWidth) && legacyWidth > 0
        ? Math.max(40, Math.min(1600, legacyWidth)) : DEFAULT_COLUMN_WIDTHS[column];
      return [column, typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? Math.max(0.001, Math.min(100, ratio))
        : (data.shotlistColumnRatios ? DEFAULT_COLUMN_WIDTHS[column] : width) / DEFAULT_WEIGHT_TOTAL * 100];
    }),
  ) as NonNullable<BaseNodeData['shotlistColumnRatios']>, [data.shotlistColumnRatios, data.shotlistColumnWidths]);
  const flexibleColumns = visibleColumns.filter((column) => FLEXIBLE_COLUMNS.includes(column));
  const columnRatios = draftColumnRatios ?? savedColumnRatios;
  const visibleRatioTotal = flexibleColumns.reduce((sum, column) => sum + (columnRatios[column] ?? 0), 0);
  const getColumnRatio = (column: ShotlistColumnKey) => (columnRatios[column] ?? 0) / visibleRatioTotal * 100;
  const tableColumns = ['26px', ...visibleColumns.map((column) => FIXED_COLUMN_WIDTHS[column] !== undefined
    ? `${FIXED_COLUMN_WIDTHS[column]}px` : `minmax(0, ${getColumnRatio(column)}fr)`), '106px'].join(' ');
  const hasCustomColumnWidths = !!data.shotlistColumnRatios || !!data.shotlistColumnWidths;

  useEffect(() => () => frameController.current?.abort(), []);

  const redistributeColumnRatios = (
    ratios: NonNullable<BaseNodeData['shotlistColumnRatios']>, column: ShotlistColumnKey, ratio: number,
  ) => {
    const total = flexibleColumns.reduce((sum, key) => sum + (ratios[key] ?? 0), 0);
    const target = total * clampColumnRatio(ratio) / 100;
    const otherTotal = total - (ratios[column] ?? 0);
    return Object.fromEntries(FLEXIBLE_COLUMNS.map((key) => [key,
      key === column ? target : flexibleColumns.includes(key) ? (ratios[key] ?? 0) * (total - target) / otherTotal
        : ratios[key],
    ])) as NonNullable<BaseNodeData['shotlistColumnRatios']>;
  };

  const writeColumnRatios = (ratios: BaseNodeData['shotlistColumnRatios'], recordHistory = true) => {
    if (recordHistory) commitToHistory();
    updateNodeDataTransient(id, { shotlistColumnRatios: ratios, shotlistColumnWidths: undefined });
    if (recordHistory) commitToHistory();
  };

  const setColumnRatio = (column: ShotlistColumnKey, ratio: number, recordHistory = true) => {
    if (!flexibleColumns.includes(column) || !Number.isFinite(ratio)) return;
    const nextRatio = clampColumnRatio(ratio);
    if (Math.abs(getColumnRatio(column) - nextRatio) < 0.000001) return;
    writeColumnRatios(redistributeColumnRatios(savedColumnRatios, column, nextRatio), recordHistory);
  };

  const onNumberScrubStateChange = (scrubbing: boolean) => {
    numberScrubbingRef.current = scrubbing;
    commitToHistory();
  };

  const startColumnResize = (event: ReactPointerEvent<HTMLButtonElement>, column: ShotlistColumnKey) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.closest('th');
    if (!header) return;
    const table = tableRef.current;
    if (!table || !flexibleColumns.includes(column)) return;
    const scale = header.offsetWidth ? header.getBoundingClientRect().width / header.offsetWidth : 1;
    const state = useAppStore.getState();
    columnResizeRef.current = {
      column, pointerId: event.pointerId, startX: event.clientX,
      startRatio: getColumnRatio(column), availableWidth: Math.max(1, (table.offsetWidth - FIXED_TABLE_WIDTH) * scale),
      initialRatios: savedColumnRatios, ratios: savedColumnRatios,
      projectId: state.currentProjectId, revision: state.getCurrentRevision(), changed: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveColumnResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = columnResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const ratio = clampColumnRatio(resize.startRatio + (event.clientX - resize.startX) / resize.availableWidth * 100);
    resize.ratios = redistributeColumnRatios(resize.initialRatios, resize.column, ratio);
    resize.changed = ratio !== resize.startRatio;
    setDraftColumnRatios(resize.ratios);
  };

  const finishColumnResize = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const resize = columnResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.stopPropagation();
    columnResizeRef.current = null;
    setDraftColumnRatios(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const state = useAppStore.getState();
    if (!cancelled && resize.changed && state.currentProjectId === resize.projectId
      && state.getCurrentRevision() === resize.revision && state.nodes.some((node) => node.id === id)) {
      writeColumnRatios(resize.ratios);
    }
  };

  const openFullscreen = useCallback(() => {
    setPicker(null);
    setColumnMenuRequested(false);
    setIsFullscreen(true);
  }, [setPicker]);

  const closeFullscreen = useCallback(() => {
    columnResizeRef.current = null;
    setDraftColumnRatios(null);
    setPicker(null);
    setColumnMenuRequested(false);
    setDragRowId(null);
    setIsFullscreen(false);
  }, []);

  const prepareFrameModel = useCallback(() => {
    const state = useAppStore.getState();
    const preferred = state.projects.find((project) => project.id === state.currentProjectId)?.settings?.defaultModels?.image
      || resolveEffectiveModel('ai-image')?.model;
    setFrameModelRef((current) => imageModels.some((model) => model.value === current) ? current
      : imageModels.find((model) => model.value === preferred)?.value ?? '');
  }, [imageModels, setFrameModelRef]);

  const writeRows = useCallback(
    (next: ShotRow[]) => updateNodeDataTransient(id, { shotlistRows: next } as Partial<BaseNodeData>),
    [id, updateNodeDataTransient],
  );

  /** 输入过程中只改数据不落历史，失焦时再提交，避免每敲一个字produce一条撤销记录 */
  const patchRow = useCallback(
    (rowId: string, patch: Partial<ShotRow>) => {
      writeRows(rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
    },
    [rows, writeRows],
  );

  const addRow = useCallback(() => {
    commitToHistory();
    writeRows(renumberRows([...rows, createShotRow(`shot-${generateId()}`, rows.length + 1)]));
    commitToHistory();
  }, [rows, writeRows, commitToHistory]);

  const deleteRow = useCallback(
    (rowId: string) => {
      commitToHistory();
      writeRows(renumberRows(rows.filter((row) => row.id !== rowId)));
      commitToHistory();
    },
    [rows, writeRows, commitToHistory],
  );

  const moveRow = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const from = rows.findIndex((row) => row.id === fromId);
      const to = rows.findIndex((row) => row.id === toId);
      if (from < 0 || to < 0) return;
      const next = [...rows];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      commitToHistory();
      writeRows(renumberRows(next));
      commitToHistory();
    },
    [rows, writeRows, commitToHistory],
  );

  const toggleColumn = useCallback(
    (key: ShotlistColumnKey) => {
      const enabled = new Set(columns);
      if (enabled.has(key)) enabled.delete(key);
      else enabled.add(key);
      commitToHistory();
      updateNodeDataTransient(id, {
        shotlistColumns: SHOTLIST_COLUMN_ORDER.filter((column) => enabled.has(column)),
      } as Partial<BaseNodeData>);
    },
    [columns, id, updateNodeDataTransient, commitToHistory],
  );

  const unbindFrame = useCallback(
    (rowId: string) => {
      commitToHistory();
      patchRow(rowId, { frame: null });
      commitToHistory();
    },
    [patchRow, commitToHistory],
  );

  /** 点击已绑画面 → 把画布移到那个源节点并选中它 */
  const focusFrameNode = useCallback(
    (nodeId: string) => {
      const target = getNode(nodeId);
      if (!target) return;
      const width = (target.measured?.width ?? 200) / 2;
      const height = (target.measured?.height ?? 200) / 2;
      const config = useAppStore.getState().config;
      void setCenter(target.position.x + width, target.position.y + height, {
        zoom: getCanvasLockedZoom(config) ?? normalizeCanvasZoom(1, config),
        duration: 400,
        interpolate: 'linear',
      });
      setSelectedNodeIds([nodeId]);
    },
    [getNode, setCenter, setSelectedNodeIds],
  );

  const openPicker = useCallback((rowId: string, anchor: HTMLElement) => {
    prepareFrameModel();
    const { nodes, edges } = useAppStore.getState();
    const rect = anchor.getBoundingClientRect();
    const row = rows.find((item) => item.id === rowId);
    setAiPrompt(row ? buildShotFramePrompt(row) : '');
    setPicker({
      rowId,
      // 浮层固定宽 360，靠右/靠下时往回收，避免顶出视口
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)),
      // @ 候选面板向上弹，底部要给它留出余量
      top: Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 380)),
      candidates: collectShotFrameCandidates(nodes, edges, id),
    });
  }, [id, rows, prepareFrameModel, setAiPrompt, setPicker]);

  const chooseCandidate = useCallback((rowId: string, nodeId: string) => {
    useAppStore.getState().bindShotlistFrame(id, rowId, nodeId);
    setPicker(null);
  }, [id, setPicker]);

  /**
   * 叫 AI 补这一格：在画布上新建一个图像节点并连回本表，生成成功后再绑定。
   * 画面始终是画布上的真节点，用户可以照常改提示词重跑，表里跟着变。
   */
  const generateFrames = useCallback(async (rowIds: string[], prompts?: Record<string, string>, replaceExisting = false) => {
    if (frameController.current || !frameModelRef) return;
    const store = useAppStore.getState();
    if (!store.currentProjectId) return;
    const controller = new AbortController();
    frameController.current = controller;
    setPicker(null);
    setBatchOpen(false);
    setBusyRows(rowIds);
    setFrameProgress({ completed: 0, total: rowIds.length });
    try {
      const results = await generateShotlistFrames({
        projectId: store.currentProjectId, baseRevision: store.getCurrentRevision(),
        nodeId: id, rowIds, prompts, replaceExisting, modelRef: frameModelRef, signal: controller.signal,
        onProgress: (completed, total) => setFrameProgress({ completed, total }),
      });
      const completed = results.filter((result) => result.status === 'success').length;
      const unfinished = results.filter((result) => !['success', 'skipped'].includes(result.status)).length;
      store.showToast(t('已补齐 {count} 镜，未完成 {remaining} 镜', { count: completed, remaining: unfinished }), unfinished ? 'error' : 'success');
    } catch (error) {
      store.showToast(error instanceof Error ? error.message : t('补图失败'), 'error');
    } finally {
      frameController.current = null;
      setBusyRows([]);
      setFrameProgress(null);
    }
  }, [frameModelRef, id, t, setPicker, setBatchOpen]);

  const generateFrame = useCallback((rowId: string) => generateFrames([rowId], aiPrompt.trim() ? { [rowId]: aiPrompt.trim() } : undefined, true), [aiPrompt, generateFrames]);

  const askAssistant = useCallback((rowId?: string) => {
    const state = useAppStore.getState();
    try {
      const draft = buildShotlistAssistantPrompt({ projectId: state.currentProjectId ?? '' }, id, rowId);
      state.openChatWithDraft(draft);
      closeFullscreen();
      state.showToast(t('已准备分镜请求，请在助手中发送'));
    } catch (error) {
      state.showToast(error instanceof Error ? error.message : t('准备分镜请求失败'), 'error');
    }
  }, [id, t, closeFullscreen]);

  /**
   * 叫模型拆整张表：复用节点通用的 AI 弹窗（模型选择器 + @ 引用 + 提示词），
   * 回答由 AINodeDialog 解析成 shotlistRows 写回来，这里只负责把弹窗开在表底下。
   */
  const openAiDialog = useCallback(() => {
    setColumnMenuRequested(false);
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    const rect = el?.getBoundingClientRect();
    useAppStore.getState().openNodeDialog(
      id,
      rect ? { x: rect.left + rect.width / 2, y: rect.bottom } : undefined,
    );
  }, [id]);

  const pushToTimeline = useCallback(async () => {
    if (timelineRunning.current) return;
    const store = useAppStore.getState();
    const projectId = store.currentProjectId ?? '';
    const guard = registerCanvasDerivation(store, id);
    if (!guard) return;
    const source = store.nodes.find((node) => node.id === id)!;
    const timelineRows = resolveShotlistTimelineRows(source.data.shotlistRows ?? [], store.nodes);
    const voiceoverNodes = includeVoiceovers ? resolveShotlistVoiceoverNodes(id, store.nodes) : undefined;
    const snapshot = JSON.stringify([timelineRows, voiceoverNodes]);
    const assertCurrent = () => {
      const current = useAppStore.getState();
      const node = current.nodes.find((candidate) => candidate.id === id);
      if (!isCanvasDerivationFresh(guard, current) || current.projectLoadStatus !== 'ready'
        || !node || JSON.stringify([resolveShotlistTimelineRows(node.data.shotlistRows ?? [], current.nodes),
          includeVoiceovers ? resolveShotlistVoiceoverNodes(id, current.nodes) : undefined]) !== snapshot) {
        throw new Error(t('项目或分镜已变化，请重新推送时间轴'));
      }
    };
    timelineRunning.current = true;
    setTimelineBusy(true);
    try {
      // 分镜表是时间轴的源，每次推送都按当前表重建，会覆盖上次在剪辑窗口里的调整
      if (await hasShotlistTimeline(projectId, id)) {
        const confirmed = await confirmAction('这张分镜表已经推送过时间轴。继续将按当前表重建，剪辑窗口里的调整会丢失。', { title: '重新推送时间轴' });
        if (!confirmed) return;
      }
      assertCurrent();
      await openVideoEditorForShotlist({
        projectId,
        nodeId: id,
        label: source.data.label || '分镜表',
        rows: timelineRows,
        includeDialogueCaptions,
        voiceoverNodes,
        assertCurrent,
        theme: store.config.theme === 'light' ? 'light' : 'dark',
      });
    } catch (err: unknown) {
      store.showToast(err instanceof Error ? err.message : '推送时间轴失败', 'error');
    } finally {
      completeCanvasDerivation(guard);
      timelineRunning.current = false;
      setTimelineBusy(false);
    }
  }, [id, includeDialogueCaptions, includeVoiceovers, t]);

  const handleResize = useCallback(
    (w: number, h: number) => updateNodeDataTransient(id, { nodeWidth: w, nodeHeight: h } as Partial<BaseNodeData>),
    [id, updateNodeDataTransient],
  );

  // 取消选中即收起：派生而非用 effect 回写，避免多一轮渲染
  const columnMenuOpen = columnMenuRequested && (!!selected || isFullscreen);

  // 点击外部关闭列菜单
  useEffect(() => {
    if (!columnMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (columnMenuRef.current && !columnMenuRef.current.contains(e.target as Element)) {
        setColumnMenuRequested(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [columnMenuOpen]);

  // 点击外部关闭画面挑选浮层
  useEffect(() => {
    if (!picker) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!pickerRef.current || !target) return;
      if (pickerRef.current.contains(target)) return;
      // 资源库弹窗 Portal 到 body，按包含关系判定会被当成"点了外面"，刚点开就被关掉
      if (isInsideMentionPortal(target)) return;
      if (target.closest('[data-ui-select-portal]')) return;
      setPicker(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [picker]);

  const renderCell = (row: ShotRow, column: ShotlistColumnKey, rowIndex: number) => {
    if (column === 'frame') {
      const frame = resolvedFrames.get(row.id);
      const busy = busyRows.includes(row.id);
      if (!row.frame) {
        return (
          <button
            type="button"
            className="shot-frame shot-frame--empty nodrag"
            data-shot-frame-row={row.id}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => openPicker(row.id, e.currentTarget)}
            title="挑选连线进来的画面，或让 AI 生成"
          >
            {busy
              ? <span className="shot-frame-spinner" aria-hidden="true" />
              : <Icon icon="mdi:plus" width={16} height={16} aria-hidden="true" />}
            <span className="shot-frame-hint">{busy ? '生成中' : '选择画面'}</span>
          </button>
        );
      }
      return (
        <div
          className={`shot-frame${frame?.dangling ? ' shot-frame--dangling' : ''}`}
          data-shot-frame-row={row.id}
        >
          <button
            type="button"
            className="shot-frame-pick nodrag"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => openPicker(row.id, e.currentTarget)}
            title="换一个画面"
            aria-label="换一个画面"
          >
            <Icon icon="mdi:image-sync-outline" width={11} height={11} />
          </button>
          {frame?.url ? (
            <img
              className="shot-frame-img"
              src={frame.url}
              alt=""
              draggable={false}
              onClick={() => focusFrameNode(row.frame!.nodeId)}
              title={frame.dangling ? '源节点已不在画布上，显示的是快照' : '点击定位到源节点'}
            />
          ) : (
            <span className="shot-frame-hint">无预览</span>
          )}
          {frame?.kind === 'video' && (
            <Icon className="shot-frame-badge" icon="mdi:play-circle" width={14} height={14} aria-hidden="true" />
          )}
          <button
            type="button"
            className="shot-frame-unbind nodrag"
            onClick={() => unbindFrame(row.id)}
            title="解除绑定"
            aria-label="解除绑定"
          >
            <Icon icon="mdi:close" width={11} height={11} />
          </button>
        </div>
      );
    }

    if (column === 'shotNo') {
      return (
        <span className="tabular-nums" aria-label={t('镜号')}>{rowIndex + 1}</span>
      );
    }

    if (column === 'duration') {
      return (
        <div className="nodrag nowheel" onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}>
          <label className="sr-only" htmlFor={`${subtitleInputId}-${row.id}-duration`}>{t('时长')}</label>
          <NumberStepper id={`${subtitleInputId}-${row.id}-duration`} size="sm" unit="s"
            className="w-full" aria-label={t('时长')} min={0} step={0.5} value={row.duration ?? 0}
            onChange={(duration) => {
              if (duration === row.duration) return;
              if (!numberScrubbingRef.current) commitToHistory();
              patchRow(row.id, { duration });
              if (!numberScrubbingRef.current) commitToHistory();
            }}
            onScrubStateChange={onNumberScrubStateChange} />
        </div>
      );
    }

    const options = OPTION_COLUMNS[column];
    if (options) {
      const value = (row[column] as string) ?? '';
      const cellId = `${row.id}:${column}`;
      const custom = customOptionCells.includes(cellId) || (!!value && !options.includes(value));
      return (
        <div className="min-w-0 nodrag">
          <Select
            size="sm" fixedMenu className="min-w-0"
            value={custom ? 'custom' : value ? `preset:${options.indexOf(value)}` : ''}
            aria-label={SHOTLIST_COLUMN_LABELS[column]}
            placeholder={t('未选择')}
            customInput={custom ? {
              value, placeholder: t('自定义'), autoFocus: customOptionCells.includes(cellId),
              onChange: (text) => {
                setCustomOptionCells((current) => current.includes(cellId) ? current : [...current, cellId]);
                patchRow(row.id, { [column]: text } as Partial<ShotRow>);
              },
              onFocus: commitToHistory, onBlur: commitToHistory,
            } : undefined}
            options={[
              { value: '', label: t('未选择') },
              ...options.map((option, index) => ({ value: `preset:${index}`, label: option })),
              { value: 'custom', label: t('自定义') },
            ]}
            onChange={(selectedValue) => {
              if (selectedValue === 'custom') {
                setCustomOptionCells((current) => current.includes(cellId) ? current : [...current, cellId]);
                return;
              }
              setCustomOptionCells((current) => current.filter((cell) => cell !== cellId));
              commitToHistory();
              patchRow(row.id, { [column]: selectedValue ? options[Number(selectedValue.slice(7))] : '' } as Partial<ShotRow>);
              commitToHistory();
            }}
          />
        </div>
      );
    }

    if (TEXT_COLUMNS.includes(column)) {
      return (
        <textarea
          className="ui-textarea shot-input shot-input--text nodrag nowheel"
          aria-label={SHOTLIST_COLUMN_LABELS[column]}
          rows={2}
          value={(row[column] as string) ?? ''}
          onChange={(e) => patchRow(row.id, { [column]: e.target.value } as Partial<ShotRow>)}
          onBlur={commitToHistory}
          onMouseDown={(e) => e.stopPropagation()}
        />
      );
    }

    return null;
  };

  const tableContent = (
    <>
        {/* 工具条本身不加 nodrag：表体几乎被输入框占满，这条带子是节点主要的拖拽手柄 */}
        <div className="shotlist-toolbar flex-wrap">
          <span className="shotlist-stat">
            共 {rows.length} 镜 · 总时长 {Number(totalDuration.toFixed(1))}″
          </span>
          <div className="shotlist-toolbar-actions nodrag flex-wrap" ref={columnMenuRef}>
            {!isFullscreen && <button type="button" className="ui-icon-btn ui-icon-btn--sm nodrag"
              onClick={openFullscreen} title={t('全屏显示')} aria-label={t('全屏显示')}>
              <Icon icon="mdi:fullscreen" width={16} height={16} />
            </button>}
            <button type="button" className="ui-btn ui-btn--sm" disabled={generating || !rows.length}
              onClick={() => askAssistant()}>
              <Icon icon="mdi:clipboard-text-search-outline" width={13} height={13} />
              {t('AI 诊断')}
            </button>
            {data.shotlistScriptSource && <button type="button" className="ui-btn ui-btn--sm" disabled={generating}
              onClick={() => setRevisionOpen(true)}>{t(scriptChanged ? '剧本已修改' : '剧本改动复核')}</button>}
            <button type="button" className="ui-btn ui-btn--sm" disabled={generating || !rows.length}
              onClick={() => setProduction({})}>{t('镜头制作准备')}</button>
            {frameProgress ? (
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => frameController.current?.abort()}>
                {t('取消补图')} {frameProgress.completed}/{frameProgress.total}
              </button>
            ) : (
              <button type="button" className="ui-btn ui-btn--sm" disabled={generating || !emptyRows.length}
                onClick={() => { prepareFrameModel(); setBatchOpen(true); }}>
                {t('补齐空镜')} ({emptyRows.length})
              </button>
            )}
            <button
              type="button"
              className="shotlist-btn"
              onClick={openAiDialog}
              disabled={generating}
              title="按剧本让模型拆出整张分镜表（只填当前显示的列）"
            >
              {generating
                ? <span className="shot-frame-spinner" aria-hidden="true" />
                : <Icon icon="mdi:auto-fix" width={13} height={13} />}
              {generating ? '生成中' : 'AI 生成'}
            </button>
            <button
              type="button"
              className="shotlist-btn"
              onClick={() => setColumnMenuRequested((open) => !open)}
              title="选择显示的列与列宽"
            >
              <Icon icon="mdi:view-column-outline" width={13} height={13} />
              列
            </button>
            {columnMenuOpen && (
              <div className="ui-menu ui-menu--right shotlist-column-menu nowheel w-64 p-2">
                <div className="mb-1 text-xs text-canvas-text-secondary">{t('显示的列')}</div>
                {SHOTLIST_OPTIONAL_COLUMNS.map((key) => (
                  <div key={key} className="ui-menu__item">
                    <input
                      id={`${subtitleInputId}-column-${key}`} className="ui-checkbox"
                      type="checkbox"
                      checked={columns.includes(key)}
                      onChange={() => toggleColumn(key)}
                    />
                    <label htmlFor={`${subtitleInputId}-column-${key}`}>{SHOTLIST_COLUMN_LABELS[key]}</label>
                  </div>
                ))}
                <div className="mt-2 border-t border-canvas-border pt-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-canvas-text-secondary">{t('列宽（%）')}</span>
                    <button type="button" className="ui-btn ui-btn--sm" disabled={!hasCustomColumnWidths}
                      onClick={() => writeColumnRatios(undefined)}>{t('恢复默认')}</button>
                  </div>
                  <p className="mb-2 text-xs text-canvas-text-muted">{t('镜号固定 48px，时长固定 84px；其他列分配剩余空间。')}</p>
                  {flexibleColumns.map((column) => (
                    <div key={column} className="mb-1 grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-2 text-xs text-canvas-text"
                      onKeyDown={(event) => event.stopPropagation()}>
                      <label htmlFor={`${subtitleInputId}-${column}-width`} className="whitespace-nowrap">{SHOTLIST_COLUMN_LABELS[column]}</label>
                      <NumberStepper id={`${subtitleInputId}-${column}-width`} size="sm" unit="%"
                        className="w-full nodrag" min={1} max={95} step={0.5} precision={1}
                        value={getColumnRatio(column)}
                        aria-label={`${SHOTLIST_COLUMN_LABELS[column]}列宽`}
                        onChange={(ratio) => setColumnRatio(column, ratio, !numberScrubbingRef.current)}
                        onScrubStateChange={onNumberScrubStateChange} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="text-xs" title={t('对白按镜头时长放置，可在剪辑器中细调')}>
              <input id={subtitleInputId} type="checkbox" className="ui-checkbox" checked={includeDialogueCaptions}
                disabled={timelineBusy} onChange={(event) => setIncludeDialogueCaptions(event.target.checked)} />
              <label htmlFor={subtitleInputId}>{t('附带对白字幕')}</label>
            </div>
            <div className="text-xs" title={t('配音按镜头起点放置，超长部分裁到镜头末尾，可在剪辑器中调整')}>
              <input id={voiceoverInputId} type="checkbox" className="ui-checkbox" checked={includeVoiceovers}
                disabled={timelineBusy} onChange={(event) => setIncludeVoiceovers(event.target.checked)} />
              <label htmlFor={voiceoverInputId}>{t('附带已就绪配音')}</label>
            </div>
            <button
              type="button"
              className="shotlist-btn shotlist-btn--primary"
              onClick={pushToTimeline}
              disabled={timelineBusy}
              title="按当前表重建剪辑时间轴"
            >
              <Icon icon="mdi:timeline-plus-outline" width={13} height={13} />
              推送时间轴
            </button>
          </div>
        </div>

        <div className="shotlist-scroll nowheel">
          <table ref={tableRef} className="shotlist-table" style={{ '--shotlist-columns': tableColumns } as CSSProperties}>
            <thead>
              <tr>
                <th className="shot-col-grip" aria-label="排序" />
                {visibleColumns.map((column) => (
                  <th key={column} className={`shot-col-${column}`} data-shot-column={column}>
                    {SHOTLIST_COLUMN_LABELS[column]}
                    {flexibleColumns.includes(column) && <button type="button" className="shotlist-column-resize nodrag nowheel"
                      aria-label={`${SHOTLIST_COLUMN_LABELS[column]}列宽`} title={t('拖动调整列宽')}
                      onPointerDown={(event) => startColumnResize(event, column)} onPointerMove={moveColumnResize}
                      onPointerUp={(event) => finishColumnResize(event)}
                      onPointerCancel={(event) => finishColumnResize(event, true)}
                      onLostPointerCapture={(event) => finishColumnResize(event, true)}
                      onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                        event.preventDefault();
                        event.stopPropagation();
                        setColumnRatio(column, getColumnRatio(column) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 5 : 1));
                      }} />}
                  </th>
                ))}
                <th className="shot-col-actions">{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr
                  key={row.id}
                  className={dragRowId === row.id ? 'shot-row--dragging' : ''}
                  onDragOver={(e) => { if (dragRowId) e.preventDefault(); }}
                  onDrop={(e) => {
                    if (!dragRowId) return;
                    e.preventDefault();
                    moveRow(dragRowId, row.id);
                    setDragRowId(null);
                  }}
                >
                  <td className="shot-col-grip">
                    <span
                      className="shot-grip nodrag"
                      draggable
                      onDragStart={() => setDragRowId(row.id)}
                      onDragEnd={() => setDragRowId(null)}
                      title="拖动调整顺序"
                    >
                      <Icon icon="mdi:drag-horizontal-variant" width={13} height={13} />
                    </span>
                  </td>
                  {visibleColumns.map((column) => (
                    <td key={column} className={`shot-col-${column}`}>{renderCell(row, column, rowIndex)}</td>
                  ))}
                  <td className="shot-col-actions">
                    <div className="flex items-center justify-center gap-1 px-1">
                      <button type="button" className="ui-icon-btn ui-icon-btn--sm nodrag"
                        disabled={generating || busyRows.includes(row.id)}
                        onClick={() => askAssistant(row.id)}
                        title={t('AI 优化本镜')} aria-label={t('AI 优化本镜')}>
                        <Icon icon="mdi:auto-fix" width={13} height={13} />
                      </button>
                      <button type="button" className="ui-icon-btn ui-icon-btn--sm nodrag" disabled={generating}
                        onClick={() => setProduction({ rowId: row.id })} title={t('镜头制作准备')} aria-label={t('镜头制作准备')}>
                        <Icon icon="mdi:movie-open-plus-outline" width={13} height={13} />
                      </button>
                      <button
                        type="button"
                        className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--danger nodrag"
                        onClick={() => deleteRow(row.id)}
                        title="删除该镜"
                        aria-label="删除该镜"
                      >
                        <Icon icon="mdi:trash-can-outline" width={13} height={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {rows.length === 0 && (
            <div className="shotlist-empty">还没有镜头，点「AI 生成」让模型拆，或点下面「加一镜」自己写</div>
          )}
        </div>

        <button type="button" className="shotlist-add nodrag" onClick={addRow}>
          <Icon icon="mdi:plus" width={13} height={13} />
          加一镜
        </button>

        {data.error && <NodeError nodeId={id} message={data.error} />}

    </>
  );

  return (
    <div className="node-wrapper relative" style={{ width: nodeWidth }}>
      <NodeLabel
        kind="ai-shotlist"
        label={displayLabel}
        displayId={data.displayId as number | undefined}
        nodeId={id}
        onRename={handleRename}
      />
      {revisionOpen && <ShotlistRevisionDialog nodeId={id} onClose={() => setRevisionOpen(false)} />}
      {production && <ShotlistProductionDialog nodeId={id} rowId={production.rowId} onClose={() => setProduction(null)} />}
      {storyboardRowId && <ShotlistStoryboardDialog nodeId={id} rowId={storyboardRowId} onClose={() => setStoryboardRowId(null)} />}
      <div className={`node shotlist-node ${selected ? 'selected' : ''}`} style={{ height: nodeHeight }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if ((event.target as Element).closest('button, input, textarea, select, label, a, [contenteditable], [role="button"]')) return;
          openFullscreen();
        }}>
        {!isFullscreen && tableContent}

        <Handle type="target" position={Position.Left} id="left" className="node-handle handle-target handle-shotlist">
          <GooeyBtn className="gooey-btn-left" hue={40} />
        </Handle>
        <Handle type="source" position={Position.Right} id="right" className="node-handle handle-source handle-shotlist">
          <GooeyBtn className="gooey-btn-right" hue={40} />
        </Handle>
      </div>

      <FullscreenOverlay isOpen={isFullscreen} onClose={closeFullscreen} title={displayLabel}
        panelWidth="96vw" className="shotlist-fullscreen" bodyClassName="shotlist-fullscreen-body" unmountOnClose>
        {isFullscreen && tableContent}
      </FullscreenOverlay>

      {/* 画面挑选浮层 —— 表体是滚动容器，只能 Portal 出去才不被裁掉 */}
      {picker && createPortal(
        <div
          ref={pickerRef}
          className="shot-picker nodrag nowheel"
          style={{ left: picker.left, top: picker.top }}
        >
          <div className="shot-picker-title">连线进来的画面</div>
          {picker.candidates.length > 0 ? (
            <div className="shot-picker-grid">
              {picker.candidates.map((candidate) => (
                <button
                  key={candidate.nodeId}
                  type="button"
                  className="shot-picker-item"
                  title={candidate.label}
                  onClick={() => chooseCandidate(picker.rowId, candidate.nodeId)}
                >
                  {candidate.url
                    ? <img src={candidate.url} alt="" className="shot-picker-img" />
                    : <span className="shot-frame-hint">未出图</span>}
                  {candidate.kind === 'video' && (
                    <Icon className="shot-frame-badge" icon="mdi:play-circle" width={12} height={12} />
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="shot-picker-empty">把图像/视频节点连到这张表，这里就能直接挑</div>
          )}

          <button type="button" className="ui-btn ui-btn--sm my-2" onClick={() => { setStoryboardRowId(picker.rowId); setPicker(null); }}>{t('从宫格取画面')}</button>
          <div className="shot-picker-title">AI 生成画面</div>
          <Select value={frameModelRef} onChange={setFrameModelRef}
            options={imageModels.map((model) => ({ value: model.value, label: model.label }))}
            placeholder={t('选择图片模型')} aria-label={t('选择图片模型')} fixedMenu />
          {/*
            走 MentionEditor 而不是裸 textarea：@ 能引用连进本表的节点、角色和资源库文件。
            存下来的 @{id:label} 记号由 generateImage 里的 resolvePromptWithImageRefs 解析，
            所以参考图会真的进到生图请求里，不是只当文字拼进提示词。
          */}
          <MentionEditor
            value={aiPrompt}
            onChange={setAiPrompt}
            onSubmit={() => void generateFrame(picker.rowId)}
            canSubmit={!busyRows.length && !!frameModelRef}
            nodeId={id}
            className="shot-picker-input"
            placeholder="默认用「内容」栏，@ 可引用角色、资源库和连线节点"
          />
          <button
            type="button"
            className="shotlist-btn shotlist-btn--primary shot-picker-go"
            onClick={() => void generateFrame(picker.rowId)}
            disabled={!!busyRows.length || !frameModelRef}
          >
            <Icon icon="mdi:auto-fix" width={13} height={13} />
            生成并绑定
          </button>
        </div>,
        document.body,
      )}

      <ModalOverlay isOpen={batchOpen} onClose={() => setBatchOpen(false)} ariaLabel={t('补齐空镜')}
        className="w-[min(420px,calc(100vw-24px))] bg-[var(--glass-bg)] text-canvas-text">
        <div className="flex items-center gap-3 border-b border-canvas-border p-4">
          <span className="flex-1 text-sm font-semibold">{t('补齐空镜')}</span>
          <PopupCloseButton ariaLabel={t('关闭')} onClick={() => setBatchOpen(false)} />
        </div>
        <div className="grid gap-4 p-4">
          <p className="text-xs text-canvas-text-secondary">
            {t('本次生成前 {count} 个空镜，已有画面保持不变。', { count: Math.min(emptyRows.length, MAX_SHOTLIST_FRAME_BATCH) })}
          </p>
          <Select value={frameModelRef} onChange={setFrameModelRef}
            options={imageModels.map((model) => ({ value: model.value, label: model.label }))}
            placeholder={t('选择图片模型')} aria-label={t('选择图片模型')} fixedMenu />
          <p className="text-xs text-canvas-text-muted">{t('每镜调用一次图片模型，可随时取消并保留已完成结果。')}</p>
          <button type="button" className="ui-btn ui-btn--primary" disabled={!frameModelRef || !emptyRows.length}
            onClick={() => { void generateFrames(emptyRows.slice(0, MAX_SHOTLIST_FRAME_BATCH).map((row) => row.id)); }}>
            {t('开始补图')}
          </button>
        </div>
      </ModalOverlay>

      <ResizeHandle
        nodeId={id}
        currentWidth={nodeWidth}
        currentHeight={nodeHeight}
        minWidth={420}
        minHeight={220}
        onResizeStart={commitToHistory}
        onResizeEnd={commitToHistory}
        onResize={handleResize}
      />
    </div>
  );
}

export default memo(ShotlistNode);
