import { useT } from '../../../i18n';
import type { WorkflowApiInputValues } from '../../../types/workflowApi';
import { AUTODL_H3_WORKFLOW } from '../../../services/workflowApi/autodlWorkflowManifest';

export default function ProviderWorkflowSection({ values, onChange }: {
  values: WorkflowApiInputValues; onChange: (values: WorkflowApiInputValues) => void;
}) {
  const t = useT();
  return <section className="provider-config-section">
    <div className="provider-section-heading"><div><h4>{t('工作流 API')}</h4><p>{t('保存连接后，在视频节点的工作流列表中选择此模板。')}</p></div></div>
    <div className="ui-card flex flex-col gap-3 p-3">
      <strong>{t(AUTODL_H3_WORKFLOW.name)}</strong>
      <span className="break-all text-xs text-canvas-text-secondary">{t('工作流 ID')}：{AUTODL_H3_WORKFLOW.id}</span>
      <p className="text-xs text-canvas-text-secondary">{t('视频输出 · 1–9 张图片 · 最多 3 段音频 · 1–15 秒')}</p>
      <div className="provider-fields-grid">
        <label className="provider-field"><span>{t('默认时长（秒）')}</span><input type="number" min={1} max={15} step={1} value={values.duration ?? 5} onChange={(e) => onChange({ ...values, duration: e.target.valueAsNumber })} /></label>
        <label className="provider-field"><span>{t('默认画质')}</span><select className="ui-select__control" value={values.resolution ?? '768p'} onChange={(e) => onChange({ ...values, resolution: e.target.value })}>{AUTODL_H3_WORKFLOW.capability.resolutions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="provider-field"><span>{t('默认比例')}</span><select className="ui-select__control" value={values.ratio ?? '9:16'} onChange={(e) => onChange({ ...values, ratio: e.target.value })}>{AUTODL_H3_WORKFLOW.capability.ratios.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="provider-field"><span>{t('随机种子（可选）')}</span><input type="number" step={1} value={values.seed ?? ''} placeholder={t('留空随机')} onChange={(e) => { const { seed: _seed, ...rest } = values; onChange(e.target.value === '' ? rest : { ...rest, seed: e.target.valueAsNumber }); }} /></label>
      </div>
      <p className="text-xs text-canvas-text-secondary">{t('本地图片和音频会通过现有上传服务转成临时公网 URL，再交给 AutoDL 读取。')}</p>
    </div>
  </section>;
}
