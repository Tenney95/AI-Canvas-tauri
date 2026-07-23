/**
 * PresetManager 快捷指令管理器 — 管理用户快捷提示词的增删改查
 * 使用 createPortal 渲染到 body，避免受 React Flow 节点堆叠上下文影响
 * 使用 framer-motion 驱动面板进出场动画
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
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
import ModelSelector from './ModelSelector';
import QualityRatioSelector from './QualityRatioSelector';
import PresetAdvancedEditor from './PresetAdvancedEditor';
import { validatePresetAdvancedConfig } from '../../../services/presetTemplateService';

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
  const {
    userPresets,
    presetManagerOpen,
    setPresetManagerOpen,
    addUserPreset,
    updateUserPreset,
    deleteUserPreset,
    showToast,
  } = useAppStore();

  const [activeTab, setActiveTab] = useState<PresetNodeType>('ai-text');
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  // 判断当前标签是否支持尺寸选择
  const showSizeSelector = activeTab === 'ai-image';

  const filteredPresets = useMemo(
    () => userPresets.filter((p) => p.nodeType === activeTab),
    [activeTab, userPresets],
  );

  // Load selected preset
  useEffect(() => {
    queueMicrotask(() => {
      if (!selectedId) {
        setName('');
        setDescription('');
        setTemplate('');
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
      const preset = userPresets.find((p) => p.id === selectedId);
      if (preset) {
        setName(preset.name);
        setDescription(preset.description);
        setTemplate(preset.promptTemplate);
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
  }, [activeTab, selectedId, userPresets]);

  // When switching tabs, select first preset
  useEffect(() => {
    const first = filteredPresets[0];
    queueMicrotask(() => setSelectedId(first?.id ?? null));
  }, [activeTab, filteredPresets]);

  const handleNew = useCallback(() => {
    const newId = generateId();
    const newPreset: UserPreset = {
      id: newId,
      nodeType: activeTab,
      name: '自定义快捷指令',
      description: '输入说明与提示词模板',
      promptTemplate: '',
      triggerMode: 'direct',
      mode: 'basic',
      advanced: createDefaultAdvancedConfig(activeTab),
    };
    addUserPreset(newPreset);
    setSelectedId(newId);
  }, [activeTab, addUserPreset]);

  const handleDelete = useCallback(
    (id: string) => {
      deleteUserPreset(id);
      if (selectedId === id) {
        const remaining = userPresets.filter(
          (p) => p.id !== id && p.nodeType === activeTab,
        );
        setSelectedId(remaining[0]?.id ?? null);
      }
      showToast('快捷指令已删除');
    },
    [deleteUserPreset, selectedId, userPresets, activeTab, showToast],
  );

  const handleSave = useCallback(() => {
    if (!selectedId || !name.trim()) return;
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
    updateUserPreset(selectedId, {
      name: name.trim(),
      description: description.trim(),
      promptTemplate: templateFromEditor,
      triggerMode,
      thumbnail,
      model: modelOverrideActive ? (presetModel || undefined) : undefined,
      provider: modelOverrideActive ? (presetProvider || undefined) : undefined,
      imageSize: sizeOverrideActive ? (presetImageSize || undefined) : undefined,
      aspectRatio: sizeOverrideActive ? (presetAspectRatio || undefined) : undefined,
      mode: presetMode,
      advanced: advancedConfig,
    });
    showToast('快捷指令已保存');
  }, [selectedId, name, description, template, triggerMode, thumbnail, presetModel, presetProvider, presetImageSize, presetAspectRatio, modelOverrideActive, sizeOverrideActive, presetMode, advancedConfig, updateUserPreset, showToast]);

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
              onClick={() => setActiveTab(nt)}
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
            <AnimatedButton type="button" className="preset-manager-new-btn" onClick={handleNew}>
              新建
            </AnimatedButton>
            <div className="preset-manager-list">
              {filteredPresets.map((preset) => (
                <div
                  key={preset.id}
                  role="button"
                  tabIndex={0}
                  className={`preset-manager-list-item${selectedId === preset.id ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(preset.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setSelectedId(preset.id);
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
                      onChange={(e) => {
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
                    <span className="preset-manager-list-desc">
                      {preset.description || '输入说明与提示词模板'}
                    </span>
                  </span>
                  <AnimatedButton
                    type="button"
                    className="preset-manager-list-delete"
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
              <div className="preset-manager-detail">
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
                    contentEditable
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
              </div>
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
                onClick={() => setTriggerMode('direct')}
              >
                直接触发
              </AnimatedButton>
              <AnimatedButton
                type="button"
                className={`preset-manager-trigger-mode${triggerMode === 'insertPrompt' ? ' is-active' : ''}`}
                data-trigger-mode="insertPrompt"
                aria-pressed={triggerMode === 'insertPrompt'}
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
          <AnimatedButton type="button" className="preset-modal-btn-primary" onClick={handleSave}>
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
