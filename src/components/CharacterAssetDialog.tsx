/**
 * CharacterAssetDialog — 角色资产编辑弹窗。
 * 编辑单个 DramaCharacter 的基本信息、参考图（上传/裁剪/分类）与声音素材（音频/时长），
 * 按项目或全局作用域写入 store；项目资产优先二进制落盘，避免先构造 Base64。
 */
import { t, useT } from '../i18n';
import Select from './shared/Select';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, generateId } from '../store/useAppStore';
import { isEligibleCharacterReferenceNode, isEligibleCharacterVoiceNode } from '../store/store.dramaAssets';
import { normalizeAssetKey } from '../services/dramaAssetExtract';
import { clamp } from '../utils/num';
import { canonicalXiaohongshuReferenceUrl } from '../utils/xiaohongshuReferenceUrl';
import {
  assertMediaDataUrlSize,
  assertMediaDataUrlWithinLimit,
  inferMediaDataUrlKind,
  saveBinaryToProjectData,
} from '../services/fileService';
import { isTauriEnv } from '../services/fs/core';
import type {
  CharacterActionCategory,
  CharacterCropRect,
  CharacterReferenceImage,
  CharacterReferenceKind,
  CharacterVoiceClip,
  CharacterVoiceKind,
  DramaCharacter,
} from '../types/dramaAssets';
import VolcengineAssetPickerDialog, { type VolcengineAssetSelection } from './volcengine/VolcengineAssetPickerDialog';
import ModalOverlay from './shared/ModalOverlay';
import LazyLoadBoundary, { LazyLoadFallback } from './shared/LazyLoadBoundary';
import PopupCloseButton from './shared/PopupCloseButton';
import MentionEditor from './nodes/shared/MentionEditor';
import {
  avatarCropBase,
  CHARACTER_REFERENCE_KIND_LABELS,
  CHARACTER_VOICE_KIND_LABELS,
  cropImageStyle,
  formatVoiceDuration,
  voiceClipTitle,
} from './character/characterReferencePresentation';
import { readAudioDuration, readAudioFile } from './character/characterVoiceMedia';
import { actionMediaFromCanvasNode } from './character/characterActionMedia';
import ComfyRefmodPicker from './assets/ComfyRefmodPicker';
import { comfyRefmodKey, normalizeCharacterRefmods } from '../utils/comfyRefmod';
import type { ComfyRefmodSelection } from '../types/comfyRefmod';
import { comfyServerName } from '../services/comfyServers';
import { acquireComfyMediaSource } from '../services/comfyMediaSource';
import ViewportImage from './shared/ViewportImage';
import ViewportVideo from './shared/ViewportVideo';
import ViewportAudio from './shared/ViewportAudio';
import type { CharacterVisualCandidate, CharacterVisualReference, CharacterVisualTarget } from '../services/characterVisualWorkbenchService';

const CharacterVisualWorkbench = lazy(() => import('./character/CharacterVisualWorkbench'));

type CharacterLibraryScope = 'project' | 'global';

const REFERENCE_KINDS = Object.entries(CHARACTER_REFERENCE_KIND_LABELS) as Array<[
  CharacterReferenceKind,
  string,
]>;

const VOICE_KINDS = Object.entries(CHARACTER_VOICE_KIND_LABELS) as Array<[
  CharacterVoiceKind,
  string,
]>;

const MAX_CHARACTER_REFERENCE_IMAGES = 16;
const MAX_CHARACTER_VOICE_CLIPS = 16;

const ACTION_CATEGORIES: Array<[CharacterActionCategory, string]> = [
  ['standing', '站立'],
  ['walking', '行走'],
  ['running', '奔跑'],
  ['jumping', '跳跃'],
  ['sitting', '坐姿'],
  ['crouching', '蹲伏'],
  ['lying', '躺卧'],
  ['climbing', '攀爬'],
  ['swimming', '游泳'],
  ['attacking', '攻击'],
  ['defending', '防御'],
  ['hit', '受击'],
  ['death', '死亡'],
  ['casting', '施法'],
  ['interacting', '互动'],
  ['dancing', '舞蹈'],
  ['expression', '表情动作'],
  ['custom', '自定义'],
];

function createEmptyCharacter(): DramaCharacter {
  const now = Date.now();
  return {
    id: `character-${generateId()}`,
    kind: 'character',
    name: '',
    key: '',
    identity: '',
    summary: '',
    visualNotes: '',
    importance: 'supporting',
    confirmed: true,
    createdAt: now,
    updatedAt: now,
    source: 'manual',
    referenceImages: [],
    voiceClips: [],
  };
}

function cloneCharacter(character: DramaCharacter): DramaCharacter {
  return {
    ...character,
    relationships: character.relationships?.map((relationship) => ({ ...relationship })),
    referenceImages: character.referenceImages?.map((reference) => ({ ...reference })) ?? [],
    voiceClips: character.voiceClips?.map((clip) => ({ ...clip })) ?? [],
    avatarCrop: character.avatarCrop ? { ...character.avatarCrop } : undefined,
    refmods: normalizeCharacterRefmods(character.refmods),
  };
}

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error(t('图片读取失败')));
    reader.onerror = () => reject(reader.error ?? new Error(t('图片读取失败')));
    reader.readAsDataURL(file);
  });
}

function AvatarCropEditor({
  reference,
  crop,
  onChange,
}: {
  reference: CharacterReferenceImage;
  crop?: CharacterCropRect;
  onChange: (crop: CharacterCropRect) => void;
}) {
  useT();
  const [ratio, setRatio] = useState(1);
  const [zoom, setZoom] = useState(1.35);
  const [focusX, setFocusX] = useState(0.5);
  const [focusY, setFocusY] = useState(0.38);
  const initializedFor = useRef<string | null>(null);

  const makeCrop = (nextZoom: number, nextX: number, nextY: number, imageRatio = ratio) => {
    const { baseWidth, baseHeight } = avatarCropBase(imageRatio);
    const width = clamp(baseWidth / nextZoom, 0.04, 1);
    const height = clamp(baseHeight / nextZoom, 0.04, 1);
    return {
      x: clamp(nextX * (1 - width), 0, 1 - width),
      y: clamp(nextY * (1 - height), 0, 1 - height),
      width,
      height,
    };
  };

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const nextRatio = image.naturalWidth / Math.max(1, image.naturalHeight);
    setRatio(nextRatio);
    if (initializedFor.current === reference.id) return;
    initializedFor.current = reference.id;

    if (crop) {
      const { baseWidth, baseHeight } = avatarCropBase(nextRatio);
      setZoom(clamp(Math.min(baseWidth / crop.width, baseHeight / crop.height), 1, 3));
      setFocusX(crop.width >= 1 ? 0.5 : crop.x / (1 - crop.width));
      setFocusY(crop.height >= 1 ? 0.5 : crop.y / (1 - crop.height));
      return;
    }
    onChange(makeCrop(1.35, 0.5, 0.38, nextRatio));
  };

  const changeCrop = (nextZoom = zoom, nextX = focusX, nextY = focusY) => {
    setZoom(nextZoom);
    setFocusX(nextX);
    setFocusY(nextY);
    onChange(makeCrop(nextZoom, nextX, nextY));
  };

  return (
    <div className="character-crop-editor">
      <div className="character-crop-preview" aria-label={t('头像裁切预览')}>
        {reference.imageUrl ? (
          <ViewportImage
            src={reference.imageUrl}
            eager
            alt=""
            draggable={false}
            onLoad={handleImageLoad}
            style={cropImageStyle(crop)}
          />
        ) : null}
        <span className="character-crop-frame" aria-hidden="true" />
      </div>
      <div className="character-crop-controls">
        <label>
          <span>{t('水平')}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={focusX}
            onChange={(event) => changeCrop(zoom, Number(event.target.value), focusY)}
          />
        </label>
        <label>
          <span>{t('垂直')}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={focusY}
            onChange={(event) => changeCrop(zoom, focusX, Number(event.target.value))}
          />
        </label>
        <label>
          <span>{t('缩放')}</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(event) => changeCrop(Number(event.target.value), focusX, focusY)}
          />
        </label>
      </div>
    </div>
  );
}

interface CharacterAssetEditorDialogProps {
  isOpen: boolean;
  scope: CharacterLibraryScope;
  character: DramaCharacter | null;
  initialReferenceId?: string | null;
  onClose: () => void;
  onSaved: (characterId: string) => void;
}

interface CharacterNodeCaptureDialogProps {
  isOpen: boolean;
  sourceNodeId: string;
  /** 从角色库发起时预选当前角色，右键菜单发起时不传 */
  initialScope?: CharacterLibraryScope;
  initialCharacterId?: string;
  onClose: () => void;
}

type CharacterAssetDialogProps = CharacterAssetEditorDialogProps | CharacterNodeCaptureDialogProps;

function CharacterNodeCaptureDialog({
  isOpen,
  sourceNodeId,
  initialScope,
  initialCharacterId,
  onClose,
}: CharacterNodeCaptureDialogProps) {
  useT();
  const {
    sourceNode,
    projectCharacters,
    globalCharacters,
    loadGlobalCharacters,
    captureImageNodeToCharacter,
    bindAudioNodeToCharacterVoice,
    addCharacterAction,
    addCharacterActionMedia,
    showToast,
  } = useAppStore(
    useShallow((state) => ({
      sourceNode: state.nodes.find((node) => node.id === sourceNodeId),
      projectCharacters: state.dramaAssets.characters,
      globalCharacters: state.globalCharacters,
      loadGlobalCharacters: state.loadGlobalCharacters,
      captureImageNodeToCharacter: state.captureImageNodeToCharacter,
      bindAudioNodeToCharacterVoice: state.bindAudioNodeToCharacterVoice,
      addCharacterAction: state.addCharacterAction,
      addCharacterActionMedia: state.addCharacterActionMedia,
      showToast: state.showToast,
    })),
  );
  const imageUrl = isEligibleCharacterReferenceNode(sourceNode)
    ? sourceNode?.data.imageUrl ?? sourceNode?.data.thumbnailUrl
    : undefined;
  const actionMedia = useMemo(() => actionMediaFromCanvasNode(sourceNode), [sourceNode]);
  const audioUrl = isEligibleCharacterVoiceNode(sourceNode) ? sourceNode?.data.audioUrl : undefined;
  const [voiceKind, setVoiceKind] = useState<CharacterVoiceKind>('timbre');
  const [voiceLabel, setVoiceLabel] = useState(sourceNode?.data.label ?? '');
  const [voiceTranscript, setVoiceTranscript] = useState(sourceNode?.data.prompt ?? '');
  const [makePrimaryVoice, setMakePrimaryVoice] = useState(false);
  const [voiceDuration, setVoiceDuration] = useState<number>();
  const [captureTab, setCaptureTab] = useState<'reference' | 'action' | 'voice'>(
    audioUrl ? 'voice' : imageUrl ? 'reference' : actionMedia ? 'action' : 'reference',
  );
  const [scope, setScope] = useState<CharacterLibraryScope>(initialScope ?? 'project');
  const [targetMode, setTargetMode] = useState<'existing' | 'new'>(
    initialCharacterId ? 'existing' : 'new',
  );
  const [selectedCharacterId, setSelectedCharacterId] = useState(
    initialCharacterId
      ?? (initialScope === 'global' ? globalCharacters[0]?.id : projectCharacters[0]?.id)
      ?? '',
  );
  const [name, setName] = useState(sourceNode?.data.label || '');
  const [identity, setIdentity] = useState('');
  const [summary, setSummary] = useState('');
  const [kind, setKind] = useState<CharacterReferenceKind>('primary');
  const [prompt, setPrompt] = useState(sourceNode?.data.prompt ?? '');
  const [hideNode, setHideNode] = useState(true);
  const [actionAttachMode, setActionAttachMode] = useState<'new' | 'existing'>('new');
  const [selectedActionId, setSelectedActionId] = useState('');
  const [actionCategory, setActionCategory] = useState<CharacterActionCategory>('standing');
  const [customActionCategory, setCustomActionCategory] = useState('');
  const [actionName, setActionName] = useState(sourceNode?.data.label || '');
  const [actionPrompt, setActionPrompt] = useState(sourceNode?.data.prompt ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (scope === 'global') void loadGlobalCharacters();
  }, [loadGlobalCharacters, scope]);

  const characters = scope === 'project' ? projectCharacters : globalCharacters;
  const effectiveCharacterId = characters.some((character) => character.id === selectedCharacterId)
    ? selectedCharacterId
    : characters[0]?.id ?? '';
  const selectedCharacter = characters.find((character) => character.id === effectiveCharacterId);
  const actions = selectedCharacter?.actions ?? [];
  const effectiveActionId = actions.some((action) => action.id === selectedActionId)
    ? selectedActionId
    : actions[0]?.id ?? '';

  const switchScope = (nextScope: CharacterLibraryScope) => {
    const nextCharacters = nextScope === 'project' ? projectCharacters : globalCharacters;
    setScope(nextScope);
    setSelectedCharacterId(nextCharacters[0]?.id ?? '');
    setSelectedActionId('');
    if (captureTab === 'reference') {
      setTargetMode((currentMode) => (
        currentMode === 'existing' && nextCharacters.length === 0 ? 'new' : currentMode
      ));
    }
  };

  const switchCaptureTab = (tab: 'reference' | 'action' | 'voice') => {
    setCaptureTab(tab);
    if (tab === 'action') setTargetMode('existing');
  };

  const handleCapture = async () => {
    if (!sourceNode) {
      showToast(t('无法读取来源节点'), 'error');
      return;
    }

    if (captureTab === 'voice') {
      if (!audioUrl || !effectiveCharacterId) {
        showToast(!audioUrl ? t('该节点没有可用的音频') : t('请选择要添加到的角色'), 'error');
        return;
      }
      setSaving(true);
      try {
        const clipId = await bindAudioNodeToCharacterVoice({
          nodeId: sourceNodeId, scope, characterId: effectiveCharacterId,
          kind: voiceKind, label: voiceLabel, transcript: voiceTranscript,
          makePrimary: makePrimaryVoice, durationSec: voiceDuration, hideNode,
        });
        if (!clipId) return;
        showToast(t('已添加到角色声音库'));
        onClose();
      } catch {
        showToast(t('添加声音失败，请重试'), 'error');
      } finally {
        setSaving(false);
      }
      return;
    }

    if (captureTab === 'action') {
      if (!actionMedia) {
        showToast(t('该节点没有可用的图片、GIF 或视频'), 'error');
        return;
      }
      if (!effectiveCharacterId || !selectedCharacter) {
        showToast(t('请选择要添加到的角色'), 'error');
        return;
      }

      setSaving(true);
      let saved: boolean;
      if (actionAttachMode === 'existing') {
        if (!effectiveActionId) {
          setSaving(false);
          showToast(t('请选择已有动作'), 'error');
          return;
        }
        const action = actions.find((item) => item.id === effectiveActionId);
        const duplicated = action?.media?.some((item) => (
          Boolean(actionMedia.assetId && item.assetId === actionMedia.assetId)
          || Boolean(actionMedia.filePath && item.filePath === actionMedia.filePath)
          || item.url === actionMedia.url
        ));
        if (duplicated) {
          setSaving(false);
          showToast(t('该节点已经添加到这个动作'));
          return;
        }
        saved = await addCharacterActionMedia(
          scope,
          effectiveCharacterId,
          effectiveActionId,
          [actionMedia],
          { nodeId: sourceNodeId, hideNode },
        );
      } else {
        const normalizedActionName = actionName.trim();
        if (!normalizedActionName) {
          setSaving(false);
          showToast(t('请填写动作名称'), 'error');
          return;
        }
        if (actionCategory === 'custom' && !customActionCategory.trim()) {
          setSaving(false);
          showToast(t('请填写自定义分类名'), 'error');
          return;
        }
        saved = Boolean(await addCharacterAction(scope, effectiveCharacterId, {
          category: actionCategory,
          customCategory: actionCategory === 'custom' ? customActionCategory.trim() : undefined,
          name: normalizedActionName,
          prompt: actionPrompt.trim(),
          media: [actionMedia],
        }, { nodeId: sourceNodeId, hideNode }));
      }
      setSaving(false);
      if (!saved) return;
      showToast(t('已添加到「{name}」的动作库', { name: selectedCharacter.name }));
      onClose();
      return;
    }

    if (!imageUrl) {
      showToast(t('该节点没有可用的角色图片'), 'error');
      return;
    }

    let newCharacter: DramaCharacter | undefined;
    if (targetMode === 'new') {
      const normalizedName = name.trim();
      if (!normalizedName) {
        showToast(t('请填写角色名称'), 'error');
        return;
      }
      newCharacter = {
        ...createEmptyCharacter(),
        name: normalizedName,
        key: normalizeAssetKey(normalizedName),
        identity: identity.trim(),
        summary: summary.trim(),
      };
    } else if (!effectiveCharacterId) {
      showToast(t('请选择角色'), 'error');
      return;
    }

    setSaving(true);
    const result = await captureImageNodeToCharacter({
      nodeId: sourceNodeId,
      scope,
      characterId: targetMode === 'existing' ? effectiveCharacterId : undefined,
      newCharacter,
      kind,
      prompt: prompt.trim(),
      hideNode,
    });
    setSaving(false);
    if (!result) return;
    showToast(hideNode ? t('已添加到角色库，画布节点已隐藏') : t('已添加到角色库'));
    onClose();
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel={t('添加到角色库')}
      className="character-capture-dialog ui-dialog-surface"
    >
      <header className="character-dialog-header">
        <div>
          <h2>{t('添加到角色库')}</h2>
          <p>{sourceNode?.data.label || t('画布节点')}</p>
        </div>
        <PopupCloseButton onClick={onClose} />
      </header>

      <div className="flex gap-1 border-b border-canvas-border px-4 py-2" role="tablist" aria-label={t('添加类型')}>
        <button
          type="button"
          role="tab"
          aria-selected={captureTab === 'reference'}
          disabled={!imageUrl}
          className={`flex min-h-8 items-center gap-1.5 rounded-md px-3 text-[11px] transition-[color,background-color,transform] duration-150 ease-out active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40 ${captureTab === 'reference' ? 'bg-canvas-hover text-canvas-text' : 'text-canvas-text-muted hover:text-canvas-text'}`}
          onClick={() => switchCaptureTab('reference')}
        >
          <Icon icon="lucide:image" width="14" height="14" aria-hidden="true" />
          {t('形象参考')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={captureTab === 'action'}
          disabled={!actionMedia}
          className={`flex min-h-8 items-center gap-1.5 rounded-md px-3 text-[11px] transition-[color,background-color,transform] duration-150 ease-out active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40 ${captureTab === 'action' ? 'bg-canvas-hover text-canvas-text' : 'text-canvas-text-muted hover:text-canvas-text'}`}
          onClick={() => switchCaptureTab('action')}
        >
          <Icon icon="lucide:film" width="14" height="14" aria-hidden="true" />
          {t('动作素材')}
        </button>
        {audioUrl ? (
          <button type="button" role="tab" aria-selected={captureTab === 'voice'}
            className={`ui-btn ui-btn--sm ${captureTab === 'voice' ? 'is-active' : ''}`}
            onClick={() => switchCaptureTab('voice')}>
            <Icon icon="lucide:audio-lines" width="14" height="14" aria-hidden="true" />
            {t('声音素材')}
          </button>
        ) : null}
      </div>

      <div className="character-capture-body">
        <section
          className="character-capture-preview"
          aria-label={captureTab === 'voice' ? t('待添加声音') : captureTab === 'reference' ? t('待添加图片') : t('待添加动作素材')}
        >
          <div className="grid min-h-80 w-full place-items-center overflow-hidden rounded-lg border border-canvas-border bg-canvas-bg/70 p-1 max-[920px]:mx-auto max-[920px]:max-w-[360px]">
            {captureTab === 'voice' && audioUrl ? (
              <div className="flex w-full min-w-0 flex-col items-center gap-4 p-3">
                <Icon icon="lucide:audio-lines" width="48" height="48" className="text-canvas-text-secondary" aria-hidden="true" />
                <ViewportAudio key={audioUrl} src={audioUrl} eager controls preload="metadata" className="w-full"
                  onLoadedMetadata={(event) => {
                    const duration = event.currentTarget.duration;
                    setVoiceDuration(Number.isFinite(duration) && duration > 0 ? duration : undefined);
                  }} />
              </div>
            ) : captureTab === 'action' && actionMedia?.kind === 'video' ? (
              <ViewportVideo
                src={actionMedia.url}
                eager
                className="max-h-[min(62vh,720px)] max-w-full object-contain"
                controls
                muted
                playsInline
                preload="metadata"
              />
            ) : captureTab === 'action' && actionMedia?.url ? (
              <ViewportImage
                src={actionMedia.url}
                eager
                alt=""
                className="block max-h-[min(62vh,720px)] max-w-full object-contain"
                draggable={false}
              />
            ) : imageUrl ? (
              <ViewportImage
                src={imageUrl}
                eager
                alt=""
                className="block max-h-[min(62vh,720px)] max-w-full object-contain"
                draggable={false}
              />
            ) : (
              <Icon icon="lucide:file-x" width="28" height="28" aria-hidden="true" />
            )}
          </div>
          <div>
            <span>{t('来源节点')}</span>
            <strong>{sourceNode?.data.label || t('画布节点')}</strong>
          </div>
        </section>

        <section
          className="character-capture-options"
          aria-label={captureTab === 'voice' ? t('角色与声音信息') : captureTab === 'reference' ? t('角色与参考图信息') : t('角色与动作信息')}
        >
          <div className="character-capture-group">
            <span className="character-capture-label">{t('保存范围')}</span>
            <div className="character-capture-segmented" role="tablist" aria-label={t('保存范围')}>
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'project'}
                className={scope === 'project' ? 'is-active' : ''}
                onClick={() => switchScope('project')}
              >
                {t('本项目')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'global'}
                className={scope === 'global' ? 'is-active' : ''}
                onClick={() => switchScope('global')}
              >
                {t('全局资产')}
              </button>
            </div>
          </div>

          {captureTab === 'voice' ? (
            <>
              <label className="character-field character-field-wide">
                <span>{t('添加到角色')}</span>
                <Select fixedMenu autoFocus value={effectiveCharacterId} disabled={!characters.length || saving}
                  onChange={(selectedOptionValue) => setSelectedCharacterId(selectedOptionValue)}>
                  {!characters.length ? <option value="">{t('当前范围暂无角色，请先在角色库新建')}</option> : null}
                  {characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
                </Select>
              </label>
              <label className="character-field character-field-wide">
                <span>{t('声音名称')}</span>
                <input value={voiceLabel} onChange={(event) => setVoiceLabel(event.target.value)} />
              </label>
              <label className="character-field">
                <span>{t('声音用途')}</span>
                <Select fixedMenu value={voiceKind} onChange={(selectedOptionValue) => setVoiceKind(selectedOptionValue as CharacterVoiceKind)}>
                  {VOICE_KINDS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
                </Select>
              </label>
              <label className="character-field character-field-wide">
                <span>{t('台词文本')}</span>
                <textarea value={voiceTranscript} rows={3} onChange={(event) => setVoiceTranscript(event.target.value)} />
              </label>
              <label className="character-capture-hide-option">
                <input type="checkbox" checked={makePrimaryVoice} onChange={(event) => setMakePrimaryVoice(event.target.checked)} />
                <span>{t('设为角色主音色')}</span>
              </label>
            </>
          ) : captureTab === 'reference' ? (
            <>
          <div className="character-capture-group">
            <span className="character-capture-label">{t('添加方式')}</span>
            <div className="character-capture-segmented" role="tablist" aria-label={t('添加方式')}>
              <button
                type="button"
                role="tab"
                aria-selected={targetMode === 'new'}
                className={targetMode === 'new' ? 'is-active' : ''}
                onClick={() => setTargetMode('new')}
              >
                {t('新建角色')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={targetMode === 'existing'}
                className={targetMode === 'existing' ? 'is-active' : ''}
                disabled={characters.length === 0}
                onClick={() => setTargetMode('existing')}
              >
                {t('已有角色')}
              </button>
            </div>
          </div>

          {targetMode === 'existing' ? (
            <label className="character-field character-field-wide">
              <span>{t('添加到角色')}</span>
              <Select fixedMenu
                autoFocus
                value={effectiveCharacterId}
                onChange={(selectedOptionValue) => setSelectedCharacterId(selectedOptionValue)}
              >
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>{character.name}</option>
                ))}
              </Select>
            </label>
          ) : (
            <div className="character-capture-new-fields">
              <label className="character-field character-field-wide">
                <span>{t('角色名称')}</span>
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('例如：沈砚')}
                />
              </label>
              <label className="character-field">
                <span>{t('身份')}</span>
                <input
                  value={identity}
                  onChange={(event) => setIdentity(event.target.value)}
                  placeholder={t('职业或身份')}
                />
              </label>
              <label className="character-field character-field-wide">
                <span>{t('简介')}</span>
                <textarea
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  rows={2}
                  placeholder={t('角色背景与核心特征')}
                />
              </label>
            </div>
          )}

          <div className="character-capture-reference-fields">
            <label className="character-field">
              <span>{t('图片用途')}</span>
              <Select fixedMenu
                value={kind}
                onChange={(selectedOptionValue) => setKind(selectedOptionValue as CharacterReferenceKind)}
              >
                {REFERENCE_KINDS.map(([value, label]) => (
                  <option key={value} value={value}>{t(label)}</option>
                ))}
              </Select>
            </label>
            <div className="character-field character-field-wide">
              <span>{t('图片提示词')}</span>
              <div className="ui-textarea focus-within:border-[var(--border-focus)] focus-within:ring-2 focus-within:ring-[var(--brand-alpha-12)]" role="group" aria-label={t('图片提示词')}>
                <MentionEditor
                  nodeId={sourceNodeId}
                  value={prompt}
                  onChange={setPrompt}
                  canSubmit={false}
                  submitShortcut="ctrl-enter"
                  placeholder={t('记录生成该形象时使用的提示词，@ 可引用节点或资产')}
                  className="[&_.prompt-editor]:min-h-20 [&_.prompt-editor]:max-h-48 [&_.prompt-editor]:text-sm [&_.mention-dropdown]:static [&_.mention-dropdown]:mt-2 [&_.mention-dropdown]:w-full [&_.mention-dropdown]:max-w-full"
                />
              </div>
            </div>
          </div>
            </>
          ) : (
            <>
              <label className="character-field character-field-wide">
                <span>{t('添加到角色')}</span>
                <Select fixedMenu
                  autoFocus
                  value={effectiveCharacterId}
                  disabled={characters.length === 0}
                  onChange={(selectedOptionValue) => {
                    setSelectedCharacterId(selectedOptionValue);
                    setSelectedActionId('');
                  }}
                >
                  {characters.length === 0 ? <option value="">{t('当前范围暂无角色')}</option> : null}
                  {characters.map((character) => (
                    <option key={character.id} value={character.id}>{character.name}</option>
                  ))}
                </Select>
              </label>

              <div className="character-capture-group">
                <span className="character-capture-label">{t('动作方式')}</span>
                <div className="character-capture-segmented" role="tablist" aria-label={t('动作添加方式')}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={actionAttachMode === 'new'}
                    className={actionAttachMode === 'new' ? 'is-active' : ''}
                    onClick={() => setActionAttachMode('new')}
                  >
                    {t('新建动作')}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={actionAttachMode === 'existing'}
                    className={actionAttachMode === 'existing' ? 'is-active' : ''}
                    disabled={actions.length === 0}
                    onClick={() => setActionAttachMode('existing')}
                  >
                    {t('追加到已有动作')}
                  </button>
                </div>
              </div>

              {actionAttachMode === 'existing' ? (
                <label className="character-field character-field-wide">
                  <span>{t('已有动作')}</span>
                  <Select fixedMenu
                    value={effectiveActionId}
                    onChange={(selectedOptionValue) => setSelectedActionId(selectedOptionValue)}
                  >
                    {actions.map((action) => (
                      <option key={action.id} value={action.id}>{action.name}</option>
                    ))}
                  </Select>
                </label>
              ) : (
                <div className="character-capture-reference-fields">
                  <label className="character-field">
                    <span>{t('动作类别')}</span>
                    <Select fixedMenu
                      value={actionCategory}
                      onChange={(selectedOptionValue) => setActionCategory(selectedOptionValue as CharacterActionCategory)}
                    >
                      {ACTION_CATEGORIES.map(([value, label]) => (
                        <option key={value} value={value}>{t(label)}</option>
                      ))}
                    </Select>
                  </label>
                  {actionCategory === 'custom' ? (
                    <label className="character-field">
                      <span>{t('自定义分类名')}</span>
                      <input
                        value={customActionCategory}
                        onChange={(event) => setCustomActionCategory(event.target.value)}
                        placeholder={t('例如：武术、特殊技能')}
                      />
                    </label>
                  ) : null}
                  <label className="character-field character-field-wide">
                    <span>{t('动作名称')}</span>
                    <input
                      value={actionName}
                      onChange={(event) => setActionName(event.target.value)}
                      placeholder={t('例如：待机呼吸、冲刺')}
                    />
                  </label>
                  <label className="character-field character-field-wide">
                    <span>{t('动作提示词')}</span>
                    <textarea
                      value={actionPrompt}
                      onChange={(event) => setActionPrompt(event.target.value)}
                      rows={3}
                      placeholder={t('记录姿态、节奏和镜头表现')}
                    />
                  </label>
                </div>
              )}

              <div className="flex min-h-10 items-center gap-2 rounded-lg border border-canvas-border bg-canvas-surface px-3 text-[10px] leading-4 text-canvas-text-muted">
                <Icon icon="lucide:link-2" width="14" height="14" className="shrink-0" aria-hidden="true" />
                {t('动作素材会绑定到所选角色，可在动作库中切换画布节点的显示与隐藏。')}
              </div>
            </>
          )}
          <label className="character-capture-hide-option">
            <input
              type="checkbox"
              checked={hideNode}
              onChange={(event) => setHideNode(event.target.checked)}
            />
            <span>{t('添加后隐藏画布节点')}</span>
          </label>
        </section>
      </div>

      <footer className="character-dialog-footer">
        <button type="button" className="character-button-secondary" onClick={onClose}>{t('取消')}</button>
        <button
          type="button"
          className="character-button-primary"
          disabled={saving
            || !sourceNode
            || (captureTab === 'voice' && (!audioUrl || !effectiveCharacterId))
            || (captureTab === 'reference' && (!imageUrl
              || (targetMode === 'existing' ? !effectiveCharacterId : !name.trim())))
            || (captureTab === 'action' && (!actionMedia
              || !effectiveCharacterId
              || (actionAttachMode === 'existing'
                ? !effectiveActionId
                : (!actionName.trim()
                  || (actionCategory === 'custom' && !customActionCategory.trim())))))}
          onClick={() => void handleCapture()}
        >
          <Icon
            icon={captureTab === 'voice' ? 'lucide:audio-lines' : captureTab === 'action' ? 'lucide:film' : 'lucide:contact-round'}
            width="15"
            height="15"
            aria-hidden="true"
          />
          {saving ? t('添加中…') : captureTab === 'voice' ? t('添加到声音库') : captureTab === 'action' ? t('添加到动作库') : t('添加到角色库')}
        </button>
      </footer>
    </ModalOverlay>
  );
}

function CharacterAssetEditorDialog({
  isOpen,
  scope,
  character,
  initialReferenceId,
  onClose: closeEditor,
  onSaved,
}: CharacterAssetEditorDialogProps) {
  useT();
  const { saveCharacterCard, showToast, currentProjectId } = useAppStore(
    useShallow((state) => ({
      saveCharacterCard: state.saveCharacterCard,
      showToast: state.showToast,
      currentProjectId: state.currentProjectId,
    })),
  );
  const initialDraft = useMemo(
    () => character ? cloneCharacter(character) : createEmptyCharacter(),
    [character],
  );
  const [draft, setDraft] = useState<DramaCharacter>(initialDraft);
  const [editorProjectId] = useState(currentProjectId);
  const [visualWorkbenchOpen, setVisualWorkbenchOpen] = useState(false);
  const [visualWorkbenchUsed, setVisualWorkbenchUsed] = useState(false);
  const editorActive = useRef(true);
  const [originalUpdatedAt] = useState(character?.updatedAt);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string | null>(
    initialReferenceId
    ?? initialDraft.primaryReferenceImageId
    ?? initialDraft.referenceImages?.[0]?.id
    ?? null,
  );
  const [selectedVoiceClipId, setSelectedVoiceClipId] = useState<string | null>(
    initialDraft.primaryVoiceClipId ?? initialDraft.voiceClips?.[0]?.id ?? null,
  );
  const [playingVoiceClipId, setPlayingVoiceClipId] = useState<string | null>(null);
  const [volcenginePickerMode, setVolcenginePickerMode] = useState<'image' | null>(null);
  const [refmodPickerOpen, setRefmodPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importingMedia, setImportingMedia] = useState(false);
  const mediaImportActive = useRef(false);
  const canGenerateVisual = isTauriEnv();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceInputRef = useRef<HTMLInputElement>(null);
  const voicePlayerRef = useRef<HTMLAudioElement>(null);
  const voicePlaybackRef = useRef<{
    clipId: string;
    player: HTMLAudioElement;
    controller: AbortController;
    release?: () => void;
  } | null>(null);
  const stopVoicePlayback = useCallback(() => {
    const playback = voicePlaybackRef.current;
    voicePlaybackRef.current = null;
    const player = playback?.player ?? voicePlayerRef.current;
    player?.pause();
    player?.removeAttribute('src');
    player?.load();
    playback?.controller.abort();
    playback?.release?.();
  }, []);
  useEffect(() => stopVoicePlayback, [isOpen, selectedVoiceClipId, stopVoicePlayback]);

  const saveController = useRef<AbortController | null>(null);
  useEffect(() => {
    editorActive.current = true;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (editorActive.current && scope === 'project'
        && (state.currentProjectId !== editorProjectId || state.projectLoadStatus !== 'ready' || state.switchingProjectName != null)) {
        editorActive.current = false;
        setVisualWorkbenchOpen(false);
      }
    });
    return () => {
      editorActive.current = false;
      unsubscribe();
      saveController.current?.abort();
    };
  }, [editorProjectId, scope]);
  const onClose = () => {
    if (saveController.current) return;
    editorActive.current = false;
    setVisualWorkbenchOpen(false);
    stopVoicePlayback();
    closeEditor();
  };

  const selectedReference = useMemo(
    () => draft.referenceImages?.find((reference) => reference.id === selectedReferenceId) ?? null,
    [draft.referenceImages, selectedReferenceId],
  );
  const selectedVoiceClip = useMemo(
    () => draft.voiceClips?.find((clip) => clip.id === selectedVoiceClipId) ?? null,
    [draft.voiceClips, selectedVoiceClipId],
  );

  const patchDraft = (patch: Partial<DramaCharacter>) => {
    setDraft((current) => ({ ...current, ...patch, updatedAt: Date.now() }));
  };

  const assertEditorCurrent = () => {
    const state = useAppStore.getState();
    const characters = scope === 'project' ? state.dramaAssets.characters : state.globalCharacters;
    const live = characters.find((item) => item.id === draft.id);
    const switchedProject = scope === 'project' && (state.currentProjectId !== editorProjectId
      || state.projectLoadStatus !== 'ready' || state.switchingProjectName != null);
    if (!editorActive.current || !isOpen || switchedProject || character && character.id !== draft.id
      || (character ? !live || live.updatedAt !== originalUpdatedAt : Boolean(live))) {
      throw new Error(t('角色已变化，请重新打开编辑器'));
    }
  };

  const appendVisualReference = (reference: CharacterReferenceImage, makePrimary: boolean) => {
    assertEditorCurrent();
    const { id } = reference;
    const references = draft.referenceImages ?? [];
    if (!references.some((reference) => reference.id === id) && references.length >= MAX_CHARACTER_REFERENCE_IMAGES) {
      throw new Error(t('每个角色最多保存 {count} 张参考图', { count: MAX_CHARACTER_REFERENCE_IMAGES }));
    }
    setDraft((current) => {
      if (current.id !== draft.id) return current;
      const previous = current.referenceImages ?? [];
      const alreadyAdded = previous.some((item) => item.id === id);
      if (!alreadyAdded && previous.length >= MAX_CHARACTER_REFERENCE_IMAGES) return current;
      return {
        ...current,
        referenceImages: alreadyAdded ? previous : [...previous, reference],
        primaryReferenceImageId: makePrimary || !previous.length ? id : current.primaryReferenceImageId,
        updatedAt: reference.updatedAt,
      };
    });
    setSelectedReferenceId(id);
  };

  const adoptVisualCandidate = async (selection: CharacterVisualCandidate, makePrimary: boolean, signal: AbortSignal) => {
    assertEditorCurrent();
    const { captureCharacterVisualTarget, readCharacterVisualCandidate } = await import('../services/characterVisualWorkbenchService');
    signal.throwIfAborted();
    assertEditorCurrent();
    const candidate = await readCharacterVisualCandidate(captureCharacterVisualTarget(scope, draft.id), selection.id);
    signal.throwIfAborted();
    const now = Date.now();
    appendVisualReference({
      id: `reference-generated-${candidate.id}`,
      kind: candidate.operation === 'turnaround' ? 'turnaround' : makePrimary || !draft.referenceImages?.length ? 'primary' : 'other',
      imageUrl: candidate.url,
      assetId: candidate.assetId,
      relativePath: candidate.relativePath,
      filePath: candidate.filePath,
      prompt: candidate.prompt,
      createdAt: now,
      updatedAt: now,
    }, makePrimary);
    setVisualWorkbenchOpen(false);
  };

  const keepVisualReference = (reference: CharacterVisualReference) => {
    const sourceUrl = canonicalXiaohongshuReferenceUrl(reference.sourceUrl);
    if (!sourceUrl || !/^xhs-[a-f0-9]{64}$/.test(reference.id)) throw new Error(t('参考图片地址不可用'));
    assertMediaDataUrlWithinLimit(reference.url, 'image', t('参考图'));
    const now = Date.now();
    appendVisualReference({ id: reference.id, kind: draft.referenceImages?.length ? 'other' : 'primary',
      imageUrl: reference.url, sourceUrl, prompt: '', createdAt: now, updatedAt: now }, false);
  };

  const resumeVisualDraft = (target: CharacterVisualTarget, name: string) => {
    assertEditorCurrent();
    const state = useAppStore.getState();
    const characters = scope === 'project' ? state.dramaAssets.characters : state.globalCharacters;
    if (character || target.scope !== scope || scope === 'project' && target.projectId !== editorProjectId
      || characters.some((item) => item.id === target.characterId)) {
      throw new Error(t('角色已变化，请重新打开编辑器'));
    }
    patchDraft({ id: target.characterId, name: draft.name.trim() ? draft.name : name });
  };

  const applyRefmods = (items: ComfyRefmodSelection[]) => {
    patchDraft({ refmods: normalizeCharacterRefmods([...(draft.refmods ?? []), ...items]) });
    setRefmodPickerOpen(false);
  };

  const applyVolcengineAsset = (items: VolcengineAssetSelection[]) => {
    const selectedItems = items.slice(0, 1).map((item) => item.asset);
    if (selectedItems.length === 0) return;
    const current = draft.volcengineBinding;
    const projectName = current?.projectName || 'default';
    patchDraft({ volcengineBinding: {
      ...current,
      projectName,
      imageAssetId: selectedItems[0].id,
      imageAssetName: selectedItems[0].name,
      imageAssetStatus: selectedItems[0].status,
    } });
    setVolcenginePickerMode(null);
  };

  const patchReference = (patch: Partial<CharacterReferenceImage>) => {
    if (!selectedReferenceId) return;
    setDraft((current) => ({
      ...current,
      updatedAt: Date.now(),
      referenceImages: (current.referenceImages ?? []).map((reference) =>
        reference.id === selectedReferenceId
          ? { ...reference, ...patch, updatedAt: Date.now() }
          : reference,
      ),
    }));
  };

  /**
   * 上传的角色媒体与画布节点一样落到项目 data 目录，只保留本地路径；
   * 全局角色先留内存 data URL，保存时由角色库服务写入全局资产目录。
   */
  const storeUploadToProject = async (
    file: File,
    read: (file: File) => Promise<string>,
  ): Promise<{ url: string; filePath?: string }> => {
    assertEditorCurrent();
    const mediaKind = inferMediaDataUrlKind(file.type || file.name);
    assertMediaDataUrlSize(file.size, mediaKind, file.name);
    if (scope === 'project' && editorProjectId && editorProjectId !== 'default') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      assertEditorCurrent();
      const stored = await saveBinaryToProjectData(bytes, editorProjectId, file.name);
      if (stored?.assetUrl) return { url: stored.assetUrl, filePath: stored.filePath };
    }
    const dataUrl = await read(file);
    assertMediaDataUrlWithinLimit(dataUrl, mediaKind, file.name);
    return { url: dataUrl };
  };

  const importDraftMedia = async (read: () => Promise<void>, failure: string) => {
    if (saveController.current || mediaImportActive.current) return;
    mediaImportActive.current = true;
    setImportingMedia(true);
    try {
      assertEditorCurrent();
      await read();
    } catch {
      if (editorActive.current) showToast(t(failure), 'error');
    } finally {
      mediaImportActive.current = false;
      if (editorActive.current) setImportingMedia(false);
    }
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    const remainingSlots = Math.max(
      0,
      MAX_CHARACTER_REFERENCE_IMAGES - (draft.referenceImages?.length ?? 0),
    );
    const files = selectedFiles.slice(0, remainingSlots);
    const shouldAssignPrimary = !draft.primaryReferenceImageId;
    event.target.value = '';
    if (files.length === 0) {
      if (selectedFiles.length > 0) showToast(t('每个角色最多保存 {count} 张参考图', { count: MAX_CHARACTER_REFERENCE_IMAGES }), 'error');
      return;
    }
    if (selectedFiles.length > files.length) {
      showToast(t('仅添加前 {count} 张：每个角色最多 {max} 张参考图', { count: files.length, max: MAX_CHARACTER_REFERENCE_IMAGES }));
    }
    await importDraftMedia(async () => {
      const now = Date.now();
      const references: CharacterReferenceImage[] = [];
      for (const [index, file] of files.entries()) {
        const stored = await storeUploadToProject(file, readImageFile);
        references.push({
          id: `reference-${generateId()}`,
          kind: shouldAssignPrimary && index === 0 ? 'primary' as const : 'other' as const,
          imageUrl: stored.url,
          filePath: stored.filePath,
          prompt: '',
          createdAt: now + index,
          updatedAt: now + index,
        });
      }
      assertEditorCurrent();
      setDraft((current) => {
        if (current.id !== draft.id) return current;
        const previous = current.referenceImages ?? [];
        const nextReferences = [...previous, ...references.slice(0, MAX_CHARACTER_REFERENCE_IMAGES - previous.length)];
        return {
          ...current,
          referenceImages: nextReferences,
          primaryReferenceImageId: current.primaryReferenceImageId ?? nextReferences[0]?.id,
          updatedAt: Date.now(),
        };
      });
      setSelectedReferenceId(references[0]?.id ?? null);
    }, '图片读取失败');
  };

  const patchVoiceClip = (patch: Partial<CharacterVoiceClip>) => {
    if (!selectedVoiceClipId) return;
    setDraft((current) => ({
      ...current,
      updatedAt: Date.now(),
      voiceClips: (current.voiceClips ?? []).map((clip) =>
        clip.id === selectedVoiceClipId
          ? { ...clip, ...patch, updatedAt: Date.now() }
          : clip,
      ),
    }));
  };

  const handleVoiceFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    const remainingSlots = Math.max(0, MAX_CHARACTER_VOICE_CLIPS - (draft.voiceClips?.length ?? 0));
    const files = selectedFiles.slice(0, remainingSlots);
    event.target.value = '';
    if (files.length === 0) {
      if (selectedFiles.length > 0) showToast(t('每个角色最多保存 {count} 条声音', { count: MAX_CHARACTER_VOICE_CLIPS }), 'error');
      return;
    }
    if (selectedFiles.length > files.length) {
      showToast(t('仅添加前 {count} 条：每个角色最多 {max} 条声音', { count: files.length, max: MAX_CHARACTER_VOICE_CLIPS }));
    }
    await importDraftMedia(async () => {
      const now = Date.now();
      const clips: CharacterVoiceClip[] = [];
      for (const [index, file] of files.entries()) {
        const stored = await storeUploadToProject(file, readAudioFile);
        clips.push({
          id: `voice-${generateId()}`,
          kind: 'timbre',
          label: file.name.replace(/\.[^.]+$/, ''),
          audioUrl: stored.url,
          filePath: stored.filePath,
          transcript: '',
          durationSec: await readAudioDuration(stored.url),
          createdAt: now + index,
          updatedAt: now + index,
        });
      }
      assertEditorCurrent();
      setDraft((current) => {
        if (current.id !== draft.id) return current;
        const previous = current.voiceClips ?? [];
        const next = [...previous, ...clips.slice(0, MAX_CHARACTER_VOICE_CLIPS - previous.length)];
        return { ...current, voiceClips: next, primaryVoiceClipId: current.primaryVoiceClipId ?? next[0]?.id, updatedAt: Date.now() };
      });
      setSelectedVoiceClipId(clips[0]?.id ?? null);
    }, '音频读取失败');
  };

  const toggleVoicePlayback = async (clip: CharacterVoiceClip) => {
    const player = voicePlayerRef.current;
    if (!player || !clip.audioUrl) return;
    if (voicePlaybackRef.current?.clipId === clip.id) {
      stopVoicePlayback();
      setPlayingVoiceClipId(null);
      return;
    }
    stopVoicePlayback();
    setPlayingVoiceClipId(null);
    const playback = { clipId: clip.id, player, controller: new AbortController(), release: undefined as (() => void) | undefined };
    voicePlaybackRef.current = playback;
    try {
      const lease = await acquireComfyMediaSource(clip.audioUrl, playback.controller.signal);
      if (playback.controller.signal.aborted || voicePlaybackRef.current !== playback || voicePlayerRef.current !== player) {
        lease.release();
        return;
      }
      playback.release = lease.release;
      player.src = lease.src;
      await player.play();
      if (voicePlaybackRef.current === playback) setPlayingVoiceClipId(clip.id);
    } catch {
      if (playback.controller.signal.aborted || voicePlaybackRef.current !== playback) return;
      stopVoicePlayback();
      showToast(t('音频播放失败'), 'error');
    }
  };

  const removeSelectedVoiceClip = () => {
    if (!selectedVoiceClipId) return;
    if (voicePlaybackRef.current?.clipId === selectedVoiceClipId) {
      stopVoicePlayback();
      setPlayingVoiceClipId(null);
    }
    const rest = (draft.voiceClips ?? []).filter((clip) => clip.id !== selectedVoiceClipId);
    patchDraft({
      voiceClips: rest,
      primaryVoiceClipId: draft.primaryVoiceClipId === selectedVoiceClipId
        ? rest[0]?.id
        : draft.primaryVoiceClipId,
    });
    setSelectedVoiceClipId(rest[0]?.id ?? null);
  };

  const removeSelectedReference = () => {
    if (!selectedReferenceId) return;
    const rest = (draft.referenceImages ?? []).filter(
      (reference) => reference.id !== selectedReferenceId,
    );
    patchDraft({
      referenceImages: rest,
      primaryReferenceImageId: draft.primaryReferenceImageId === selectedReferenceId
        ? rest[0]?.id
        : draft.primaryReferenceImageId,
      avatarReferenceImageId: draft.avatarReferenceImageId === selectedReferenceId
        ? undefined
        : draft.avatarReferenceImageId,
      avatarCrop: draft.avatarReferenceImageId === selectedReferenceId
        ? undefined
        : draft.avatarCrop,
    });
    setSelectedReferenceId(rest[0]?.id ?? null);
  };

  const handleSave = async () => {
    if (saveController.current || mediaImportActive.current || visualWorkbenchOpen || refmodPickerOpen || volcenginePickerMode) return;
    const name = draft.name.trim();
    if (!name) {
      showToast(t('请填写角色名称'), 'error');
      return;
    }
    try { assertEditorCurrent(); }
    catch (error) {
      showToast(error instanceof Error ? error.message : t('角色保存失败，请重试'), 'error');
      return;
    }
    setSaving(true);
    const controller = new AbortController(); saveController.current = controller;
    const references = draft.referenceImages ?? [];
    const primaryReference = references.find(
      (reference) => reference.id === draft.primaryReferenceImageId,
    ) ?? references[0];
    const payload = {
      ...draft,
      name,
      key: normalizeAssetKey(name),
      referenceImages: references,
      primaryReferenceImageId: primaryReference?.id,
      imageNodeId: primaryReference?.sourceNodeId,
      imageUrl: primaryReference?.imageUrl,
      updatedAt: Date.now(),
    };
    const workbench = !character && visualWorkbenchUsed
      ? await import('../services/characterVisualWorkbenchService').catch(() => null) : null;
    const visualTarget = workbench?.captureCharacterVisualTarget(scope, payload.id);
    let saved: boolean;
    try {
      assertEditorCurrent();
      saved = await saveCharacterCard(scope, payload, {
        signal: controller.signal,
        assertCurrent: assertEditorCurrent,
        awaitProjectSave: scope === 'project',
      });
    } catch {
      saved = false;
      if (!controller.signal.aborted) showToast(t('角色保存失败，请重试'), 'error');
    }
    if (saved && workbench && visualTarget) void workbench.markCharacterVisualDraftSaved(visualTarget).catch(() => undefined);
    if (controller.signal.aborted) return;
    saveController.current = null; setSaving(false);
    if (!saved) return;
    showToast(scope === 'project' ? t('角色已保存到本项目') : t('角色已保存到全局资产'));
    onSaved(payload.id);
    onClose();
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel={character ? t('编辑角色') : t('新建角色')}
      className="character-dialog ui-dialog-surface"
    >
      <header className="character-dialog-header">
        <div>
          <h2>{character ? t('编辑角色') : t('新建角色')}</h2>
          <p>{scope === 'project' ? t('保存到本项目') : t('保存到全局资产')}</p>
        </div>
        <PopupCloseButton disabled={saving} onClick={onClose} />
      </header>

      <div className="character-dialog-body" inert={saving} aria-busy={saving || importingMedia}>
        <section className="character-dialog-fields" aria-label={t('角色资料')}>
          <label className="character-field character-field-wide">
            <span>{t('角色名称')}</span>
            <input
              autoFocus
              value={draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
              placeholder={t('例如：沈砚')}
            />
          </label>
          <label className="character-field">
            <span>{t('身份')}</span>
            <input
              value={draft.identity}
              onChange={(event) => patchDraft({ identity: event.target.value })}
              placeholder={t('职业或身份')}
            />
          </label>
          <label className="character-field">
            <span>{t('故事定位')}</span>
            <input
              value={draft.storyRole ?? ''}
              onChange={(event) => patchDraft({ storyRole: event.target.value || undefined })}
              placeholder={t('主角、反派、导师…')}
            />
          </label>
          <label className="character-field character-field-wide">
            <span>{t('简介')}</span>
            <textarea
              value={draft.summary}
              onChange={(event) => patchDraft({ summary: event.target.value })}
              rows={2}
              placeholder={t('角色背景与核心特征')}
            />
          </label>
          <label className="character-field character-field-wide">
            <span>{t('外观特征')}</span>
            <textarea
              value={draft.visualNotes}
              onChange={(event) => patchDraft({ visualNotes: event.target.value })}
              rows={2}
              placeholder={t('发型、五官、体态、服饰等稳定视觉特征')}
            />
          </label>
          <label className="character-field">
            <span>{t('性格')}</span>
            <input
              value={draft.personality ?? ''}
              onChange={(event) => patchDraft({ personality: event.target.value || undefined })}
            />
          </label>
          <label className="character-field">
            <span>{t('默认服装')}</span>
            <input
              value={draft.wardrobeDefault ?? ''}
              onChange={(event) => patchDraft({ wardrobeDefault: event.target.value || undefined })}
            />
          </label>
          <label className="character-field character-field-wide">
            <span>{t('声音特征')}</span>
            <input
              value={draft.voiceNotes ?? ''}
              onChange={(event) => patchDraft({ voiceNotes: event.target.value || undefined })}
              placeholder={t('音色、口音、语速，例如：低沉沙哑，语速偏慢，带轻微南方口音')}
            />
          </label>
        </section>

        <section className="character-dialog-references" aria-label={t('参考图')}>
          <div className="character-reference-toolbar">
            <div>
              <h3>{t('参考图')}</h3>
              <span>{t('{count} 张', { count: draft.referenceImages?.length ?? 0 })}</span>
            </div>
            <div className="flex-wrap justify-end">
              <button type="button" className="character-button-secondary" disabled={importingMedia} onClick={() => fileInputRef.current?.click()}>
                <Icon icon="lucide:images" width="15" height="15" aria-hidden="true" />
                {t('添加图片')}
              </button>
              <button type="button" className="ui-btn ui-btn--secondary" disabled={saving || importingMedia || !canGenerateVisual}
                title={canGenerateVisual ? undefined : t('角色生图仅支持桌面应用')} onClick={() => {
                try {
                  assertEditorCurrent();
                  setVisualWorkbenchUsed(true);
                  setVisualWorkbenchOpen(true);
                }
                catch (error) { showToast(error instanceof Error ? error.message : t('角色已变化，请重新打开编辑器'), 'error'); }
              }}>
                <Icon icon="lucide:sparkles" width="15" height="15" aria-hidden="true" />
                {t('生成角色形象')}
              </button>
            </div>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => void handleFiles(event)}
            />
          </div>

          <div className="character-dialog-reference-strip" role="list" aria-label={t('已添加图片')}>
            {(draft.referenceImages ?? []).map((reference, index) => (
              <button
                key={reference.id}
                type="button"
                role="listitem"
                className={reference.id === selectedReferenceId ? 'is-selected' : ''}
                onClick={() => setSelectedReferenceId(reference.id)}
                aria-label={t('第 {index} 张，{kind}', { index: index + 1, kind: t(CHARACTER_REFERENCE_KIND_LABELS[reference.kind]) })}
              >
                {reference.imageUrl ? <ViewportImage src={reference.imageUrl} alt="" /> : null}
              </button>
            ))}
            {(draft.referenceImages?.length ?? 0) === 0 ? (
              <button
                type="button"
                className="character-reference-add-empty"
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon icon="lucide:plus" width="20" height="20" aria-hidden="true" />
                <span>{t('添加多张角色参考图')}</span>
              </button>
            ) : null}
          </div>

          {selectedReference ? (
            <div className="character-reference-editor">
              <div className="character-reference-editor-main">
                <div className="character-reference-editor-image">
                  {selectedReference.imageUrl ? <ViewportImage src={selectedReference.imageUrl} eager alt="" /> : null}
                </div>
                <div className="character-reference-editor-fields">
                  <label className="character-field">
                    <span>{t('图片用途')}</span>
                    <Select fixedMenu
                      value={selectedReference.kind}
                      onChange={(selectedOptionValue) => patchReference({
                        kind: selectedOptionValue as CharacterReferenceKind,
                      })}
                    >
                      {REFERENCE_KINDS.map(([value, label]) => (
                        <option key={value} value={value}>{t(label)}</option>
                      ))}
                    </Select>
                  </label>
                  <div className="character-field">
                    <span>{t('图片提示词')}</span>
                    <div className="ui-textarea focus-within:border-[var(--border-focus)] focus-within:ring-2 focus-within:ring-[var(--brand-alpha-12)]" role="group" aria-label={t('图片提示词')}>
                      <MentionEditor
                        key={selectedReference.id}
                        nodeId={selectedReference.sourceNodeId}
                        value={selectedReference.prompt}
                        onChange={(value) => patchReference({ prompt: value })}
                        canSubmit={false}
                        submitShortcut="ctrl-enter"
                        placeholder={t('记录生成该形象时使用的提示词，@ 可引用节点或资产')}
                        className="[&_.prompt-editor]:min-h-20 [&_.prompt-editor]:max-h-48 [&_.prompt-editor]:text-sm [&_.mention-dropdown]:static [&_.mention-dropdown]:mt-2 [&_.mention-dropdown]:w-full [&_.mention-dropdown]:max-w-full"
                      />
                    </div>
                  </div>
                  <div className="character-reference-actions">
                    <button
                      type="button"
                      className={draft.primaryReferenceImageId === selectedReference.id ? 'is-active' : ''}
                      onClick={() => patchDraft({ primaryReferenceImageId: selectedReference.id })}
                    >
                      <Icon icon="lucide:star" width="14" height="14" aria-hidden="true" />
                      {t('主视觉')}
                    </button>
                    <button
                      type="button"
                      className={draft.avatarReferenceImageId === selectedReference.id ? 'is-active' : ''}
                      onClick={() => patchDraft({
                        avatarReferenceImageId: selectedReference.id,
                        avatarCrop: draft.avatarReferenceImageId === selectedReference.id
                          ? draft.avatarCrop
                          : undefined,
                      })}
                    >
                      <Icon icon="lucide:scan-face" width="14" height="14" aria-hidden="true" />
                      {t('设为头像')}
                    </button>
                    <button type="button" className="is-danger" onClick={removeSelectedReference}>
                      <Icon icon="lucide:trash-2" width="14" height="14" aria-hidden="true" />
                      {t('移除')}
                    </button>
                  </div>
                </div>
              </div>

              {draft.avatarReferenceImageId === selectedReference.id ? (
                <AvatarCropEditor
                  key={selectedReference.id}
                  reference={selectedReference}
                  crop={draft.avatarCrop}
                  onChange={(avatarCrop) => patchDraft({ avatarCrop })}
                />
              ) : null}
            </div>
          ) : null}

          <div className="character-voice-block">
            <div className="character-reference-toolbar">
              <div>
                <h3>{t('角色声音')}</h3>
                <span>{t('{count} 段', { count: draft.voiceClips?.length ?? 0 })}</span>
              </div>
              <button type="button" disabled={importingMedia} onClick={() => voiceInputRef.current?.click()}>
                <Icon icon="lucide:audio-lines" width="15" height="15" aria-hidden="true" />
                {t('上传音频')}
              </button>
              <input
                ref={voiceInputRef}
                className="sr-only"
                type="file"
                accept="audio/*"
                multiple
                onChange={(event) => void handleVoiceFiles(event)}
              />
            </div>

            {(draft.voiceClips?.length ?? 0) === 0 ? (
              <button
                type="button"
                className="character-reference-add-empty w-full"
                disabled={importingMedia}
                onClick={() => voiceInputRef.current?.click()}
              >
                <Icon icon="lucide:mic" width="20" height="20" aria-hidden="true" />
                <span>{t('上传音色参考或台词样本，也可在角色库里绑定画布音频节点')}</span>
              </button>
            ) : (
              <div className="character-voice-clip-list" role="list" aria-label={t('已绑定声音')}>
                {(draft.voiceClips ?? []).map((clip) => (
                  <div
                    key={clip.id}
                    role="listitem"
                    className={`character-voice-clip${clip.id === selectedVoiceClipId ? ' is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="character-voice-play"
                      aria-label={playingVoiceClipId === clip.id ? t('暂停试听') : t('试听')}
                      disabled={!clip.audioUrl}
                      onClick={() => void toggleVoicePlayback(clip)}
                    >
                      <Icon
                        icon={playingVoiceClipId === clip.id ? 'lucide:pause' : 'lucide:play'}
                        width="14"
                        height="14"
                        aria-hidden="true"
                      />
                    </button>
                    <button
                      type="button"
                      className="character-voice-clip-main"
                      onClick={() => setSelectedVoiceClipId(clip.id)}
                    >
                      <strong>{voiceClipTitle(clip)}</strong>
                      <span>
                        {t(CHARACTER_VOICE_KIND_LABELS[clip.kind])} · {formatVoiceDuration(clip.durationSec)}
                        {clip.sourceNodeId ? t(' · 画布节点') : ''}
                      </span>
                    </button>
                    {draft.primaryVoiceClipId === clip.id ? (
                      <span className="character-voice-primary-tag">{t('主音色')}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {selectedVoiceClip ? (
              <div className="character-voice-editor">
                <div className="character-voice-editor-fields">
                  <label className="character-field">
                    <span>{t('声音名称')}</span>
                    <input
                      value={selectedVoiceClip.label ?? ''}
                      onChange={(event) => patchVoiceClip({ label: event.target.value })}
                      placeholder={t('例如：低沉男声')}
                    />
                  </label>
                  <label className="character-field">
                    <span>{t('用途')}</span>
                    <Select fixedMenu
                      value={selectedVoiceClip.kind}
                      onChange={(selectedOptionValue) => patchVoiceClip({
                        kind: selectedOptionValue as CharacterVoiceKind,
                      })}
                    >
                      {VOICE_KINDS.map(([value, label]) => (
                        <option key={value} value={value}>{t(label)}</option>
                      ))}
                    </Select>
                  </label>
                </div>
                <label className="character-field">
                  <span>{t('台词 / 音色描述')}</span>
                  <textarea
                    value={selectedVoiceClip.transcript}
                    onChange={(event) => patchVoiceClip({ transcript: event.target.value })}
                    rows={3}
                    placeholder={t('记录该音频的台词内容或音色特征')}
                  />
                </label>
                <div className="character-reference-actions">
                  <button
                    type="button"
                    className={draft.primaryVoiceClipId === selectedVoiceClip.id ? 'is-active' : ''}
                    onClick={() => patchDraft({ primaryVoiceClipId: selectedVoiceClip.id })}
                  >
                    <Icon icon="lucide:star" width="14" height="14" aria-hidden="true" />
                    {t('主音色')}
                  </button>
                  <button type="button" className="is-danger" onClick={removeSelectedVoiceClip}>
                    <Icon icon="lucide:trash-2" width="14" height="14" aria-hidden="true" />
                    {t('移除')}
                  </button>
                </div>
              </div>
            ) : null}

            <audio
              ref={voicePlayerRef}
              className="sr-only"
              onPause={(event) => {
                if (event.currentTarget.paused && voicePlaybackRef.current?.release) stopVoicePlayback();
                setPlayingVoiceClipId(null);
              }}
              onEnded={() => { stopVoicePlayback(); setPlayingVoiceClipId(null); }}
              onError={(event) => {
                if (!event.currentTarget.error || !voicePlaybackRef.current) return;
                stopVoicePlayback(); setPlayingVoiceClipId(null);
                showToast(t('音频播放失败'), 'error');
              }}
            />
          </div>
        </section>

        <section className="ui-card mx-[10px] p-3" aria-label={t('ComfyUI 角色参考包')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium text-canvas-text">{t('ComfyUI 角色参考包（RefMod）')}</h3>
              <p className="mt-1 text-xs text-canvas-text-secondary">{t('关联已制作的参考包，方便 H3 多人物参考；文件仍由对应 ComfyUI 服务加载。')}</p>
            </div>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={(draft.refmods?.length ?? 0) >= 16} onClick={() => setRefmodPickerOpen(true)}>{t('关联参考包')}</button>
          </div>
          {(draft.refmods ?? []).length === 0 ? <p className="mt-2 text-xs text-canvas-text-muted">{t('尚未关联，可选；不会自动把角色照片转换为 RefMod。')}</p> : (
            <ul className="mt-2 space-y-2">
              {draft.refmods!.map((reference) => (
                <li key={comfyRefmodKey(reference)} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-canvas-border p-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-all text-sm text-canvas-text">{reference.fileName}</p>
                    <p className="text-xs text-canvas-text-secondary">{reference.serverId ? comfyServerName(reference.serverId) || t('原服务已移除') : t('默认服务器')} · {reference.loaderType === 'refmods-lab' ? 'RefMods Lab' : reference.loaderType === 'h3-refmods' ? 'Francky' : 'MiniMax H3'}</p>
                  </div>
                  {reference.loaderType !== 'refmods-lab' && <label className="flex items-center gap-2 text-xs text-canvas-text-secondary">{t('默认强度')}
                    <input type="number" aria-label={t('{name} 默认强度', { name: reference.fileName })} className="ui-input w-20" min={0} max={reference.loaderType === 'minimax-h3' ? 1 : 10} step={0.05} value={reference.strength} onChange={(event) => {
                      const value = event.target.valueAsNumber;
                      if (Number.isFinite(value)) patchDraft({ refmods: (draft.refmods ?? []).map((item) => comfyRefmodKey(item) === comfyRefmodKey(reference) ? { ...item, strength: Math.min(reference.loaderType === 'minimax-h3' ? 1 : 10, Math.max(0, value)) } : item) });
                    }} />
                  </label>}
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => patchDraft({ refmods: draft.refmods?.filter((item) => comfyRefmodKey(item) !== comfyRefmodKey(reference)) })}>{t('解除关联')}</button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="character-dialog-fields character-volcengine-binding" aria-label={t('火山方舟角色绑定')}>
          <div className="character-field character-field-wide">
            <span>{t('火山方舟视觉资产绑定（可选）')}</span>
            <small>{t('将角色绑定至火山方舟虚拟人像库，使用火山方舟API调用Seedance2.0系列、Seedance2.5可过人脸审核')}</small>
          </div>
          <label className="character-field">
            <span>{t('项目名称')}</span>
            <input
              value={draft.volcengineBinding?.projectName ?? 'default'}
              onChange={(event) => patchDraft({ volcengineBinding: { ...draft.volcengineBinding, projectName: event.target.value || 'default' } })}
              placeholder="default"
            />
          </label>
          <div className="character-field character-field-wide">
            <span>{t('角色人物资产')}</span>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-canvas-text-secondary">{draft.volcengineBinding?.imageAssetId ? t('已绑定：{name}', { name: draft.volcengineBinding.imageAssetName || draft.volcengineBinding.imageAssetId }) : t('未绑定')}</span>
              <button type="button" className="character-button-secondary" onClick={() => setVolcenginePickerMode('image')}>{t('选择视觉资产')}</button>
              {draft.volcengineBinding?.imageAssetId && <button type="button" className="character-button-secondary" onClick={() => patchDraft({ volcengineBinding: { projectName: draft.volcengineBinding?.projectName ?? 'default', imageAssetId: undefined, imageAssetName: undefined, imageAssetStatus: undefined, imageAssets: undefined } })}>{t('清除')}</button>}
            </div>
          </div>
        </section>
      </div>

      <footer className="character-dialog-footer">
        <button type="button" className="character-button-secondary" disabled={saving} onClick={onClose}>{t('取消')}</button>
        <button
          type="button"
          className="character-button-primary"
          disabled={saving || importingMedia}
          onClick={() => void handleSave()}
        >
          {saving ? t('保存中…') : importingMedia ? t('正在添加素材') : t('保存角色')}
        </button>
      </footer>
      <VolcengineAssetPickerDialog
        isOpen={volcenginePickerMode !== null}
        selectedAssetIds={draft.volcengineBinding?.imageAssetId ? [draft.volcengineBinding.imageAssetId] : []}
        allowedAssetTypes={['Image']}
        maxSelections={1}
        onClose={() => setVolcenginePickerMode(null)}
        onConfirm={applyVolcengineAsset}
      />
      <ComfyRefmodPicker
        isOpen={refmodPickerOpen}
        selectedKeys={(draft.refmods ?? []).map(comfyRefmodKey)}
        maxSelections={16 - (draft.refmods?.length ?? 0)}
        onClose={() => setRefmodPickerOpen(false)}
        onConfirm={applyRefmods}
      />
      {visualWorkbenchOpen && isOpen && (
        <LazyLoadBoundary label="角色形象工作台" resetKey={draft.id}>
          <Suspense fallback={<LazyLoadFallback label="角色形象工作台" />}>
            <CharacterVisualWorkbench
              key={draft.id}
              scope={scope}
              character={draft}
              isNew={!character}
              selectedReferenceId={selectedReferenceId}
              assertCurrent={assertEditorCurrent}
              onClose={() => setVisualWorkbenchOpen(false)}
              onAdopt={adoptVisualCandidate}
              onKeepReference={keepVisualReference}
              onResumeDraft={resumeVisualDraft}
              onApplyFields={(patch) => { assertEditorCurrent(); patchDraft(patch); }}
            />
          </Suspense>
        </LazyLoadBoundary>
      )}
    </ModalOverlay>
  );
}

export default function CharacterAssetDialog(props: CharacterAssetDialogProps) {
  return 'sourceNodeId' in props
    ? <CharacterNodeCaptureDialog {...props} />
    : <CharacterAssetEditorDialog {...props} />;
}
