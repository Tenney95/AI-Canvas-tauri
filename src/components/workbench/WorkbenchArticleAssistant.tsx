import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { ScriptWorkbenchDispatch } from '../../types/scriptWorkbench';
import type { WorkbenchArticleCandidate, WorkbenchArticleTarget } from '../../types/workbenchArticle';

interface WorkbenchArticleAssistantProps {
  targetKey: string;
  targetLabel: string;
  target: WorkbenchArticleTarget | null;
  disabled: boolean;
  generating: boolean;
  unavailableReason?: string;
  dispatch: ScriptWorkbenchDispatch;
  containerRef?: Ref<HTMLElement>;
  hidden?: boolean;
}

export default function WorkbenchArticleAssistant({ targetKey, targetLabel, target, disabled, generating,
  unavailableReason, dispatch, containerRef, hidden = false }: WorkbenchArticleAssistantProps) {
  const t = useT();
  const inputId = useId();
  const [instruction, setInstruction] = useState('');
  const [candidate, setCandidate] = useState<{ key: string; value: WorkbenchArticleCandidate } | null>(null);
  const [pending, setPending] = useState<'generate' | 'apply' | 'discard' | 'cancel' | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const lifetime = useRef(0);
  const request = useRef(0);
  const currentTargetKey = useRef(targetKey);

  useEffect(() => {
    lifetime.current += 1;
    return () => { lifetime.current += 1; };
  }, []);
  useEffect(() => {
    currentTargetKey.current = targetKey;
    request.current += 1;
    setInstruction('');
    setCandidate(null);
    setError('');
    setStatus('');
    setPending(null);
  }, [targetKey]);

  const visibleCandidate = candidate?.key === targetKey ? candidate.value : null;
  const running = generating || pending === 'generate';
  const unavailable = disabled || !target;
  const busy = running || pending !== null;

  const generate = async () => {
    if (unavailable || busy || visibleCandidate || !instruction.trim() || !target) return;
    const capturedLifetime = lifetime.current;
    const capturedKey = targetKey;
    const sequence = ++request.current;
    const isCurrent = () => lifetime.current === capturedLifetime && currentTargetKey.current === capturedKey && request.current === sequence;
    setPending('generate'); setError(''); setStatus('');
    try {
      const result = await dispatch({ type: 'article_generate', target, instruction: instruction.trim() }) as WorkbenchArticleCandidate;
      if (!isCurrent()) return;
      if (!result || typeof result.id !== 'string' || typeof result.text !== 'string' || typeof result.targetLabel !== 'string') {
        throw new Error(t('文章候选响应无效，请重试'));
      }
      setCandidate({ key: capturedKey, value: result });
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : t('文章修改未完成，请重试'));
    } finally {
      if (isCurrent()) setPending(null);
    }
  };

  const act = async (kind: 'apply' | 'discard' | 'cancel') => {
    if (kind === 'cancel' ? !running || pending === 'cancel' : busy || !visibleCandidate || (kind === 'apply' && unavailable)) return;
    const capturedLifetime = lifetime.current;
    const capturedKey = targetKey;
    const sequence = request.current;
    const isCurrent = () => lifetime.current === capturedLifetime && currentTargetKey.current === capturedKey && request.current === sequence;
    setPending(kind); setError(''); setStatus('');
    try {
      const result = await dispatch(kind === 'cancel' ? { type: 'article_cancel' }
        : kind === 'apply' ? { type: 'article_apply', candidateId: visibleCandidate!.id }
          : { type: 'article_discard_candidate', candidateId: visibleCandidate!.id });
      if (!isCurrent()) return;
      if (kind === 'apply' && result !== true) throw new Error(t('当前文章已变化，请重新生成候选'));
      if (kind === 'cancel') request.current += 1;
      setCandidate(null);
      if (kind === 'apply') {
        setInstruction('');
        setStatus(t('修改已进入草稿，请保存当前文章。'));
      }
      setPending(null);
    } catch (cause) {
      if (isCurrent()) { setError(cause instanceof Error ? cause.message : t('文章操作未完成，请重试')); setPending(null); }
    }
  };

  return <section ref={containerRef} className={`${hidden ? 'hidden' : ''} absolute inset-x-0 bottom-0 z-10 max-h-[50%] overflow-y-auto p-1.5`} aria-label={t('文章 AI 修改')}>
    {visibleCandidate && <div className="ui-card mb-2 max-h-56" aria-label={t('文章修改候选')}>
      <div className="ui-card__header shrink-0 flex-wrap">
        <h3 className="ui-card__title">{t('修改预览')}</h3>
        <span className="ui-card__desc min-w-0 truncate" title={visibleCandidate.targetLabel}>{visibleCandidate.targetLabel}</span>
        <div className="ui-card__header-actions flex-wrap">
          <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={() => { void act('discard'); }}>{t('丢弃')}</button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={unavailable || busy} onClick={() => { void act('apply'); }}>
            {pending === 'apply' ? t('采用中…') : t('采用到草稿')}
          </button>
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-sans text-sm leading-relaxed text-canvas-text">{visibleCandidate.text}</pre>
    </div>}
    <div className="ui-ai-input" aria-busy={running}>
      <div className="ui-ai-input__body">
        <label htmlFor={inputId} className="sr-only">{t('文章修改要求')}</label>
        <textarea id={inputId} className="ui-ai-input__editor resize-none" rows={3} maxLength={2000}
          value={instruction} disabled={unavailable || busy || !!visibleCandidate} aria-disabled={unavailable || busy || !!visibleCandidate}
          placeholder={status || (unavailable ? unavailableReason || t('请先选择或载入可编辑的文章。')
            : t('输入修改要求，例如：保留情节，精简对白，增强结尾悬念…\nAI 先生成修改预览，采用后进入当前文章草稿。'))}
          onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.stopPropagation(); void generate();
            }
          }} />
      </div>
      <div className="ui-ai-input__footer ui-ai-input__footer--single-row">
        <span className="min-w-0 flex-1 truncate text-[11px] text-canvas-text-muted" title={targetLabel}>
          {target ? t('修改：{target}', { target: targetLabel }) : t('请选择可编辑的文章')}
        </span>
        <div className="ui-ai-input__tools">
          <span className="ui-ai-input__shortcut-hint text-[10px] text-canvas-text-muted">Ctrl / ⌘ + Enter</span>
          {running ? <button type="button" className="ui-ai-input__icon-btn ui-ai-input__submit" disabled={pending === 'cancel'}
            aria-label={t('停止修改文章')} title={t('停止修改文章')} onClick={() => { void act('cancel'); }}>
            <Icon icon="lucide:square" width="14" aria-hidden="true" />
          </button> : <button type="button" className="ui-ai-input__icon-btn ui-ai-input__submit"
            disabled={unavailable || busy || !!visibleCandidate || !instruction.trim()}
            aria-label={t('按要求修改当前文章')} title={t('按要求修改当前文章')} onClick={() => { void generate(); }}>
            <Icon icon="lucide:arrow-up" width="16" aria-hidden="true" />
          </button>}
        </div>
      </div>
    </div>
    {error && <p className="ui-error mt-2 break-words" role="alert">{error}</p>}
    <span className="sr-only" role="status" aria-live="polite">{running ? t('正在按要求修改文章…')
      : status || (unavailable ? unavailableReason || t('当前内容暂不可编辑，请先选择或载入文章。')
        : visibleCandidate ? t('预览后采用到当前文章草稿，再保存文章。') : t('AI 先生成修改预览，采用后进入当前文章草稿。'))}</span>
  </section>;
}
