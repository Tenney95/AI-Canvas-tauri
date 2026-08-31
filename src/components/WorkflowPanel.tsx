/**
 * WorkflowPanel 工作流面板 — 管理 RunningHUB 工作流定义，支持导入 JSON、分类筛选、拖放到画布
 * 使用 framer-motion 驱动面板进出场动画
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, generateId } from '../store/useAppStore';
import type { WorkflowDefinition, WorkflowCategory, WorkflowIONode, WorkflowIONodeType } from '../types';
import { extractComfyUIIONodes, openComfyUIWorkflowEditor } from '../services/comfyUIWindowService';
import { comfyBaseUrlFor, DEFAULT_COMFY_URL } from '../services/comfyServers';
import PopupCloseButton from './shared/PopupCloseButton';
import Select from './shared/Select';

const CATEGORIES: { value: WorkflowCategory; label: string }[] = [
  { value: 'ai-text', label: '生成文本' },
  { value: 'ai-image', label: '生成图像' },
  { value: 'ai-video', label: '生成视频' },
  { value: 'ai-audio', label: '生成音频' },
];

/** 浏览器文件选择器：选取 .json 文件（解析与校验交给统一入口） */
function pickJsonFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      document.body.removeChild(input);
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve(null);
    });
    input.click();
  });
}

/** 已导入列表的分类筛选项 */
const LIST_FILTERS: { value: WorkflowCategory | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  ...CATEGORIES,
];

/** 分类值 → wf-cat-chip 节点主题色 modifier（选中态会改用对应节点色） */
const CATEGORY_CHIP_MODIFIER: Record<string, string> = {
  'ai-text': 'text',
  'ai-image': 'image',
  'ai-video': 'video',
  'ai-audio': 'audio',
};
function categoryChipModifier(value: string): string {
  const mod = CATEGORY_CHIP_MODIFIER[value];
  return mod ? ` wf-cat-chip--${mod}` : '';
}

/** 输入/输出节点类型 → 显示图标 */
const IONODE_ICONS: Record<WorkflowIONodeType, string> = {
  prompt: '📝',
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
};

/** 输入/输出节点类型 → 中文名，用于默认节点提示 */
const IONODE_LABELS: Record<WorkflowIONodeType, string> = {
  prompt: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
};

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

const itemVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.04, duration: 0.2, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

export default function WorkflowPanel() {
  const {
    workflows,
    workflowPanelOpen,
    setWorkflowPanelOpen,
    addWorkflow,
    deleteWorkflow,
    updateWorkflow,
    resetBuiltIns,
    comfyServers,
    showToast,
  } = useAppStore(
    useShallow((s) => ({
      workflows: s.workflows,
      workflowPanelOpen: s.workflowPanelOpen,
      setWorkflowPanelOpen: s.setWorkflowPanelOpen,
      addWorkflow: s.addWorkflow,
      deleteWorkflow: s.deleteWorkflow,
      updateWorkflow: s.updateWorkflow,
      resetBuiltIns: s.resetBuiltInWorkflows,
      comfyServers: s.config.comfyServers,
      showToast: s.showToast,
    })),
  );

  const [name, setName] = useState('');
  const [category, setCategory] = useState<WorkflowCategory>('ai-text');
  const [fileName, setFileName] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [ioNodes, setIoNodes] = useState<WorkflowIONode[]>([]);
  const [listFilter, setListFilter] = useState<WorkflowCategory | 'all'>('all');
  // 列表里节点徽章默认收起，展开的条目 id 记在这里
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState('');
  const [dragOver, setDragOver] = useState(false);
  // 重置会覆盖改过的内置工作流，点两下才执行
  const [resetArmed, setResetArmed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!workflowPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setWorkflowPanelOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [workflowPanelOpen, setWorkflowPanelOpen]);

  // Reset form
  const resetForm = useCallback(() => {
    setName('');
    setFileName('');
    setFileContent('');
    setIoNodes([]);
    setUploadError('');
    setUploadSuccess('');
  }, []);

  // Close and reset
  const handleClose = useCallback(() => {
    setWorkflowPanelOpen(false);
    setTimeout(resetForm, 200);
  }, [setWorkflowPanelOpen, resetForm]);

  // 点击选择与拖放共用的读取入口
  const acceptFile = useCallback(async (file: File) => {
    setUploadError('');
    setUploadSuccess('');
    if (!/\.json$/i.test(file.name)) {
      setUploadError('请选择 ComfyUI 导出的 .json 文件');
      return;
    }
    try {
      const content = await file.text();
      // Validate it's likely a ComfyUI workflow
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object') {
        setUploadError('不是有效的 JSON 文件');
        return;
      }
      setFileName(file.name);
      setFileContent(content);
      // Extract IO nodes
      setIoNodes(extractComfyUIIONodes(content));
      // Auto-fill name from filename
      setName((current) => current || file.name.replace(/\.json$/i, ''));
    } catch {
      setUploadError('JSON 解析失败，请检查文件格式');
    }
  }, []);

  const handlePickFile = useCallback(async () => {
    const file = await pickJsonFile();
    if (file) await acceptFile(file);
  }, [acceptFile]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void acceptFile(file);
  }, [acceptFile]);

  // 清掉已选文件，名称与分类留着，方便换个文件继续
  const handleClearFile = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setFileName('');
    setFileContent('');
    setIoNodes([]);
    setUploadError('');
  }, []);

  // Submit
  const handleSubmit = useCallback(async () => {
    if (!fileContent) {
      setUploadError('请先选择一个工作流文件');
      return;
    }
    if (!name.trim()) {
      setUploadError('请输入工作流名称');
      return;
    }

    const workflow: WorkflowDefinition = {
      id: `wf-${generateId()}`,
      name: name.trim(),
      category,
      fileName,
      fileContent,
      ioNodes,
      createdAt: Date.now(),
    };

    try {
      await addWorkflow(workflow);
      resetForm();
      setUploadSuccess(`"${workflow.name}" 已添加`);
      setTimeout(() => setUploadSuccess(''), 2500);
    } catch {
      setUploadError('保存工作流失败，请重试');
    }
  }, [fileContent, name, category, fileName, ioNodes, addWorkflow, resetForm]);

  // Delete workflow
  const handleDelete = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      deleteWorkflow(id);
    },
    [deleteWorkflow]
  );

  // 默认 IO 节点：用户没 @ 该类型节点时，提示词框里的同类内容自动注入这里
  const handleToggleDefaultNode = useCallback(
    (workflow: WorkflowDefinition, ioNode: WorkflowIONode) => {
      const defaultNodes = { ...workflow.defaultNodes };
      const isDefault = defaultNodes[ioNode.type] === ioNode.nodeId;
      if (isDefault) {
        delete defaultNodes[ioNode.type];
      } else {
        defaultNodes[ioNode.type] = ioNode.nodeId;
      }
      updateWorkflow(workflow.id, { defaultNodes })
        .then(() => showToast(
          isDefault
            ? `已取消默认${IONODE_LABELS[ioNode.type]}节点`
            : `“${ioNode.title}”已设为默认${IONODE_LABELS[ioNode.type]}节点`,
          'success',
        ))
        .catch(() => showToast('保存默认节点失败', 'error'));
    },
    [updateWorkflow, showToast],
  );

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleEdit = useCallback(async (workflow: WorkflowDefinition, event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      const missing = await openComfyUIWorkflowEditor(
        comfyBaseUrlFor(workflow.id) || DEFAULT_COMFY_URL,
        workflow,
      );
      // 缺节点不拦，ComfyUI 会把缺的节点标红；这里只提醒一句缺了什么
      if (missing.length > 0) {
        showToast(`已打开，但 ComfyUI 缺少这些节点：${missing.join('、')}`, 'error');
      }
      // 面板保持打开：ComfyUI 那边保存回来后这里会实时刷新，方便接着改默认节点
    } catch (error) {
      const message = typeof error === 'string'
        ? error
        : error instanceof Error ? error.message : '无法在 ComfyUI 中打开工作流';
      showToast(message, 'error');
    }
  }, [showToast]);

  const handleResetBuiltIns = useCallback(() => {
    if (!resetArmed) {
      setResetArmed(true);
      setTimeout(() => setResetArmed(false), 4000);
      return;
    }
    setResetArmed(false);
    resetBuiltIns()
      .then((count) => showToast(`已恢复 ${count} 个内置工作流`, 'success'))
      .catch(() => showToast('恢复内置工作流失败', 'error'));
  }, [resetArmed, resetBuiltIns, showToast]);

  // Filter workflows by category for the preview list
  const workflowsByCategory = CATEGORIES
    .filter((cat) => listFilter === 'all' || cat.value === listFilter)
    .map((cat) => ({
      ...cat,
      items: workflows.filter((w) => w.category === cat.value),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <AnimatePresence>
      {workflowPanelOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            data-tauri-drag-region
            className="wf-panel-backdrop"
            variants={backdropVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={{ duration: 0.2 }}
          />

          {/* Centering wrapper */}
          <div className="wf-panel-wrapper">
            <motion.div
              ref={panelRef}
              className="wf-panel"
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
            >
        {/* 左卡片：上传与添加 */}
        <div className="wf-panel-card wf-panel-import">
          <span className="wf-section-title">导入 ComfyUI 工作流</span>
          <div className="wf-section-rule" />

          {/* Name */}
          <div className="wf-field">
            <label className="wf-label">工作流名称</label>
            <input
              type="text"
              className="wf-input"
              placeholder="为你的工作流命名"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Category */}
          <div className="wf-field">
            <label className="wf-label">分类</label>
            <div className="wf-category-row">
              {CATEGORIES.map((cat) => (
                <motion.button
                  key={cat.value}
                  type="button"
                  className={`wf-cat-chip${categoryChipModifier(cat.value)} ${category === cat.value ? 'active' : ''}`}
                  onClick={() => setCategory(cat.value)}
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.96 }}
                >
                  {cat.label}
                </motion.button>
              ))}
            </div>
          </div>

          {/* File picker */}
          <div className="wf-field">
            <label className="wf-label">工作流文件</label>
            <motion.div
              className={`ui-dropzone${dragOver ? ' is-dragover' : ''}`}
              role="button"
              tabIndex={0}
              onClick={handlePickFile}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void handlePickFile();
                }
              }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              whileTap={{ scale: 0.995 }}
            >
              <span className="ui-dropzone__title">把工作流文件拖到这里</span>
              <span className="ui-dropzone__icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </span>
              <span className="ui-dropzone__hint">
                支持 ComfyUI 导出的 .json 工作流文件，点击这里也可以选择。
              </span>
            </motion.div>
            {fileContent && (
              <div className="wf-file-card">
                <span className="wf-file-card-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </span>
                <span className="wf-file-card-info">
                  <span className="wf-file-card-name" title={fileName}>{fileName}</span>
                  <span className="wf-file-card-meta">
                    JSON · {Math.max(1, Math.round(fileContent.length / 1024))} KB · {ioNodes.length} 个输入输出节点
                  </span>
                </span>
                <button
                  type="button"
                  className="wf-file-card-clear"
                  aria-label="移除已选文件"
                  onClick={handleClearFile}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}
            {/* IO nodes preview */}
            <AnimatePresence>
              {ioNodes.length > 0 && (
                <motion.div
                  className="wf-ionodes-preview"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {ioNodes.map((n, i) => (
                    <span key={i} className={`wf-ionode-badge wf-ionode-${n.type}`}>
                      {IONODE_ICONS[n.type]} {n.title}
                      <code>#{n.nodeId}</code>
                    </span>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Actions & messages */}
          <div className="wf-actions-row">
            <motion.button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={resetForm}
              disabled={!fileContent && !name}
              whileHover={fileContent || name ? { scale: 1.03 } : {}}
              whileTap={fileContent || name ? { scale: 0.97 } : {}}
            >
              取消
            </motion.button>
            <motion.button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={() => void handleSubmit()}
              disabled={!fileContent}
              whileHover={fileContent ? { scale: 1.03 } : {}}
              whileTap={fileContent ? { scale: 0.97 } : {}}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加工作流
            </motion.button>
            <AnimatePresence>
              {uploadError && (
                <motion.span
                  className="wf-msg wf-msg-error"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                >
                  {uploadError}
                </motion.span>
              )}
              {uploadSuccess && (
                <motion.span
                  className="wf-msg wf-msg-success"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                >
                  {uploadSuccess}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* 右卡片：已导入工作流管理 */}
        <div className="wf-panel-card wf-panel-list">
          <div className="wf-list-titlebar">
            <h2 className="wf-panel-title">工作流管理</h2>
            <motion.button
              type="button"
              className={`wf-reset-btn${resetArmed ? ' is-armed' : ''}`}
              onClick={handleResetBuiltIns}
              data-tooltip="把随包发布的内置工作流恢复回来（删掉的补回，改过的覆盖）"
              data-tooltip-pos="bottom"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              {resetArmed ? '再点一次确认' : '重置内置工作流'}
            </motion.button>
            <PopupCloseButton onClick={handleClose} />
          </div>
          <div className="wf-list-header">
            <span className="wf-section-title">
              已导入工作流
              <span className="wf-count">{workflows.length}</span>
            </span>
            <div className="wf-filter-row">
              {LIST_FILTERS.map((cat) => (
                <button
                  key={cat.value}
                  type="button"
                  className={`wf-cat-chip wf-filter-chip${categoryChipModifier(cat.value)} ${listFilter === cat.value ? 'active' : ''}`}
                  onClick={() => setListFilter(cat.value)}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>
          <div className="wf-section-rule" />

          {/* 顶栏与筛选固定，只有提示与列表滚动 */}
          <div className="wf-list-scroll">
          <p className="wf-hint" role="note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>
              未设置默认节点时，ComfyUI 调用需要在提示词中 <code className="wf-hint-code">@对应节点</code>，提示词或参考图才会写入对应输入。展开下方工作流卡片，点击节点徽章设为该类型默认节点（显示为 <code className="wf-hint-code">★</code>），调用时即可自动注入，无须每次 <code className="wf-hint-code">@</code>。
            </span>
          </p>

          <AnimatePresence mode="popLayout">
            {workflows.length > 0 && workflowsByCategory.length === 0 ? (
              <motion.div
                key="filtered-empty"
                className="wf-empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <span>该分类下暂无工作流</span>
              </motion.div>
            ) : workflows.length === 0 ? (
              <motion.div
                key="empty"
                className="wf-empty"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.4">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="9" y1="21" x2="9" y2="9" />
                </svg>
                <span>暂无工作流，请导入 ComfyUI 工作流文件</span>
              </motion.div>
            ) : (
              <motion.div key="list" className="wf-list">
                {workflowsByCategory.map((group, gi) => (
                  <motion.div
                    key={group.value}
                    className="wf-group"
                    variants={itemVariants}
                    initial="hidden"
                    animate="visible"
                    custom={gi}
                  >
                    <div className="wf-group-header">
                      <span className="wf-cat-dot" data-cat={group.value} />
                      <span className="wf-group-label">{group.label}</span>
                      <span className="wf-group-count">{group.items.length}</span>
                    </div>
                    {group.items.map((wf) => {
                      const nodeCount = wf.ioNodes?.length ?? 0;
                      const defaultCount = wf.ioNodes?.filter(
                        (n) => wf.defaultNodes?.[n.type] === n.nodeId,
                      ).length ?? 0;
                      const expanded = expandedIds.has(wf.id);
                      return (
                      <motion.div
                        key={wf.id}
                        className={`wf-item${expanded ? ' is-expanded' : ''}`}
                        layout
                        variants={itemVariants}
                      >
                        <div className="wf-item-row">
                          <div className="wf-item-info">
                            <span className="wf-item-name" title={wf.name}>{wf.name}</span>
                            <span className="wf-item-meta">
                              <span className="wf-item-file" title={wf.fileName}>{wf.fileName}</span>
                              <span className="wf-item-sep">·</span>
                              <span>{new Date(wf.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</span>
                              {/* 从 ComfyUI 存回来的分类是猜的，猜错了在这里改 */}
                              <Select
                                className="wf-item-cat"
                                triggerClassName="wf-item-cat-trigger"
                                value={wf.category}
                                title="修改分类"
                                options={CATEGORIES.map((cat) => ({ value: cat.value, label: cat.label }))}
                                onChange={(value) => {
                                  updateWorkflow(wf.id, { category: value as WorkflowCategory })
                                    .catch(() => showToast('修改分类失败', 'error'));
                                }}
                              />
                              {/* 只有配了多台服务端才需要选：单台时这一栏是纯噪音 */}
                              {(comfyServers?.length ?? 0) > 0 && (
                                <Select
                                  className="wf-item-cat"
                                  triggerClassName="wf-item-cat-trigger"
                                  value={wf.serverId ?? ''}
                                  title="选择执行这个工作流的 ComfyUI 服务端"
                                  options={[
                                    { value: '', label: '默认服务端' },
                                    ...(comfyServers ?? []).map((server) => ({
                                      value: server.id,
                                      label: server.name || server.url,
                                    })),
                                  ]}
                                  onChange={(value) => {
                                    updateWorkflow(wf.id, { serverId: value || undefined })
                                      .catch(() => showToast('绑定服务端失败', 'error'));
                                  }}
                                />
                              )}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {nodeCount > 0 && (
                              <button
                                type="button"
                                className="wf-item-toggle"
                                onClick={() => handleToggleExpand(wf.id)}
                                data-tooltip={expanded ? '收起输入输出节点' : '展开输入输出节点'}
                                data-tooltip-pos="left"
                                aria-expanded={expanded}
                              >
                                <svg className="wf-item-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <polyline points="9 18 15 12 9 6" />
                                </svg>
                                <span>{nodeCount} 节点</span>
                                {defaultCount > 0 && <span className="wf-item-star">★{defaultCount}</span>}
                              </button>
                            )}
                            <motion.button
                              type="button"
                              className="wf-item-del wf-item-edit"
                              onClick={(event) => void handleEdit(wf, event)}
                              data-tooltip="在 ComfyUI 中编辑"
                              data-tooltip-pos="left"
                              whileHover={{ scale: 1.1 }}
                              whileTap={{ scale: 0.9 }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                              </svg>
                            </motion.button>
                            <motion.button
                              type="button"
                              className="wf-item-del"
                              onClick={(e) => handleDelete(wf.id, e)}
                              data-tooltip="删除工作流"
                              data-tooltip-pos="left"
                              whileHover={{ scale: 1.1 }}
                              whileTap={{ scale: 0.9 }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </motion.button>
                          </div>
                        </div>{/* /wf-item-row */}

                        <AnimatePresence initial={false}>
                          {expanded && nodeCount > 0 && (
                            <motion.div
                              key="ionodes"
                              className="wf-item-ionodes-wrap"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                            >
                              <div className="wf-item-ionodes">
                                {(wf.ioNodes ?? []).map((n, i) => {
                                  const isDefault = wf.defaultNodes?.[n.type] === n.nodeId;
                                  return (
                                    <button
                                      key={i}
                                      type="button"
                                      className={`wf-ionode-badge wf-ionode-${n.type}${isDefault ? ' is-default' : ''}`}
                                      onClick={() => handleToggleDefaultNode(wf, n)}
                                      title={isDefault
                                        ? `已是默认${IONODE_LABELS[n.type]}节点，点击取消`
                                        : `设为默认${IONODE_LABELS[n.type]}节点：提示词框里的${IONODE_LABELS[n.type]}内容在没 @ 时自动注入这里`}
                                    >
                                      {isDefault ? '★' : IONODE_ICONS[n.type]} {n.title}
                                      <code>#{n.nodeId}</code>
                                    </button>
                                  );
                                })}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                      );
                    })}
                  </motion.div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          </div>{/* /wf-list-scroll */}
        </div>
      </motion.div>
      </div>{/* /wf-panel-wrapper */}
    </>
      )}
    </AnimatePresence>
  );
}
