/**
 * ModelDownloadDialog — 模型下载确认弹窗 + 下载中遮罩
 * 通过 createPortal 渲染到 document.body，避免被节点裁剪
 */
import { createPortal } from 'react-dom';

interface ModelInfo {
  title: string;
  description: string;
  loadingText: string;
  sizeText: string;
}

const MODEL_MAP: Record<'upscale' | 'matting', ModelInfo> = {
  upscale: {
    title: '超分模型未安装',
    description:
      '首次使用超分功能需要下载 Real-ESRGAN 模型文件（约 67MB）。下载后模型会保存在本地，后续使用无需再次下载。',
    loadingText: '正在下载模型...',
    sizeText: '首次下载约 67MB，请耐心等待',
  },
  matting: {
    title: '主体识别模型未安装',
    description:
      '首次使用自动识别主体功能需要下载 RMBG-1.4 模型文件（约 176MB）。下载后模型会保存在本地，后续使用无需再次下载。',
    loadingText: '正在下载模型...',
    sizeText: '首次下载约 176MB，请耐心等待',
  },
};

export interface ModelDownloadDialogProps {
  type: 'upscale' | 'matting';
  showPrompt: boolean;
  showDownloading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ModelDownloadDialog({
  type,
  showPrompt,
  showDownloading,
  onConfirm,
  onCancel,
}: ModelDownloadDialogProps) {
  const info = MODEL_MAP[type];

  return createPortal(
    <>
      {/* ── 下载确认弹窗 ── */}
      {showPrompt && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={onCancel}>
          <div
            className="bg-canvas-card border border-canvas-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center mt-0.5">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-canvas-text mb-1">{info.title}</h3>
                <p className="text-xs text-canvas-text-secondary leading-relaxed">{info.description}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 text-xs rounded-lg bg-canvas-hover text-canvas-text-secondary hover:bg-canvas-border transition-colors"
                onClick={onCancel}
              >
                取消
              </button>
              <button
                className="px-4 py-2 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors font-medium"
                onClick={onConfirm}
              >
                下载模型
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 下载中遮罩 ── */}
      {showDownloading && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
          <div className="bg-canvas-card border border-canvas-border rounded-xl p-8 max-w-xs mx-4 shadow-2xl text-center">
            <div className="spinner large mx-auto mb-4" />
            <p className="text-sm text-canvas-text font-medium mb-1">{info.loadingText}</p>
            <p className="text-xs text-canvas-text-muted">{info.sizeText}</p>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
