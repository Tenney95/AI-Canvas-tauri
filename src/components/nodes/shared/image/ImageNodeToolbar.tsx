/**
 * ImageNodeToolbar 图像节点浮动工具栏 + 编辑态支持
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import AnimatedButton from '../../../shared/AnimatedButton';
import { useToolbarEdit } from '../../../../hooks/useToolbarEdit';
import ToolbarEditor from '../toolbar/ToolbarEditor';
import { getButtonRegistry } from '../toolbar/toolbarRegistry';

interface ImageNodeToolbarProps {
  nodeId: string;
  onUpload?: () => void;
  onMatting?: () => void;
  onSubjectMatting?: () => void;
  onMultiAngle?: () => void;
  onExpand?: () => void;
  onMultiGrid?: (side: number) => void;
  onCustomGrid?: () => void;
  onCompose?: () => void;
  onFullscreen?: () => void;
  onCrop?: () => void;
  onAnnotate?: () => void;
  onUpscale?: () => void;
  onRepaint?: () => void;
  isUpscaling?: boolean;
  isSubjectMattingRunning?: boolean;
}

const GRID_PRESETS = [2, 3, 4, 5];

function ImageNodeToolbar({
  nodeId: _nodeId,
  onUpload, onMatting, onSubjectMatting, onMultiAngle, onExpand,
  onMultiGrid, onCustomGrid, onCompose, onFullscreen, onCrop,
  onAnnotate, onUpscale, onRepaint, isUpscaling, isSubjectMattingRunning,
}: ImageNodeToolbarProps) {
  const nodeType = 'ai-image';
  const registry = getButtonRegistry(nodeType);
  const edit = useToolbarEdit({ nodeType });

  // ── 宫格子菜单 ──
  const [gridMenuOpen, setGridMenuOpen] = useState(false);
  const [gridMenuBelow, setGridMenuBelow] = useState(false);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const gridMenuRef = useRef<HTMLDivElement>(null);

  const toggleGridMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setGridMenuOpen((v) => !v);
  }, []);

  useEffect(() => {
    if (!gridMenuOpen) { setGridMenuBelow(false); return; }
    const raf = requestAnimationFrame(() => {
      const btn = gridWrapRef.current;
      const menu = gridMenuRef.current;
      if (!btn || !menu) return;
      const btnRect = btn.getBoundingClientRect();
      const menuHeight = menu.offsetHeight;
      setGridMenuBelow(btnRect.top - menuHeight - 12 < 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [gridMenuOpen]);

  const pickGrid = useCallback((side: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setGridMenuOpen(false);
    onMultiGrid?.(side);
  }, [onMultiGrid]);

  const pickCustom = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setGridMenuOpen(false);
    onCustomGrid?.();
  }, [onCustomGrid]);

  useEffect(() => {
    if (!gridMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (gridWrapRef.current && !gridWrapRef.current.contains(e.target as Node)) {
        setGridMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [gridMenuOpen]);

  const actionMap: Record<string, (e: React.MouseEvent) => void> = {
    matting:        (e) => { e.stopPropagation(); onMatting?.(); },
    expand:         (e) => { e.stopPropagation(); onExpand?.(); },
    multiGrid:      toggleGridMenu,
    multiAngle:     (e) => { e.stopPropagation(); onMultiAngle?.(); },
    repaint:        (e) => { e.stopPropagation(); onRepaint?.(); },
    upscale:        (e) => { e.stopPropagation(); if (!isUpscaling) onUpscale?.(); },
    subjectMatting: (e) => { e.stopPropagation(); if (!isSubjectMattingRunning) onSubjectMatting?.(); },
    annotate:       (e) => { e.stopPropagation(); onAnnotate?.(); },
    crop:           (e) => { e.stopPropagation(); onCrop?.(); },
    compose:        (e) => { e.stopPropagation(); onCompose?.(); },
    upload:         (e) => { e.stopPropagation(); onUpload?.(); },
    fullscreen:     (e) => { e.stopPropagation(); onFullscreen?.(); },
  };

  // ── 渲染单个按钮 ──
  const renderButton = useCallback((key: string) => {
    const def = registry.find((d) => d.key === key);
    if (!def || !actionMap[key]) return null;

    if (key === 'upscale') {
      return (
        <AnimatedButton
          key={key}
          className="ftb-btn icon-only act-hd"
          data-tooltip={isUpscaling ? '超分处理中...' : '高清超分'}
          aria-label="高清超分"
          disabled={isUpscaling}
          onClick={actionMap[key]}
        >
          <Icon icon={def.icon} width={14} height={14} />
        </AnimatedButton>
      );
    }

    if (key === 'subjectMatting') {
      return (
        <AnimatedButton
          key={key}
          className="ftb-btn icon-only act-auto-subject"
          data-tooltip={isSubjectMattingRunning ? '主体识别中...' : '自动识别主体'}
          aria-label="自动识别主体"
          disabled={isSubjectMattingRunning}
          onClick={actionMap[key]}
        >
          <Icon icon={def.icon} width={14} height={14} />
        </AnimatedButton>
      );
    }

    if (key === 'multiGrid') {
      return (
        <div key={key} className="multigrid-wrap" ref={gridWrapRef}>
          <AnimatedButton
            className="ftb-btn icon-only act-multigrid"
            data-tooltip="宫格裁切"
            aria-label="宫格裁切"
            onClick={toggleGridMenu}
          >
            <Icon icon={def.icon} width={14} height={14} />
          </AnimatedButton>
          {gridMenuOpen && (
            <div
              ref={gridMenuRef}
              className={`multigrid-menu nodrag${gridMenuBelow ? ' multigrid-menu--below' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="multigrid-menu-title">选择宫格</div>
              {GRID_PRESETS.map((side) => (
                <button key={side} type="button" className="multigrid-menu-item" onClick={pickGrid(side)}>
                  <span>{side * side}宫格</span>
                </button>
              ))}
              <div className="multigrid-menu-divider" />
              <button type="button" className="multigrid-menu-item multigrid-menu-item--custom" onClick={pickCustom}>
                <span>自定义裁切</span>
              </button>
            </div>
          )}
        </div>
      );
    }

    return (
      <AnimatedButton
        key={key}
        className={`ftb-btn icon-only act-${key}`}
        data-tooltip={def.label}
        aria-label={def.label}
        onClick={actionMap[key]}
      >
        <Icon icon={def.icon} width={14} height={14} />
      </AnimatedButton>
    );
  }, [registry, actionMap, isUpscaling, isSubjectMattingRunning, toggleGridMenu, gridMenuOpen, gridMenuBelow, pickGrid, pickCustom]);

  // ── 编辑态 ──
  if (edit.isEditing) {
    return <ToolbarEditor edit={edit} nodeType={nodeType} />;
  }

  // ── 正常态：按布局渲染 ──
  return (
    <div
      className="node-floating-toolbar img-toolbar nodrag"
      {...edit.longPressHandlers}
    >
      <div className="img-toolbar-main nodrag">
        {edit.layout.zones.map((zone, zi) => (
          <div key={zone.id} className="img-toolbar-zone nodrag">
            {zone.buttonKeys.map((key) => renderButton(key))}
            {zi < edit.layout.zones.length - 1 && (
              <div className="ftb-divider img-toolbar-main-divider" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(ImageNodeToolbar);
