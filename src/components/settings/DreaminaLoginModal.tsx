/**
 * DreaminaLoginModal — 即梦 OAuth 登录引导弹窗
 *
 * 展示官方 dreamina_cli OAuth 设备授权流程：打开授权链接 → 输入验证码 → 自动同步登录状态。
 * 运行态由父组件通过 Rust 命令 / 事件驱动传入。
 */
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type { DreaminaRuntime } from '../../types';
import PopupCloseButton from '../shared/PopupCloseButton';

interface DreaminaLoginModalProps {
  isOpen: boolean;
  runtime: DreaminaRuntime | null;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
  onCopy: (text: string, label: string) => void;
}

export default function DreaminaLoginModal({
  isOpen,
  runtime,
  onClose,
  onOpenUrl,
  onCopy,
}: DreaminaLoginModalProps) {
  const phase = runtime?.phase || 'preparing';
  const authUrl = runtime?.verificationUrl || '';
  const userCode = runtime?.userCode || '';
  const ready = phase === 'oauth_ready' || phase === 'polling';
  const waiting = phase === 'preparing' || phase === 'starting';

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="dreamina-login-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <motion.div
            className="dreamina-login-modal dreamina-login-modal--guide-open"
            role="dialog"
            aria-modal="true"
            aria-label="即梦登录"
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ type: 'spring', stiffness: 350, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            <PopupCloseButton
              ariaLabel="关闭即梦登录窗口"
              className="absolute right-3.5 top-3"
              onClick={onClose}
            />

            <div className="dreamina-login-modal-badge">即梦账号</div>

            <div className="dreamina-login-modal-message">
              {runtime?.message || 'OAuth 登录已启动，请按下方步骤完成授权。'}
            </div>

            {waiting && (
              <div className="dreamina-login-modal-wait">
                <div className="dreamina-login-modal-spinner" aria-hidden="true" />
                <div className="dreamina-login-modal-wait-text">
                  正在准备授权链接，请稍候…
                </div>
              </div>
            )}

            {ready && (
              <div className="dreamina-manual-guide">
                <div className="dreamina-manual-guide-head">
                  <div className="dreamina-manual-guide-title">OAuth 登录（2 步）</div>
                </div>
                <div className="dreamina-manual-quick">
                  <div className="dreamina-manual-step">1) 打开即梦授权链接</div>
                  <div className="dreamina-manual-link-row">
                    <input
                      className="dreamina-manual-link-input"
                      readOnly
                      aria-label="即梦授权链接"
                      value={authUrl}
                    />
                    <button
                      type="button"
                      className="settings-save-btn"
                      disabled={!authUrl}
                      onClick={() => authUrl && onOpenUrl(authUrl)}
                    >
                      打开
                    </button>
                    <button
                      type="button"
                      className="settings-save-btn settings-btn-ghost"
                      disabled={!authUrl}
                      onClick={() => authUrl && onCopy(authUrl, '授权链接')}
                    >
                      复制
                    </button>
                  </div>

                  <div className="dreamina-manual-step">2) 在授权页面输入验证码</div>
                  <div className="dreamina-manual-link-row">
                    <input
                      className="dreamina-manual-link-input dreamina-manual-code-input"
                      readOnly
                      aria-label="即梦验证码"
                      value={userCode}
                    />
                    <button
                      type="button"
                      className="settings-save-btn settings-btn-ghost"
                      disabled={!userCode}
                      onClick={() => userCode && onCopy(userCode, '验证码')}
                    >
                      复制验证码
                    </button>
                  </div>
                </div>
                <div className="dreamina-login-modal-wait dreamina-login-modal-wait--inline">
                  <div className="dreamina-login-modal-spinner" aria-hidden="true" />
                  <div className="dreamina-login-modal-wait-text">
                    请打开授权链接，在页面输入验证码；系统会自动同步登录状态。
                  </div>
                </div>
              </div>
            )}

            {phase === 'failed' && (
              <div className="dreamina-login-modal-error">
                {runtime?.error || '登录失败，请重试。'}
              </div>
            )}

            <div className="dreamina-login-modal-actions">
              <button type="button" className="settings-save-btn settings-btn-ghost" onClick={onClose}>
                收起登录引导
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
