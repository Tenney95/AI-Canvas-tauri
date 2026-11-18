import { useState, useSyncExternalStore } from 'react';
import { useT } from '../../../i18n';
import { imagePromptCharacterCount } from '../../../services/ai/imagePromptLimits';
import {
  applyImagePromptOptimization, chooseImagePromptTruncation, closeImagePromptOverflow,
  getImagePromptOverflow, optimizeImagePrompt, subscribeImagePromptOverflow, updateImagePromptOverflowPreview,
  type ImagePromptOverflowView,
} from '../../../services/imagePromptOverflowService';
import ModalOverlay from '../../shared/ModalOverlay';
import PopupCloseButton from '../../shared/PopupCloseButton';
import ModelSelector from './ModelSelector';

export default function ImagePromptOverflowDialog() {
  const view = useSyncExternalStore(subscribeImagePromptOverflow, getImagePromptOverflow, () => null);
  return view ? <ImagePromptOverflowContent key={view.nodeId} view={view} /> : null;
}

function ImagePromptOverflowContent({ view }: { view: ImagePromptOverflowView }) {
  const t = useT();
  const [textModelId, setTextModelId] = useState(view.textModelId);
  const [confirmTruncation, setConfirmTruncation] = useState(false);
  const { overflow } = view;
  const previewCharacters = imagePromptCharacterCount(view.preview);
  return <ModalOverlay isOpen onClose={() => closeImagePromptOverflow()}
    ariaLabel={t('图片提示词超出上限')} className="ui-dialog-surface w-[min(680px,calc(100vw-24px))] max-h-[85vh]" zIndex={390}>
    <header className="ui-card__header shrink-0">
      <div className="min-w-0 flex-1">
        <h3 className="ui-card__title">{t('图片提示词超出上限')}</h3>
        <p className="ui-card__desc">{overflow.modelId}</p>
      </div>
      <PopupCloseButton ariaLabel={t('关闭')} onClick={() => closeImagePromptOverflow()} />
    </header>
    <div className="ui-card__body ui-scroll flex min-h-0 flex-col gap-3">
      <p role="alert" className="ui-alert ui-alert--warning">{t('最终提示词 {count} 字符，上限 {limit}，超出 {excess}。尚未提交生图请求。', {
        count: overflow.characters, limit: overflow.maxCharacters, excess: overflow.characters - overflow.maxCharacters,
      })}</p>
      <p className="ui-hint">{t('输入 {input} 字符；引用展开及附加说明后 {total} 字符。', {
        input: overflow.inputCharacters, total: overflow.characters,
      })}</p>
      <details className="ui-card p-2">
        <summary className="cursor-pointer text-xs text-canvas-text-secondary">{t('查看最终提示词')}</summary>
        <textarea readOnly className="ui-textarea mt-2 min-h-32" aria-label={t('最终提示词')} value={overflow.prompt} />
      </details>
      <button type="button" className="ui-btn ui-btn--secondary" disabled={view.busy} onClick={() => closeImagePromptOverflow(true)}>
        {t('返回手动精简')}
      </button>
      <section className="ui-card flex flex-col gap-2 p-3">
        <h4 className="text-sm font-medium text-canvas-text">{t('裁剪后继续生成')}</h4>
        <p className="ui-hint">{t('仅本次保留前 {limit} 字符，末尾内容会丢失，原提示词保留。', { limit: overflow.maxCharacters })}</p>
        <label className="flex items-center gap-2 text-xs text-canvas-text-secondary">
          <input type="checkbox" checked={confirmTruncation} disabled={view.busy} onChange={(event) => setConfirmTruncation(event.target.checked)} />
          {t('我已了解裁剪会丢失末尾内容')}
        </label>
        <button type="button" className="ui-btn ui-btn--secondary" disabled={view.busy || !confirmTruncation} onClick={chooseImagePromptTruncation}>
          {t('确认裁剪并生成')}
        </button>
      </section>
      <section className="ui-card flex flex-col gap-2 p-3">
        <h4 className="text-sm font-medium text-canvas-text">{t('创建文本节点，用 AI 优化')}</h4>
        <p className="ui-hint">{t('调用所选文本模型可能计费。先创建优化节点并预览结果，确认后继续生图。')}</p>
        <ModelSelector nodeType="ai-text" persistPreference={false} selectedModel={textModelId} disabled={view.busy}
          onSelect={(model) => setTextModelId(model.value)} onClear={() => setTextModelId('')} />
        <button type="button" className="ui-btn ui-btn--primary" disabled={view.busy || !textModelId}
          onClick={() => { void optimizeImagePrompt(textModelId); }}>
          {view.busy ? t('正在优化…') : t('创建节点并优化描述')}
        </button>
        {view.preview && <>
          <label className="ui-label" htmlFor="image-prompt-optimization-preview">{t('优化描述预览')} · {previewCharacters} / {overflow.maxCharacters}</label>
          <textarea id="image-prompt-optimization-preview" className="ui-textarea min-h-40" value={view.preview}
            disabled={view.busy} onChange={(event) => updateImagePromptOverflowPreview(event.target.value)} />
          <button type="button" className="ui-btn ui-btn--primary" disabled={view.busy || !view.preview.trim() || previewCharacters > overflow.maxCharacters}
            onClick={applyImagePromptOptimization}>{t('使用优化结果继续生图')}</button>
        </>}
      </section>
      {view.error && <p role="alert" className="ui-alert ui-alert--danger">{view.error}</p>}
    </div>
    <footer className="ui-card__footer shrink-0">
      <p className="ui-hint">{t('原始内容不会被自动覆盖，优化文本节点会保留。')}</p>
      <button type="button" className="ui-btn ui-btn--ghost" onClick={() => closeImagePromptOverflow()}>{t('取消生成')}</button>
    </footer>
  </ModalOverlay>;
}
