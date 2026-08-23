/**
 * CharacterAssetDialog — 角色资产编辑弹窗。
 * 编辑单个 DramaCharacter 的基本信息、参考图（上传/裁剪/分类）与声音素材（音频/时长），
 * 按项目或全局作用域写入 store，资产文件经 saveDataUrlToProjectData 落盘到项目数据目录。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, generateId } from '../store/useAppStore';
import { isEligibleCharacterReferenceNode } from '../store/store.dramaAssets';
import { normalizeAssetKey } from '../services/dramaAssetExtract';
import { clamp } from '../utils/num';
import { saveDataUrlToProjectData } from '../services/fileService';
import type { BaseNodeData } from '../types';
import type {
  CharacterActionCategory,
  CharacterActionMedia,
  CharacterCropRect,
  CharacterReferenceImage,
  CharacterReferenceKind,
  CharacterVoiceClip,
  CharacterVoiceKind,
  DramaCharacter,
} from '../types/dramaAssets';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';
import {
  avatarCropBase,
  CHARACTER_REFERENCE_KIND_LABELS,
  CHARACTER_VOICE_KIND_LABELS,
  cropImageStyle,
  formatVoiceDuration,
  voiceClipTitle,
} from './character/characterReferencePresentation';
import { readAudioDuration, readAudioFile } from './character/characterVoiceMedia';

type CharacterLibraryScope = 'project' | 'global';

const REFERENCE_KINDS = Object.entries(CHARACTER_REFERENCE_KIND_LABELS) as Array<[
  CharacterReferenceKind,
  string,
]>;

const VOICE_KINDS = Object.entries(CHARACTER_VOICE_KIND_LABELS) as Array<[
  CharacterVoiceKind,
  string,
]>;

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

function actionMediaFromNode(node?: { data: BaseNodeData }): CharacterActionMedia | null {
  if (!node) return null;
  const data = node.data;
  const name = data.fileName || data.label || '画布动作素材';
  const now = Date.now();
  if (data.videoUrl) {
    const extension = (data.fileName || data.filePath || data.videoUrl)
      .split(/[?#]/, 1)[0]
      .split('.')
      .pop()
      ?.toLowerCase();
    return {
      id: `action-media-${generateId()}`,
      kind: 'video',
      name,
      mimeType: extension === 'webm'
        ? 'video/webm'
        : extension === 'mov'
          ? 'video/quicktime'
          : extension === 'm4v'
            ? 'video/x-m4v'
            : 'video/mp4',
      assetId: data.assetId,
      relativePath: data.relativePath,
      filePath: data.filePath,
      url: data.videoUrl,
      createdAt: now,
      updatedAt: now,
    };
  }
  const imageUrl = data.imageUrl || data.thumbnailUrl;
  if (!imageUrl) return null;
  const imageIdentity = [data.fileName, data.filePath, imageUrl]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const isGif = /\.gif(?:[?#]|$)/i.test(imageIdentity) || imageUrl.startsWith('data:image/gif');
  const extension = (data.fileName || data.filePath || imageUrl)
    .split(/[?#]/, 1)[0]
    .split('.')
    .pop()
    ?.toLowerCase();
  const dataMimeType = imageUrl.match(/^data:(image\/[^;,]+)/i)?.[1]?.toLowerCase();
  const mimeType = isGif
    ? 'image/gif'
    : dataMimeType
      ?? (extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : extension === 'webp'
          ? 'image/webp'
          : extension === 'avif'
            ? 'image/avif'
            : 'image/png');
  return {
    id: `action-media-${generateId()}`,
    kind: isGif ? 'gif' : 'image',
    name,
    mimeType,
    assetId: data.assetId,
    relativePath: data.relativePath,
    filePath: data.filePath,
    url: imageUrl,
    createdAt: now,
    updatedAt: now,
  };
}

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
  };
}

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('图片读取失败'));
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
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
      <div className="character-crop-preview" aria-label="头像裁切预览">
        {reference.imageUrl ? (
          <img
            src={reference.imageUrl}
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
          <span>水平</span>
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
          <span>垂直</span>
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
          <span>缩放</span>
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
  const {
    sourceNode,
    projectCharacters,
    globalCharacters,
    loadGlobalCharacters,
    captureImageNodeToCharacter,
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
      addCharacterAction: state.addCharacterAction,
      addCharacterActionMedia: state.addCharacterActionMedia,
      showToast: state.showToast,
    })),
  );
  const imageUrl = isEligibleCharacterReferenceNode(sourceNode)
    ? sourceNode?.data.imageUrl ?? sourceNode?.data.thumbnailUrl
    : undefined;
  const actionMedia = useMemo(() => actionMediaFromNode(sourceNode), [sourceNode]);
  const [captureTab, setCaptureTab] = useState<'reference' | 'action'>(
    imageUrl ? 'reference' : actionMedia ? 'action' : 'reference',
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

  const switchCaptureTab = (tab: 'reference' | 'action') => {
    setCaptureTab(tab);
    if (tab === 'action') setTargetMode('existing');
  };

  const handleCapture = async () => {
    if (!sourceNode) {
      showToast('无法读取来源节点', 'error');
      return;
    }

    if (captureTab === 'action') {
      if (!actionMedia) {
        showToast('该节点没有可用的图片、GIF 或视频', 'error');
        return;
      }
      if (!effectiveCharacterId || !selectedCharacter) {
        showToast('请选择要添加到的角色', 'error');
        return;
      }

      setSaving(true);
      let saved: boolean;
      if (actionAttachMode === 'existing') {
        if (!effectiveActionId) {
          setSaving(false);
          showToast('请选择已有动作', 'error');
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
          showToast('该节点已经添加到这个动作');
          return;
        }
        saved = await addCharacterActionMedia(
          scope,
          effectiveCharacterId,
          effectiveActionId,
          [actionMedia],
        );
      } else {
        const normalizedActionName = actionName.trim();
        if (!normalizedActionName) {
          setSaving(false);
          showToast('请填写动作名称', 'error');
          return;
        }
        if (actionCategory === 'custom' && !customActionCategory.trim()) {
          setSaving(false);
          showToast('请填写自定义分类名', 'error');
          return;
        }
        saved = Boolean(await addCharacterAction(scope, effectiveCharacterId, {
          category: actionCategory,
          customCategory: actionCategory === 'custom' ? customActionCategory.trim() : undefined,
          name: normalizedActionName,
          prompt: actionPrompt.trim(),
          media: [actionMedia],
        }));
      }
      setSaving(false);
      if (!saved) return;
      showToast(`已添加到「${selectedCharacter.name}」的动作库`);
      onClose();
      return;
    }

    if (!imageUrl) {
      showToast('该节点没有可用的角色图片', 'error');
      return;
    }

    let newCharacter: DramaCharacter | undefined;
    if (targetMode === 'new') {
      const normalizedName = name.trim();
      if (!normalizedName) {
        showToast('请填写角色名称', 'error');
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
      showToast('请选择角色', 'error');
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
    showToast(hideNode ? '已添加到角色库，画布节点已隐藏' : '已添加到角色库');
    onClose();
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel="添加到角色库"
      className="character-capture-dialog"
    >
      <header className="character-dialog-header">
        <div>
          <h2>添加到角色库</h2>
          <p>{sourceNode?.data.label || '画布节点'}</p>
        </div>
        <PopupCloseButton onClick={onClose} />
      </header>

      <div className="flex gap-1 border-b border-canvas-border px-4 py-2" role="tablist" aria-label="添加类型">
        <button
          type="button"
          role="tab"
          aria-selected={captureTab === 'reference'}
          disabled={!imageUrl}
          className={`flex min-h-8 items-center gap-1.5 rounded-md px-3 text-[11px] transition-[color,background-color,transform] duration-150 ease-out active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40 ${captureTab === 'reference' ? 'bg-canvas-hover text-canvas-text' : 'text-canvas-text-muted hover:text-canvas-text'}`}
          onClick={() => switchCaptureTab('reference')}
        >
          <Icon icon="lucide:image" width="14" height="14" aria-hidden="true" />
          形象参考
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
          动作素材
        </button>
      </div>

      <div className="character-capture-body">
        <section
          className="character-capture-preview"
          aria-label={captureTab === 'reference' ? '待添加图片' : '待添加动作素材'}
        >
          <div className="grid min-h-80 w-full place-items-center overflow-hidden rounded-lg border border-canvas-border bg-canvas-bg/70 p-1 max-[920px]:mx-auto max-[920px]:max-w-[360px]">
            {captureTab === 'action' && actionMedia?.kind === 'video' ? (
              <video
                src={actionMedia.url}
                className="max-h-[min(62vh,720px)] max-w-full object-contain"
                controls
                muted
                playsInline
                preload="metadata"
              />
            ) : captureTab === 'action' && actionMedia?.url ? (
              <img
                src={actionMedia.url}
                alt=""
                className="block max-h-[min(62vh,720px)] max-w-full object-contain"
                draggable={false}
              />
            ) : imageUrl ? (
              <img
                src={imageUrl}
                alt=""
                className="block max-h-[min(62vh,720px)] max-w-full object-contain"
                draggable={false}
              />
            ) : (
              <Icon icon="lucide:file-x" width="28" height="28" aria-hidden="true" />
            )}
          </div>
          <div>
            <span>来源节点</span>
            <strong>{sourceNode?.data.label || '画布节点'}</strong>
          </div>
        </section>

        <section
          className="character-capture-options"
          aria-label={captureTab === 'reference' ? '角色与参考图信息' : '角色与动作信息'}
        >
          <div className="character-capture-group">
            <span className="character-capture-label">保存范围</span>
            <div className="character-capture-segmented" role="tablist" aria-label="保存范围">
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'project'}
                className={scope === 'project' ? 'is-active' : ''}
                onClick={() => switchScope('project')}
              >
                本项目
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'global'}
                className={scope === 'global' ? 'is-active' : ''}
                onClick={() => switchScope('global')}
              >
                全局资产
              </button>
            </div>
          </div>

          {captureTab === 'reference' ? (
            <>
          <div className="character-capture-group">
            <span className="character-capture-label">添加方式</span>
            <div className="character-capture-segmented" role="tablist" aria-label="添加方式">
              <button
                type="button"
                role="tab"
                aria-selected={targetMode === 'new'}
                className={targetMode === 'new' ? 'is-active' : ''}
                onClick={() => setTargetMode('new')}
              >
                新建角色
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={targetMode === 'existing'}
                className={targetMode === 'existing' ? 'is-active' : ''}
                disabled={characters.length === 0}
                onClick={() => setTargetMode('existing')}
              >
                已有角色
              </button>
            </div>
          </div>

          {targetMode === 'existing' ? (
            <label className="character-field character-field-wide">
              <span>添加到角色</span>
              <select
                autoFocus
                value={effectiveCharacterId}
                onChange={(event) => setSelectedCharacterId(event.target.value)}
              >
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>{character.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <div className="character-capture-new-fields">
              <label className="character-field character-field-wide">
                <span>角色名称</span>
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：沈砚"
                />
              </label>
              <label className="character-field">
                <span>身份</span>
                <input
                  value={identity}
                  onChange={(event) => setIdentity(event.target.value)}
                  placeholder="职业或身份"
                />
              </label>
              <label className="character-field character-field-wide">
                <span>简介</span>
                <textarea
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  rows={2}
                  placeholder="角色背景与核心特征"
                />
              </label>
            </div>
          )}

          <div className="character-capture-reference-fields">
            <label className="character-field">
              <span>图片用途</span>
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as CharacterReferenceKind)}
              >
                {REFERENCE_KINDS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="character-field character-field-wide">
              <span>图片提示词</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                placeholder="记录生成该形象时使用的提示词"
              />
            </label>
          </div>

          <label className="character-capture-hide-option">
            <input
              type="checkbox"
              checked={hideNode}
              onChange={(event) => setHideNode(event.target.checked)}
            />
            <span>添加后隐藏画布节点</span>
          </label>
            </>
          ) : (
            <>
              <label className="character-field character-field-wide">
                <span>添加到角色</span>
                <select
                  autoFocus
                  value={effectiveCharacterId}
                  disabled={characters.length === 0}
                  onChange={(event) => {
                    setSelectedCharacterId(event.target.value);
                    setSelectedActionId('');
                  }}
                >
                  {characters.length === 0 ? <option value="">当前范围暂无角色</option> : null}
                  {characters.map((character) => (
                    <option key={character.id} value={character.id}>{character.name}</option>
                  ))}
                </select>
              </label>

              <div className="character-capture-group">
                <span className="character-capture-label">动作方式</span>
                <div className="character-capture-segmented" role="tablist" aria-label="动作添加方式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={actionAttachMode === 'new'}
                    className={actionAttachMode === 'new' ? 'is-active' : ''}
                    onClick={() => setActionAttachMode('new')}
                  >
                    新建动作
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={actionAttachMode === 'existing'}
                    className={actionAttachMode === 'existing' ? 'is-active' : ''}
                    disabled={actions.length === 0}
                    onClick={() => setActionAttachMode('existing')}
                  >
                    追加到已有动作
                  </button>
                </div>
              </div>

              {actionAttachMode === 'existing' ? (
                <label className="character-field character-field-wide">
                  <span>已有动作</span>
                  <select
                    value={effectiveActionId}
                    onChange={(event) => setSelectedActionId(event.target.value)}
                  >
                    {actions.map((action) => (
                      <option key={action.id} value={action.id}>{action.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="character-capture-reference-fields">
                  <label className="character-field">
                    <span>动作类别</span>
                    <select
                      value={actionCategory}
                      onChange={(event) => setActionCategory(event.target.value as CharacterActionCategory)}
                    >
                      {ACTION_CATEGORIES.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  {actionCategory === 'custom' ? (
                    <label className="character-field">
                      <span>自定义分类名</span>
                      <input
                        value={customActionCategory}
                        onChange={(event) => setCustomActionCategory(event.target.value)}
                        placeholder="例如：武术、特殊技能"
                      />
                    </label>
                  ) : null}
                  <label className="character-field character-field-wide">
                    <span>动作名称</span>
                    <input
                      value={actionName}
                      onChange={(event) => setActionName(event.target.value)}
                      placeholder="例如：待机呼吸、冲刺"
                    />
                  </label>
                  <label className="character-field character-field-wide">
                    <span>动作提示词</span>
                    <textarea
                      value={actionPrompt}
                      onChange={(event) => setActionPrompt(event.target.value)}
                      rows={3}
                      placeholder="记录姿态、节奏和镜头表现"
                    />
                  </label>
                </div>
              )}

              <div className="flex min-h-10 items-center gap-2 rounded-lg border border-canvas-border bg-canvas-surface px-3 text-[10px] leading-4 text-canvas-text-muted">
                <Icon icon="lucide:link-2" width="14" height="14" className="shrink-0" aria-hidden="true" />
                动作素材会绑定到所选角色，原画布节点保持不变。
              </div>
            </>
          )}
        </section>
      </div>

      <footer className="character-dialog-footer">
        <button type="button" className="character-button-secondary" onClick={onClose}>取消</button>
        <button
          type="button"
          className="character-button-primary text-white"
          disabled={saving
            || !sourceNode
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
            icon={captureTab === 'action' ? 'lucide:film' : 'lucide:contact-round'}
            width="15"
            height="15"
            aria-hidden="true"
          />
          {saving ? '添加中…' : captureTab === 'action' ? '添加到动作库' : '添加到角色库'}
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
  onClose,
  onSaved,
}: CharacterAssetEditorDialogProps) {
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
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceInputRef = useRef<HTMLInputElement>(null);
  const voicePlayerRef = useRef<HTMLAudioElement>(null);

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
    const dataUrl = await read(file);
    if (scope !== 'project' || !currentProjectId || currentProjectId === 'default') {
      return { url: dataUrl };
    }
    const stored = await saveDataUrlToProjectData(dataUrl, currentProjectId, file.name);
    return stored?.assetUrl
      ? { url: stored.assetUrl, filePath: stored.filePath }
      : { url: dataUrl };
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const shouldAssignPrimary = !draft.primaryReferenceImageId;
    event.target.value = '';
    if (files.length === 0) return;
    try {
      const now = Date.now();
      const references = await Promise.all(files.map(async (file, index) => {
        const stored = await storeUploadToProject(file, readImageFile);
        return {
          id: `reference-${generateId()}`,
          kind: shouldAssignPrimary && index === 0 ? 'primary' as const : 'other' as const,
          imageUrl: stored.url,
          filePath: stored.filePath,
          prompt: '',
          createdAt: now + index,
          updatedAt: now + index,
        };
      }));
      setDraft((current) => {
        const nextReferences = [...(current.referenceImages ?? []), ...references];
        return {
          ...current,
          referenceImages: nextReferences,
          primaryReferenceImageId: current.primaryReferenceImageId ?? references[0]?.id,
          updatedAt: Date.now(),
        };
      });
      setSelectedReferenceId(references[0]?.id ?? null);
    } catch {
      showToast('图片读取失败', 'error');
    }
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
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    try {
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
      setDraft((current) => ({
        ...current,
        voiceClips: [...(current.voiceClips ?? []), ...clips],
        primaryVoiceClipId: current.primaryVoiceClipId ?? clips[0]?.id,
        updatedAt: Date.now(),
      }));
      setSelectedVoiceClipId(clips[0]?.id ?? null);
    } catch {
      showToast('音频读取失败', 'error');
    }
  };

  const toggleVoicePlayback = (clip: CharacterVoiceClip) => {
    const player = voicePlayerRef.current;
    if (!player || !clip.audioUrl) return;
    if (playingVoiceClipId === clip.id) {
      player.pause();
      setPlayingVoiceClipId(null);
      return;
    }
    player.src = clip.audioUrl;
    void player.play()
      .then(() => setPlayingVoiceClipId(clip.id))
      .catch(() => showToast('音频播放失败', 'error'));
  };

  const removeSelectedVoiceClip = () => {
    if (!selectedVoiceClipId) return;
    if (playingVoiceClipId === selectedVoiceClipId) {
      voicePlayerRef.current?.pause();
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
    const name = draft.name.trim();
    if (!name) {
      showToast('请填写角色名称', 'error');
      return;
    }
    setSaving(true);
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
    const saved = await saveCharacterCard(scope, payload);
    setSaving(false);
    if (!saved) return;
    showToast(scope === 'project' ? '角色已保存到本项目' : '角色已保存到全局资产');
    onSaved(payload.id);
    onClose();
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel={character ? '编辑角色' : '新建角色'}
      className="character-dialog"
    >
      <header className="character-dialog-header">
        <div>
          <h2>{character ? '编辑角色' : '新建角色'}</h2>
          <p>{scope === 'project' ? '保存到本项目' : '保存到全局资产'}</p>
        </div>
        <PopupCloseButton onClick={onClose} />
      </header>

      <div className="character-dialog-body">
        <section className="character-dialog-fields" aria-label="角色资料">
          <label className="character-field character-field-wide">
            <span>角色名称</span>
            <input
              autoFocus
              value={draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
              placeholder="例如：沈砚"
            />
          </label>
          <label className="character-field">
            <span>身份</span>
            <input
              value={draft.identity}
              onChange={(event) => patchDraft({ identity: event.target.value })}
              placeholder="职业或身份"
            />
          </label>
          <label className="character-field">
            <span>故事定位</span>
            <input
              value={draft.storyRole ?? ''}
              onChange={(event) => patchDraft({ storyRole: event.target.value || undefined })}
              placeholder="主角、反派、导师…"
            />
          </label>
          <label className="character-field character-field-wide">
            <span>简介</span>
            <textarea
              value={draft.summary}
              onChange={(event) => patchDraft({ summary: event.target.value })}
              rows={2}
              placeholder="角色背景与核心特征"
            />
          </label>
          <label className="character-field character-field-wide">
            <span>外观特征</span>
            <textarea
              value={draft.visualNotes}
              onChange={(event) => patchDraft({ visualNotes: event.target.value })}
              rows={2}
              placeholder="发型、五官、体态、服饰等稳定视觉特征"
            />
          </label>
          <label className="character-field">
            <span>性格</span>
            <input
              value={draft.personality ?? ''}
              onChange={(event) => patchDraft({ personality: event.target.value || undefined })}
            />
          </label>
          <label className="character-field">
            <span>默认服装</span>
            <input
              value={draft.wardrobeDefault ?? ''}
              onChange={(event) => patchDraft({ wardrobeDefault: event.target.value || undefined })}
            />
          </label>
          <label className="character-field character-field-wide">
            <span>声音特征</span>
            <input
              value={draft.voiceNotes ?? ''}
              onChange={(event) => patchDraft({ voiceNotes: event.target.value || undefined })}
              placeholder="音色、口音、语速，例如：低沉沙哑，语速偏慢，带轻微南方口音"
            />
          </label>
        </section>

        <section className="character-dialog-references" aria-label="参考图">
          <div className="character-reference-toolbar">
            <div>
              <h3>参考图</h3>
              <span>{draft.referenceImages?.length ?? 0} 张</span>
            </div>
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              <Icon icon="lucide:images" width="15" height="15" aria-hidden="true" />
              添加图片
            </button>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => void handleFiles(event)}
            />
          </div>

          <div className="character-dialog-reference-strip" role="list" aria-label="已添加图片">
            {(draft.referenceImages ?? []).map((reference, index) => (
              <button
                key={reference.id}
                type="button"
                role="listitem"
                className={reference.id === selectedReferenceId ? 'is-selected' : ''}
                onClick={() => setSelectedReferenceId(reference.id)}
                aria-label={`第 ${index + 1} 张，${CHARACTER_REFERENCE_KIND_LABELS[reference.kind]}`}
              >
                {reference.imageUrl ? <img src={reference.imageUrl} alt="" /> : null}
              </button>
            ))}
            {(draft.referenceImages?.length ?? 0) === 0 ? (
              <button
                type="button"
                className="character-reference-add-empty"
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon icon="lucide:plus" width="20" height="20" aria-hidden="true" />
                <span>添加多张角色参考图</span>
              </button>
            ) : null}
          </div>

          {selectedReference ? (
            <div className="character-reference-editor">
              <div className="character-reference-editor-main">
                <div className="character-reference-editor-image">
                  {selectedReference.imageUrl ? <img src={selectedReference.imageUrl} alt="" /> : null}
                </div>
                <div className="character-reference-editor-fields">
                  <label className="character-field">
                    <span>图片用途</span>
                    <select
                      value={selectedReference.kind}
                      onChange={(event) => patchReference({
                        kind: event.target.value as CharacterReferenceKind,
                      })}
                    >
                      {REFERENCE_KINDS.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="character-field">
                    <span>图片提示词</span>
                    <textarea
                      value={selectedReference.prompt}
                      onChange={(event) => patchReference({ prompt: event.target.value })}
                      rows={4}
                      placeholder="记录生成该形象时使用的提示词"
                    />
                  </label>
                  <div className="character-reference-actions">
                    <button
                      type="button"
                      className={draft.primaryReferenceImageId === selectedReference.id ? 'is-active' : ''}
                      onClick={() => patchDraft({ primaryReferenceImageId: selectedReference.id })}
                    >
                      <Icon icon="lucide:star" width="14" height="14" aria-hidden="true" />
                      主视觉
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
                      设为头像
                    </button>
                    <button type="button" className="is-danger" onClick={removeSelectedReference}>
                      <Icon icon="lucide:trash-2" width="14" height="14" aria-hidden="true" />
                      移除
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
                <h3>角色声音</h3>
                <span>{draft.voiceClips?.length ?? 0} 段</span>
              </div>
              <button type="button" onClick={() => voiceInputRef.current?.click()}>
                <Icon icon="lucide:audio-lines" width="15" height="15" aria-hidden="true" />
                上传音频
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
                className="character-reference-add-empty"
                onClick={() => voiceInputRef.current?.click()}
              >
                <Icon icon="lucide:mic" width="20" height="20" aria-hidden="true" />
                <span>上传音色参考或台词样本，也可在角色库里绑定画布音频节点</span>
              </button>
            ) : (
              <div className="character-voice-clip-list" role="list" aria-label="已绑定声音">
                {(draft.voiceClips ?? []).map((clip) => (
                  <div
                    key={clip.id}
                    role="listitem"
                    className={`character-voice-clip${clip.id === selectedVoiceClipId ? ' is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="character-voice-play"
                      aria-label={playingVoiceClipId === clip.id ? '暂停试听' : '试听'}
                      disabled={!clip.audioUrl}
                      onClick={() => toggleVoicePlayback(clip)}
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
                        {CHARACTER_VOICE_KIND_LABELS[clip.kind]} · {formatVoiceDuration(clip.durationSec)}
                        {clip.sourceNodeId ? ' · 画布节点' : ''}
                      </span>
                    </button>
                    {draft.primaryVoiceClipId === clip.id ? (
                      <span className="character-voice-primary-tag">主音色</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {selectedVoiceClip ? (
              <div className="character-voice-editor">
                <div className="character-voice-editor-fields">
                  <label className="character-field">
                    <span>声音名称</span>
                    <input
                      value={selectedVoiceClip.label ?? ''}
                      onChange={(event) => patchVoiceClip({ label: event.target.value })}
                      placeholder="例如：低沉男声"
                    />
                  </label>
                  <label className="character-field">
                    <span>用途</span>
                    <select
                      value={selectedVoiceClip.kind}
                      onChange={(event) => patchVoiceClip({
                        kind: event.target.value as CharacterVoiceKind,
                      })}
                    >
                      {VOICE_KINDS.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="character-field">
                  <span>台词 / 音色描述</span>
                  <textarea
                    value={selectedVoiceClip.transcript}
                    onChange={(event) => patchVoiceClip({ transcript: event.target.value })}
                    rows={3}
                    placeholder="记录该音频的台词内容或音色特征"
                  />
                </label>
                <div className="character-reference-actions">
                  <button
                    type="button"
                    className={draft.primaryVoiceClipId === selectedVoiceClip.id ? 'is-active' : ''}
                    onClick={() => patchDraft({ primaryVoiceClipId: selectedVoiceClip.id })}
                  >
                    <Icon icon="lucide:star" width="14" height="14" aria-hidden="true" />
                    主音色
                  </button>
                  <button type="button" className="is-danger" onClick={removeSelectedVoiceClip}>
                    <Icon icon="lucide:trash-2" width="14" height="14" aria-hidden="true" />
                    移除
                  </button>
                </div>
              </div>
            ) : null}

            <audio
              ref={voicePlayerRef}
              className="sr-only"
              onEnded={() => setPlayingVoiceClipId(null)}
            />
          </div>
        </section>
      </div>

      <footer className="character-dialog-footer">
        <button type="button" className="character-button-secondary" onClick={onClose}>取消</button>
        <button
          type="button"
          className="character-button-primary text-white"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? '保存中…' : '保存角色'}
        </button>
      </footer>
    </ModalOverlay>
  );
}

export default function CharacterAssetDialog(props: CharacterAssetDialogProps) {
  return 'sourceNodeId' in props
    ? <CharacterNodeCaptureDialog {...props} />
    : <CharacterAssetEditorDialog {...props} />;
}
