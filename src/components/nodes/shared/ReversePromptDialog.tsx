/**
 * 反推结果先留在弹窗，经用户确认后统一写入画布。
 */
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ModelOption, ReversePromptRequest } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import {
  addReversePromptTextNodes,
  isCompleteReversePromptResult,
  resolveVisionTextModel,
  reversePromptDraft,
  REVERSE_PROMPT_SOURCE_LABELS,
  type ReversePromptKind,
  type ReversePromptOptions,
  type ReversePromptOutput,
  type ReversePromptResult,
} from '../../../services/ai/reversePrompt';
import { VLM_MAX_IMAGES } from '../../../services/ai/imageUtils';
import {
  cancelCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
} from '../../../services/canvasDerivationGuard';
import { copyText } from '../../../services/clipboardService';
import ModelSelector from './ModelSelector';
import { resolveEffectiveModel } from './toolbar/presetAction';
import PopupCloseButton from '../../shared/PopupCloseButton';
import ModalOverlay from '../../shared/ModalOverlay';
import Select from '../../shared/Select';
import ViewportImage from '../../shared/ViewportImage';
import { useT } from '../../../i18n';

interface ReverseJob {
  kind: ReversePromptKind;
  sourceNodeIds: string[];
  imageUrls: string[];
  label?: string;
}

interface DraftRow {
  result?: ReversePromptResult;
  error?: string;
}

type SupplementMode = 'positive' | 'negative' | 'both';
type ReverseRunInputs = Pick<ReversePromptOptions, 'model' | 'provider' | 'extraPrompt' | 'negativeRequirement'>;

function ReversePromptContent({ request }: { request: ReversePromptRequest }) {
  const t = useT();
  const formId = useId();
  const sourceLabel = t(REVERSE_PROMPT_SOURCE_LABELS[request.kind]);
  const isText = request.kind === 'text';
  const sources = request.kind === 'images' ? request.sources : undefined;
  const imageUrls = useMemo(() => {
    if (request.kind === 'text') return [];
    return request.kind === 'images' ? request.sources.map((source) => source.imageUrl) : request.imageUrls;
  }, [request]);
  const [model, setModel] = useState(() => isText ? resolveEffectiveModel('ai-text') : resolveVisionTextModel());
  const [individual, setIndividual] = useState(false);
  const [outputFormat, setOutputFormat] = useState<ReversePromptOutput>('positive');
  const [supplementMode, setSupplementMode] = useState<SupplementMode>('positive');
  const [positive, setPositive] = useState('');
  const [negative, setNegative] = useState('');
  const [lastRunInputs, setLastRunInputs] = useState<ReverseRunInputs | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [selectedRow, setSelectedRow] = useState(0);
  const [processed, setProcessed] = useState<number | null>(null);
  const [runTotal, setRunTotal] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [runError, setRunError] = useState('');
  const [copied, setCopied] = useState(false);
  const activeRun = useRef<AbortController | null>(null);
  const checkSource = useRef<(() => boolean) | null>(null);
  const copyVersion = useRef(0);
  const invalidateCopy = useCallback(() => { copyVersion.current++; }, []);

  const jobs = useMemo<ReverseJob[]>(() => {
    if (request.kind !== 'images') return [{ kind: request.kind, sourceNodeIds: [request.sourceNodeId], imageUrls }];
    if (!individual) return [{ kind: 'images', sourceNodeIds: request.sources.map((source) => source.sourceNodeId), imageUrls }];
    return request.sources.map((source) => ({
      kind: 'image',
      sourceNodeIds: [source.sourceNodeId],
      imageUrls: [source.imageUrl],
      label: source.label,
    }));
  }, [imageUrls, individual, request]);

  useLayoutEffect(() => {
    const initial = useAppStore.getState();
    if (initial.reversePromptRequest !== request) return;
    const sourceId = request.kind === 'images' ? request.sources[0]?.sourceNodeId : request.sourceNodeId;
    const guard = sourceId && registerCanvasDerivation(initial, sourceId, {
      onCancel: () => {
        activeRun.current?.abort();
        invalidateCopy();
      },
    });

    // Only recheck source contents when the graph changes. Selection and token progress don't rebuild this map.
    const expectedImages = request.kind === 'images'
      ? new Map(request.sources.map((source) => [source.sourceNodeId, source.imageUrl]))
      : null;
    let checkedNodes: typeof initial.nodes | undefined;
    let sourcesMatch = false;

    const isCurrent = () => {
      const state = useAppStore.getState();
      if (state.reversePromptRequest !== request || !guard || !isCanvasDerivationFresh(guard, state)) return false;
      if (checkedNodes === state.nodes) return sourcesMatch;
      checkedNodes = state.nodes;
      if (expectedImages) {
        let matched = 0;
        for (const node of state.nodes) {
          const expected = expectedImages.get(node.id);
          if (expected === undefined) continue;
          const url = node.data.imageUrl?.trim() || node.data.thumbnailUrl?.trim();
          if (url !== expected) break;
          matched++;
        }
        sourcesMatch = matched === expectedImages.size;
      } else {
        const data = state.nodes.find((node) => node.id === sourceId)?.data;
        switch (request.kind) {
          case 'text':
            sourcesMatch = (data?.output?.trim() || data?.prompt?.trim()) === request.text;
            break;
          case 'image':
            sourcesMatch = (data?.imageUrl || data?.thumbnailUrl) === request.imageUrls[0];
            break;
          case 'video':
            sourcesMatch = data?.videoUrl === request.videoUrl;
            break;
        }
      }
      return sourcesMatch;
    };

    checkSource.current = isCurrent;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.nodes === previous.nodes && state.reversePromptRequest === previous.reversePromptRequest
        && state.projectExecutionContext === previous.projectExecutionContext
        && state.currentProjectId === previous.currentProjectId && state.projects === previous.projects
        && state.projectLoadStatus === previous.projectLoadStatus
        && state.switchingProjectName === previous.switchingProjectName
        && state.isCreatingProject === previous.isCreatingProject
        && state.isReturningToStartPage === previous.isReturningToStartPage
        && state.canvasRevision === previous.canvasRevision && state.globalCanvasRevision === previous.globalCanvasRevision) return;
      if (isCurrent()) return;
      if (guard) cancelCanvasDerivation(guard);
      if (state.reversePromptRequest === request) setInvalid(true);
    });
    return () => {
      unsubscribe();
      checkSource.current = null;
      invalidateCopy();
      if (guard) cancelCanvasDerivation(guard);
    };
  }, [invalidateCopy, request]);

  const close = useCallback(() => {
    activeRun.current?.abort();
    const store = useAppStore.getState();
    if (store.reversePromptRequest === request) store.setReversePromptRequest(null);
  }, [request]);

  const running = processed !== null;
  const limited = Boolean(sources && !individual && sources.length > VLM_MAX_IMAGES);
  const { validCount, pendingCount } = useMemo(() => {
    let validCount = 0;
    let pendingCount = 0;
    for (const { result } of rows) {
      if (result && isCompleteReversePromptResult(result)) validCount++;
      else pendingCount++;
    }
    return { validCount, pendingCount };
  }, [rows]);
  const activeResult = rows[selectedRow]?.result;
  const activeError = rows[selectedRow]?.error;
  const canCopy = Boolean(activeResult?.prompt?.trim() || activeResult?.negativePrompt?.trim());
  const showPositive = supplementMode !== 'negative';
  const showNegative = supplementMode !== 'positive';
  const extraPrompt = showPositive ? positive.trim() : '';
  const negativeRequirement = showNegative ? negative.trim() : '';
  const sameRunInputs = lastRunInputs
    && lastRunInputs.model === model?.model && lastRunInputs.provider === model?.provider
    && lastRunInputs.extraPrompt === extraPrompt && lastRunInputs.negativeRequirement === negativeRequirement;
  const retryCount = individual && sameRunInputs ? pendingCount : 0;

  const resetResults = () => {
    copyVersion.current++;
    setLastRunInputs(null);
    setRows([]);
    setSelectedRow(0);
    setRunError('');
    setCopied(false);
  };

  const verifySource = () => {
    if (checkSource.current?.()) return true;
    setInvalid(true);
    return false;
  };

  const handleRun = async () => {
    if (activeRun.current || invalid || limited || !verifySource()) return;
    if (!model?.model || !model.provider) {
      setRunError(t(isText ? '请先选择一个文本模型' : '请先选择一个能读图的文本模型'));
      return;
    }

    const controller = new AbortController();
    activeRun.current = controller;
    copyVersion.current++;
    setCopied(false);
    setRunError('');
    setStopping(false);
    const runInputs = { ...model, extraPrompt, negativeRequirement };
    const nextRows = retryCount ? rows.slice() : new Array<DraftRow>(jobs.length).fill({});
    setRunTotal(retryCount || jobs.length);
    setProcessed(0);
    const isCurrent = checkSource.current;

    let completed = 0;
    try {
      for (let index = 0; index < jobs.length; index++) {
        if (controller.signal.aborted) break;
        const previous = nextRows[index];
        if (previous.result && isCompleteReversePromptResult(previous.result)) continue;
        const job = jobs[index];
        try {
          const result = await reversePromptDraft({
            ...runInputs,
            kind: job.kind,
            imageUrls: job.imageUrls,
            sourceText: request.kind === 'text' ? request.text : undefined,
            signal: controller.signal,
          }, outputFormat);
          if (controller.signal.aborted) break;
          nextRows[index] = { result };
        } catch (error) {
          if (controller.signal.aborted) break;
          nextRows[index] = { ...previous, error: error instanceof Error ? error.message : t('提示词反推失败') };
        }
        setProcessed(++completed);
      }
    } finally {
      if (activeRun.current === controller) {
        activeRun.current = null;
        if (checkSource.current === isCurrent && useAppStore.getState().reversePromptRequest === request) {
          if (!isCurrent?.()) {
            setInvalid(true);
          } else if (completed > 0) {
            setLastRunInputs(runInputs);
            setRows(nextRows);
            setSelectedRow((index) => nextRows[index]?.result || nextRows[index]?.error
              ? index : Math.max(0, nextRows.findIndex((row) => row.result || row.error)));
          }
          setProcessed(null);
          setStopping(false);
        }
      }
    }
  };

  const handleStop = () => {
    setStopping(true);
    activeRun.current?.abort();
  };

  const handleCopy = async () => {
    if (activeRun.current || !canCopy || !activeResult) return;
    const version = ++copyVersion.current;
    const { prompt, negativePrompt } = activeResult;
    const text = prompt !== undefined && negativePrompt !== undefined
      ? `${t('正向提示词')}\n${prompt}\n\n${t('逆向提示词')}\n${negativePrompt}`
      : prompt ?? negativePrompt ?? '';
    const ok = await copyText(text);
    if (version !== copyVersion.current) return;
    setCopied(ok);
    if (!ok) useAppStore.getState().showToast(t('复制失败，请手动复制'), 'error');
  };

  const editResult = (field: keyof ReversePromptResult, text: string) => {
    copyVersion.current++;
    setCopied(false);
    setRows((previous) => {
      const result = previous[selectedRow]?.result;
      if (!result) return previous;
      const next = previous.slice();
      next[selectedRow] = { result: { ...result, [field]: text } };
      return next;
    });
  };

  const handleAdd = () => {
    if (activeRun.current || !validCount || !verifySource()) return;
    const validRows = rows.flatMap(({ result }, index) => result && isCompleteReversePromptResult(result)
      ? [{ ...result, sourceNodeIds: jobs[index].sourceNodeIds }]
      : []);
    if (addReversePromptTextNodes(request.kind, validRows).length) close();
  };

  const handleModelSelect = (option: ModelOption) => setModel({ model: option.value, provider: option.provider });
  const disabled = running || invalid;
  const error = invalid ? t('来源或画布已变化，请关闭后重新打开反推') : running ? '' : runError || activeError;

  return (
    <ModalOverlay
      isOpen
      onClose={close}
      ariaLabel={t('反推提示词')}
      className="reverse-prompt-modal"
    >
      <header className="preset-runner-header">
        <div className="preset-runner-heading">
          <span className="preset-runner-heading-icon">
            <Icon icon="mdi:text-search" width={20} height={20} />
          </span>
          <div>
            <h2>{t('反推提示词')}</h2>
            <p>{request.kind === 'video'
              ? t('已抽取 {count} 帧关键帧，连画面带运动一起反推', { count: imageUrls.length })
              : sources ? t('已选 {count} 张图片', { count: sources.length })
                : isText ? t('根据所选文本重构生成提示词') : t('读取这张图，反推出能重新生成它的提示词')}</p>
          </div>
        </div>
        <PopupCloseButton onClick={close} />
      </header>

      <div className="preset-runner-body overscroll-contain">
        {isText ? (
          <div className="reverse-prompt-source-text preset-manager-input" tabIndex={0} aria-label={t('参考文本')}>{request.text}</div>
        ) : (
          <div className="reverse-prompt-thumbs" aria-label={t('参与反推的{source}', { source: sourceLabel })}>
            {imageUrls.slice(0, VLM_MAX_IMAGES).map((url, index) => (
              <ViewportImage key={sources?.[index].sourceNodeId ?? index} src={url} alt={sources?.[index].label ?? `${sourceLabel}${index + 1}`} />
            ))}
          </div>
        )}

        <div className="preset-manager-field" role="group" aria-labelledby={`${formId}-model`}>
          <span className="preset-manager-label" id={`${formId}-model`}>{t('反推模型')}</span>
          <div className="reverse-prompt-model">
            <ModelSelector
              nodeType="ai-text"
              selectedModel={model?.model}
              selectedProvider={model?.provider}
              onSelect={handleModelSelect}
              disabled={disabled}
              persistPreference={false}
            />
            {!isText && <span className="reverse-prompt-hint">{t('需要能读图的模型')}</span>}
          </div>
        </div>

        <div className="reverse-prompt-settings">
          {sources && <div className="preset-manager-field">
            <label className="preset-manager-label" htmlFor={`${formId}-scope`}>{t('多图反推方式')}</label>
            <Select id={`${formId}-scope`} aria-label={t('多图反推方式')} aria-describedby={`${formId}-scope-hint`}
              value={individual ? 'individual' : 'common'} disabled={disabled}
              onChange={(value) => {
                const next = value === 'individual';
                if (next === individual) return;
                setIndividual(next);
                resetResults();
              }}>
              <option value="common">{t('公共提示词')}</option>
              <option value="individual">{t('逐图反推')}</option>
            </Select>
            <span id={`${formId}-scope-hint`} className="reverse-prompt-hint">{limited
              ? t('公共反推一次最多处理 {count} 张图片，请减少选图或选择逐图反推', { count: VLM_MAX_IMAGES })
              : individual ? t('每张图片单独生成一组提示词') : t('提炼所有图片共有的特征')}</span>
          </div>}
          <div className="preset-manager-field">
            <label className="preset-manager-label" htmlFor={`${formId}-output`}>{t('输出方式')}</label>
            <Select<ReversePromptOutput> id={`${formId}-output`} aria-label={t('输出方式')} value={outputFormat} disabled={disabled}
              onChange={(value) => {
                if (value === outputFormat) return;
                setOutputFormat(value);
                resetResults();
              }}>
              <option value="positive">{t('正向')}</option>
              <option value="negative">{t('逆向')}</option>
              <option value="positive-negative">{t('正向和逆向')}</option>
            </Select>
          </div>
          <div className="preset-manager-field">
            <label className="preset-manager-label" htmlFor={`${formId}-supplement`}>{t('补充方式')}</label>
            <Select<SupplementMode> id={`${formId}-supplement`} aria-label={t('补充方式')} value={supplementMode}
              disabled={disabled} onChange={setSupplementMode}>
              <option value="positive">{t('正向补充')}</option>
              <option value="negative">{t('逆向补充')}</option>
              <option value="both">{t('双向补充')}</option>
            </Select>
          </div>
        </div>

        <div className="reverse-prompt-fields reverse-prompt-supplements">
          {showPositive && <label className="preset-manager-field">
            <span className="preset-manager-label">{t('正向补充要求（可选）')}</span>
            <textarea className="preset-manager-input" value={positive}
              disabled={disabled} onChange={(event) => setPositive(event.target.value)}
              placeholder={t('例如：输出英文提示词 / 只描述角色不描述背景 / 按 Midjourney 风格组织')} />
          </label>}
          {showNegative && <label className="preset-manager-field">
            <span className="preset-manager-label">{t('逆向补充要求（可选）')}</span>
            <textarea className="preset-manager-input" value={negative}
              disabled={disabled} onChange={(event) => setNegative(event.target.value)}
              placeholder={t('例如：水印、文字、模糊背景')} />
          </label>}
        </div>

        <div className="reverse-prompt-preview">
          {running && <div className="reverse-prompt-preview-status" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>{stopping ? t('正在停止…') : individual
              ? t('已处理 {done} / {total} 张图片', { done: processed, total: runTotal })
              : t('正在读{source}并反推提示词...', { source: sourceLabel })}</span>
          </div>}

          {!running && individual && rows.length > 0 && (
            <div className="preset-manager-field">
              <div className="reverse-prompt-result-heading">
                <label className="preset-manager-label" htmlFor={`${formId}-result`}>{t('查看图片结果')}</label>
                <span id={`${formId}-result-count`} className="reverse-prompt-hint">
                  {t('{done} / {total} 组可添加', { done: validCount, total: jobs.length })}
                </span>
              </div>
              <Select id={`${formId}-result`} aria-label={t('查看图片结果')}
                aria-describedby={`${formId}-result-count`} value={selectedRow}
                onChange={(value) => {
                  copyVersion.current++;
                  setCopied(false);
                  setSelectedRow(Number(value));
                }}>
                {jobs.map((job, index) => {
                  const row = rows[index];
                  const complete = row?.result && isCompleteReversePromptResult(row.result);
                  return <option key={job.sourceNodeIds[0]} value={index}>
                    {index + 1}. {job.label} · {t(complete ? '已完成' : row?.error ? '失败' : '待反推')}
                  </option>;
                })}
              </Select>
            </div>
          )}

          <div aria-live="polite" aria-atomic="true" className={error ? 'reverse-prompt-error' : 'sr-only'}>
            {error && <>
              <Icon icon="lucide:triangle-alert" width={15} height={15} aria-hidden="true" />
              <span>{error}</span>
            </>}
          </div>

          {!running && activeResult && (
            <div className="reverse-prompt-fields">
              {activeResult.prompt !== undefined && <label className="preset-manager-field">
                <span className="preset-manager-label">{t('正向提示词')}</span>
                <textarea className="preset-manager-input reverse-prompt-result"
                  value={activeResult.prompt} readOnly={invalid}
                  onChange={(event) => editResult('prompt', event.target.value)} />
              </label>}
              {activeResult.negativePrompt !== undefined && <label className="preset-manager-field">
                <span className="preset-manager-label">{t('逆向提示词')}</span>
                <textarea className="preset-manager-input reverse-prompt-result"
                  value={activeResult.negativePrompt} readOnly={invalid}
                  onChange={(event) => editResult('negativePrompt', event.target.value)} />
              </label>}
            </div>
          )}

          {!running && !activeResult && !error && (
            <div className="reverse-prompt-preview-status">
              {t(rows.length ? '当前图片待反推' : '开始反推后，可在这里编辑提示词')}
            </div>
          )}
        </div>
      </div>

      <footer className="preset-modal-actions reverse-prompt-actions">
        <button type="button" className="preset-modal-btn-secondary" disabled={running || !canCopy} onClick={handleCopy}>
          <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width={15} height={15} />
          <span>{t(copied ? '已复制' : '复制')}</span>
        </button>
        <div>
          {running ? (
            <button type="button" className="preset-modal-btn-secondary" disabled={stopping} onClick={handleStop}>
              <Icon icon="mdi:stop" width={15} height={15} />
              <span>{t('停止反推')}</span>
            </button>
          ) : (
            <button type="button" className="preset-modal-btn-secondary" disabled={invalid || limited} onClick={handleRun}>
              <Icon icon="mdi:refresh" width={15} height={15} />
              <span>{t(retryCount ? '反推未完成项' : rows.length || runError ? '重新反推' : '开始反推')}</span>
            </button>
          )}
          <button type="button" className="preset-modal-btn-primary" disabled={disabled || !validCount} onClick={handleAdd}>
            <Icon icon="mdi:file-document-plus-outline" width={15} height={15} />
            <span>{individual ? t('添加 {count} 组结果', { count: validCount }) : t('添加为文本节点')}</span>
          </button>
        </div>
      </footer>
    </ModalOverlay>
  );
}

export default function ReversePromptDialog() {
  const request = useAppStore((state) => state.reversePromptRequest);
  const [instance, setInstance] = useState(() => ({ request, key: 0 }));
  if (instance.request !== request) setInstance({ request, key: instance.key + 1 });
  return request && <ReversePromptContent key={instance.key} request={request} />;
}
