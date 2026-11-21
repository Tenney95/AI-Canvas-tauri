import { t, useT } from '../../i18n';
import Select from '../shared/Select';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { isEligibleCharacterReferenceNode, isEligibleCharacterVoiceNode } from '../../store/store.dramaAssets';
import { normalizeAssetKey } from '../../services/dramaAssetExtract';
import type { CharacterActionCategory, CharacterReferenceKind, CharacterVoiceKind, DramaCharacter } from '../../types/dramaAssets';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import MentionEditor from '../nodes/shared/MentionEditor';
import { actionMediaFromCanvasNode } from './characterActionMedia';
import ViewportImage from '../shared/ViewportImage';
import ViewportVideo from '../shared/ViewportVideo';
import ViewportAudio from '../shared/ViewportAudio';
import { createEmptyCharacter, REFERENCE_KINDS, VOICE_KINDS, type CharacterLibraryScope } from './characterAssetFields';

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

export interface CharacterNodeCaptureDialogProps {
  isOpen: boolean;
  sourceNodeId: string;
  /** 从角色库发起时预选当前角色，右键菜单发起时不传 */
  initialScope?: CharacterLibraryScope;
  initialCharacterId?: string;
  onClose: () => void;
}

export default function CharacterNodeCaptureDialog({
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
