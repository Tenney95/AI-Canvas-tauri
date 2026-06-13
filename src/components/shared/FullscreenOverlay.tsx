/**
 * FullscreenOverlay — 全屏蒙层组件
 * 通过 Portal 渲染到 document.body，使用 framer-motion 动画
 */
import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import type { ReactNode } from 'react';

export interface FullscreenOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
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

export default function FullscreenOverlay({
  isOpen,
  onClose,
  title,
  children,
  panelWidth = 'min(90vw, 900px)',
  className = '',
  hideHeader = false,
  hidePanel = false,
  bodyClassName = '',
  headerContent,
}: FullscreenOverlayProps) {
  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={`fullscreen-overlay${hidePanel ? ' fullscreen-overlay--transparent' : ''} ${className}`}
          variants={backdropVariants}
          initial="hidden"
          animate="visible"
          exit="hidden"
          transition={{ duration: 0.2 }}
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
