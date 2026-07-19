/**
 * Toast 全局消息提示 — 顶部居中弹出式通知，支持成功、信息和错误状态，自动消失
 */
import { Icon } from '@iconify/react';
import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import PopupCloseButton from './shared/PopupCloseButton';
import { springSmooth, fadeFast } from '../utils/motion';

export default function Toast() {
  const { toast, dismissToast } = useAppStore(
    useShallow((s) => ({ toast: s.toast, dismissToast: s.dismissToast })),
  );

  return (
    <AnimatePresence>
      {toast.visible && (
        <motion.div
          className="fixed top-16 left-1/2 z-[100]"
          style={{ x: '-50%' }}
          initial={{ opacity: 0, y: -10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98, transition: fadeFast }}
          transition={springSmooth}
        >
          <div
            role={toast.type === 'error' ? 'alert' : 'status'}
            aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
            className={`app-toast is-${toast.type} flex w-max max-w-[calc(100vw-2rem)] items-center gap-2
                        rounded-lg border py-1.5 pl-2 pr-1.5`}
          >
            <motion.span
              className="app-toast-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ ...springSmooth, delay: 0.03 }}
              aria-hidden="true"
            >
              <Icon
                icon={toast.type === 'success'
                  ? 'lucide:check'
                  : toast.type === 'info'
                    ? 'lucide:info'
                    : 'lucide:triangle-alert'}
                width={15}
                height={15}
              />
            </motion.span>
            <span className="min-w-0 break-words text-[13px] font-medium leading-5 text-canvas-text">
              {toast.message}
            </span>
            <PopupCloseButton
              onClick={dismissToast}
              ariaLabel="关闭通知"
              className="ml-0.5"
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
