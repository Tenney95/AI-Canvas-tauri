/**
 * Toast 全局消息提示 — 顶部居中弹出式通知，支持成功/错误两种状态，自动消失
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from '../store/useAppStore';
import AnimatedButton from './shared/AnimatedButton';

export default function Toast() {
  const { toast, dismissToast } = useAppStore();

  return (
    <AnimatePresence>
      {toast.visible && (
        <motion.div
          className="fixed top-16 left-1/2 z-[100]"
          style={{ x: '-50%' }}
          initial={{ opacity: 0, y: -12, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.95 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
          <div
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl shadow-black/30 border text-sm backdrop-blur-xl ${
              toast.type === 'success'
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 ring-1 ring-emerald-400/10'
                : 'bg-red-500/15 border-red-500/30 text-red-300 ring-1 ring-red-400/10'
            }`}
          >
            {toast.type === 'success' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            )}
            <span>{toast.message}</span>
            <AnimatedButton
              onClick={dismissToast}
              className="ml-2 opacity-60 hover:opacity-100 transition-opacity"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </AnimatedButton>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
