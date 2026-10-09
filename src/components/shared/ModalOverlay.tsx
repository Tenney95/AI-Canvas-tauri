/**
 * ModalOverlay — 可复用的模态框外层容器（AnimatePresence + backdrop + 弹簧落位）
 */
import { useCallback, useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
} from 'framer-motion';
import { fadeFast, fadeNormal, panelMotion, springSmooth } from '../../utils/motion';
import { useDialogFocus } from '../../hooks/useDialogFocus';

export default function ModalOverlay({
  isOpen,
  onClose,
  children,
  ariaLabel,
  className = '',
  closeOnBackdrop = true,
  draggable = false,
  motionPreset = 'spring',
  backdropBlur = true,
  zIndex = 250,
}: {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  ariaLabel: string;
  className?: string;
  closeOnBackdrop?: boolean;
  draggable?: boolean;
  motionPreset?: 'spring' | 'quick';
  backdropBlur?: boolean;
  /** Overlay stacking order. Higher values keep nested dialogs above their parent modal. */
  zIndex?: number;
}) {
  const reduceMotion = useReducedMotion();
  const quickMotion = motionPreset === 'quick';
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);

  const clampPanelToViewport = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const viewportMargin = 8;
    const rect = panel.getBoundingClientRect();
    let xCorrection = 0;
    let yCorrection = 0;

    if (rect.left < viewportMargin) xCorrection = viewportMargin - rect.left;
    else if (rect.right > window.innerWidth - viewportMargin) {
      xCorrection = window.innerWidth - viewportMargin - rect.right;
    }

    if (rect.top < viewportMargin) yCorrection = viewportMargin - rect.top;
    else if (rect.bottom > window.innerHeight - viewportMargin) {
      yCorrection = window.innerHeight - viewportMargin - rect.bottom;
    }

    if (xCorrection !== 0) dragX.set(dragX.get() + xCorrection);
    if (yCorrection !== 0) dragY.set(dragY.get() + yCorrection);
  }, [dragX, dragY]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggable || event.button !== 0) return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    const dragHandle = target?.closest('[data-modal-drag-handle]');
    if (!dragHandle || target?.closest('button, a, input, select, textarea, [role="button"]')) return;

    event.preventDefault();
    dragControls.start(event);
  };

  useDialogFocus(isOpen, panelRef, onClose, { zIndex });

  useEffect(() => {
    if (!isOpen || !draggable) {
      dragX.set(0);
      dragY.set(0);
      return;
    }

    const handleResize = () => requestAnimationFrame(clampPanelToViewport);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [clampPanelToViewport, dragX, dragY, draggable, isOpen]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={overlayRef}
          className="fixed inset-0 z-[250] flex items-center justify-center overflow-hidden rounded-2xl"
          style={{ zIndex }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={quickMotion ? fadeFast : fadeNormal}
        >
          <motion.div
            data-tauri-drag-region
            aria-hidden="true"
            className={`absolute inset-0 bg-black/50 ${backdropBlur ? 'backdrop-blur-sm' : ''}`}
            initial={quickMotion ? false : { opacity: 0 }}
            animate={quickMotion ? undefined : { opacity: 1 }}
            exit={quickMotion ? undefined : { opacity: 0 }}
            onClick={closeOnBackdrop ? onClose : undefined}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            className={`relative glass-panel border rounded-2xl shadow-2xl overflow-hidden overscroll-contain flex flex-col ${className}`}
            style={draggable ? { x: dragX, y: dragY } : undefined}
            {...panelMotion(Boolean(reduceMotion), quickMotion, draggable)}
            transition={reduceMotion || quickMotion ? fadeFast : springSmooth}
            drag={draggable}
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={draggable ? overlayRef : undefined}
            dragElastic={0}
            dragMomentum={false}
            onDragEnd={clampPanelToViewport}
            onPointerDown={handlePointerDown}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
