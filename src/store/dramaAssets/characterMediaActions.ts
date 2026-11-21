import type { StateCreator } from 'zustand';
import type { AppState } from '../useAppStore';
import type { Node } from '@xyflow/react';
import type { CharacterReferenceImage, CharacterVoiceClip } from '../../types/dramaAssets';
import { normalizeDramaCharacter } from '../../types/dramaAssets';
import { generateId } from '../store.utils';
import type { BaseNodeData, CharacterLibraryNodeLink } from '../../types';
import {
  registerCanvasDerivation,
  isCanvasDerivationFresh,
  completeCanvasDerivation,
} from '../../services/canvasDerivationGuard';
import { saveGlobalCharacterCard } from '../../services/characterLibraryService';
import {
  findScopedCharacter,
  isEligibleCharacterReferenceNode,
  isEligibleCharacterVoiceNode,
  silentSave,
  saveCharacterActionWithNode,
  upsertCharacterReference,
  upsertCharacterVoiceClip,
  pickSpawnPosition,
} from './assetMutations';
import type { DramaAssetsSlice } from '../store.dramaAssets';

type CharacterMediaActions = Pick<DramaAssetsSlice,
  | 'captureImageNodeToCharacter'
  | 'createImageNodeFromCharacterReference'
  | 'addCharacterVoiceClip'
  | 'updateCharacterVoiceClip'
  | 'removeCharacterVoiceClip'
  | 'setCharacterPrimaryVoice'
  | 'addCharacterAction'
  | 'addCharacterActionMedia'
  | 'removeCharacterActionMedia'
  | 'removeCharacterAction'
  | 'bindAudioNodeToCharacterVoice'
  | 'createAudioNodeFromCharacterVoice'
  | 'createVoiceOverNodeFromCharacterVoice'>;

export function createCharacterMediaActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: () => AppState,
): CharacterMediaActions {
  return {
    captureImageNodeToCharacter: async (input) => {
      const initialState = get();
      const sourceNode = initialState.nodes.find((node) => node.id === input.nodeId);
      if (!sourceNode || !isEligibleCharacterReferenceNode(sourceNode)) {
        initialState.showToast?.('该节点没有可用的角色图片', 'error');
        return null;
      }
      const projectId = initialState.currentProjectId;
      if (!projectId) return null;

      const characters = input.scope === 'project'
        ? initialState.dramaAssets.characters
        : initialState.globalCharacters;
      const baseCharacter = input.characterId
        ? characters.find((character) => character.id === input.characterId)
        : input.newCharacter;
      if (!baseCharacter) {
        initialState.showToast?.('请选择角色', 'error');
        return null;
      }

      const previousLink = sourceNode.data.characterLibraryLinks?.find((link) => (
        link.scope === input.scope && link.characterId === baseCharacter.id && link.referenceImageId !== undefined
      ));
      const previousReference = baseCharacter.referenceImages?.find((reference) => (
        reference.id === previousLink?.referenceImageId
        || (input.scope === 'project' && reference.sourceNodeId === sourceNode.id)
      ));
      const now = Date.now();
      const reference: CharacterReferenceImage = {
        id: previousReference?.id ?? `reference-${generateId()}`,
        kind: input.kind,
        assetId: sourceNode.data.assetId,
        relativePath: sourceNode.data.relativePath,
        // 与节点共用同一份本地文件，不复制副本
        filePath: sourceNode.data.filePath,
        imageUrl: sourceNode.data.imageUrl ?? sourceNode.data.thumbnailUrl,
        sourceNodeId: sourceNode.id,
        prompt: input.prompt,
        createdAt: previousReference?.createdAt ?? now,
        updatedAt: now,
      };
      const nextCharacter = upsertCharacterReference(
        baseCharacter,
        reference,
        !baseCharacter.primaryReferenceImageId || input.kind === 'primary',
      );

      if (input.scope === 'project') {
        const previousLibrary = initialState.dramaAssets;
        const exists = previousLibrary.characters.some((item) => item.id === nextCharacter.id);
        set({
          dramaAssets: {
            ...previousLibrary,
            characters: exists
              ? previousLibrary.characters.map((item) => item.id === nextCharacter.id ? nextCharacter : item)
              : [...previousLibrary.characters, nextCharacter],
          },
        });
        const persistedProjectId = await get().saveCurrentProjectSilent();
        if (!persistedProjectId) {
          if (get().currentProjectId === projectId) set({ dramaAssets: previousLibrary });
          get().showToast?.('角色保存失败，画布节点保持显示', 'error');
          return null;
        }
      } else {
        try {
          const persisted = await saveGlobalCharacterCard(nextCharacter);
          set((state) => ({
            globalCharacters: state.globalCharacters.some((item) => item.id === persisted.id)
              ? state.globalCharacters.map((item) => item.id === persisted.id
                ? { ...persisted, libraryOrder: item.libraryOrder } : item)
              : [persisted, ...state.globalCharacters],
          }));
        } catch {
          get().showToast?.('全局角色保存失败，画布节点保持显示', 'error');
          return null;
        }
      }

      if (get().currentProjectId === projectId && get().nodes.some((node) => node.id === sourceNode.id)) {
        const link: CharacterLibraryNodeLink = {
          scope: input.scope,
          characterId: nextCharacter.id,
          referenceImageId: reference.id,
        };
        const linked = get().linkNodeToCharacter(sourceNode.id, link, input.hideNode);
        if (linked) void get().saveCurrentProjectSilent();
      }
      return { characterId: nextCharacter.id, referenceImageId: reference.id };
    },

    createImageNodeFromCharacterReference: (scope, characterId, referenceImageId) => {
      const state = get();
      const character = findScopedCharacter(state, scope, characterId);
      const reference = character?.referenceImages?.find((item) => item.id === referenceImageId);
      if (!character || !reference?.imageUrl) {
        state.showToast?.('参考图不可用', 'error');
        return null;
      }
      const linkedNode = state.nodes.find((node) => (
        node.id === reference.sourceNodeId
        || node.data.characterLibraryLinks?.some((link) => (
          link.scope === scope
          && link.characterId === characterId
          && link.referenceImageId === referenceImageId
        ))
      ));
      if (linkedNode) return linkedNode.id;

      const nodeId = `node-${generateId()}`;
      const link: CharacterLibraryNodeLink = { scope, characterId, referenceImageId };
      state.addNode({
        id: nodeId,
        type: 'source-image',
        position: pickSpawnPosition(state.nodes as Node<BaseNodeData>[]),
        data: {
          label: `${character.name} · 参考图`,
          type: 'source-image',
          role: 'source',
          status: 'success',
          prompt: reference.prompt,
          imageUrl: reference.imageUrl,
          thumbnailUrl: reference.imageUrl,
          assetId: reference.assetId,
          relativePath: reference.relativePath,
          filePath: reference.filePath,
          nodeWidth: 280,
          nodeHeight: 280,
          characterLibraryLinks: [link],
        },
      });
      if (scope === 'project') {
        void state.addCharacterReferenceImage('project', characterId, {
          ...reference,
          sourceNodeId: nodeId,
          updatedAt: Date.now(),
        });
      }
      return nodeId;
    },

    addCharacterVoiceClip: async (scope, characterId, clip, options) => {
      const character = findScopedCharacter(get(), scope, characterId);
      if (!character) return false;
      return get().saveCharacterCard(
        scope,
        upsertCharacterVoiceClip(character, clip, options?.makePrimary === true),
        options,
      );
    },

    updateCharacterVoiceClip: async (scope, characterId, clipId, patch, options) => {
      const character = findScopedCharacter(get(), scope, characterId);
      if (!character?.voiceClips?.some((clip) => clip.id === clipId)) return false;
      return get().saveCharacterCard(scope, normalizeDramaCharacter({
        ...character,
        voiceClips: character.voiceClips.map((clip) =>
          clip.id === clipId ? { ...clip, ...patch, updatedAt: Date.now() } : clip,
        ),
        updatedAt: Date.now(),
      }), options);
    },

    removeCharacterVoiceClip: async (scope, characterId, clipId, options) => {
      const state = get();
      const character = findScopedCharacter(state, scope, characterId);
      const clip = character?.voiceClips?.find((item) => item.id === clipId);
      if (!character || !clip) return false;
      const rest = (character.voiceClips ?? []).filter((item) => item.id !== clipId);
      const sourceNodeId = scope === 'project' ? clip.sourceNodeId : undefined;
      const guard = sourceNodeId ? registerCanvasDerivation(state, sourceNodeId) : null;
      try {
        const saved = await get().saveCharacterCard(scope, normalizeDramaCharacter({
          ...character,
          voiceClips: rest,
          primaryVoiceClipId: character.primaryVoiceClipId === clipId
            ? rest[0]?.id
            : character.primaryVoiceClipId,
          updatedAt: Date.now(),
        }), options);
        // 声音条目与来源节点共用素材，解除关联只恢复显隐，不删除节点、连线或文件。
        if (saved && sourceNodeId && guard && isCanvasDerivationFresh(guard, get())) {
          if (get().setCharacterLibraryNodeHidden(sourceNodeId, false)) silentSave(get);
        }
        return saved;
      } finally {
        if (guard) completeCanvasDerivation(guard);
      }
    },

    setCharacterPrimaryVoice: async (scope, characterId, clipId, options) => {
      const character = findScopedCharacter(get(), scope, characterId);
      if (!character?.voiceClips?.some((clip) => clip.id === clipId)) return false;
      return get().saveCharacterCard(scope, normalizeDramaCharacter({
        ...character,
        primaryVoiceClipId: clipId,
        updatedAt: Date.now(),
      }), options);
    },

    addCharacterAction: async (scope, characterId, action, capture) => {
      const character = findScopedCharacter(get(), scope, characterId);
      const name = action.name.trim();
      const prompt = action.prompt.trim();
      if (!character || !name) return null;
      const now = Date.now();
      const actionId = `action-${generateId()}`;
      const saved = await saveCharacterActionWithNode(set, get, scope, normalizeDramaCharacter({
        ...character,
        actions: [
          ...(character.actions ?? []),
          {
            id: actionId,
            category: action.category,
            customCategory: action.category === 'custom'
              ? action.customCategory?.trim() || undefined
              : undefined,
            name,
            prompt,
            media: action.media ?? [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        updatedAt: now,
      }), actionId, action.media ?? [], capture);
      return saved ? actionId : null;
    },

    addCharacterActionMedia: async (scope, characterId, actionId, media, capture) => {
      if (media.length === 0) return false;
      const character = findScopedCharacter(get(), scope, characterId);
      if (!character?.actions?.some((action) => action.id === actionId)) return false;
      const now = Date.now();
      return saveCharacterActionWithNode(set, get, scope, normalizeDramaCharacter({
        ...character,
        actions: character.actions.map((action) => action.id === actionId
          ? {
              ...action,
              media: [...(action.media ?? []), ...media],
              updatedAt: now,
            }
          : action),
        updatedAt: now,
      }), actionId, media, capture);
    },

    removeCharacterActionMedia: async (scope, characterId, actionId, mediaId) => {
      const projectId = get().currentProjectId;
      const character = findScopedCharacter(get(), scope, characterId);
      const action = character?.actions?.find((item) => item.id === actionId);
      if (!character || !action?.media?.some((item) => item.id === mediaId)) return false;
      const now = Date.now();
      const saved = await get().saveCharacterCard(scope, normalizeDramaCharacter({
        ...character,
        actions: character.actions?.map((item) => item.id === actionId
          ? {
              ...item,
              media: item.media?.filter((mediaItem) => mediaItem.id !== mediaId),
              updatedAt: now,
            }
          : item),
        updatedAt: now,
      }));
      if (saved && get().currentProjectId === projectId) {
        get().releaseCharacterLibraryNodes(scope, characterId, actionId, mediaId);
        silentSave(get);
      }
      return saved;
    },

    removeCharacterAction: async (scope, characterId, actionId) => {
      const projectId = get().currentProjectId;
      const character = findScopedCharacter(get(), scope, characterId);
      if (!character?.actions?.some((action) => action.id === actionId)) return false;
      const saved = await get().saveCharacterCard(scope, normalizeDramaCharacter({
        ...character,
        actions: character.actions.filter((action) => action.id !== actionId),
        updatedAt: Date.now(),
      }));
      if (saved && get().currentProjectId === projectId) {
        get().releaseCharacterLibraryNodes(scope, characterId, actionId);
        silentSave(get);
      }
      return saved;
    },

    bindAudioNodeToCharacterVoice: async (input) => {
      const state = get();
      const sourceNode = state.nodes.find((node) => node.id === input.nodeId);
      if (!sourceNode || !isEligibleCharacterVoiceNode(sourceNode)) {
        state.showToast?.('该节点没有可用的音频', 'error');
        return null;
      }
      const character = findScopedCharacter(state, input.scope, input.characterId);
      if (!character) {
        state.showToast?.('请选择角色', 'error');
        return null;
      }

      const existing = character.voiceClips?.find((clip) => (
        (input.scope === 'project' && clip.sourceNodeId === sourceNode.id)
        || Boolean(sourceNode.data.assetId && clip.assetId === sourceNode.data.assetId)
      ));
      const now = Date.now();
      const clip: CharacterVoiceClip = {
        id: existing?.id ?? `voice-${generateId()}`,
        kind: input.kind ?? existing?.kind ?? 'timbre',
        label: input.label?.trim() || existing?.label || sourceNode.data.label || undefined,
        assetId: sourceNode.data.assetId,
        relativePath: sourceNode.data.relativePath,
        // 与节点共用同一份本地文件，不复制副本
        filePath: sourceNode.data.filePath,
        audioUrl: sourceNode.data.audioUrl,
        // 全局角色不保存项目节点 ID
        sourceNodeId: input.scope === 'project' ? sourceNode.id : undefined,
        transcript: input.transcript
          ?? existing?.transcript
          ?? (typeof sourceNode.data.prompt === 'string' ? sourceNode.data.prompt : ''),
        durationSec: input.durationSec ?? existing?.durationSec,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const guard = input.hideNode ? registerCanvasDerivation(state, sourceNode.id) : null;
      try {
        const saved = await get().addCharacterVoiceClip(input.scope, character.id, clip, {
          makePrimary: input.makePrimary === true,
        });
        if (saved && guard && isCanvasDerivationFresh(guard, get())) {
          if (get().setCharacterLibraryNodeHidden(sourceNode.id, true)) silentSave(get);
        }
        return saved ? clip.id : null;
      } finally {
        if (guard) completeCanvasDerivation(guard);
      }
    },

    createAudioNodeFromCharacterVoice: (scope, characterId, clipId) => {
      const state = get();
      const character = findScopedCharacter(state, scope, characterId);
      const clip = character?.voiceClips?.find((item) => item.id === clipId);
      if (!character || !clip?.audioUrl) {
        state.showToast?.('角色声音不可用', 'error');
        return null;
      }
      const linkedNode = clip.sourceNodeId
        ? state.nodes.find((node) => node.id === clip.sourceNodeId)
        : undefined;
      if (linkedNode) return linkedNode.id;

      const nodeId = `node-${generateId()}`;
      state.addNode({
        id: nodeId,
        type: 'source-audio',
        position: pickSpawnPosition(state.nodes as Node<BaseNodeData>[]),
        data: {
          label: `${character.name} · ${clip.label?.trim() || '角色声音'}`,
          type: 'source-audio',
          role: 'source',
          status: 'success',
          prompt: clip.transcript,
          audioUrl: clip.audioUrl,
          assetId: clip.assetId,
          relativePath: clip.relativePath,
          filePath: clip.filePath,
          nodeWidth: 260,
          nodeHeight: 160,
        },
      });
      if (scope === 'project' && clip.sourceNodeId) {
        void state.addCharacterVoiceClip('project', characterId, {
          ...clip,
          sourceNodeId: nodeId,
          updatedAt: Date.now(),
        });
      }
      return nodeId;
    },

    createVoiceOverNodeFromCharacterVoice: (scope, characterId, clipId) => {
      const voiceNodeId = get().createAudioNodeFromCharacterVoice(scope, characterId, clipId);
      if (!voiceNodeId) return null;

      const state = get();
      const character = findScopedCharacter(state, scope, characterId);
      if (!character) return null;
      const clip = character.voiceClips?.find((item) => item.id === clipId);
      const voiceNode = state.nodes.find((node) => node.id === voiceNodeId);

      const nodeId = `node-${generateId()}`;
      const position = voiceNode
        ? { x: voiceNode.position.x + 340, y: voiceNode.position.y }
        : pickSpawnPosition(state.nodes as Node<BaseNodeData>[]);
      const newNode: Node<BaseNodeData> = {
        id: nodeId,
        type: 'ai-audio',
        position,
        data: {
          label: `${character.name} · 配音`,
          type: 'ai-audio',
          role: 'generator',
          status: 'idle',
          prompt: clip?.transcript ?? '',
          audioPurpose: 'speech',
          nodeWidth: 260,
          nodeHeight: 160,
        },
      };

      // 回填本地偏好模型（与侧栏添加音频节点一致）
      try {
        const raw = localStorage.getItem('canvas-model-prefs');
        if (raw) {
          const prefs: Record<string, string> = JSON.parse(raw);
          const modelValue = prefs['ai-audio'];
          if (modelValue && modelValue.includes('::')) {
            const [provider, model] = modelValue.split('::');
            if (provider && model) {
              newNode.data.provider = provider;
              newNode.data.model = model;
            }
          }
        }
      } catch { /* ignore */ }

      state.addNode(newNode);
      // 连线即引用：生成音频时这条线上的声音会作为音色参考
      // 句柄留空时 React Flow 会挑到两端各自的第一个（左）句柄，画出「左连左」的错线
      state.onConnect({
        source: voiceNodeId,
        target: nodeId,
        sourceHandle: 'right',
        targetHandle: 'left',
      });
      return nodeId;
    },
  };
}
