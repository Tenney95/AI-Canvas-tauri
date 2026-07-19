/**
 * ModalOverlay — 可复用的模态框外层容器（AnimatePresence + backdrop + 弹簧落位）
 */
import { useCallback, useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
} from 'framer-motion';
import { fadeNormal, springSmooth } from '../../utils/motion';

export default function ModalOverlay({
  isOpen,
  onClose,
  children,
  ariaLabel,
  className = '',
  closeOnBackdrop = true,
  draggable = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  ariaLabel: string;
  className?: string;
  closeOnBackdrop?: boolean;
  draggable?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
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

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

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

  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const panel = panelRef.current;
    if (!panel) return;

    const getFocusableElements = () => Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);

    const focusFrame = requestAnimationFrame(() => {
      const firstFocusable = getFocusableElements()[0];
      (firstFocusable ?? panel).focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === firstFocusable || !panel.contains(activeElement))) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && (activeElement === lastFocusable || !panel.contains(activeElement))) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={overlayRef}
          className="fixed inset-0 z-[250] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeNormal}
        >
          <motion.div
            aria-hidden="true"
            className="absolute inset-0 bg-black/50 backdrop-blur-sm rounded-2xl"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
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
            initial={reduceMotion
              ? { opacity: 0 }
              : draggable
                ? { opacity: 0, scale: 0.94 }
                : { opacity: 0, scale: 0.94, y: 14 }}
            animate={draggable ? { opacity: 1, scale: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion
              ? { opacity: 0 }
              : draggable
                ? { opacity: 0, scale: 0.96 }
                : { opacity: 0, scale: 0.96, y: 10 }}
            transition={reduceMotion ? fadeNormal : springSmooth}
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
    </AnimatePresence>
  );
}
