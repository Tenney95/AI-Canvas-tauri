/**
 * CharacterLibraryPanel — 角色库侧边面板。
 * 列出项目级与全局角色，支持新建、编辑（打开 CharacterAssetDialog）、删除与筛选，
 * 头像取自角色主视觉参考图，全局角色可被跨项目复用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { generateId, useAppStore } from '../store/useAppStore';
import { isEligibleCharacterVoiceNode } from '../store/store.dramaAssets';
import {
  assertMediaDataUrlSize,
  assertMediaDataUrlWithinLimit,
  inferMediaDataUrlKind,
  saveBinaryToProjectData,
} from '../services/fileService';
import type { BaseNodeData } from '../types';
import type {
  CharacterActionCategory,
  CharacterActionMedia,
  CharacterActionMediaKind,
  CharacterReferenceImage,
  CharacterVoiceClip,
  DramaCharacter,
} from '../types/dramaAssets';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';
import Select from './shared/Select';
import ViewportImage from './shared/ViewportImage';
import ViewportVideo from './shared/ViewportVideo';
import { useT } from '../i18n';
import CharacterAssetDialog from './CharacterAssetDialog';
import CharacterReferenceGallery from './character/CharacterReferenceGallery';
import type { ReferenceStageBox } from './character/CharacterReferenceGallery';
import {
  CHARACTER_VOICE_KIND_LABELS,
  cropImageStyle,
  formatVoiceDuration,
  voiceClipTitle,
} from './character/characterReferencePresentation';
import { readAudioDuration } from './character/characterVoiceMedia';

type CharacterLibraryScope = 'project' | 'global';

const CHARACTER_ACTION_CATEGORIES: Array<{
  id: CharacterActionCategory;
  label: string;
  icon: string;
}> = [
  { id: 'standing', label: '站立', icon: 'lucide:person-standing' },
  { id: 'walking', label: '行走', icon: 'lucide:footprints' },
  { id: 'running', label: '奔跑', icon: 'lucide:footprints' },
  { id: 'jumping', label: '跳跃', icon: 'lucide:arrow-up-from-line' },
  { id: 'sitting', label: '坐姿', icon: 'lucide:armchair' },
  { id: 'crouching', label: '蹲伏', icon: 'lucide:move-down' },
  { id: 'lying', label: '躺卧', icon: 'lucide:bed-single' },
  { id: 'climbing', label: '攀爬', icon: 'lucide:mountain' },
  { id: 'swimming', label: '游泳', icon: 'lucide:waves' },
  { id: 'attacking', label: '攻击', icon: 'lucide:sword' },
  { id: 'defending', label: '防御', icon: 'lucide:shield' },
  { id: 'hit', label: '受击', icon: 'lucide:zap' },
  { id: 'death', label: '死亡', icon: 'lucide:skull' },
  { id: 'casting', label: '施法', icon: 'lucide:sparkles' },
  { id: 'interacting', label: '互动', icon: 'lucide:handshake' },
  { id: 'dancing', label: '舞蹈', icon: 'lucide:music-2' },
  { id: 'expression', label: '表情动作', icon: 'lucide:smile' },
  { id: 'custom', label: '自定义', icon: 'lucide:shapes' },
];

const ACTION_MEDIA_ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif,video/mp4,video/webm,video/quicktime,video/x-m4v';
const ACTION_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif']);
const ACTION_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v']);

function actionMediaKind(file: File): CharacterActionMediaKind | null {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (file.type === 'image/gif' || extension === 'gif') return 'gif';
  if (file.type.startsWith('image/') || (extension && ACTION_IMAGE_EXTENSIONS.has(extension))) {
    return 'image';
  }
  if (file.type.startsWith('video/') || (extension && ACTION_VIDEO_EXTENSIONS.has(extension))) {
    return 'video';
  }
  return null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('媒体读取失败'));
    reader.onerror = () => reject(reader.error ?? new Error('媒体读取失败'));
    reader.readAsDataURL(file);
  });
}

function actionMediaFromCanvasNode(node: { data: BaseNodeData }): CharacterActionMedia | null {
  const data = node.data;
  const name = data.fileName || data.label || '画布动作素材';
  if (data.videoUrl) {
    const extension = (data.fileName || data.filePath || data.videoUrl)
      .split(/[?#]/, 1)[0]
      .split('.')
      .pop()
      ?.toLowerCase();
    const mimeType = extension === 'webm'
      ? 'video/webm'
      : extension === 'mov'
        ? 'video/quicktime'
        : extension === 'm4v'
          ? 'video/x-m4v'
          : 'video/mp4';
    const now = Date.now();
    return {
      id: `action-media-${generateId()}`,
      kind: 'video',
      name,
      mimeType,
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
  const now = Date.now();
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

function characterAvatar(character: DramaCharacter): CharacterReferenceImage | undefined {
  const references = character.referenceImages ?? [];
  return references.find((reference) => reference.id === character.avatarReferenceImageId)
    ?? references.find((reference) => reference.id === character.primaryReferenceImageId)
    ?? references[0];
}

function CharacterAvatar({ character }: { character: DramaCharacter }) {
  const reference = characterAvatar(character);
  const cropped = reference?.id === character.avatarReferenceImageId && character.avatarCrop;
  return (
    <span className="character-avatar">
      {reference?.imageUrl ? (
        <ViewportImage
          src={reference.imageUrl}
          alt=""
          draggable={false}
          className={cropped ? 'is-cropped' : ''}
          style={cropped ? cropImageStyle(character.avatarCrop) : undefined}
        />
      ) : (
        <Icon icon="lucide:user-round" width={22} height={22} aria-hidden="true" />
      )}
    </span>
  );
}

export default function CharacterLibraryPanel() {
  const t = useT();
  const {
    open,
    actionLibraryOpen,
    setActionLibraryOpen,
    setOpen,
    projectCharacters,
    globalCharacters,
    globalCharactersLoading,
    loadGlobalCharacters,
    copyCharacterToGlobal,
    copyGlobalCharacterToProject,
    deleteDramaAsset,
    deleteGlobalCharacter,
    nodes,
    setCharacterLibraryNodeHidden,
    createImageNodeFromCharacterReference,
    bindAudioNodeToCharacterVoice,
    removeCharacterVoiceClip,
    setCharacterPrimaryVoice,
    createAudioNodeFromCharacterVoice,
    createVoiceOverNodeFromCharacterVoice,
    addCharacterAction,
    addCharacterActionMedia,
    removeCharacterActionMedia,
    removeCharacterAction,
    currentProjectId,
    setSelectedNodeIds,
    showToast,
  } = useAppStore(
    useShallow((state) => ({
      open: state.characterLibraryOpen,
      setOpen: state.setCharacterLibraryOpen,
      actionLibraryOpen: state.characterActionLibraryOpen,
      setActionLibraryOpen: state.setCharacterActionLibraryOpen,
      projectCharacters: state.dramaAssets.characters,
      globalCharacters: state.globalCharacters,
      globalCharactersLoading: state.globalCharactersLoading,
      loadGlobalCharacters: state.loadGlobalCharacters,
      copyCharacterToGlobal: state.copyCharacterToGlobal,
      copyGlobalCharacterToProject: state.copyGlobalCharacterToProject,
      deleteDramaAsset: state.deleteDramaAsset,
      deleteGlobalCharacter: state.deleteGlobalCharacter,
      nodes: state.nodes,
      setCharacterLibraryNodeHidden: state.setCharacterLibraryNodeHidden,
      createImageNodeFromCharacterReference: state.createImageNodeFromCharacterReference,
      bindAudioNodeToCharacterVoice: state.bindAudioNodeToCharacterVoice,
      removeCharacterVoiceClip: state.removeCharacterVoiceClip,
      setCharacterPrimaryVoice: state.setCharacterPrimaryVoice,
      createAudioNodeFromCharacterVoice: state.createAudioNodeFromCharacterVoice,
      createVoiceOverNodeFromCharacterVoice: state.createVoiceOverNodeFromCharacterVoice,
      addCharacterAction: state.addCharacterAction,
      addCharacterActionMedia: state.addCharacterActionMedia,
      removeCharacterActionMedia: state.removeCharacterActionMedia,
      removeCharacterAction: state.removeCharacterAction,
      currentProjectId: state.currentProjectId,
      setSelectedNodeIds: state.setSelectedNodeIds,
      showToast: state.showToast,
    })),
  );
  const [scope, setScope] = useState<CharacterLibraryScope>('project');
  const [search, setSearch] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  // 图片按容器高等比缩小后左右会留白，浮层要贴图片边缘，否则卡片会跨在图片与面板底色的分界上
  const [referenceStage, setReferenceStage] = useState<ReferenceStageBox | null>(null);
  const handleStageResize = useCallback((next: ReferenceStageBox | null) => {
    setReferenceStage((previous) => (
      previous?.width === next?.width && previous?.height === next?.height ? previous : next
    ));
  }, []);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogCharacter, setDialogCharacter] = useState<DramaCharacter | null>(null);
  const [dialogReferenceId, setDialogReferenceId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  // 记角色归属，切换角色时自然失效，不必在 effect 里回收状态
  const [playingVoice, setPlayingVoice] = useState<{
    characterId: string;
    clipId: string;
  } | null>(null);
  const [bindingVoice, setBindingVoice] = useState(false);
  const [captureNodeId, setCaptureNodeId] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [actionCategory, setActionCategory] = useState<CharacterActionCategory>('standing');
  const [actionFilter, setActionFilter] = useState<CharacterActionCategory | 'all'>('all');
  const [actionName, setActionName] = useState('');
  const [actionPrompt, setActionPrompt] = useState('');
  const [customActionCategory, setCustomActionCategory] = useState('');
  const [pendingActionMedia, setPendingActionMedia] = useState<CharacterActionMedia[]>([]);
  const [actionMediaTargetId, setActionMediaTargetId] = useState<string | null>(null);
  const [actionNodePickerTargetId, setActionNodePickerTargetId] = useState<string | null>(null);
  const [uploadingActionMedia, setUploadingActionMedia] = useState(false);
  const [savingAction, setSavingAction] = useState(false);
  const voicePlayerRef = useRef<HTMLAudioElement>(null);
  const actionMediaInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open || actionLibraryOpen) void loadGlobalCharacters();
  }, [actionLibraryOpen, loadGlobalCharacters, open]);

  // 面板卸载时清掉动作库标记：关角色库的路径有好几条（开设置、开素材库…），
  // 不清的话下次从侧边栏进角色库会莫名直接弹出动作库
  useEffect(() => () => setActionLibraryOpen(false), [setActionLibraryOpen]);

  const sourceCharacters = scope === 'project' ? projectCharacters : globalCharacters;
  const characters = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...sourceCharacters]
      .filter((character) => !query || [
        character.name,
        character.summary,
        character.identity,
        character.storyRole,
        character.visualNotes,
      ].some((value) => value?.toLowerCase().includes(query)))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
  }, [search, sourceCharacters]);

  const selectedCharacter = characters.find(
    (character) => character.id === selectedCharacterId,
  ) ?? characters[0] ?? null;
  const effectiveReferenceId = selectedCharacter?.referenceImages?.some(
    (reference) => reference.id === selectedReferenceId,
  )
    ? selectedReferenceId
    : selectedCharacter?.primaryReferenceImageId
      ?? selectedCharacter?.referenceImages?.[0]?.id
      ?? null;
  const selectedReference = selectedCharacter?.referenceImages?.find(
    (reference) => reference.id === effectiveReferenceId,
  ) ?? null;
  const sourceNode = useMemo(() => {
    if (!selectedCharacter || !selectedReference) return null;
    return nodes.find((node) => (
      node.id === selectedReference.sourceNodeId
      || node.data.characterLibraryLinks?.some((link) => (
        link.scope === scope
        && link.characterId === selectedCharacter.id
        && link.referenceImageId === selectedReference.id
      ))
    )) ?? null;
  }, [nodes, scope, selectedCharacter, selectedReference]);
  const canvasActionLabel = sourceNode
    ? sourceNode.data.hiddenByCharacterLibrary
      ? t('显示并定位节点')
      : t('定位画布节点')
    : t('添加到画布');
  const canvasActionIcon = sourceNode
    ? sourceNode.data.hiddenByCharacterLibrary
      ? 'lucide:eye'
      : 'lucide:locate-fixed'
    : 'lucide:square-plus';

  // 画布上还没进过角色库的图片节点，可当作新视角参考图
  const pickableNodes = useMemo(() => nodes.filter((node) => (
    !node.data.hiddenByCharacterLibrary
    && (node.data.imageUrl || node.data.thumbnailUrl)
  )), [nodes]);
  // 画布上带音频产物的节点，可绑定为角色声音
  const pickableAudioNodes = useMemo(
    () => nodes.filter((node) => isEligibleCharacterVoiceNode(node)),
    [nodes],
  );
  const pickableActionNodes = useMemo(
    () => nodes.filter((node) => actionMediaFromCanvasNode(node) !== null),
    [nodes],
  );
  const voiceClips = selectedCharacter?.voiceClips ?? [];
  const visibleActions = (selectedCharacter?.actions ?? []).filter((action) => (
    actionFilter === 'all' || action.category === actionFilter
  ));
  const playingVoiceClipId = playingVoice?.characterId === selectedCharacter?.id
    ? playingVoice?.clipId ?? null
    : null;

  // 切换角色或关闭面板时停止试听，避免声音跟着上一个角色继续播
  useEffect(() => {
    voicePlayerRef.current?.pause();
  }, [open, scope, selectedCharacter?.id]);

  const switchScope = (nextScope: CharacterLibraryScope) => {
    setScope(nextScope);
    setSelectedCharacterId(null);
    setSelectedReferenceId(null);
    setVoicePickerOpen(false);
  };

  const toggleVoicePlayback = (clip: CharacterVoiceClip) => {
    const player = voicePlayerRef.current;
    if (!player || !clip.audioUrl || !selectedCharacter) return;
    if (playingVoiceClipId === clip.id) {
      player.pause();
      return;
    }
    player.src = clip.audioUrl;
    void player.play()
      .then(() => setPlayingVoice({ characterId: selectedCharacter.id, clipId: clip.id }))
      .catch(() => showToast(t('音频播放失败'), 'error'));
  };

  const handleBindVoiceNode = async (nodeId: string) => {
    if (!selectedCharacter) return;
    const node = nodes.find((item) => item.id === nodeId);
    const audioUrl = node?.data.audioUrl;
    if (!audioUrl) {
      showToast(t('该节点没有可用的音频'), 'error');
      return;
    }
    setVoicePickerOpen(false);
    setBindingVoice(true);
    const clipId = await bindAudioNodeToCharacterVoice({
      nodeId,
      scope,
      characterId: selectedCharacter.id,
      label: node?.data.label,
      durationSec: await readAudioDuration(audioUrl),
    });
    setBindingVoice(false);
    if (!clipId) return;
    showToast(scope === 'project' ? t('已绑定到本项目角色声音') : t('已绑定到全局角色声音'));
  };

  const handleRemoveVoiceClip = async (clip: CharacterVoiceClip) => {
    if (!selectedCharacter) return;
    if (playingVoiceClipId === clip.id) voicePlayerRef.current?.pause();
    if (await removeCharacterVoiceClip(scope, selectedCharacter.id, clip.id)) {
      showToast(t('已移除该声音'));
    }
  };

  const focusNode = (nodeId: string) => {
    setOpen(false);
    setSelectedNodeIds([nodeId]);
    window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId } }));
  };

  const handleVoiceToCanvas = (clip: CharacterVoiceClip) => {
    if (!selectedCharacter) return;
    const nodeId = createAudioNodeFromCharacterVoice(scope, selectedCharacter.id, clip.id);
    if (nodeId) focusNode(nodeId);
  };

  const handleVoiceOver = (clip: CharacterVoiceClip) => {
    if (!selectedCharacter) return;
    const nodeId = createVoiceOverNodeFromCharacterVoice(scope, selectedCharacter.id, clip.id);
    if (!nodeId) return;
    showToast(t('已创建配音节点，声音已连线为音色参考'));
    focusNode(nodeId);
  };

  const handleAddAction = async () => {
    if (!selectedCharacter || !actionName.trim()) return;
    setSavingAction(true);
    const actionId = await addCharacterAction(scope, selectedCharacter.id, {
      category: actionCategory,
      customCategory: actionCategory === 'custom' ? customActionCategory : undefined,
      name: actionName,
      prompt: actionPrompt,
      media: pendingActionMedia,
    });
    setSavingAction(false);
    if (!actionId) return;
    setActionName('');
    setActionPrompt('');
    setPendingActionMedia([]);
    if (actionCategory === 'custom') setCustomActionCategory('');
    showToast(t('动作已添加到「{name}」', { name: selectedCharacter.name }));
  };

  const storeActionMediaFile = async (file: File): Promise<CharacterActionMedia | null> => {
    const kind = actionMediaKind(file);
    if (!kind) return null;
    const mediaKind = inferMediaDataUrlKind(file.type || file.name);
    assertMediaDataUrlSize(file.size, mediaKind, file.name);
    let url: string | undefined;
    let filePath: string | undefined;
    if (scope === 'project' && currentProjectId && currentProjectId !== 'default') {
      const stored = await saveBinaryToProjectData(
        new Uint8Array(await file.arrayBuffer()),
        currentProjectId,
        file.name,
      );
      url = stored?.assetUrl || undefined;
      filePath = stored?.filePath;
    }
    if (!url) {
      url = await readFileAsDataUrl(file);
      assertMediaDataUrlWithinLimit(url, mediaKind, file.name);
    }
    const now = Date.now();
    return {
      id: `action-media-${generateId()}`,
      kind,
      name: file.name,
      mimeType: file.type || undefined,
      filePath,
      url,
      createdAt: now,
      updatedAt: now,
    };
  };

  const openActionMediaPicker = (actionId: string | null) => {
    setActionMediaTargetId(actionId);
    requestAnimationFrame(() => actionMediaInputRef.current?.click());
  };

  const handleActionMediaFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const targetActionId = actionMediaTargetId;
    event.target.value = '';
    if (files.length === 0 || !selectedCharacter) return;
    setUploadingActionMedia(true);
    try {
      const media: CharacterActionMedia[] = [];
      for (const file of files) {
        const stored = await storeActionMediaFile(file);
        if (stored) media.push(stored);
      }
      if (media.length === 0) {
        showToast(t('请选择 PNG、JPG、WebP、AVIF、GIF、MP4、WebM、MOV 或 M4V 文件'), 'error');
        return;
      }
      if (targetActionId) {
        if (await addCharacterActionMedia(
          scope,
          selectedCharacter.id,
          targetActionId,
          media,
        )) {
          showToast(t('已添加 {count} 个动作媒体', { count: media.length }));
        }
      } else {
        setPendingActionMedia((current) => [...current, ...media]);
      }
    } catch {
      showToast(t('动作媒体读取或保存失败'), 'error');
    } finally {
      setUploadingActionMedia(false);
      setActionMediaTargetId(null);
    }
  };

  const handleBindActionNode = async (nodeId: string) => {
    if (!selectedCharacter || !actionNodePickerTargetId) return;
    const action = selectedCharacter.actions?.find((item) => item.id === actionNodePickerTargetId);
    const node = nodes.find((item) => item.id === nodeId);
    const media = node ? actionMediaFromCanvasNode(node) : null;
    if (!action || !media) {
      showToast(t('该节点没有可用的图片、GIF 或视频'), 'error');
      return;
    }
    const duplicated = action.media?.some((item) => (
      Boolean(media.assetId && item.assetId === media.assetId)
      || Boolean(media.filePath && item.filePath === media.filePath)
      || item.url === media.url
    ));
    if (duplicated) {
      showToast(t('该节点已经添加到这个动作'));
      return;
    }
    if (await addCharacterActionMedia(
      scope,
      selectedCharacter.id,
      action.id,
      [media],
    )) {
      setActionNodePickerTargetId(null);
      showToast(t('画布节点已添加到动作「{name}」', { name: action.name }));
    }
  };

  const closeActionLibrary = () => {
    setActionNodePickerTargetId(null);
    setActionLibraryOpen(false);
  };

  const openEditor = (character: DramaCharacter | null, referenceId?: string | null) => {
    setDialogCharacter(character);
    setDialogReferenceId(referenceId ?? null);
    setDialogOpen(true);
  };

  const handleCopy = async () => {
    if (!selectedCharacter) return;
    if (scope === 'project') {
      const copiedId = await copyCharacterToGlobal(selectedCharacter.id);
      if (!copiedId) return;
      showToast(t('已复制到全局资产'));
      setScope('global');
      setSelectedCharacterId(copiedId);
      setSelectedReferenceId(null);
      return;
    }
    const copiedId = copyGlobalCharacterToProject(selectedCharacter.id);
    if (!copiedId) return;
    showToast(t('已复制到本项目'));
    setScope('project');
    setSelectedCharacterId(copiedId);
    setSelectedReferenceId(null);
  };

  const handleDelete = async () => {
    if (!selectedCharacter) return;
    setDeleteConfirmOpen(false);
    if (scope === 'project') {
      deleteDramaAsset('character', selectedCharacter.id);
    } else if (!await deleteGlobalCharacter(selectedCharacter.id)) {
      return;
    }
    showToast(t('角色已删除'));
    setSelectedCharacterId(null);
    setSelectedReferenceId(null);
  };

  const handleCanvasAction = () => {
    if (!selectedCharacter || !selectedReference) return;
    let nodeId = sourceNode?.id ?? null;
    if (sourceNode?.data.hiddenByCharacterLibrary) {
      setCharacterLibraryNodeHidden(sourceNode.id, false);
      showToast(t('节点已显示'));
    } else if (!sourceNode) {
      nodeId = createImageNodeFromCharacterReference(
        scope,
        selectedCharacter.id,
        selectedReference.id,
      );
      if (!nodeId) return;
      showToast(t('已将角色参考图添加到画布'));
    }
    if (!nodeId) return;

    setOpen(false);
    setSelectedNodeIds([nodeId]);
    window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId } }));
  };

  return (
    <>
      <ModalOverlay
        isOpen={open}
        onClose={() => setOpen(false)}
        ariaLabel={t('角色库')}
        className="character-library-panel"
      >
        <div className="character-library-toolbar">
          <div className="character-library-tabs" role="tablist" aria-label={t('角色保存范围')}>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'project'}
              className={scope === 'project' ? 'is-active' : ''}
              onClick={() => switchScope('project')}
            >
              {t('本项目')}
              <span>{projectCharacters.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'global'}
              className={scope === 'global' ? 'is-active' : ''}
              onClick={() => switchScope('global')}
            >
              {t('全局资产')}
              <span>{globalCharacters.length}</span>
            </button>
          </div>
          <label className="character-library-search">
            <Icon icon="lucide:search" width="15" height="15" aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('搜索角色、身份或简介')}
            />
            {search ? (
              <button type="button" aria-label={t('清空搜索')} onClick={() => setSearch('')}>
                <Icon icon="lucide:x" width="13" height="13" aria-hidden="true" />
              </button>
            ) : null}
          </label>
          <button type="button" className="character-library-new" onClick={() => openEditor(null)}>
            <Icon icon="lucide:plus" width="13" height="13" aria-hidden="true" />
            {t('新建角色')}
          </button>
          <PopupCloseButton onClick={() => setOpen(false)} />
        </div>

        <main className="character-library-content">
          {scope === 'global' && globalCharactersLoading ? (
            <div className="character-library-empty">
              <Icon icon="lucide:loader-circle" className="animate-spin" width="26" height="26" aria-hidden="true" />
              <p>{t('正在读取全局角色…')}</p>
            </div>
          ) : selectedCharacter ? (
            <section
              className="character-library-gallery"
              aria-label={t('多图参考')}
              style={referenceStage ? {
                '--character-stage-width': `${referenceStage.width}px`,
                '--character-stage-height': `${referenceStage.height}px`,
              } as CSSProperties : undefined}
            >
              <CharacterReferenceGallery
                references={selectedCharacter.referenceImages ?? []}
                selectedId={effectiveReferenceId}
                onSelect={setSelectedReferenceId}
                onEdit={(referenceId) => openEditor(selectedCharacter, referenceId)}
                onStageResize={handleStageResize}
              />

              <div className="character-library-dock">
                {pickerOpen ? (
                  <div className="character-node-picker" role="listbox" aria-label={t('选择画布图片节点')}>
                    {pickableNodes.length === 0 ? (
                      <span className="character-node-picker-empty">{t('画布上没有可用的图片节点')}</span>
                    ) : pickableNodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => {
                          setCaptureNodeId(node.id);
                          setPickerOpen(false);
                        }}
                      >
                        <ViewportImage src={node.data.imageUrl ?? node.data.thumbnailUrl} alt="" draggable={false} />
                        <span>{node.data.label || t('图片节点')}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                <section className="character-voice-dock" aria-label={t('角色声音')}>
                  <div className="character-voice-dock-head">
                    <Icon icon="lucide:audio-lines" width="14" height="14" aria-hidden="true" />
                    <span>{t('角色声音')}</span>
                    <strong>{voiceClips.length}</strong>
                    <button
                      type="button"
                      data-tooltip={t('绑定画布音频节点')}
                      aria-label={t('绑定画布音频节点')}
                      aria-expanded={voicePickerOpen}
                      className={voicePickerOpen ? 'is-active' : ''}
                      disabled={bindingVoice}
                      onClick={() => {
                        setPickerOpen(false);
                        setVoicePickerOpen((current) => !current);
                      }}
                    >
                      <Icon icon="lucide:link" width="15" height="15" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      data-tooltip={t('上传音频')}
                      aria-label={t('上传音频')}
                      onClick={() => openEditor(selectedCharacter)}
                    >
                      <Icon icon="lucide:upload" width="15" height="15" aria-hidden="true" />
                    </button>
                  </div>

                  {voicePickerOpen ? (
                    <div className="character-voice-picker" role="listbox" aria-label={t('选择画布音频节点')}>
                      {pickableAudioNodes.length === 0 ? (
                        <span className="character-node-picker-empty">{t('画布上没有可用的音频节点')}</span>
                      ) : pickableAudioNodes.map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          role="option"
                          aria-selected={false}
                          onClick={() => void handleBindVoiceNode(node.id)}
                        >
                          <Icon icon="lucide:audio-lines" width="15" height="15" aria-hidden="true" />
                          <span>{node.data.label || t('音频节点')}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {voiceClips.length === 0 ? (
                    <p className="character-voice-dock-empty">
                      {bindingVoice ? t('正在绑定…') : t('还没有声音，可绑定画布音频节点或上传音频')}
                    </p>
                  ) : (
                    <div className="character-voice-chips" role="list">
                      {voiceClips.map((clip) => (
                        <div
                          key={clip.id}
                          role="listitem"
                          className={`character-voice-chip${
                            clip.id === selectedCharacter.primaryVoiceClipId ? ' is-primary' : ''
                          }`}
                        >
                          <button
                            type="button"
                            className="character-voice-play"
                            aria-label={playingVoiceClipId === clip.id ? t('暂停试听') : t('试听')}
                            disabled={!clip.audioUrl}
                            onClick={() => toggleVoicePlayback(clip)}
                          >
                            <Icon
                              icon={playingVoiceClipId === clip.id ? 'lucide:pause' : 'lucide:play'}
                              width="13"
                              height="13"
                              aria-hidden="true"
                            />
                          </button>
                          <span className="character-voice-chip-copy">
                            <strong>{voiceClipTitle(clip)}</strong>
                            <span>
                              {CHARACTER_VOICE_KIND_LABELS[clip.kind]} · {formatVoiceDuration(clip.durationSec)}
                            </span>
                          </span>
                          <span className="character-voice-chip-actions">
                            <button
                              type="button"
                              data-tooltip={t('设为主音色')}
                              aria-label={t('设为主音色')}
                              className={clip.id === selectedCharacter.primaryVoiceClipId ? 'is-active' : ''}
                              onClick={() => void setCharacterPrimaryVoice(scope, selectedCharacter.id, clip.id)}
                            >
                              <Icon icon="lucide:star" width="13" height="13" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              data-tooltip={t('用这个声音生成台词')}
                              aria-label={t('用这个声音生成台词')}
                              onClick={() => handleVoiceOver(clip)}
                            >
                              <Icon icon="lucide:mic" width="13" height="13" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              data-tooltip={clip.sourceNodeId ? t('定位画布节点') : t('添加到画布')}
                              aria-label={clip.sourceNodeId ? t('定位画布节点') : t('添加到画布')}
                              onClick={() => handleVoiceToCanvas(clip)}
                            >
                              <Icon
                                icon={clip.sourceNodeId ? 'lucide:locate-fixed' : 'lucide:square-plus'}
                                width="13"
                                height="13"
                                aria-hidden="true"
                              />
                            </button>
                            <button
                              type="button"
                              data-tooltip={t('移除该声音')}
                              aria-label={t('移除该声音')}
                              onClick={() => void handleRemoveVoiceClip(clip)}
                            >
                              <Icon icon="lucide:trash-2" width="13" height="13" aria-hidden="true" />
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="character-library-profile" aria-label={t('当前角色')}>
                  <div className="character-library-profile-copy">
                    <div className="character-library-profile-name">
                      <h3>{selectedCharacter.name}</h3>
                      {selectedCharacter.identity ? <span>{selectedCharacter.identity}</span> : null}
                      {selectedCharacter.storyRole ? <span>{selectedCharacter.storyRole}</span> : null}
                    </div>
                    <p>{selectedCharacter.summary || selectedCharacter.visualNotes || t('尚未填写角色简介')}</p>
                  </div>
                  <div className="character-library-profile-actions">
                    {selectedReference ? (
                      <button type="button" data-tooltip={canvasActionLabel} aria-label={canvasActionLabel} onClick={handleCanvasAction}>
                        <Icon icon={canvasActionIcon} width="16" height="16" aria-hidden="true" />
                      </button>
                    ) : null}
                    {sourceNode && !sourceNode.data.hiddenByCharacterLibrary ? (
                      <button
                        type="button"
                        data-tooltip={t('在画布中隐藏')}
                        aria-label={t('在画布中隐藏')}
                        onClick={() => {
                          if (setCharacterLibraryNodeHidden(sourceNode.id, true)) showToast(t('节点已隐藏'));
                        }}
                      >
                        <Icon icon="lucide:eye-off" width="16" height="16" aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-tooltip={t('从画布添加视角图')}
                      aria-label={t('从画布添加视角图')}
                      aria-expanded={pickerOpen}
                      className={pickerOpen ? 'is-active' : ''}
                      onClick={() => {
                        setVoicePickerOpen(false);
                        setPickerOpen((open) => !open);
                      }}
                    >
                      <Icon icon="lucide:image-plus" width="16" height="16" aria-hidden="true" />
                    </button>
                    <button type="button" data-tooltip={t('编辑角色')} aria-label={t('编辑角色')} onClick={() => openEditor(selectedCharacter)}>
                      <Icon icon="lucide:pencil" width="16" height="16" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      data-tooltip={t('角色动作库')}
                      aria-label={t('打开「{name}」的动作库', { name: selectedCharacter.name })}
                      aria-expanded={actionLibraryOpen}
                      className={actionLibraryOpen ? 'is-active' : ''}
                      onClick={() => setActionLibraryOpen(true)}
                    >
                      <Icon icon="lucide:accessibility" width="16" height="16" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      data-tooltip={scope === 'project' ? t('复制到全局资产') : t('复制到本项目')}
                      aria-label={scope === 'project' ? t('复制到全局资产') : t('复制到本项目')}
                      onClick={() => void handleCopy()}
                    >
                      <Icon icon="lucide:copy-plus" width="16" height="16" aria-hidden="true" />
                    </button>
                    <button type="button" data-tooltip={t('删除角色')} aria-label={t('删除角色')} onClick={() => setDeleteConfirmOpen(true)}>
                      <Icon icon="lucide:trash-2" width="16" height="16" aria-hidden="true" />
                    </button>
                  </div>
                </section>
              </div>

              <audio
                ref={voicePlayerRef}
                className="sr-only"
                onPause={() => setPlayingVoice(null)}
                onEnded={() => setPlayingVoice(null)}
              />
            </section>
          ) : (
            <div className="character-library-empty">
              <Icon icon="lucide:contact-round" width="34" height="34" aria-hidden="true" />
              <h3>{search ? t('没有匹配的角色') : t('这里还没有角色')}</h3>
              {!search ? (
                <button type="button" className="character-button-primary mt-3 text-white" onClick={() => openEditor(null)}>
                  <Icon icon="lucide:plus" width="15" height="15" aria-hidden="true" />
                  {t('新建角色')}
                </button>
              ) : null}
            </div>
          )}
        </main>

        <footer className="character-library-strip" aria-label={t('角色列表')}>
          <div className="character-library-strip-label">
            <span>{scope === 'project' ? t('本项目角色') : t('全局角色')}</span>
            <strong>{characters.length}</strong>
          </div>
          <div className="character-library-strip-list" role="list">
            {characters.map((character) => (
              <button
                key={character.id}
                type="button"
                role="listitem"
                className={character.id === selectedCharacter?.id ? 'is-selected' : ''}
                onClick={() => {
                  setSelectedCharacterId(character.id);
                  setSelectedReferenceId(null);
                }}
              >
                <CharacterAvatar character={character} />
                <span>{character.name}</span>
              </button>
            ))}
          </div>
        </footer>
      </ModalOverlay>

      {dialogOpen ? createPortal(
        <CharacterAssetDialog
          isOpen
          scope={scope}
          character={dialogCharacter}
          initialReferenceId={dialogReferenceId}
          onClose={() => setDialogOpen(false)}
          onSaved={(characterId) => {
            setSelectedCharacterId(characterId);
            setSelectedReferenceId(null);
          }}
        />,
        document.body,
      ) : null}

      {deleteConfirmOpen && selectedCharacter ? createPortal(
        <ModalOverlay
          isOpen
          onClose={() => setDeleteConfirmOpen(false)}
          ariaLabel={t('确认删除角色')}
          className="character-confirm-dialog"
          motionPreset="quick"
        >
          <div className="character-confirm-body">
            <span className="character-confirm-icon" aria-hidden="true">
              <Icon icon="lucide:trash-2" width="18" height="18" />
            </span>
            <div>
              <h3>{t('删除「{name}」？', { name: selectedCharacter.name })}</h3>
              <p>
                {scope === 'project'
                  ? t('将从本项目移除该角色及其 {count} 张参考图，画布上被收纳的节点会重新显示。', { count: selectedCharacter.referenceImages?.length ?? 0 })
                  : t('将从全局资产永久删除该角色及其 {count} 张参考图，删除后无法恢复。', { count: selectedCharacter.referenceImages?.length ?? 0 })}
              </p>
            </div>
          </div>
          <footer className="character-dialog-footer">
            <button type="button" className="character-button-secondary" onClick={() => setDeleteConfirmOpen(false)}>
              {t('取消')}
            </button>
            <button type="button" className="character-button-danger" onClick={() => void handleDelete()}>
              {t('删除角色')}
            </button>
          </footer>
        </ModalOverlay>,
        document.body,
      ) : null}

      {selectedCharacter ? (
        <ModalOverlay
          isOpen={actionLibraryOpen}
          onClose={closeActionLibrary}
          ariaLabel={t('「{name}」的动作库', { name: selectedCharacter.name })}
          className="h-[min(820px,calc(100vh-32px))] w-[min(1180px,calc(100vw-32px))] border-canvas-border bg-canvas-surface text-canvas-text"
          motionPreset="quick"
        >
          <header className="flex items-center gap-3 border-b border-canvas-border px-5 py-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-canvas-border bg-canvas-card text-indigo-400">
              <Icon icon="lucide:accessibility" width="19" height="19" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-semibold">{t('{name} · 动作库', { name: selectedCharacter.name })}</h2>
              <p className="mt-0.5 text-[11px] text-canvas-text-secondary">
                {t('{count} 个动作 · 支持为每个动作添加多份图片、GIF 和视频', { count: selectedCharacter.actions?.length ?? 0 })}
              </p>
            </div>
            <PopupCloseButton onClick={closeActionLibrary} />
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] max-md:block max-md:overflow-y-auto">
            <section className="flex min-h-0 flex-col" aria-label={t('动作列表')}>
              <div className="flex items-center gap-3 border-b border-canvas-border px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-xs font-semibold">{t('动作列表')}</h3>
                  <p className="mt-0.5 text-[10px] text-canvas-text-muted">{t('同一动作可继续添加多份演示素材')}</p>
                </div>
                <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
                  {t('角色')}
                  <Select
                    value={selectedCharacter.id}
                    onChange={(value) => setSelectedCharacterId(value)}
                    className="min-w-32 max-w-44"
                    triggerStyle={{ height: 32 }}
                    fixedMenu
                    options={characters.map((character) => ({ value: character.id, label: character.name }))}
                  />
                </label>
                <label className="flex items-center gap-2 text-[10px] text-canvas-text-secondary">
                  {t('筛选')}
                  <Select
                    value={actionFilter}
                    onChange={(value) => setActionFilter(value as CharacterActionCategory | 'all')}
                    className="min-w-32"
                    triggerStyle={{ height: 32 }}
                    fixedMenu
                    options={[
                      { value: 'all', label: t('全部类别') },
                      ...CHARACTER_ACTION_CATEGORIES.map((category) => ({
                        value: category.id,
                        label: t(category.label),
                      })),
                    ]}
                  />
                </label>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {visibleActions.length === 0 ? (
                  <div className="flex h-full min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-canvas-border px-6 text-center">
                    <Icon icon="lucide:accessibility" width="28" height="28" className="text-canvas-text-muted" aria-hidden="true" />
                    <h3 className="mt-3 text-sm font-medium">{actionFilter === 'all' ? t('还没有动作') : t('这个类别还没有动作')}</h3>
                    <p className="mt-1 max-w-72 text-xs leading-5 text-canvas-text-secondary">{t('在右侧选择类别并添加动作，可同时上传多份图片、GIF 或视频')}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 items-start gap-3 max-lg:grid-cols-1">
                    {visibleActions.map((action) => {
                      const category = CHARACTER_ACTION_CATEGORIES.find((item) => item.id === action.category);
                      const categoryLabel = action.category === 'custom' && action.customCategory
                        ? action.customCategory
                        : category?.label ?? '自定义';
                      return (
                        <article key={action.id} className="character-action-card flex min-w-0 flex-col rounded-xl border border-canvas-border bg-canvas-card p-3 shadow-sm">
                          <div className="flex items-start gap-2">
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-canvas-border bg-canvas-surface text-indigo-400">
                              <Icon icon={category?.icon ?? 'lucide:shapes'} width="15" height="15" aria-hidden="true" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <h3 className="truncate text-xs font-semibold">{action.name}</h3>
                              <span className="mt-1 inline-flex rounded-md border border-canvas-border px-1.5 py-0.5 text-[10px] text-canvas-text-secondary">
                                {t(categoryLabel)}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="grid size-7 shrink-0 place-items-center rounded-md text-canvas-text-muted transition-[transform,color,background-color] duration-150 ease-out hover:bg-canvas-hover hover:text-canvas-text active:scale-[.97]"
                              aria-label={t('删除动作「{name}」', { name: action.name })}
                              onClick={async () => {
                                if (await removeCharacterAction(scope, selectedCharacter.id, action.id)) {
                                  showToast(t('动作已移除'));
                                }
                              }}
                            >
                              <Icon icon="lucide:trash-2" width="13" height="13" aria-hidden="true" />
                            </button>
                          </div>
                          <p className="mt-2 min-h-10 text-[11px] leading-5 text-canvas-text-secondary">
                            {action.prompt || t('未填写动作提示词')}
                          </p>

                          <div className="mt-3 grid grid-cols-2 gap-2">
                            {(action.media ?? []).map((media) => (
                              <figure key={media.id} className="group relative m-0 aspect-video overflow-hidden rounded-lg border border-canvas-border bg-canvas-surface">
                                {media.kind !== 'video' ? (
                                  <ViewportImage src={media.url} alt={media.name} className="size-full object-cover" draggable={false} />
                                ) : (
                                  <ViewportVideo src={media.url} className="size-full object-cover" controls aria-label={media.name} />
                                )}
                                <span className="pointer-events-none absolute bottom-1 left-1 max-w-[calc(100%-8px)] truncate rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-white">
                                  {media.name}
                                </span>
                                <button
                                  type="button"
                                  className="absolute right-1 top-1 grid size-6 place-items-center rounded-md bg-black/60 text-white transition-[transform,background-color] duration-150 ease-out hover:bg-black/80 active:scale-[.97]"
                                  aria-label={t('移除媒体「{name}」', { name: media.name })}
                                  onClick={async () => {
                                    if (await removeCharacterActionMedia(
                                      scope,
                                      selectedCharacter.id,
                                      action.id,
                                      media.id,
                                    )) showToast(t('动作媒体已移除'));
                                  }}
                                >
                                  <Icon icon="lucide:x" width="12" height="12" aria-hidden="true" />
                                </button>
                              </figure>
                            ))}
                            <button
                              type="button"
                              disabled={uploadingActionMedia}
                              className="flex aspect-video min-h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-canvas-border text-[10px] text-canvas-text-muted transition-[transform,color,background-color,border-color] duration-150 ease-out hover:border-indigo-400 hover:bg-canvas-surface hover:text-canvas-text active:scale-[.98] disabled:opacity-50"
                              onClick={() => openActionMediaPicker(action.id)}
                            >
                              <Icon icon="lucide:upload" width="16" height="16" aria-hidden="true" />
                              {t('上传图片 / GIF / 视频')}
                            </button>
                            <button
                              type="button"
                              aria-expanded={actionNodePickerTargetId === action.id}
                              className="flex aspect-video min-h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-canvas-border text-[10px] text-canvas-text-muted transition-[transform,color,background-color,border-color] duration-150 ease-out hover:border-indigo-400 hover:bg-canvas-surface hover:text-canvas-text active:scale-[.98]"
                              onClick={() => setActionNodePickerTargetId((current) => (
                                current === action.id ? null : action.id
                              ))}
                            >
                              <Icon icon="lucide:panel-top" width="16" height="16" aria-hidden="true" />
                              {t('从画布添加')}
                            </button>
                            {actionNodePickerTargetId === action.id ? (
                              <div className="col-span-2 rounded-lg border border-canvas-border bg-canvas-surface p-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[10px] font-medium text-canvas-text-secondary">
                                    {t('选择画布图片 / GIF / 视频节点')}
                                  </span>
                                  <button
                                    type="button"
                                    className="grid size-6 place-items-center rounded-md text-canvas-text-muted transition-[color,background-color] duration-150 hover:bg-canvas-hover hover:text-canvas-text"
                                    aria-label={t('关闭画布节点选择')}
                                    onClick={() => setActionNodePickerTargetId(null)}
                                  >
                                    <Icon icon="lucide:x" width="12" height="12" aria-hidden="true" />
                                  </button>
                                </div>
                                {pickableActionNodes.length === 0 ? (
                                  <div className="mt-2 flex min-h-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-canvas-border px-3 text-center text-[10px] text-canvas-text-muted">
                                    <Icon icon="lucide:film" width="16" height="16" aria-hidden="true" />
                                    {t('画布中暂无图片、GIF 或视频节点')}
                                  </div>
                                ) : (
                                  <div className="mt-2 grid max-h-48 grid-cols-3 gap-2 overflow-y-auto pr-1 max-sm:grid-cols-2">
                                    {pickableActionNodes.map((node) => {
                                      const previewUrl = node.data.videoUrl
                                        || node.data.imageUrl
                                        || node.data.thumbnailUrl;
                                      const label = node.data.label
                                        || node.data.fileName
                                        || t('未命名节点');
                                      return (
                                        <button
                                          key={node.id}
                                          type="button"
                                          className="group min-w-0 overflow-hidden rounded-md border border-canvas-border bg-canvas-card text-left transition-[transform,border-color,background-color] duration-150 ease-out hover:border-indigo-400 hover:bg-canvas-hover active:scale-[.98]"
                                          onClick={() => void handleBindActionNode(node.id)}
                                        >
                                          <span className="block aspect-video overflow-hidden bg-canvas-bg">
                                            {node.data.videoUrl ? (
                                              <ViewportVideo
                                                src={previewUrl}
                                                className="size-full object-cover"
                                                muted
                                                playsInline
                                                preload="metadata"
                                                aria-hidden="true"
                                              />
                                            ) : (
                                              <ViewportImage
                                                src={previewUrl}
                                                alt=""
                                                className="size-full object-cover"
                                                draggable={false}
                                              />
                                            )}
                                          </span>
                                          <span className="block truncate px-2 py-1.5 text-[10px] text-canvas-text-secondary group-hover:text-canvas-text">
                                            {label}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <form
              className="flex min-h-0 flex-col border-l border-canvas-border bg-canvas-card/80 max-md:border-l-0 max-md:border-t"
              onSubmit={(event) => {
                event.preventDefault();
                void handleAddAction();
              }}
            >
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="flex items-center gap-2">
                  <span className="grid size-8 place-items-center rounded-lg bg-indigo-500 text-white">
                    <Icon icon="lucide:plus" width="15" height="15" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="text-xs font-semibold">{t('添加动作')}</h3>
                    <p className="text-[10px] text-canvas-text-muted">{t('类别在添加时选择')}</p>
                  </div>
                </div>

                <label className="mt-4 grid gap-1 text-[10px] text-canvas-text-secondary">
                  {t('动作类别')}
                  <Select
                    value={actionCategory}
                    onChange={(value) => setActionCategory(value as CharacterActionCategory)}
                    triggerStyle={{ height: 36 }}
                    fixedMenu
                    options={CHARACTER_ACTION_CATEGORIES.map((category) => ({
                      value: category.id,
                      label: t(category.label),
                    }))}
                  />
                </label>

                {actionCategory === 'custom' ? (
                  <label className="mt-3 grid gap-1 text-[10px] text-canvas-text-secondary">
                    {t('自定义分类名')}
                    <input
                      value={customActionCategory}
                      onChange={(event) => setCustomActionCategory(event.target.value)}
                      placeholder={t('例如：武术、特殊技能')}
                      className="h-9 rounded-lg border border-canvas-border bg-canvas-surface px-3 text-xs text-canvas-text outline-none transition-[border-color] duration-150 focus:border-indigo-400"
                    />
                  </label>
                ) : null}

                <label className="mt-3 grid gap-1 text-[10px] text-canvas-text-secondary">
                  {t('动作名称')}
                  <input
                    value={actionName}
                    onChange={(event) => setActionName(event.target.value)}
                    placeholder={t('例如：警戒站姿')}
                    className="h-9 rounded-lg border border-canvas-border bg-canvas-surface px-3 text-xs text-canvas-text outline-none transition-[border-color] duration-150 focus:border-indigo-400"
                  />
                </label>

                <label className="mt-3 grid gap-1 text-[10px] text-canvas-text-secondary">
                  {t('动作提示词')}
                  <textarea
                    value={actionPrompt}
                    onChange={(event) => setActionPrompt(event.target.value)}
                    placeholder={t('描述姿势、重心、手部动作和运动方向…')}
                    rows={4}
                    className="resize-none rounded-lg border border-canvas-border bg-canvas-surface px-3 py-2 text-xs leading-5 text-canvas-text outline-none transition-[border-color] duration-150 focus:border-indigo-400"
                  />
                </label>

                <div className="mt-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-canvas-text-secondary">{t('动作媒体')}</span>
                    <span className="text-[9px] text-canvas-text-muted">{t('可多选')}</span>
                  </div>
                  {pendingActionMedia.length > 0 ? (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {pendingActionMedia.map((media) => (
                        <figure key={media.id} className="relative m-0 aspect-video overflow-hidden rounded-lg border border-canvas-border bg-canvas-surface">
                          {media.kind !== 'video' ? (
                            <ViewportImage src={media.url} alt={media.name} className="size-full object-cover" draggable={false} />
                          ) : (
                            <ViewportVideo src={media.url} className="size-full object-cover" aria-label={media.name} />
                          )}
                          <button
                            type="button"
                            className="absolute right-1 top-1 grid size-6 place-items-center rounded-md bg-black/60 text-white transition-transform duration-150 ease-out active:scale-[.97]"
                            aria-label={t('移除待添加媒体「{name}」', { name: media.name })}
                            onClick={() => setPendingActionMedia((current) => current.filter((item) => item.id !== media.id))}
                          >
                            <Icon icon="lucide:x" width="12" height="12" aria-hidden="true" />
                          </button>
                        </figure>
                      ))}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    disabled={uploadingActionMedia}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-canvas-border bg-canvas-surface px-3 py-3 text-[10px] text-canvas-text-secondary transition-[transform,color,border-color] duration-150 ease-out hover:border-indigo-400 hover:text-canvas-text active:scale-[.98] disabled:opacity-50"
                    onClick={() => openActionMediaPicker(null)}
                  >
                    <Icon icon={uploadingActionMedia ? 'lucide:loader-circle' : 'lucide:upload'} className={uploadingActionMedia ? 'animate-spin' : ''} width="14" height="14" aria-hidden="true" />
                    {uploadingActionMedia ? t('正在处理媒体…') : t('添加多份图片、GIF 或视频')}
                  </button>
                </div>
              </div>

              <footer className="border-t border-canvas-border p-4">
                <button
                  type="submit"
                  disabled={!actionName.trim() || savingAction || uploadingActionMedia}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 text-xs font-medium text-white transition-[transform,opacity,background-color] duration-150 ease-out hover:bg-indigo-400 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon icon={savingAction ? 'lucide:loader-circle' : 'lucide:plus'} className={savingAction ? 'animate-spin' : ''} width="14" height="14" aria-hidden="true" />
                  {savingAction ? t('正在保存…') : t('添加到动作库')}
                </button>
              </footer>
            </form>

            <input
              ref={actionMediaInputRef}
              type="file"
              accept={ACTION_MEDIA_ACCEPT}
              multiple
              className="sr-only"
              onChange={(event) => void handleActionMediaFiles(event)}
            />
          </div>
        </ModalOverlay>
      ) : null}

      {captureNodeId ? createPortal(
        <CharacterAssetDialog
          isOpen
          sourceNodeId={captureNodeId}
          initialScope={scope}
          initialCharacterId={selectedCharacter?.id}
          onClose={() => setCaptureNodeId(null)}
        />,
        document.body,
      ) : null}
    </>
  );
}
