/**
 * PresetManager 快捷指令管理器 — 管理用户快捷提示词的增删改查
 * 使用 createPortal 渲染到 body，避免受 React Flow 节点堆叠上下文影响
 * 使用 framer-motion 驱动面板进出场动画
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../../store/useAppStore';
import { generateId } from '../../../store/store.utils';
import type {
  ModelOption,
  NodeType,
  PresetAdvancedConfig,
  PresetNodeType,
  PresetTriggerMode,
  UserPreset,
  UserPresetMode,
} from '../../../types';
import {
  PRESET_NODE_TYPES,
  PRESET_NODE_TYPE_LABELS,
} from '../../../types';
import AnimatedButton from '../../shared/AnimatedButton';
import PopupCloseButton from '../../shared/PopupCloseButton';
import Select from '../../shared/Select';
import ModelSelector from './ModelSelector';
import QualityRatioSelector from './QualityRatioSelector';
import PresetAdvancedEditor from './PresetAdvancedEditor';
import { validatePresetAdvancedConfig } from '../../../services/presetTemplateService';
import { groupPresetsByFolder, resolvePresetFolderId, UNGROUPED_PRESET_FOLDER_ID } from '../../../utils/presetFolders';

const PLACEHOLDER_MARKER = '\u200B'; // zero-width space as placeholder pill

function createDefaultAdvancedConfig(nodeType: PresetNodeType): PresetAdvancedConfig {
  return {
    parameters: [],
    steps: [{
      id: 'step-' + generateId(),
      name: '步骤 1',
      nodeType,
      promptTemplate: '{{currentPrompt}}',
    }],
  };
}

function buildPillEl(label: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'preset-placeholder-pill';
  span.contentEditable = 'false';
  span.setAttribute('data-preset-placeholder', 'user-input');
  span.textContent = label;
  // zero-width space before and after so cursor can navigate around the pill
  const wrapper = document.createElement('span');
  wrapper.appendChild(document.createTextNode(PLACEHOLDER_MARKER));
  wrapper.appendChild(span);
  wrapper.appendChild(document.createTextNode(PLACEHOLDER_MARKER));
  return wrapper as unknown as HTMLSpanElement;
}

function serializePresetEditor(root: HTMLElement): string {
  let result = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += (node.textContent || '').replace(new RegExp(PLACEHOLDER_MARKER, 'g'), '');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.hasAttribute('data-preset-placeholder')) {
        result += '{{ 文章内容 }}';
      } else if (el.tagName === 'BR') {
        result += '\n';
      } else {
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    }
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return result.replace(/\n+$/, '');
}

function deserializeToEditor(root: HTMLElement, text: string) {
  root.innerHTML = '';
  const regex = /\{\{ 文章内容 \}\}/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      root.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }
    root.appendChild(buildPillEl('提示词'));
    lastIdx = regex.lastIndex;
  }
  if (lastIdx < text.length) {
    const remaining = text.slice(lastIdx);
    const lines = remaining.split('\n');
    lines.forEach((line, i) => {
      if (i > 0) root.appendChild(document.createElement('br'));
      if (line) root.appendChild(document.createTextNode(line));
    });
  }
}

/* ============================================
   Framer-motion animation variants
   ============================================ */

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const panelVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 20 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 350, damping: 30 },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 20,
    transition: { duration: 0.15, ease: 'easeIn' as const },
  },
};

export default function PresetManager() {
  // 只订阅用到的字段：面板常驻在节点对话框内，避免被无关的 store 变更带着重渲染
  const {
    userPresets,
    presetFolders,
    presetManagerOpen,
    setPresetManagerOpen,
    addUserPreset,
    updateUserPreset,
    deleteUserPreset,
    addPresetFolder,
    renamePresetFolder,
    deletePresetFolder,
    showToast,
  } = useAppStore(
    useShallow((s) => ({
      userPresets: s.userPresets,
      presetFolders: s.presetFolders,
      presetManagerOpen: s.presetManagerOpen,
      setPresetManagerOpen: s.setPresetManagerOpen,
      addUserPreset: s.addUserPreset,
      updateUserPreset: s.updateUserPreset,
      deleteUserPreset: s.deleteUserPreset,
      addPresetFolder: s.addPresetFolder,
      renamePresetFolder: s.renamePresetFolder,
      deletePresetFolder: s.deletePresetFolder,
      showToast: s.showToast,
    })),
  );

  const [activeTab, setActiveTab] = useState<PresetNodeType>('ai-text');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeFolderId, setActiveFolderId] = useState(UNGROUPED_PRESET_FOLDER_ID);
  const [folderId, setFolderId] = useState('');
  const [folderEditor, setFolderEditor] = useState<{ id?: string; name: string } | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('');
  const [triggerMode, setTriggerMode] = useState<PresetTriggerMode>('direct');
  const [presetMode, setPresetMode] = useState<UserPresetMode>('basic');
  const [advancedConfig, setAdvancedConfig] = useState<PresetAdvancedConfig>(
    () => createDefaultAdvancedConfig('ai-text'),
  );
  const [thumbnail, setThumbnail] = useState<string | undefined>();
  // 预设绑定的模型和尺寸（可选）
  const [presetModel, setPresetModel] = useState('');
  const [presetProvider, setPresetProvider] = useState('');
  const [presetImageSize, setPresetImageSize] = useState('');
  const [presetAspectRatio, setPresetAspectRatio] = useState('');
  // 是否已激活模型/尺寸覆盖（点了「指定」才展开选择器）
  const [modelOverrideActive, setModelOverrideActive] = useState(false);
  const [sizeOverrideActive, setSizeOverrideActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const loadedPresetRef = useRef<UserPreset | null>(null);
  // 判断当前标签是否支持尺寸选择
  const showSizeSelector = activeTab === 'ai-image';

  const filteredPresets = useMemo(
    () => userPresets.filter((p) => p.nodeType === activeTab),
    [activeTab, userPresets],
  );
  const folderGroups = useMemo(() => groupPresetsByFolder(activeTab, userPresets, presetFolders), [activeTab, userPresets, presetFolders]);
  const selectedPreset = userPresets.find((preset) => preset.id === selectedId && preset.nodeType === activeTab);

  // 高级模式的结构错误实时算，编辑器里已经列出来了，这里只用来锁保存
  const advancedError = useMemo(
    () => (presetMode === 'advanced' ? validatePresetAdvancedConfig(advancedConfig)[0] : undefined),
    [advancedConfig, presetMode],
  );

  // Load selected preset
  useEffect(() => {
    if (!presetManagerOpen) {
      loadedPresetRef.current = null;
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!selectedId) {
        loadedPresetRef.current = null;
        setName('');
        setDescription('');
        setTemplate('');
        setFolderId('');
        setTriggerMode('direct');
        setPresetMode('basic');
        setAdvancedConfig(createDefaultAdvancedConfig(activeTab));
        setThumbnail(undefined);
        setPresetModel('');
        setPresetProvider('');
        setPresetImageSize('');
        setPresetAspectRatio('');
        setModelOverrideActive(false);
        setSizeOverrideActive(false);
        if (editorRef.current) editorRef.current.innerHTML = '';
        return;
      }
      const preset = selectedPreset;
      if (preset) {
        const previous = loadedPresetRef.current;
        loadedPresetRef.current = preset;
        // 分类变化不重载正文，保留尚未保存的名称、模板和模型草稿。
        const keys = Object.keys({ ...previous, ...preset }) as Array<keyof UserPreset>;
        if (previous && keys.every((key) => key === 'folderId' || previous[key] === preset[key])) {
          setFolderId((current) => resolvePresetFolderId({ nodeType: activeTab, folderId: current }, presetFolders) || '');
          return;
        }
        setName(preset.name);
        setDescription(preset.description);
        setTemplate(preset.promptTemplate);
        setFolderId(preset.folderId || '');
        setTriggerMode(preset.triggerMode);
        setPresetMode(preset.mode === 'advanced' ? 'advanced' : 'basic');
        setAdvancedConfig(preset.advanced ?? createDefaultAdvancedConfig(preset.nodeType));
        setThumbnail(preset.thumbnail);
        setPresetModel(preset.model || '');
        setPresetProvider(preset.provider || '');
        setPresetImageSize(preset.imageSize || '');
        setPresetAspectRatio(preset.aspectRatio || '');
        setModelOverrideActive(!!preset.model);
        setSizeOverrideActive(!!preset.imageSize || !!preset.aspectRatio);
        if (editorRef.current) {
          deserializeToEditor(editorRef.current, preset.promptTemplate);
        }
      }
    });
    return () => { cancelled = true; };
  }, [activeTab, presetManagerOpen, selectedId, selectedPreset, presetFolders]);

  // When switching tabs, select first preset
  useEffect(() => {
    if (selectedId && filteredPresets.some((preset) => preset.id === selectedId)) return;
    const first = filteredPresets[0];
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSelectedId(first?.id ?? null);
      setActiveFolderId(first?.folderId || UNGROUPED_PRESET_FOLDER_ID);
    });
    return () => { cancelled = true; };
  }, [activeTab, filteredPresets, selectedId]);

  useEffect(() => {
    if (folderGroups.some((group) => group.id === activeFolderId)) return;
    queueMicrotask(() => setActiveFolderId(UNGROUPED_PRESET_FOLDER_ID));
  }, [activeFolderId, folderGroups]);

  const handleNew = useCallback(async () => {
    if (saving || folderBusy) return;
    setSaving(true);
    const newId = generateId();
    const newPreset: UserPreset = {
      id: newId,
      nodeType: activeTab,
      name: '自定义快捷指令',
      description: '输入说明与提示词模板',
      promptTemplate: '',
      triggerMode: 'direct',
      mode: 'basic',
      folderId: activeFolderId === UNGROUPED_PRESET_FOLDER_ID ? undefined : activeFolderId,
      advanced: createDefaultAdvancedConfig(activeTab),
    };
    try {
      await addUserPreset(newPreset);
      setSelectedId(newId);
    } catch (error) { showToast(error instanceof Error ? error.message : '新建快捷指令失败', 'error'); }
    finally { setSaving(false); }
  }, [activeTab, activeFolderId, addUserPreset, saving, folderBusy, showToast]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (saving || folderBusy) return;
      setSaving(true);
      try {
        await deleteUserPreset(id);
        if (selectedId === id) {
          const remaining = userPresets.filter(
            (p) => p.id !== id && p.nodeType === activeTab,
          );
          setSelectedId(remaining[0]?.id ?? null);
          setActiveFolderId(remaining[0]?.folderId || UNGROUPED_PRESET_FOLDER_ID);
        }
        showToast('快捷指令已删除');
      } catch (error) { showToast(error instanceof Error ? error.message : '删除快捷指令失败', 'error'); }
      finally { setSaving(false); }
    },
    [deleteUserPreset, selectedId, userPresets, activeTab, showToast, saving, folderBusy],
  );

  const handleSave = useCallback(async () => {
    if (!selectedId || !name.trim() || saving || folderBusy) return;
    if (presetMode === 'advanced') {
      const advancedErrors = validatePresetAdvancedConfig(advancedConfig);
      if (advancedErrors[0]) {
        showToast(advancedErrors[0], 'error');
        return;
      }
    }
    const templateFromEditor = presetMode === 'basic' && editorRef.current
      ? serializePresetEditor(editorRef.current)
      : template;
    setSaving(true);
    try {
      const savedFolderId = resolvePresetFolderId({ nodeType: activeTab, folderId: folderId || undefined }, presetFolders);
      await updateUserPreset(selectedId, {
        name: name.trim(),
        description: description.trim(),
        promptTemplate: templateFromEditor,
        triggerMode,
        folderId: savedFolderId,
        thumbnail,
        model: modelOverrideActive ? (presetModel || undefined) : undefined,
        provider: modelOverrideActive ? (presetProvider || undefined) : undefined,
        imageSize: sizeOverrideActive ? (presetImageSize || undefined) : undefined,
        aspectRatio: sizeOverrideActive ? (presetAspectRatio || undefined) : undefined,
        mode: presetMode,
        advanced: advancedConfig,
      });
      showToast('快捷指令已保存');
      setActiveFolderId(savedFolderId || UNGROUPED_PRESET_FOLDER_ID);
    } catch (error) { showToast(error instanceof Error ? error.message : '保存失败，编辑内容已保留', 'error'); }
    finally { setSaving(false); }
  }, [selectedId, name, description, template, triggerMode, folderId, activeTab, presetFolders, thumbnail, presetModel, presetProvider, presetImageSize, presetAspectRatio, modelOverrideActive, sizeOverrideActive, presetMode, advancedConfig, updateUserPreset, showToast, saving, folderBusy]);

  const handleFolderSave = async () => {
    if (!folderEditor || folderBusy || saving) return;
    setFolderBusy(true);
    try {
      if (folderEditor.id) await renamePresetFolder(folderEditor.id, folderEditor.name);
      else {
        const folder = await addPresetFolder(activeTab, folderEditor.name);
        setActiveFolderId(folder.id);
      }
      setFolderEditor(null);
    } catch (error) { showToast(error instanceof Error ? error.message : '文件夹保存失败', 'error'); }
    finally { setFolderBusy(false); }
  };

  const handleFolderDelete = async () => {
    if (!folderToDelete || folderBusy || saving) return;
    setFolderBusy(true);
    try {
      await deletePresetFolder(folderToDelete);
      if (folderId === folderToDelete) setFolderId('');
      setActiveFolderId(UNGROUPED_PRESET_FOLDER_ID);
      setFolderToDelete(null);
      showToast('文件夹已移除，快捷指令保留并直接显示');
    } catch (error) { showToast(error instanceof Error ? error.message : '移除文件夹失败', 'error'); }
    finally { setFolderBusy(false); }
  };

  const handlePresetModeChange = useCallback((mode: UserPresetMode) => {
    setPresetMode(mode);
    if (mode === 'basic') {
      requestAnimationFrame(() => {
        if (editorRef.current) deserializeToEditor(editorRef.current, template);
      });
    }
  }, [template]);

  const handleThumbnailUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        setThumbnail(reader.result as string);
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  const handleEditorInput = useCallback(() => {
    if (editorRef.current) {
      setTemplate(serializePresetEditor(editorRef.current));
    }
  }, []);

  const handleInsertPlaceholder = useCallback(() => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const pill = buildPillEl('提示词');
    range.insertNode(pill);
    range.setStartAfter(pill);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    handleEditorInput();
  }, [handleEditorInput]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing) return; // 输入法组合中，回车属于候选框
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleEditorInput();
      }
    },
    [handleEditorInput],
  );

  const handlePresetModelSelect = useCallback((model: ModelOption) => {
    setPresetModel(model.value);
    setPresetProvider(model.provider);
    setModelOverrideActive(true);
  }, []);

  const handlePresetImageSizeChange = useCallback((size: string) => {
    setPresetImageSize(size);
    setSizeOverrideActive(true);
  }, []);

  const handlePresetAspectRatioChange = useCallback((ratio: string) => {
    setPresetAspectRatio(ratio);
    setSizeOverrideActive(true);
  }, []);

  return createPortal(
    <AnimatePresence>
      {presetManagerOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            data-tauri-drag-region
            className="preset-modal-overlay"
            variants={backdropVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={{ duration: 0.2 }}
            onClick={() => setPresetManagerOpen(false)}
          />

          {/* Centering wrapper — avoids framer-motion transform clashing with CSS centering */}
          <div className="preset-modal-wrapper">
            <motion.div
              className="preset-modal preset-modal--manager"
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
            >
        {/* Header */}
        <div className="preset-manager-title-row">
          <div className="preset-manager-title-group">
            <div className="preset-modal-title">快捷指令</div>
            <div className="preset-modal-desc">
              管理 {PRESET_NODE_TYPE_LABELS[activeTab].replace('预设', '快捷指令')} 的提示词模板
            </div>
          </div>
          <PopupCloseButton onClick={() => setPresetManagerOpen(false)} />
        </div>

        {/* Tabs */}
        <div className="preset-manager-tabs" role="tablist">
          {PRESET_NODE_TYPES.map((nt) => (
            <motion.button
              key={nt}
              type="button"
              className={`preset-manager-tab${activeTab === nt ? ' is-active' : ''}`}
              role="tab"
              aria-selected={activeTab === nt}
              disabled={saving || folderBusy}
              onClick={() => { setActiveTab(nt); setFolderEditor(null); setFolderToDelete(null); }}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
            >
              <svg
                className="preset-manager-tab-icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                {nt === 'ai-text' && (
                  <>
                    <polyline points="4 7 4 4 20 4 20 7" />
                    <line x1="9" y1="20" x2="15" y2="20" />
                    <line x1="12" y1="4" x2="12" y2="20" />
                  </>
                )}
                {nt === 'ai-image' && (
                  <>
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </>
                )}
                {nt === 'ai-video' && (
                  <>
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" />
                  </>
                )}
                {nt === 'ai-audio' && (
                  <>
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </>
                )}
              </svg>
              <span>{PRESET_NODE_TYPE_LABELS[nt]}</span>
            </motion.button>
          ))}
        </div>

        {/* Body: sidebar + detail */}
        <div className="preset-manager-shell">
          <div className="preset-manager-sidebar">
            <AnimatedButton type="button" className="preset-manager-new-btn" onClick={handleNew} disabled={saving || folderBusy}>
              新建
            </AnimatedButton>
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--block" disabled={saving || folderBusy}
              onClick={() => { setFolderToDelete(null); setFolderEditor({ name: '' }); }}>
              <Icon icon="mdi:folder-plus-outline" width={16} /> 新建文件夹
            </button>
            {folderEditor && <form className="space-y-2 rounded border border-canvas-border p-2" onSubmit={(event) => { event.preventDefault(); void handleFolderSave(); }}>
              <input className="ui-input ui-input--sm w-full" aria-label="文件夹名称" placeholder="文件夹名称" maxLength={80}
                autoFocus value={folderEditor.name} disabled={saving || folderBusy}
                onChange={(event) => setFolderEditor({ ...folderEditor, name: event.target.value })} />
              <div className="flex justify-end gap-1">
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={saving || folderBusy} onClick={() => setFolderEditor(null)}>取消</button>
                <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={saving || folderBusy || !folderEditor.name.trim()}>保存</button>
              </div>
            </form>}
            {folderToDelete && <div className="space-y-2 rounded border border-canvas-border p-2" role="group" aria-label="移除文件夹确认">
              <p className="m-0 text-xs text-canvas-text-secondary">移除文件夹后，指令会直接显示，内容保留。</p>
              <div className="flex justify-end gap-1">
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={saving || folderBusy} onClick={() => setFolderToDelete(null)}>取消</button>
                <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={saving || folderBusy} onClick={handleFolderDelete}>移除</button>
              </div>
            </div>}
            <div className="preset-manager-list">
              {folderGroups.map((group) => {
                const isUngrouped = group.id === UNGROUPED_PRESET_FOLDER_ID;
                if (isUngrouped && group.presets.length === 0) return null;
                return (
                  <section key={group.id} className="min-w-0">
                    {!isUngrouped && <div className="flex items-center gap-1">
                      <button type="button" className={`ui-menu__item min-w-0 flex-1${activeFolderId === group.id ? ' is-active' : ''}`}
                        aria-expanded={activeFolderId === group.id} disabled={saving || folderBusy}
                        onClick={() => setActiveFolderId(group.id)}>
                        <Icon icon={activeFolderId === group.id ? 'mdi:folder-open-outline' : 'mdi:folder-outline'} width={16} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate" title={group.name}>{group.name}</span>
                        <span className="ui-menu__shortcut">{group.presets.length}</span>
                      </button>
                        <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" aria-label={`重命名文件夹 ${group.name}`}
                          disabled={saving || folderBusy} onClick={() => { setFolderToDelete(null); setFolderEditor({ id: group.id, name: group.name }); }}>
                          <Icon icon="mdi:pencil-outline" width={14} />
                        </button>
                        <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost ui-icon-btn--danger" aria-label={`移除文件夹 ${group.name}`}
                          disabled={saving || folderBusy} onClick={() => { setFolderEditor(null); setFolderToDelete(group.id); }}>
                          <Icon icon="mdi:folder-remove-outline" width={14} />
                        </button>
                    </div>}
                    {(isUngrouped || activeFolderId === group.id) && <div className={isUngrouped ? undefined : 'ml-2 border-l border-canvas-border pl-1'}>
                      {group.presets.map((preset) => (
                        <div
                          key={preset.id}
                          role="button"
                          tabIndex={0}
                          className={`preset-manager-list-item${selectedId === preset.id ? ' is-active' : ''}`}
                          title={preset.description || preset.name}
                          aria-disabled={saving || folderBusy}
                          onClick={() => {
                            if (saving || folderBusy) return;
                            setSelectedId(preset.id);
                            setActiveFolderId(group.id);
                          }}
                          onKeyDown={(e) => {
                            if (!saving && !folderBusy && (e.key === 'Enter' || e.key === ' ')) {
                              e.preventDefault();
                              setSelectedId(preset.id);
                              setActiveFolderId(group.id);
                            }
                          }}
                        >
                          <label
                            className="preset-manager-list-thumb"
                            data-tooltip="上传缩略图"
                            data-tooltip-source="native-title"
                            data-native-title="上传缩略图"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {preset.thumbnail ? (
                              <img
                                className="preset-manager-list-thumb-img"
                                src={preset.thumbnail}
                                alt=""
                              />
                            ) : (
                              <span className="preset-manager-list-thumb-plus">+</span>
                            )}
                            <input
                              className="preset-manager-thumb-input"
                              type="file"
                              accept="image/*"
                              disabled={saving || folderBusy}
                              onChange={(e) => {
                                setActiveFolderId(group.id);
                                if (selectedId === preset.id) {
                                  handleThumbnailUpload(e);
                                } else {
                                  // If another preset is selected, select this one first then upload
                                  setSelectedId(preset.id);
                                  // Need to defer the upload since setSelectedId is async
                                  setTimeout(() => handleThumbnailUpload(e), 0);
                                }
                              }}
                              ref={selectedId === preset.id ? fileInputRef : undefined}
                            />
                          </label>
                          <span className="preset-manager-list-text">
                            <span className="preset-manager-list-title">{preset.name}</span>
                          </span>
                          <AnimatedButton
                            type="button"
                            className="preset-manager-list-delete"
                            disabled={saving || folderBusy}
                            aria-label={`删除 ${preset.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(preset.id);
                            }}
                          >
                            ×
                          </AnimatedButton>
                        </div>
                      ))}
                      {group.presets.length === 0 && <div className="p-2 text-xs text-canvas-text-muted">此文件夹暂无快捷指令</div>}
                    </div>}
                  </section>
                );
              })}
              {filteredPresets.length === 0 && (
                <div className="preset-manager-list-empty">
                  暂无快捷指令，点击「新建」创建
                </div>
              )}
            </div>
          </div>

          {/* Detail pane */}
          <div className="preset-manager-detail-pane">
            {selectedId ? (
              <fieldset className="preset-manager-detail m-0 min-w-0 border-0 p-0" disabled={saving || folderBusy}>
                <label className="preset-manager-field">
                  <span className="preset-manager-label">名字</span>
                  <input
                    className="preset-manager-input"
                    type="text"
                    placeholder="快捷指令名称"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                {folderGroups.length > 1 && <label className="preset-manager-field">
                  <span className="preset-manager-label">所属文件夹</span>
                  <Select fixedMenu className="w-full" value={folderId} onChange={setFolderId}>
                    <option value="">无文件夹</option>
                    {presetFolders.filter((folder) => folder.nodeType === activeTab).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                  </Select>
                </label>}
                <label className="preset-manager-field">
                  <span className="preset-manager-label">说明</span>
                  <input
                    className="preset-manager-input"
                    type="text"
                    placeholder="说明这个快捷指令适合什么场景"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <div className="preset-manager-mode-picker">
                  <div>
                    <span className="preset-manager-label">配置模式</span>
                    <span className="preset-manager-mode-help">
                      {presetMode === 'basic'
                        ? '适合快速保存单次提示词操作'
                        : '使用参数和步骤定义顺序生成链'}
                    </span>
                  </div>
                  <div className="preset-manager-mode-segment" role="group" aria-label="配置模式">
                    <button
                      type="button"
                      className={presetMode === 'basic' ? 'is-active' : ''}
                      aria-pressed={presetMode === 'basic'}
                      onClick={() => handlePresetModeChange('basic')}
                    >
                      基础
                    </button>
                    <button
                      type="button"
                      className={presetMode === 'advanced' ? 'is-active' : ''}
                      aria-pressed={presetMode === 'advanced'}
                      onClick={() => handlePresetModeChange('advanced')}
                    >
                      高级
                    </button>
                  </div>
                </div>
                {presetMode === 'basic' ? (
                  <>
                <div className="preset-manager-template-tools">
                  <span className="preset-manager-label">提示词模板</span>
                  <AnimatedButton
                    type="button"
                    className="preset-modal-btn-secondary preset-manager-insert-btn"
                    onClick={handleInsertPlaceholder}
                  >
                    点击插入提示词栏内容
                  </AnimatedButton>
                </div>
                <div className="preset-manager-editor-wrap">
                  <div
                    ref={editorRef}
                    className="preset-manager-textarea preset-manager-editor"
                    contentEditable={!saving && !folderBusy}
                    suppressContentEditableWarning
                    spellCheck={false}
                    onInput={handleEditorInput}
                    onKeyDown={handleKeyDown}
                  />
                  {!template && (
                    <div className="preset-manager-editor-placeholder" aria-hidden="true">
                      例如：生成全身三视图，包含正视图、45度侧视图、后视图，背景简洁
                      人物参考{' '}
                      <span
                        className="preset-placeholder-pill"
                        contentEditable={false}
                        data-preset-placeholder="user-input"
                      >
                        提示词
                      </span>
                    </div>
                  )}
                </div>

                {/* 模型选择（可选） */}
                <div className="preset-manager-section">
                  <span className="preset-manager-section-title">模型</span>
                  <span className="preset-manager-section-desc">
                    {modelOverrideActive ? '已指定模型，生图时覆盖节点设置' : '未指定则使用节点当前模型'}
                  </span>
                  {modelOverrideActive ? (
                    <>
                      <ModelSelector
                        nodeType={activeTab as NodeType}
                        selectedModel={presetModel || undefined}
                        selectedProvider={presetProvider || undefined}
                        onSelect={handlePresetModelSelect}
                      />
                      <button
                        type="button"
                        className="preset-manager-section-toggle"
                        onClick={() => { setModelOverrideActive(false); setPresetModel(''); setPresetProvider(''); }}
                      >
                        取消指定
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="preset-manager-section-toggle"
                      onClick={() => setModelOverrideActive(true)}
                    >
                      + 指定模型
                    </button>
                  )}
                </div>

                {/* 尺寸选择（仅图片预设显示） */}
                {showSizeSelector && (
                  <div className="preset-manager-section">
                    <span className="preset-manager-section-title">尺寸</span>
                    <span className="preset-manager-section-desc">
                      {sizeOverrideActive ? '已指定尺寸，生图时覆盖节点设置' : '未指定则使用节点当前画质和比例'}
                    </span>
                    {sizeOverrideActive ? (
                      <>
                        <QualityRatioSelector
                          imageSize={presetImageSize || undefined}
                          aspectRatio={presetAspectRatio || undefined}
                          onChangeImageSize={handlePresetImageSizeChange}
                          onChangeAspectRatio={handlePresetAspectRatioChange}
                          showImageSize
                        />
                        <button
                          type="button"
                          className="preset-manager-section-toggle"
                          onClick={() => { setSizeOverrideActive(false); setPresetImageSize(''); setPresetAspectRatio(''); }}
                        >
                          取消指定
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="preset-manager-section-toggle"
                        onClick={() => setSizeOverrideActive(true)}
                      >
                        + 指定尺寸
                      </button>
                    )}
                  </div>
                )}
                  </>
                ) : (
                  <PresetAdvancedEditor
                    config={advancedConfig}
                    defaultNodeType={activeTab}
                    onChange={setAdvancedConfig}
                  />
                )}
              </fieldset>
            ) : (
              <div className="preset-manager-detail-empty">
                选择一个快捷指令或新建一个
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="preset-modal-actions">
          {presetMode === 'basic' ? (
            <div className="preset-manager-trigger-modes" role="group" aria-label="快捷指令触发方式">
              <span className="preset-manager-trigger-mode-label">模式：</span>
              <AnimatedButton
                type="button"
                className={`preset-manager-trigger-mode${triggerMode === 'direct' ? ' is-active' : ''}`}
                data-trigger-mode="direct"
                aria-pressed={triggerMode === 'direct'}
                disabled={saving || folderBusy}
                onClick={() => setTriggerMode('direct')}
              >
                直接触发
              </AnimatedButton>
              <AnimatedButton
                type="button"
                className={`preset-manager-trigger-mode${triggerMode === 'insertPrompt' ? ' is-active' : ''}`}
                data-trigger-mode="insertPrompt"
                aria-pressed={triggerMode === 'insertPrompt'}
                disabled={saving || folderBusy}
                onClick={() => setTriggerMode('insertPrompt')}
              >
                加入提示词
              </AnimatedButton>
            </div>
          ) : (
            <div className="preset-manager-sequence-mode">
              <span className="preset-manager-sequence-dot" aria-hidden="true" />
              <span>按步骤顺序自动执行，失败时停止</span>
            </div>
          )}
          <AnimatedButton
            type="button"
            className="preset-modal-btn-primary"
            onClick={handleSave}
            disabled={saving || folderBusy || !selectedId || !name.trim() || !!advancedError}
            title={advancedError}
          >
            保存
          </AnimatedButton>
        </div>
      </motion.div>
      </div>{/* /preset-modal-wrapper */}
    </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
