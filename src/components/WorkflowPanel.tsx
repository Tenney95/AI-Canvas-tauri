import { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore, generateId } from '../store/useAppStore';
import type { WorkflowDefinition, WorkflowCategory, WorkflowIONode, WorkflowIONodeType } from '../types';

const CATEGORIES: { value: WorkflowCategory; label: string }[] = [
  { value: 'ai-text', label: '生成文本' },
  { value: 'ai-image', label: '生成图像' },
  { value: 'ai-video', label: '生成视频' },
  { value: 'ai-audio', label: '生成音频' },
];

/** 浏览器文件选择器：选取 .json 文件并返回内容 */
function pickJsonFile(): Promise<{ name: string; content: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      document.body.removeChild(input);
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        JSON.parse(text); // validate JSON
        resolve({ name: file.name, content: text });
      } catch {
        resolve(null);
      }
    });
    input.addEventListener('cancel', () => {
      document.body.removeChild(input);
      resolve(null);
    });
    input.click();
  });
}

/** ComfyUI class_type 匹配规则 → 输入/输出节点类型 */
const IO_TYPE_RULES: { patterns: RegExp[]; type: WorkflowIONodeType }[] = [
  { type: 'image',  patterns: [/^LoadImage/i] },
  { type: 'video',  patterns: [/^LoadVideo/i, /^VHS_LoadVideo/i, /^VHS_LoadVideoPath/i] },
  { type: 'audio',  patterns: [/^LoadAudio/i] },
  { type: 'prompt', patterns: [/CLIPTextEncode/i, /TextEncode/i, /StringLiteral/i, /PrimitiveString/i, /^ShowText|pysssss/i] },
];

/** 输入/输出节点类型 → 显示图标 */
const IONODE_ICONS: Record<WorkflowIONodeType, string> = {
  prompt: '📝',
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
};

/** 解析 ComfyUI workflow JSON，提取输入/输出节点 */
function extractIONodes(jsonStr: string): WorkflowIONode[] {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(jsonStr); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];

  const results: WorkflowIONode[] = [];

  for (const [nodeId, raw] of Object.entries(parsed)) {
    if (!raw || typeof raw !== 'object') continue;
    const data = raw as Record<string, unknown>;
    const classType = String(data.class_type || '');
    const title = String((data._meta as Record<string, unknown> | undefined)?.title || classType || '');

    // Match by class_type patterns
    for (const rule of IO_TYPE_RULES) {
      if (rule.patterns.some((re) => re.test(classType))) {
        results.push({ nodeId, title, type: rule.type });
        break;
      }
    }

    // Also detect text/prompt nodes by input field names containing "text"/"prompt" with string value
    const inputs = data.inputs as Record<string, unknown> | undefined;
    if (inputs) {
      const alreadyMatched = results.some((r) => r.nodeId === nodeId);
      if (!alreadyMatched) {
        for (const [key, value] of Object.entries(inputs)) {
          if ((/text|prompt|writing/i).test(key) && typeof value === 'string' && value.trim()) {
            results.push({ nodeId, title: title || classType || key, type: 'prompt' });
            break;
          }
        }
      }
    }
  }

  return results;
}

export default function WorkflowPanel() {
  const {
    workflows,
    workflowPanelOpen,
    setWorkflowPanelOpen,
    addWorkflow,
    deleteWorkflow,
  } = useAppStore();

  const [name, setName] = useState('');
  const [category, setCategory] = useState<WorkflowCategory>('ai-text');
  const [fileName, setFileName] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [ioNodes, setIoNodes] = useState<WorkflowIONode[]>([]);
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState('');
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

  // Pick file
  const handlePickFile = useCallback(async () => {
    setUploadError('');
    setUploadSuccess('');
    const result = await pickJsonFile();
    if (!result) return;
    try {
      // Validate it's likely a ComfyUI workflow
      const parsed = JSON.parse(result.content);
      if (!parsed || typeof parsed !== 'object') {
        setUploadError('不是有效的 JSON 文件');
        return;
      }
      setFileName(result.name);
      setFileContent(result.content);
      // Extract IO nodes
      const extracted = extractIONodes(result.content);
      setIoNodes(extracted);
      // Auto-fill name from filename
      if (!name) {
        const baseName = result.name.replace(/\.json$/i, '');
        setName(baseName);
      }
    } catch {
      setUploadError('JSON 解析失败，请检查文件格式');
    }
  }, [name]);

  // Submit
  const handleSubmit = useCallback(() => {
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

    addWorkflow(workflow);
    resetForm();
    setUploadSuccess(`"${workflow.name}" 已添加`);
    setTimeout(() => setUploadSuccess(''), 2500);
  }, [fileContent, name, category, fileName, ioNodes, addWorkflow, resetForm]);

  // Delete workflow
  const handleDelete = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      deleteWorkflow(id);
    },
    [deleteWorkflow]
  );

  if (!workflowPanelOpen) return null;

  // Filter workflows by category for the preview list
  const workflowsByCategory = CATEGORIES.map((cat) => ({
    ...cat,
    items: workflows.filter((w) => w.category === cat.value),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      {/* Backdrop */}
      <div className="wf-panel-backdrop" onMouseDown={handleClose} />

      {/* Modal */}
      <div
        ref={panelRef}
        className="wf-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="wf-panel-header">
          <h2 className="wf-panel-title">工作流管理</h2>
          <button
            type="button"
            className="wf-panel-close"
            onClick={handleClose}
            data-tooltip="关闭"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Import section */}
        <div className="wf-panel-section">
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
                <button
                  key={cat.value}
                  type="button"
                  className={`wf-cat-chip ${category === cat.value ? 'active' : ''}`}
                  onClick={() => setCategory(cat.value)}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* File picker */}
          <div className="wf-field">
            <label className="wf-label">工作流文件</label>
            <div className="wf-file-area" onClick={handlePickFile}>
              {fileContent ? (
                <div className="wf-file-selected">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                  <span className="wf-file-name">{fileName}</span>
                  <span className="wf-file-size">
                    ({Math.round(fileContent.length / 1024)} KB)
                  </span>
                </div>
              ) : (
                <div className="wf-file-placeholder">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span>点击选择 ComfyUI 导出的 .json 文件</span>
                </div>
              )}
            </div>
            {/* IO nodes preview */}
            {ioNodes.length > 0 && (
              <div className="wf-ionodes-preview">
                {ioNodes.map((n, i) => (
                  <span key={i} className={`wf-ionode-badge wf-ionode-${n.type}`}>
                    {IONODE_ICONS[n.type]} {n.title}
                    <code>#{n.nodeId}</code>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Actions & messages */}
          <div className="wf-actions-row">
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={handleSubmit}
              disabled={!fileContent}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加工作流
            </button>
            {uploadError && <span className="wf-msg wf-msg-error">{uploadError}</span>}
            {uploadSuccess && <span className="wf-msg wf-msg-success">{uploadSuccess}</span>}
          </div>
        </div>

        {/* Existing workflows list */}
        <div className="wf-panel-section">
          <span className="wf-section-title">
            已导入工作流
            <span className="wf-count">{workflows.length}</span>
          </span>
          <div className="wf-section-rule" />

          {workflows.length === 0 ? (
            <div className="wf-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.4">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              <span>暂无工作流，请导入 ComfyUI 工作流文件</span>
            </div>
          ) : (
            <div className="wf-list">
              {workflowsByCategory.map((group) => (
                <div key={group.value} className="wf-group">
                  <div className="wf-group-header">
                    <span className="wf-cat-dot" data-cat={group.value} />
                    <span className="wf-group-label">{group.label}</span>
                  </div>
                  {group.items.map((wf) => (
                    <div key={wf.id} className="wf-item">
                      <div className="wf-item-info">
                        <span className="wf-item-name">{wf.name}</span>
                        <span className="wf-item-meta">
                          {wf.fileName} · {new Date(wf.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                        </span>
                        {wf.ioNodes && wf.ioNodes.length > 0 && (
                          <div className="wf-item-ionodes">
                            {wf.ioNodes.map((n, i) => (
                              <span key={i} className={`wf-ionode-badge wf-ionode-${n.type}`}>
                                {IONODE_ICONS[n.type]} {n.title}
                                <code>#{n.nodeId}</code>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="wf-item-del"
                        onClick={(e) => handleDelete(wf.id, e)}
                        data-tooltip="删除工作流"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
