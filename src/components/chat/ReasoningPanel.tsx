import { useT } from '../../i18n';

/** Display only provider-returned, sanitized content; never manufacture reasoning. */
export default function ReasoningPanel({ content, truncated }: { content: string; truncated?: boolean }) {
  const t = useT();
  if (!content) return null;
  return (
    <details className="ui-card mb-2 min-w-0 p-2 text-xs text-canvas-text-secondary">
      <summary className="cursor-pointer rounded py-1 font-medium text-canvas-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        {t('模型推理摘要')}
      </summary>
      <p className="my-2 text-[11px] text-canvas-text-muted">{t('由模型接口返回，仅供参考；工具权限和执行依据由应用独立判定。')}</p>
      <div tabIndex={0} className="max-h-60 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{content}</div>
      {truncated && <p className="mt-2 text-warning-light">{t('推理内容过长，展示已截断。')}</p>}
    </details>
  );
}
