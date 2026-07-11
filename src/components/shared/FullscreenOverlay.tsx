/**
 * FullscreenOverlay — 全屏蒙层组件
 * 通过 Portal 渲染到 document.body，使用 framer-motion 动画
 */
import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import type { ReactNode } from 'react';
import { EASE_OUT_EXPO } from '../../utils/motion';

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
}

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 1, ease: EASE_OUT_EXPO },
  },
};

/** hidePanel 模式下蒙层不做淡入（避免遮盖图片飞入动画的视觉效果） */
const backdropVariantsInstant = {
  hidden: { opacity: 1 },
  visible: { opacity: 1 },
};

const panelVariants = {
  hidden: { opacity: 0, scale: 0.96, y: 18, filter: 'blur(8px)' },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 1, ease: EASE_OUT_EXPO },
  },
  exit: {
    opacity: 0,
    scale: 0.985,
    y: 10,
    filter: 'blur(4px)',
    transition: { duration: 1, ease: EASE_OUT_EXPO },
  },
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
}: FullscreenOverlayProps) {
  // Close on Escape release so child keydown handlers cannot swallow the shortcut.
  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (isOpen) {
      window.addEventListener('keyup', handleKeyUp, true);
      return () => window.removeEventListener('keyup', handleKeyUp, true);
    }
  }, [isOpen, handleKeyUp]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={`fullscreen-overlay${hidePanel ? ' fullscreen-overlay--transparent' : ''} ${className}`}
          variants={hidePanel ? backdropVariantsInstant : backdropVariants}
          initial="hidden"
          animate="visible"
          exit="hidden"
          transition={{ duration: 1, ease: EASE_OUT_EXPO }}
          onClick={hidePanel ? undefined : onClose}
        >
          {hidePanel ? (
            <>
              <motion.button
                className="fullscreen-close fullscreen-close--absolute"
                onClick={onClose}
                aria-label="关闭"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </motion.button>
              {children}
            </>
          ) : (
            <motion.div
              className="fullscreen-panel"
              style={{ width: panelWidth }}
              variants={panelVariants}
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
                  <motion.button
                    className="fullscreen-close"
                    onClick={onClose}
                    aria-label="关闭"
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </motion.button>
                </div>
              )}
              {hideHeader && (
                <motion.button
                  className="fullscreen-close fullscreen-close--absolute"
                  onClick={onClose}
                  aria-label="关闭"
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </motion.button>
              )}
              <div className={`fullscreen-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
                {children}
              </div>
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
