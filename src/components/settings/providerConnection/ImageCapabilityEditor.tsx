/** 图片能力声明；候选按钮只用于编辑，不会自动成为模型支持的参数。 */
import { useState } from 'react';
import type { ProviderModelSelection } from '../../../types';
import type { ImageModelCapability } from '../../../types/aiTypes';
import { assertModelCapabilityProtocol, describeModelParameterGaps } from '../../../services/ai/modelCapabilityValidation';
import Select from '../../shared/Select';
import { IMAGE_QUICK_ADAPT_OPTIONS } from '../../../services/ai/imageModelTemplates';
import { useT } from '../../../i18n';

interface Props {
  model: ProviderModelSelection;
  onChange: (capability: ImageModelCapability) => void;
  onApplyTemplate: (templateId: string) => void;
  onClose: () => void;
}

const BACKGROUND_LABELS: Record<string, string> = {
  auto: 'auto（自动）', opaque: 'opaque（不透明）', transparent: 'transparent（透明）',
};

export default function ImageCapabilityEditor({ model, onChange, onApplyTemplate, onClose }: Props) {
  const t = useT();
  const capability = model.imageCapability ?? {};
  const [customResolution, setCustomResolution] = useState('');
  const [customRatio, setCustomRatio] = useState('');
  const [customQuality, setCustomQuality] = useState('');
  const [customBackground, setCustomBackground] = useState('');
  const [gptTemplate, setGptTemplate] = useState('gpt-2:openai');
  const [bananaTemplate, setBananaTemplate] = useState('banana-pro:google');
  let error = '';
  try { assertModelCapabilityProtocol(model); } catch (reason) {
    error = reason instanceof Error ? reason.message : t('图片参数声明无效');
  }
  const choose = (field: 'resolutions' | 'ratios' | 'qualities' | 'backgrounds',
    fallback: 'defaultResolution' | 'defaultRatio' | 'defaultQuality' | 'defaultBackground', value: string) => {
    const current = capability[field] ?? [];
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    onChange({ ...capability, [field]: next.length ? next : undefined,
      [fallback]: next.includes(capability[fallback] ?? '') ? capability[fallback] : undefined });
  };
  const booleanFields = [
    ['supportsBatch', t('批量生成')], ['supportsImageReference', t('参考图')],
    ['supportsDataUrlReference', t('Base64 参考图')],
  ] as const;
  return (
    <section className="ui-card p-3 space-y-3" aria-label={t('{name} 图片参数能力', { name: model.name })}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-canvas-text">{model.name} {t("· 图片参数能力")}</h4>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onClose}>{t("关闭")}</button>
      </div>
      <p className="text-xs text-canvas-text-secondary">{t("按该渠道文档勾选。留空表示未声明；多选参数还须在调用协议中映射对应变量。")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {([
          ['gpt', t('GPT Image 快速适配'), gptTemplate, setGptTemplate,
            t('同步更新当前模型的能力、协议与参考图方式；GPT 2／2.5 的高分辨率为实验档。')],
          ['banana', t('Nano Banana 快速适配'), bananaTemplate, setBananaTemplate,
            t('原生格式完整发送参考图，受应用 Base64 预算限制最多 6 张；中转站须支持所选接口格式。')],
        ] as const).map(([family, title, templateId, setTemplateId, description]) => (
          <section key={family} className="ui-card p-2 space-y-2" aria-label={t(title)}>
            <h5 className="text-xs font-medium text-canvas-text">{t(title)}</h5>
            <div className="flex items-center gap-2">
              <Select fixedMenu size="sm" className="min-w-0 flex-1" aria-label={t(title)} value={templateId} onChange={setTemplateId}>
                {IMAGE_QUICK_ADAPT_OPTIONS.filter((option) => option.family === family).map((option) => (
                  <option key={option.id} value={option.id}>{option.modelLabel} · {t(option.formatLabel)}</option>
                ))}
              </Select>
              <button type="button" className="ui-btn ui-btn--sm shrink-0" onClick={() => onApplyTemplate(templateId)}>{t('应用模板')}</button>
            </div>
            <p className="text-xs text-canvas-text-secondary">{t(description)}</p>
          </section>
        ))}
      </div>
      <p className="text-xs text-canvas-text-muted">{t('应用模板后仍可按渠道文档调整，保存连接后生效。')}</p>
      {([
        ['resolutions', 'defaultResolution', t('分辨率'), ['720p', '1K', '2K', '4K'], customResolution, setCustomResolution],
        ['ratios', 'defaultRatio', t('比例'), ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', 'auto'], customRatio, setCustomRatio],
        ['qualities', 'defaultQuality', t('质量'), ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], customQuality, setCustomQuality],
        ['backgrounds', 'defaultBackground', t('背景'), ['auto', 'opaque', 'transparent'], customBackground, setCustomBackground],
      ] as const).map(([field, fallback, label, presets, custom, setCustom]) => (
        <div key={field} className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-canvas-text">{label}{t("（可多选）")}</span>
            <label className="flex items-center gap-2 text-xs text-canvas-text-secondary">{t("默认")}
              <Select fixedMenu size="sm" aria-label={t('默认{label}', { label })} value={capability[fallback] ?? ''}
                onChange={(value) => onChange({ ...capability, [fallback]: value || undefined })}>
                <option value="">{field === 'backgrounds' ? t('接口默认（省略 background）')
                  : field === 'qualities' ? t('接口默认（省略 quality）') : t('模型默认（未声明）')}</option>
                {capability[field]?.map((value) => <option key={value} value={value}>{value}</option>)}
              </Select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {[...new Set([...presets, ...(capability[field] ?? [])])].map((value) => (
              <button key={value} type="button" aria-pressed={capability[field]?.includes(value) ?? false}
                className={`ui-btn ui-btn--sm ${capability[field]?.includes(value) ? 'is-active' : ''}`}
                onClick={() => choose(field, fallback, value)}>{field === 'backgrounds'
                  ? t(BACKGROUND_LABELS[value] ?? value)
                  : value === 'auto' ? field === 'qualities' ? t('auto（自动）') : t('自适应') : value}</button>
            ))}
            <input className="ui-input w-24" aria-label={t('自定义{label}', { label })} placeholder={t("自定义")} value={custom}
              onChange={(event) => setCustom(event.target.value)} />
            <button type="button" className="ui-btn ui-btn--sm" aria-label={t('添加自定义{label}', { label })} onClick={() => {
              const value = custom.trim();
              if (value && !capability[field]?.includes(value)) choose(field, fallback, value);
              setCustom('');
            }}>+</button>
          </div>
          {field === 'backgrounds' && <p className="text-xs text-canvas-text-muted">{t("接口默认省略背景参数；auto 是单独的参数值。仅按当前渠道文档声明，透明背景须使用支持透明通道的输出格式。")}</p>}
        </div>
      ))}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {booleanFields.map(([field, label]) => (
          <label key={field} className="space-y-1 text-xs text-canvas-text-secondary">
            <span>{label}</span>
            <Select fixedMenu size="sm" value={capability[field] === undefined ? '' : String(capability[field])}
              onChange={(value) => onChange({ ...capability, [field]: value === '' ? undefined : value === 'true',
                ...(field === 'supportsBatch' && value === 'false' ? { maxBatchCount: 1 } : {}),
                ...(field === 'supportsImageReference' && value === 'false' ? { maxImageReferences: 0, supportsDataUrlReference: false } : {}),
              })}>
              <option value="">{t("未声明")}</option><option value="true">{t("支持")}</option><option value="false">{t("不支持")}</option>
            </Select>
          </label>
        ))}
        {([['maxBatchCount', t('单次生成上限')], ['maxImageReferences', t('参考图数量上限')],
          ['promptMaxCharacters', t('提示词最多字符')], ['promptMaxNonAsciiCharacters', t('非 ASCII 提示词预算')]] as const).map(([field, label]) => (
          <label key={field} className="space-y-1 text-xs text-canvas-text-secondary">
            <span>{label}</span>
            <input className="ui-input w-full" type="number" step="1" min={field === 'maxImageReferences' ? 0 : 1}
              aria-label={label} placeholder={t("未声明")} value={capability[field] ?? ''}
              onChange={(event) => onChange({ ...capability,
                [field]: event.target.value === '' ? undefined : Number(event.target.value) })} />
          </label>
        ))}
      </div>
      {capability.promptMaxNonAsciiCharacters !== undefined && <p className="text-xs text-canvas-text-muted">{t('混合提示词按 ASCII/最多字符 + 非 ASCII/非 ASCII 预算 ≤ 1 校验。')}</p>}
      {describeModelParameterGaps(model) && <p className="text-xs text-canvas-text-muted">{t(describeModelParameterGaps(model))}</p>}
      {error && <p role="alert" className="text-xs text-canvas-text">{error}</p>}
    </section>
  );
}
