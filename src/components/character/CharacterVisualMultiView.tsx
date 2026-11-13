import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { CharacterVisualGenerationParameters } from '../../types/media';
import CharacterVisualGenerationSettings from './CharacterVisualGenerationSettings';
import type { DramaCharacter } from '../../types/dramaAssets';
import {
  CHARACTER_VISUAL_VIEWS, composeCharacterVisualViews, DEFAULT_CHARACTER_VISUAL_CROP,
  type CharacterVisualCrop, type CharacterVisualView,
} from '../../services/characterVisualComposition';
import {
  generateCharacterVisual, readCharacterVisualCandidate, saveCharacterVisualComposite, resolveCharacterVisualParameters,
  type CharacterVisualCandidate, type CharacterVisualModel, type CharacterVisualReference, type CharacterVisualRun,
  type CharacterVisualTarget,
} from '../../services/characterVisualWorkbenchService';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';
import ViewportImage from '../shared/ViewportImage';

interface Props {
  target: CharacterVisualTarget;
  character: DramaCharacter;
  isNew: boolean;
  models: readonly CharacterVisualModel[];
  references: CharacterVisualReference[];
  runs: readonly CharacterVisualRun[];
  assertCurrent?: () => void;
  onGenerated: (run: CharacterVisualRun) => void;
  onComposite: (candidate: CharacterVisualCandidate) => void;
  onClose: () => void;
}

export default function CharacterVisualMultiView({
  target, character, isNew, models, references, runs, assertCurrent, onGenerated, onComposite, onClose,
}: Props) {
  const t = useT();
  const [modelId, setModelId] = useState('');
  const [generationParameters, setGenerationParameters] = useState<CharacterVisualGenerationParameters>({});
  const [style, setStyle] = useState('');
  const [versions, setVersions] = useState<Partial<Record<CharacterVisualView, string>>>({});
  const [crops, setCrops] = useState<Partial<Record<CharacterVisualView, CharacterVisualCrop>>>({});
  const [active, setActive] = useState<CharacterVisualView | 'compose' | 'save'>();
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ url: string; key: string }>();
  const [candidatePreviews, setCandidatePreviews] = useState<{ key: string; candidates: CharacterVisualCandidate[] }>();
  const actionRef = useRef<AbortController | null>(null);
  useEffect(() => () => actionRef.current?.abort(), []);

  const compatible = models.filter((model) => model.channel === 'standard' && references.length <= model.maxReferences);
  const model = compatible.find((item) => item.id === modelId) ?? (!modelId ? compatible[0] : undefined);
  const selections = CHARACTER_VISUAL_VIEWS.map((view) => {
    const candidateIds = runs.filter((run) => run.viewSlot === view.id).flatMap((run) => run.candidateIds);
    const selectedId = versions[view.id] ?? candidateIds[0];
    return { ...view, candidateIds, selectedId, crop: crops[view.id] ?? DEFAULT_CHARACTER_VISUAL_CROP };
  });
  const candidateKey = selections.flatMap((view) => view.selectedId || []).join(',');
  useEffect(() => {
    if (!candidateKey) return;
    let current = true;
    void Promise.all(candidateKey.split(',').map((id) => readCharacterVisualCandidate(target, id).catch(() => null)))
      .then((candidates) => {
        if (current) setCandidatePreviews({ key: candidateKey, candidates: candidates.filter((candidate) => candidate !== null) });
      });
    return () => { current = false; };
  }, [target, candidateKey]);
  const candidatesReady = candidatePreviews?.key === candidateKey;
  const views = selections.map((view) => ({ ...view,
    candidate: candidatesReady ? candidatePreviews?.candidates.find((item) => item.id === view.selectedId) : undefined,
  }));
  const selected = views.flatMap((view) => view.candidate
    ? [{ url: view.candidate.url, id: view.candidate.id, width: view.width, crop: view.crop }] : []);
  const key = JSON.stringify(selected.map(({ id, crop }) => [id, crop]));
  const currentPreview = preview && preview.key === key ? preview.url : undefined;
  const pending = Boolean(active);
  const generationRatio = (view: typeof CHARACTER_VISUAL_VIEWS[number]) => {
    if (!model) return undefined;
    if (model.ratios.length === 0) return view.ratio;
    const ratios = [generationParameters.aspectRatio, ...(view.ratio === '1:1' ? ['1:1'] : [view.ratio, '2:3', '4:5'])];
    return ratios.find((ratio) => ratio !== undefined && model.ratios.includes(ratio));
  };
  const missingViews = views.filter((view) => !view.candidateIds.length);

  const run = async (kind: NonNullable<typeof active>, action: (signal: AbortSignal) => Promise<void>) => {
    if (actionRef.current) return;
    const controller = new AbortController();
    actionRef.current = controller;
    setActive(kind);
    setError('');
    try {
      assertCurrent?.();
      await action(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('定妆操作失败'));
    } finally {
      actionRef.current = null;
      if (!controller.signal.aborted) setActive(undefined);
    }
  };

  const generate = async (view: typeof CHARACTER_VISUAL_VIEWS[number], signal: AbortSignal) => {
    const aspectRatio = generationRatio(view);
    if (!model || !aspectRatio) return false;
    setActive(view.id);
    const prompt = [
      [character.name, character.identity, character.summary, character.visualNotes, character.wardrobeDefault].filter(Boolean).join('。'),
      style.trim(),
      '保持各图为同一角色，服装、发型、五官和材质一致。统一采用干净中性背景、均匀棚光，不加文字。',
      `本次仅生成 ${view.label}（${aspectRatio}）。${view.requirement}`,
    ].filter(Boolean).join('\n\n');
    const result = await generateCharacterVisual({ ...resolveCharacterVisualParameters(model, generationParameters), target, characterName: character.name, isNew,
      workflowId: model.workflowId,
      operation: 'appearance', viewSlot: view.id, prompt, model: model.id, provider: model.provider,
      aspectRatio, references, assertCurrent }, signal);
    signal.throwIfAborted();
    assertCurrent?.();
    onGenerated(result);
    if (!result.candidates.length) {
      setError(result.error || t('定妆图未生成，请查看生成历史'));
      return false;
    }
    setVersions((previous) => ({ ...previous, [view.id]: result.candidates[0].id }));
    setCrops((previous) => ({ ...previous, [view.id]: DEFAULT_CHARACTER_VISUAL_CROP }));
    return true;
  };

  return (
    <ModalOverlay isOpen onClose={onClose} ariaLabel={t('多图定妆拼接')} zIndex={290}
      className="ui-dialog-surface max-h-[calc(100vh-48px)] w-[min(1120px,calc(100vw-48px))]">
      <header className="ui-card__header shrink-0 justify-between">
        <h2 className="ui-card__title">{t('多图定妆拼接')}</h2>
        <PopupCloseButton onClick={onClose} />
      </header>
      <div className="ui-stack min-h-0 overflow-auto p-3">
        <div className="flex flex-wrap gap-2">
          <CharacterVisualGenerationSettings models={compatible} model={model} values={generationParameters} disabled={pending}
            onSelect={(item) => setModelId(item.id)} onChange={(patch) => setGenerationParameters((current) => ({ ...current, ...patch }))} />
          <button type="button" className="ui-btn ui-btn--primary" disabled={pending || !missingViews.length || missingViews.some((view) => !generationRatio(view))}
            onClick={() => void run('sheet', async (signal) => {
              for (const view of missingViews) {
                if (!await generate(view, signal)) break;
              }
            })}>{t('生成缺少的定妆图')}</button>
          {references.length > 0 && <span className="self-center text-xs text-canvas-text-secondary">{t('沿用选中的 {count} 张参考图', { count: references.length })}</span>}
          {!compatible.length && <p className="self-center text-xs text-canvas-text-secondary">{t('当前没有兼容的生图模型，请在「设置 → API Key」中配置')}</p>}
        </div>
        <input className="ui-input" aria-label={t('统一风格要求')} placeholder={t('统一风格要求')} maxLength={2000}
          value={style} disabled={pending} onChange={(event) => setStyle(event.target.value)} />
        <div className="grid gap-3 md:grid-cols-3">
          {views.map((view) => (
            <section key={view.id} className="ui-card ui-stack p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="ui-card__title">{t(view.label)}</h3>
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={pending || !generationRatio(view)}
                  onClick={() => void run(view.id, async (signal) => { await generate(view, signal); })}>
                  {t(active === view.id ? '生成中…' : view.candidateIds.length ? '重做此图' : '生成此图')}
                </button>
              </div>
              {view.candidate && <ViewportImage className="h-40 w-full rounded-md bg-canvas-surface object-contain" src={view.candidate.url} alt={t(view.label)} />}
              {view.selectedId && !view.candidate && <p className="text-xs text-canvas-text-secondary" role="status">
                {t(candidatesReady ? '原候选图片文件不可用' : '正在读取候选图片…')}
              </p>}
              {view.candidateIds.length > 0 && (
                <Select aria-label={t('选择定妆版本')} value={view.selectedId ?? ''} disabled={pending} onChange={(id) => {
                  setVersions((previous) => ({ ...previous, [view.id]: id }));
                  setCrops((previous) => ({ ...previous, [view.id]: DEFAULT_CHARACTER_VISUAL_CROP }));
                }}>
                  <option value="">{t('不加入拼接')}</option>
                  {view.candidateIds.map((id, index) => <option key={id} value={id}>{t('版本 {number}', { number: view.candidateIds.length - index })}</option>)}
                </Select>
              )}
              {view.candidate && (
                <div className="ui-stack ui-stack--tight text-xs">
                  {(['zoom', 'x', 'y'] as const).map((field, index) => (
                    <label key={field} className="flex items-center gap-2">
                      <span className="shrink-0">{t(['裁切缩放', '水平', '垂直'][index])}</span>
                      <input className="min-w-0 flex-1" type="range" min={field === 'zoom' ? 1 : 0}
                        max={field === 'zoom' ? 3 : 100} step={field === 'zoom' ? 0.05 : 1} value={view.crop[field]} disabled={pending}
                        onChange={(event) => setCrops((previous) => ({ ...previous, [view.id]: {
                          ...view.crop, [field]: event.target.valueAsNumber,
                        } }))} />
                    </label>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
        {currentPreview && <ViewportImage src={currentPreview} alt={t('定妆拼接预览')} className="max-h-80 w-full object-contain" eager />}
        {error && <p role="alert" className="text-sm text-canvas-text-secondary">{error}</p>}
      </div>
      <footer className="ui-card__footer justify-end gap-2">
        <button type="button" className="ui-btn ui-btn--secondary" disabled={pending || selected.length < 2}
          onClick={() => void run('compose', async (signal) => { setPreview({ key, url: await composeCharacterVisualViews(selected, signal) }); })}>
          {t('预览拼接')}
        </button>
        <button type="button" className="ui-btn ui-btn--primary" disabled={pending || !currentPreview}
          onClick={() => {
            if (!currentPreview) return;
            void run('save', async (signal) => {
              const candidate = await saveCharacterVisualComposite(target, currentPreview, character.name, isNew, signal, assertCurrent);
              signal.throwIfAborted();
              onComposite(candidate);
            });
          }}>{t('保存拼接候选')}</button>
      </footer>
    </ModalOverlay>
  );
}
