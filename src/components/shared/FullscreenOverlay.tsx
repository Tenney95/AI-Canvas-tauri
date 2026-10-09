/**
 * FullscreenOverlay — 全屏蒙层组件
 * 通过 Portal 渲染到 document.body，使用 framer-motion 动画
 */
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { fadeFast, fadeNormal } from '../../utils/motion';
import PopupCloseButton from './PopupCloseButton';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { useT } from '../../i18n';

export interface FullscreenOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 内层面板宽度，默认 min(90vw, 900px) */
  panelWidth?: string;
  /** 覆盖层 class */
  className?: string;
  /** 隐藏标题栏，关闭按钮绝对定位在右上角 */
  hideHeader?: boolean;
  /** 完全隐藏面板框，只留半透明遮罩背景（如裁切/抠图等工具） */
  hidePanel?: boolean;
  /** body 区域自定义 class */
  bodyClassName?: string;
  /** 注入到标题栏中（标题与关闭按钮之间） */
  headerContent?: ReactNode;
  /** 关闭时立即卸载重媒体/Canvas 子树，不等待退场动画 */
  unmountOnClose?: boolean;
}

const backdropVariants = {
  hidden: { opacity: 0, transition: fadeFast },
  visible: {
    opacity: 1,
    transition: fadeNormal,
  },
};

/** hidePanel 模式下蒙层不做淡入（避免遮盖图片飞入动画的视觉效果） */
const backdropVariantsInstant = {
  hidden: { opacity: 1 },
  visible: { opacity: 1 },
};

const panelVariants = {
  hidden: { opacity: 0, transform: 'translate3d(0, 12px, 0) scale(0.98)' },
  visible: {
    opacity: 1,
    transform: 'translate3d(0, 0, 0) scale(1)',
    transition: fadeNormal,
  },
  exit: {
    opacity: 0,
    transform: 'translate3d(0, 6px, 0) scale(0.99)',
    transition: fadeFast,
  },
};

const reducedPanelVariants = {
  hidden: { opacity: 0, transform: 'none' },
  visible: { opacity: 1, transform: 'none', transition: fadeFast },
  exit: { opacity: 0, transform: 'none', transition: fadeFast },
};

export default function FullscreenOverlay({
  isOpen,
  onClose,
  title = '',
  children,
  panelWidth = 'min(90vw, 900px)',
  className = '',
  hideHeader = false,
  hidePanel = false,
  bodyClassName = '',
  headerContent,
  unmountOnClose = false,
}: FullscreenOverlayProps) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const overlayRef = useRef<HTMLDivElement>(null);
  // 保留松开 Escape 关闭的语义，并与嵌套弹窗共享焦点/键盘层级。
  useDialogFocus(isOpen, overlayRef, onClose, { escapeOnKeyUp: true });

  const overlay = isOpen ? (
        <motion.div
          ref={overlayRef}
          role="dialog"
          aria-modal="true"
          aria-label={title || t('全屏预览')}
          tabIndex={-1}
          data-tauri-drag-region
          className={`fullscreen-overlay${hidePanel ? ' fullscreen-overlay--transparent' : ''} ${className}`}
          variants={hidePanel ? backdropVariantsInstant : backdropVariants}
          initial="hidden"
          animate="visible"
          exit="hidden"
          transition={fadeFast}
          onClick={hidePanel ? undefined : onClose}
        >
          {hidePanel ? (
            <>
              <PopupCloseButton
                ariaLabel="关闭"
                onClick={onClose}
                className="fullscreen-close--absolute"
              />
              {children}
            </>
          ) : (
            <motion.div
              className="fullscreen-panel"
              style={{ width: panelWidth }}
              variants={reduceMotion ? reducedPanelVariants : panelVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
            >
              {!hideHeader && (
                <div className="fullscreen-header">
                  <span className="fullscreen-title">{title}</span>
                  {headerContent && (
                    <div className="fullscreen-header-extra">{headerContent}</div>
                  )}
                  <PopupCloseButton
                    ariaLabel="关闭"
                    onClick={onClose}
                  />
                </div>
              )}
              {hideHeader && (
                <PopupCloseButton
                  ariaLabel="关闭"
                  onClick={onClose}
                  className="fullscreen-close--absolute"
                />
              )}
              <div className={`fullscreen-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
                {children}
              </div>
            </motion.div>
          )}
        </motion.div>
  ) : null;

  // hidePanel 均为图片、视频或编辑器舞台；退场期间保留子树会与底层预览重叠占用资源。
  const shouldUnmountImmediately = hidePanel || unmountOnClose;

  return createPortal(
    shouldUnmountImmediately ? overlay : <AnimatePresence>{overlay}</AnimatePresence>,
    document.body,
  );
}
