import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import type { DramaCharacter } from '../../types/dramaAssets';
import {
  analyzeCharacterVisualFields, listCharacterVisualAnalysisModels, previewCharacterVisualProjectUpdate,
  type CharacterVisualFieldPatch,
} from '../../services/characterVisualProjectUpdate';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';
import ViewportImage from '../shared/ViewportImage';

const visualFields = ['visualNotes', 'wardrobeDefault'] as const;
const fieldLabels = { visualNotes: '外观特征', wardrobeDefault: '默认服装' };
type Preview = Awaited<ReturnType<typeof previewCharacterVisualProjectUpdate>>;

export default function CharacterVisualProjectUpdate({ character, scope, imageUrl, targetReferenceId, assertCurrent, onApplyFields, onClose }: {
  character: DramaCharacter;
  scope: 'project' | 'global';
  imageUrl: string;
  targetReferenceId?: string;
  assertCurrent?: () => void;
  onApplyFields: (patch: CharacterVisualFieldPatch) => void;
  onClose: () => void;
}) {
  const t = useT();
  const config = useAppStore((state) => state.config);
  const savedReference = useAppStore((state) => scope === 'project' && targetReferenceId !== undefined
    && Boolean(state.dramaAssets.characters.find((item) => item.id === character.id)?.referenceImages
      ?.some((reference) => reference.id === targetReferenceId)));
  const models = useMemo(() => listCharacterVisualAnalysisModels(config), [config]);
  const [modelId, setModelId] = useState('');
  const model = models.find((item) => item.value === modelId) ?? models[0];
  const [suggestion, setSuggestion] = useState<CharacterVisualFieldPatch | null>(null);
  const [selectedFields, setSelectedFields] = useState<(keyof CharacterVisualFieldPatch)[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [pending, setPending] = useState<'analyze' | 'preview' | 'apply'>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const task = useRef<AbortController | null>(null);
  useEffect(() => () => task.current?.abort(), []);

  const run = async (action: NonNullable<typeof pending>, work: (signal: AbortSignal) => Promise<void>, fallback?: string) => {
    if (task.current) return;
    const controller = new AbortController();
    task.current = controller;
    setPending(action);
    setError('');
    setMessage('');
    try {
      assertCurrent?.();
      await work(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) setError(fallback ?? (reason instanceof Error ? reason.message : t('操作失败，请重试')));
    } finally {
      task.current = null;
      if (!controller.signal.aborted) setPending(undefined);
    }
  };

  const analyze = () => {
    if (!model) return;
    setSuggestion(null);
    setSelectedFields([]);
    void run('analyze', async (signal) => {
      const projectId = scope === 'project' ? useAppStore.getState().currentProjectId : undefined;
      const result = await analyzeCharacterVisualFields({ imageUrl, projectId, modelId: model.value, signal,
        assertCurrent: () => { signal.throwIfAborted(); assertCurrent?.(); } });
      if (!signal.aborted) setSuggestion(result);
    }, t('角色识图失败，请检查图片和所选模型'));
  };
  const applyFields = () => {
    if (!suggestion) return;
    try {
      assertCurrent?.();
      const patch: CharacterVisualFieldPatch = {};
      for (const key of selectedFields) if (suggestion[key] !== undefined) patch[key] = suggestion[key];
      if (!Object.keys(patch).length) return;
      onApplyFields(patch);
      setSuggestion(null);
      setSelectedFields([]);
      setError('');
      setMessage(t('已写入角色草稿，返回后点击保存角色'));
    } catch {
      setError(t('角色已变化，请重新打开编辑器'));
    }
  };
  const readPreview = () => {
    if (!targetReferenceId || !savedReference) return;
    setPreview(null);
    setSelectedNodes([]);
    void run('preview', async (signal) => {
      const result = await previewCharacterVisualProjectUpdate(character.id, targetReferenceId, signal);
      if (!signal.aborted) setPreview(result);
    });
  };
  const applyReferences = () => {
    if (!preview || !selectedNodes.length) return;
    void run('apply', async (signal) => {
      const count = await useAppStore.getState().applyCharacterVisualReferencePlan(preview.plan, selectedNodes, () => {
        signal.throwIfAborted();
        assertCurrent?.();
      });
      if (signal.aborted) return;
      setPreview(null);
      setSelectedNodes([]);
      setMessage(t('已更新 {count} 个节点的角色引用，可在画布撤销', { count }));
    });
  };
  const fields = visualFields.filter((key) => suggestion?.[key] && suggestion[key] !== character[key]);
  const close = () => { if (pending !== 'apply') { task.current?.abort(); onClose(); } };
  return (
    <ModalOverlay isOpen onClose={close} closeOnBackdrop={pending !== 'apply'} ariaLabel={t('按图更新角色与项目')}
      className="ui-dialog-surface w-[min(860px,calc(100vw-32px))] max-h-[85vh]" zIndex={365}>
      <header className="ui-card__header justify-between">
        <div className="min-w-0">
          <h2 className="ui-card__title">{t('按图更新角色与项目')}</h2>
          {character.name && <p className="ui-card__desc truncate">{character.name}</p>}
        </div>
        <PopupCloseButton onClick={close} disabled={pending === 'apply'} />
      </header>
      <div className="ui-card__body ui-scroll ui-stack min-h-0">
        <section className="ui-card ui-stack p-3" aria-label={t('识图更新角色设定')}>
          <div className="flex flex-wrap items-start gap-3">
            <ViewportImage src={imageUrl} alt={t('当前选中图')} eager className="h-24 w-28 shrink-0 rounded bg-canvas-surface object-contain" />
            <div className="ui-stack flex-1">
              <h3 className="ui-card__title">{t('识图更新角色设定')}</h3>
              <div className="flex flex-wrap gap-2">
                <Select value={model?.value ?? ''} onChange={setModelId} disabled={Boolean(pending) || !models.length}
                  aria-label={t('识图模型')} placeholder={t('请选择可识图的文本模型')}>
                  {models.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </Select>
                <button type="button" className="ui-btn ui-btn--secondary" disabled={Boolean(pending) || !model}
                  onClick={analyze}>{t(pending === 'analyze' ? '正在识图…' : '识别外观和服装')}</button>
              </div>
            </div>
          </div>
          {suggestion && !fields.length && <p role="status" className="ui-hint">{t('没有可采纳的外观或服装修改')}</p>}
          {fields.map((key) => (
            <div key={key} className="ui-card ui-stack p-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="ui-checkbox" checked={selectedFields.includes(key)} disabled={Boolean(pending)}
                  onChange={(event) => setSelectedFields(event.target.checked ? [...selectedFields, key] : selectedFields.filter((item) => item !== key))} />
                {t(fieldLabels[key])}
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <div><p className="ui-hint">{t('当前内容')}</p><p className="whitespace-pre-wrap break-words">{character[key] || t('空白')}</p></div>
                <div><p className="ui-hint">{t('识图建议')}</p><p className="whitespace-pre-wrap break-words">{suggestion?.[key]}</p></div>
              </div>
            </div>
          ))}
          {!!fields.length && <button type="button" className="ui-btn ui-btn--primary self-start" disabled={Boolean(pending) || !selectedFields.length}
            onClick={applyFields}>{t('采纳选中的角色设定')}</button>}
        </section>
        {scope === 'project' && <section className="ui-card ui-stack p-3" aria-label={t('批量更新项目引用')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="ui-card__title">{t('批量更新项目引用')}</h3>
            <button type="button" className="ui-btn ui-btn--secondary" disabled={Boolean(pending) || !savedReference}
              onClick={readPreview}>{t(pending === 'preview' ? '正在查找引用…' : '预览引用变更')}</button>
          </div>
          {!savedReference ? <p className="ui-hint">{t('请先把选中图加入参考图并保存角色，再重新打开此操作')}</p>
            : <p className="ui-hint">{t('选择当前画布的节点，将其已指定的角色图片引用改为选中图')}</p>}
          {preview && !preview.plan.changes.length && <p role="status" className="ui-hint">{t('当前画布没有可改绑的角色图片引用')}</p>}
          {preview?.plan.changes.map((entry) => (
            <label key={entry.nodeId} className="flex items-center gap-2 rounded border border-canvas-border p-2">
              <input type="checkbox" className="ui-checkbox" checked={selectedNodes.includes(entry.nodeId)} disabled={Boolean(pending)}
                onChange={(event) => setSelectedNodes(event.target.checked ? [...selectedNodes, entry.nodeId] : selectedNodes.filter((id) => id !== entry.nodeId))} />
              <span className="min-w-0 flex-1 break-words text-sm">{entry.label}</span>
              <span className="ui-hint shrink-0">{t('{count} 处图片引用', { count: entry.promptMatches + entry.videoMatches })}</span>
            </label>
          ))}
          {!!preview?.readonlyLocations.length && <details>
            <summary className="ui-hint cursor-pointer">{t('其他 {count} 处使用位置仅供查看', { count: preview.readonlyLocations.length })}</summary>
            <ul className="ui-stack mt-2 max-h-36 overflow-y-auto">
              {preview.readonlyLocations.map((item) => <li key={item.key} className="break-words text-sm">
                {item.projectName ? `${item.projectName} · ` : ''}{item.name}
              </li>)}
            </ul>
          </details>}
          {!!preview?.plan.changes.length && <button type="button" className="ui-btn ui-btn--primary self-start"
            disabled={Boolean(pending) || !selectedNodes.length} onClick={applyReferences}>
            {t(pending === 'apply' ? '正在保存…' : '更新选中节点的引用')}
          </button>}
        </section>}
        {message && <p role="status" className="ui-hint">{message}</p>}
        {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
      </div>
      <footer className="ui-card__footer justify-end">
        <button type="button" className="ui-btn ui-btn--secondary" disabled={pending === 'apply'} onClick={close}>{t('返回')}</button>
      </footer>
    </ModalOverlay>
  );
}
