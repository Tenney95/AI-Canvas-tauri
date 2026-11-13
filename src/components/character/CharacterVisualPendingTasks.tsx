import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { confirmAction } from '../../services/confirmDialog';
import {
  captureCharacterVisualScope, listPendingCharacterVisualRuns, reviewCharacterVisualRun, subscribeCharacterVisualRuns,
  type CharacterVisualTarget, type PendingCharacterVisualRun,
} from '../../services/characterVisualWorkbenchService';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';

const PAGE_SIZE = 30;

export default function CharacterVisualPendingTasks({ scope, onClose }: { scope: CharacterVisualTarget['scope']; onClose: () => void }) {
  const t = useT();
  const [target] = useState(() => captureCharacterVisualScope(scope));
  const [tasks, setTasks] = useState<PendingCharacterVisualRun[]>();
  const [readFailed, setReadFailed] = useState(false);
  const [reviewFailed, setReviewFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [reviewing, setReviewing] = useState<string>();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const review = useRef<AbortController | null>(null);

  useEffect(() => () => review.current?.abort(), []);
  useEffect(() => {
    let active = true;
    let requested = 0;
    const refresh = async () => {
      const version = ++requested;
      try {
        const latest = await listPendingCharacterVisualRuns(target);
        if (active && version === requested) { setTasks(latest); setReadFailed(false); }
      } catch {
        if (active && version === requested) setReadFailed(true);
      }
    };
    const unsubscribe = subscribeCharacterVisualRuns(() => { void refresh(); });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [target, revision]);

  const markReviewed = async (task: PendingCharacterVisualRun) => {
    if (review.current || task.status === 'active') return;
    const controller = new AbortController();
    review.current = controller;
    setReviewing(task.id);
    setReviewFailed(false);
    try {
      const confirmed = await confirmAction(task.status === 'prepared' ? '确认结束这条未提交的任务？'
        : '确认已在服务商核对原任务？继续生成可能产生新的费用。', { title: '核对原任务' });
      if (!confirmed || controller.signal.aborted) return;
      await reviewCharacterVisualRun({ ...target, characterId: task.characterId }, task.id, () => {
        controller.signal.throwIfAborted();
        if (!useAppStore.getState().characterLibraryOpen) throw new Error(t('原角色生成任务已变化，请刷新后重试'));
      }, task.status);
    } catch {
      if (!controller.signal.aborted) setReviewFailed(true);
    } finally {
      review.current = null;
      if (!controller.signal.aborted) setReviewing(undefined);
    }
  };

  return <ModalOverlay isOpen ariaLabel={t('待处理生图任务')} onClose={onClose} zIndex={280}
    className="ui-dialog-surface max-h-[calc(100vh-48px)] w-[min(640px,calc(100vw-48px))]">
    <header className="ui-card__header shrink-0 justify-between">
      <h2 className="ui-card__title">{t('待处理生图任务')}</h2>
      <PopupCloseButton onClick={onClose} />
    </header>
    <div className="ui-stack min-h-0 overflow-auto p-3">
      {readFailed ? <p role="alert" className="text-sm text-canvas-text-secondary">{t('角色生成历史读取失败')}</p>
        : tasks === undefined ? <p role="status" className="text-sm text-canvas-text-secondary">{t('正在读取待处理任务…')}</p>
          : !tasks.length ? <p role="status" className="text-sm text-canvas-text-secondary">{t('暂无待处理生图任务')}</p> : null}
      {reviewFailed && <p role="alert" className="text-sm text-canvas-text-secondary">{t('任务核对状态保存失败')}</p>}
      {!readFailed && tasks?.slice(0, visibleCount).map((task) => <section key={task.id} className="ui-card flex flex-wrap items-center justify-between gap-3 p-2">
        <div className="min-w-0 flex-1 text-sm">
          <p className="break-words">{task.name || task.characterId} · {task.model}</p>
          <p className="text-xs text-canvas-text-secondary">{t(task.status === 'active' ? '生成中…' : task.status === 'prepared'
            ? '本次图片生成未提交' : '提交状态待核对')} · {new Date(task.createdAt).toLocaleString()}</p>
          <p className="break-all text-xs text-canvas-text-secondary">{task.id}</p>
        </div>
        {task.status !== 'active' && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm"
          disabled={Boolean(reviewing)} onClick={() => void markReviewed(task)}>
          {t(task.status === 'prepared' ? '结束跟踪' : '已核对原任务')}
        </button>}
      </section>)}
      {!readFailed && (tasks?.length ?? 0) > visibleCount && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm self-center"
        onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>{t('加载更多')}</button>}
    </div>
    <footer className="ui-card__footer justify-end">
      <button type="button" className="ui-btn ui-btn--secondary" disabled={Boolean(reviewing)}
        onClick={() => setRevision((value) => value + 1)}>{t('刷新')}</button>
    </footer>
  </ModalOverlay>;
}
