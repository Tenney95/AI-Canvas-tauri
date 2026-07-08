/**
 * UpdateBubble — 吉祥物旁的聊天气泡，提示有新版本可用
 */
import { motion, AnimatePresence } from 'framer-motion';
import type { UpdateInfo } from '../../../services/updateService';

interface UpdateBubbleProps {
  info: UpdateInfo;
  visible: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
  updating?: boolean;
}

export default function UpdateBubble({ info, visible, onUpdate, onDismiss, updating }: UpdateBubbleProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.6, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: 6 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-[245px] right-[28px] z-50 max-w-[280px]"
        >
          {/* 聊天气泡尖角 — 指向右下吉祥物 */}
          <div className="absolute -bottom-2 right-6 w-4 h-4 rotate-45 bg-canvas-card border-r border-b border-canvas-border" />

          <div className="relative bg-canvas-card border border-canvas-border rounded-xl p-4 shadow-xl">
            <p className="text-sm text-canvas-text font-semibold mb-1">
              发现新版本 v{info.version}
            </p>
            {info.body && (
              <p className="text-xs text-canvas-text-secondary mb-3 line-clamp-3">
                {info.body}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={onDismiss}
                className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-canvas-hover text-canvas-text-secondary hover:bg-canvas-border transition-colors"
              >
                暂不更新
              </button>
              <button
                onClick={onUpdate}
                disabled={updating}
                className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
              >
                {updating ? '正在更新...' : '立即更新'}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
