/**
 * ModalOverlay — 可复用的模态框外层容器（AnimatePresence + backdrop + 缩放动画）
 */
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const MODAL_EASE = [0.16, 1, 0.3, 1] as const;

export default function ModalOverlay({
  isOpen,
  onClose,
  children,
  className = '',
}: {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[250] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm rounded-2xl"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            className={`relative bg-canvas-surface border border-canvas-border rounded-2xl shadow-2xl overflow-hidden flex flex-col ${className}`}
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 12 }}
            transition={{ duration: 0.25, ease: MODAL_EASE }}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
