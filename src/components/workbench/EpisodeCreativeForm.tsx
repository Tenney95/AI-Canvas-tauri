import { useId } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { CreativeFieldId } from '../../services/seriesCreativeService';
import type { WorkbenchCreativeDraft } from '../../types/scriptWorkbench';
import NumberStepper from '../shared/NumberStepper';

function CreativeField({
  label,
  value,
  placeholder,
  multiline = false,
  readOnly = false,
  numberInput,
  onChange,
  onAiAction,
  aiDisabled = false,
}: {
  label: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
  readOnly?: boolean;
  numberInput?: { min: number; max?: number; step?: number };
  onChange: (value: string) => void;
  onAiAction?: () => void;
  aiDisabled?: boolean;
}) {
  const t = useT();
  const inputId = useId();
  const aiActionLabel = value.trim() ? t('AI 润色') : t('AI 生成');
  const fieldClass = `w-full rounded-lg border border-canvas-border bg-canvas-card px-3 text-xs
                      text-canvas-text outline-none transition-colors placeholder:text-canvas-text-muted
                      focus:border-indigo-400/60 focus:ring-1 focus:ring-indigo-400/20`;
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="flex min-w-0 items-center gap-2">
        <label
          htmlFor={inputId}
          className="min-w-0 flex-1 truncate text-[11px] font-medium text-canvas-text-secondary"
        >
          {label}
        </label>
        {onAiAction ? (
          <button
            type="button"
            disabled={aiDisabled}
            onClick={(event) => {
              event.preventDefault();
              onAiAction();
            }}
            aria-label={t('{action}{label}', { action: aiActionLabel, label })}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-indigo-400/20
                       bg-indigo-500/10 px-2 text-[10px] font-medium text-indigo-300 transition-colors
                       hover:border-indigo-400/40 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon icon="lucide:sparkles" className="h-3 w-3" />
            {aiActionLabel}
          </button>
        ) : null}
      </span>
      {numberInput ? (
        <NumberStepper id={inputId} value={Number.parseFloat(value) || numberInput.min}
          onChange={(next) => onChange(String(next))} min={numberInput.min} max={numberInput.max} step={numberInput.step ?? 1}
          disabled={readOnly} aria-label={label} className="w-full" />
      ) : multiline ? (
        <textarea
          id={inputId}
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`${fieldClass} min-h-24 resize-y py-2.5 leading-relaxed`}
        />
      ) : (
        <input
          id={inputId}
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`${fieldClass} h-9`}
        />
      )}
    </div>
  );
}

interface EpisodeCreativeFormProps {
  draft: WorkbenchCreativeDraft;
  disabled: boolean;
  aiDisabled: boolean;
  onChange: (field: keyof WorkbenchCreativeDraft, value: string) => void;
  onPolish: (field: CreativeFieldId, label: string, hasValue: boolean) => void;
}

export default function EpisodeCreativeForm({ draft, disabled, aiDisabled, onChange, onPolish }: EpisodeCreativeFormProps) {
  const t = useT();
  return (
    <fieldset disabled={disabled} className="grid gap-4 p-4 md:grid-cols-2">
      <CreativeField
        label={t('本集任务')}
        value={draft.task}
        placeholder={t('这一集必须完成什么叙事推进？')}
        onChange={(value) => onChange('task', value)}
        onAiAction={() => { void onPolish('task', t('本集任务'), Boolean(draft.task.trim())); }}
        aiDisabled={aiDisabled}
      />
      <CreativeField
        label={t('核心冲突')}
        value={draft.coreConflict}
        placeholder={t('谁与谁争夺什么，失败代价是什么？')}
        onChange={(value) => onChange('coreConflict', value)}
        onAiAction={() => { void onPolish('coreConflict', t('核心冲突'), Boolean(draft.coreConflict.trim())); }}
        aiDisabled={aiDisabled}
      />
      <CreativeField
        label={t('开场钩子')}
        value={draft.openingHook}
        placeholder={t('开场 3-5 秒发生什么？')}
        onChange={(value) => onChange('openingHook', value)}
        onAiAction={() => { void onPolish('openingHook', t('开场钩子'), Boolean(draft.openingHook.trim())); }}
        aiDisabled={aiDisabled}
      />
      <CreativeField
        label={t('反转或情绪爆点')}
        value={draft.reversal}
        placeholder={t('本集最强的变化是什么？')}
        onChange={(value) => onChange('reversal', value)}
        onAiAction={() => { void onPolish('reversal', t('反转或情绪爆点'), Boolean(draft.reversal.trim())); }}
        aiDisabled={aiDisabled}
      />
      <CreativeField
        label={t('结尾卡点')}
        value={draft.endingHook}
        placeholder={t('观众必须继续看的未完成事件')}
        onChange={(value) => onChange('endingHook', value)}
        onAiAction={() => { void onPolish('endingHook', t('结尾卡点'), Boolean(draft.endingHook.trim())); }}
        aiDisabled={aiDisabled}
      />
      <CreativeField
        label={t('原著来源范围')}
        value={draft.sourceRange}
        placeholder={t('例如：第 3 章 20%-45%')}
        onChange={(value) => onChange('sourceRange', value)}
      />
      <CreativeField
        label={t('主要情节点（每行一条）')}
        value={draft.beats}
        placeholder={t('建议 3-5 条，按发生顺序排列')}
        multiline
        onChange={(value) => onChange('beats', value)}
        onAiAction={() => { void onPolish('beats', t('主要情节点（每行一条）'), Boolean(draft.beats.trim())); }}
        aiDisabled={aiDisabled}
      />
      <CreativeField
        label={t('目标时长（秒）')}
        readOnly={disabled}
        numberInput={{ min: 1 }}
        value={draft.targetDurationSec}
        placeholder="90"
        onChange={(value) => onChange('targetDurationSec', value)}
      />
    </fieldset>
  );
}
