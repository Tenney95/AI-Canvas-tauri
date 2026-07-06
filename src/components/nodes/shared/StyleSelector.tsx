/**
 * StyleSelector — 画风选择器，PromptPanel 底部按钮 + ModalOverlay 弹出网格面板
 * 支持用户自定义画风（名称 + 提示词 + 图片）
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import ModalOverlay from '../../shared/ModalOverlay';
import { useAppStore } from '../../../store/useAppStore';

// ── 画风缩略图 ──
import thumbRealistic from '../../../assets/images/styles/realistic.png';
import thumbAnime from '../../../assets/images/styles/anime.png';
import thumbWatercolor from '../../../assets/images/styles/watercolor.png';
import thumbOilPainting from '../../../assets/images/styles/oil-painting.png';
import thumbSketch from '../../../assets/images/styles/sketch.png';
import thumbCyberpunk from '../../../assets/images/styles/cyberpunk.png';
import thumbInkWash from '../../../assets/images/styles/ink-wash.png';
import thumbPixelArt from '../../../assets/images/styles/pixel-art.png';
import thumb3dRender from '../../../assets/images/styles/3d-render.png';
import thumbFlatIllustration from '../../../assets/images/styles/flat-illustration.png';
import thumbCinematic from '../../../assets/images/styles/cinematic.png';
import thumbVintage from '../../../assets/images/styles/vintage.png';

/** 画风缩略图映射表 */
const THUMBNAILS: Record<string, string> = {
  realistic: thumbRealistic,
  anime: thumbAnime,
  watercolor: thumbWatercolor,
  'oil-painting': thumbOilPainting,
  sketch: thumbSketch,
  cyberpunk: thumbCyberpunk,
  'ink-wash': thumbInkWash,
  'pixel-art': thumbPixelArt,
  '3d-render': thumb3dRender,
  'flat-illustration': thumbFlatIllustration,
  cinematic: thumbCinematic,
  vintage: thumbVintage,
};

export interface StyleOption {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  thumbnail?: string;
  isCustom?: boolean;
}

/** 画风列表 — ai-image / ai-panorama / ai-video 共用同一套选项 */
const SHARED_STYLES: StyleOption[] = [
  { id: 'realistic', name: '写实摄影', description: '真实质感，光影自然', thumbnail: THUMBNAILS.realistic },
  { id: 'anime', name: '动漫风格', description: '日系二次元绘画', thumbnail: THUMBNAILS.anime },
  { id: 'watercolor', name: '水彩画', description: '柔和通透的晕染', thumbnail: THUMBNAILS.watercolor },
  { id: 'oil-painting', name: '油画', description: '厚重肌理与笔触', thumbnail: THUMBNAILS['oil-painting'] },
  { id: 'sketch', name: '素描', description: '黑白线条速写', thumbnail: THUMBNAILS.sketch },
  { id: 'cyberpunk', name: '赛博朋克', description: '霓虹都市科技感', thumbnail: THUMBNAILS.cyberpunk },
  { id: 'ink-wash', name: '水墨画', description: '水墨画', thumbnail: THUMBNAILS['ink-wash'] },
  { id: 'pixel-art', name: '像素艺术', description: '像素风', thumbnail: THUMBNAILS['pixel-art'] },
  { id: '3d-render', name: '3D 渲染', description: 'C4D 质感立体', thumbnail: THUMBNAILS['3d-render'] },
  { id: 'flat-illustration', name: '扁平插画', description: '简洁干净的矢量风', thumbnail: THUMBNAILS['flat-illustration'] },
  { id: 'cinematic', name: '电影质感', description: '电影级调色与光影', thumbnail: THUMBNAILS.cinematic },
  { id: 'vintage', name: '复古胶片', description: '胶片颗粒与暖调', thumbnail: THUMBNAILS.vintage },
];

/** 画风列表 — 按 nodeType 分组（当前共用同一套选项） */
export const STYLE_GROUPS: Record<string, StyleOption[]> = {
  'ai-image': SHARED_STYLES,
  'ai-panorama': SHARED_STYLES,
  'ai-video': SHARED_STYLES,
};

interface StyleSelectorProps {
  nodeType: string;
  selectedStyle?: string;
  onChange?: (styleId: string) => void;
}

export default function StyleSelector({ nodeType, selectedStyle, onChange }: StyleSelectorProps) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // 新增表单
  const [formName, setFormName] = useState('');
  const [formPrompt, setFormPrompt] = useState('');
  const [formThumbnail, setFormThumbnail] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const customStyles = useAppStore((s) => s.customStyles);
  const addCustomStyle = useAppStore((s) => s.addCustomStyle);
  const deleteCustomStyle = useAppStore((s) => s.deleteCustomStyle);

  // 合并内置 + 自定义画风
  const builtin = STYLE_GROUPS[nodeType] ?? [];
  const custom = customStyles.filter((s) => s.nodeType === nodeType).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.prompt,
    prompt: s.prompt,
    thumbnail: s.thumbnail,
    isCustom: true,
  }));
  const styles = [...builtin, ...custom];

  // Escape 关闭
  useEffect(() => {
    if (!open && !addOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (addOpen) setAddOpen(false);
        else setOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, addOpen]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((v) => !v);
  }, []);

  const handleSelect = useCallback(
    (styleId: string) => {
      onChange?.(styleId);
      setOpen(false);
    },
    [onChange],
  );

  const handleDeleteCustom = useCallback(
    (e: React.MouseEvent, styleId: string) => {
      e.stopPropagation();
      e.preventDefault();
      deleteCustomStyle(styleId);
      // 如果当前选中了被删除的画风，清除选择
      if (selectedStyle === styleId) onChange?.('');
    },
    [deleteCustomStyle, selectedStyle, onChange],
  );

  // 打开新增表单
  const openAddForm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setFormName('');
    setFormPrompt('');
    setFormThumbnail(undefined);
    setAddOpen(true);
  }, []);

  // 选择图片文件
  const handlePickImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setFormThumbnail(reader.result as string);
    reader.readAsDataURL(file);
    // reset so same file can be re-selected
    e.target.value = '';
  }, []);

  // 提交新增
  const handleAddSubmit = useCallback(() => {
    const name = formName.trim();
    if (!name) return;
    addCustomStyle({
      nodeType,
      name,
      prompt: formPrompt.trim(),
      thumbnail: formThumbnail,
    });
    setAddOpen(false);
  }, [formName, formPrompt, formThumbnail, nodeType, addCustomStyle]);

  const selectedName = styles.find((s) => s.id === selectedStyle)?.name;

  return (
    <>
      <button
        type="button"
        className={`prompt-btn style-selector-btn${open ? ' style-active' : ''}${selectedStyle ? ' has-style' : ''}`}
        data-tooltip={selectedName ? `画风: ${selectedName}` : '选择画风'}
        onClick={handleToggle}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
        </svg>
      </button>

      {/* ── 画风选择弹窗 ── */}
      {createPortal(
        <ModalOverlay
          isOpen={open}
          onClose={() => setOpen(false)}
          className="style-picker-panel"
        >
          <div className="style-picker-header">
            <span className="asset-picker-title">选择画风</span>
            <div className="style-picker-header-actions">
              <button
                type="button"
                className="style-add-btn"
                onClick={openAddForm}
                data-tooltip="添加自定义画风"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                type="button"
                className="asset-picker-close"
                onClick={() => setOpen(false)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
          <div className="style-picker-grid">
            {styles.length === 0 && (
              <div className="style-picker-empty">暂无可选画风</div>
            )}
            {styles.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`style-card${selectedStyle === s.id ? ' selected' : ''}${s.isCustom ? ' is-custom' : ''}`}
                onClick={() => handleSelect(s.id)}
              >
                <div className="style-card-img">
                  {s.thumbnail ? (
                    <img src={s.thumbnail} alt={s.name} />
                  ) : (
                    <div className="style-card-placeholder" />
                  )}
                  <span className="style-card-name">{s.name}</span>
                </div>
                {s.description && (
                  <div className="style-card-desc">{s.description}</div>
                )}
                {s.isCustom && (
                  <button
                    type="button"
                    className="style-card-delete"
                    onClick={(e) => handleDeleteCustom(e, s.id)}
                    data-tooltip="删除此画风"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </button>
            ))}
          </div>
        </ModalOverlay>,
        document.body,
      )}

      {/* ── 新增自定义画风弹窗 ── */}
      {createPortal(
        <ModalOverlay
          isOpen={addOpen}
          onClose={() => setAddOpen(false)}
          className="style-add-panel"
        >
          <div className="style-picker-header">
            <span className="asset-picker-title">添加自定义画风</span>
            <button
              type="button"
              className="asset-picker-close"
              onClick={() => setAddOpen(false)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="style-add-body">
            {/* 缩略图 */}
            <div className="style-add-thumb" onClick={handlePickImage}>
              {formThumbnail ? (
                <img src={formThumbnail} alt="" className="style-add-thumb-img" />
              ) : (
                <div className="style-add-thumb-placeholder">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <span>点击上传缩略图</span>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="style-add-file-input"
                onChange={handleFileChange}
              />
            </div>
            {/* 名称 */}
            <label className="style-add-label">画风名称</label>
            <input
              type="text"
              className="style-add-input"
              placeholder="例如：赛博朋克"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddSubmit(); }}
              autoFocus
            />
            {/* 提示词 */}
            <label className="style-add-label">提示词</label>
            <textarea
              className="style-add-textarea"
              placeholder="输入该画风对应的提示词，生成时会自动附加到主提示词中"
              value={formPrompt}
              onChange={(e) => setFormPrompt(e.target.value)}
              rows={3}
            />
            {/* 操作按钮 */}
            <div className="style-add-actions">
              <button
                type="button"
                className="style-add-cancel"
                onClick={() => setAddOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="style-add-submit"
                disabled={!formName.trim()}
                onClick={handleAddSubmit}
              >
                保存
              </button>
            </div>
          </div>
        </ModalOverlay>,
        document.body,
      )}
    </>
  );
}
