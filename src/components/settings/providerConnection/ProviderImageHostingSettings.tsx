import type { ImageHostingConfig } from '../../../types/imageHosting';
import { IMAGE_HOSTING_TEMPLATES } from '../../../services/imageHostingTemplates';
import { useT } from '../../../i18n';
import Select from '../../shared/Select';

const DEFAULT_CONFIG: ImageHostingConfig = {
  enabled: true, uploadUrl: '', fileField: 'file', responseUrlPath: 'data.url', auth: 'none',
};

export default function ProviderImageHostingSettings({ config, onChange, apiKey, onApiKeyChange }: {
  config?: ImageHostingConfig;
  onChange: (config: ImageHostingConfig) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
}) {
  const t = useT();
  const current = config ?? DEFAULT_CONFIG;
  const patch = (value: Partial<ImageHostingConfig>) => onChange({ ...current, ...value });
  const fields = current.formFields ?? [];
  return <section className="provider-config-section" aria-label={t('自定义图床')}>
    <div className="provider-section-heading">
      <div>
        <h4>{t('自定义图床（可选）')}</h4>
        <p>{t('此连接需要公网图片链接时，将本地参考图上传到指定图床。支持 POST 文件表单和 JSON 返回链接。')}</p>
      </div>
      <button type="button" role="switch" aria-label={t('启用自定义图床')} aria-checked={config?.enabled ?? false}
        className="ui-switch shrink-0" onClick={() => patch({ enabled: !config?.enabled })} />
    </div>
    {config?.enabled && <div className="space-y-3">
      <label className="ui-field">
        <span className="ui-label">{t('套用内置上传格式')}</span>
        <Select fixedMenu value="" onChange={(id) => {
          const template = id === 'custom' ? DEFAULT_CONFIG : IMAGE_HOSTING_TEMPLATES.find((item) => item.id === id)?.config;
          if (template) onChange({ ...structuredClone(template), credentialRef: current.credentialRef });
        }}>
          <option value="" disabled>{t('选择格式，替换当前上传参数')}</option>
          <option value="custom">{t('清空为自定义配置')}</option>
          {IMAGE_HOSTING_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}
        </Select>
        <small className="ui-hint">{t('按内置中转站的实际上传规则填入，使用前仍需确认你的接口支持该格式。')}</small>
      </label>
      <label className="ui-field">
        <span className="ui-label">{t('图床上传地址')}</span>
        <input className="ui-input w-full" value={current.uploadUrl} placeholder="{{baseUrl}}/uploads/images"
          onChange={(event) => patch({ uploadUrl: event.target.value })} />
        <small className="ui-hint">{t('填写完整地址，或用 {{baseUrl}} 代表上方接口地址（保留 /v1 等路径）。密钥通过下方鉴权配置。')}</small>
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="ui-field">
          <span className="ui-label">{t('图片文件字段')}</span>
          <input className="ui-input w-full" value={current.fileField} placeholder="file / image / files[]"
            onChange={(event) => patch({ fileField: event.target.value })} />
        </label>
        <label className="ui-field">
          <span className="ui-label">{t('返回链接路径')}</span>
          <input className="ui-input w-full" value={current.responseUrlPath} placeholder="data.url / files[0].url"
            onChange={(event) => patch({ responseUrlPath: event.target.value })} />
        </label>
        <label className="ui-field">
          <span className="ui-label">{t('图床鉴权方式')}</span>
          <Select fixedMenu value={current.auth} onChange={(value) => patch({ auth: value as ImageHostingConfig['auth'],
            authField: value === 'header' ? 'Authorization' : value === 'form' ? 'key' : undefined })}>
            <option value="none">{t('无需鉴权')}</option>
            <option value="bearer">Bearer Token</option>
            <option value="header">{t('自定义请求头')}</option>
            <option value="form">{t('表单密钥字段')}</option>
          </Select>
        </label>
        {current.auth !== 'none' && <label className="ui-field">
          <span className="ui-label">{t('图床密钥来源')}</span>
          <Select fixedMenu value={current.credentialSource ?? 'separate'} onChange={(value) => patch({ credentialSource: value as 'separate' | 'connection' })}>
            <option value="separate">{t('独立图床密钥')}</option>
            <option value="connection">{t('沿用当前连接 API Key（仅同源）')}</option>
          </Select>
        </label>}
        {(current.auth === 'header' || current.auth === 'form') && <label className="ui-field">
          <span className="ui-label">{current.auth === 'header' ? t('鉴权请求头名称') : t('密钥表单字段')}</span>
          <input className="ui-input w-full" value={current.authField ?? ''} placeholder={current.auth === 'header' ? 'Authorization' : 'key'}
            onChange={(event) => patch({ authField: event.target.value })} />
        </label>}
        {current.auth !== 'none' && current.credentialSource !== 'connection' && <label className="ui-field sm:col-span-2">
          <span className="ui-label">{t('图床密钥')}</span>
          <input type="password" autoComplete="new-password" className="ui-input w-full" value={apiKey}
            placeholder={current.credentialRef ? t('已保存密钥，留空保持不变') : t('填写图床自己的密钥')}
            onChange={(event) => onApiKeyChange(event.target.value)} />
          <small className="ui-hint">{current.auth === 'header'
            ? t('按图床文档填写完整请求头值；例如 Bearer xxx。密钥与连接一起保存。')
            : t('使用独立图床密钥，与连接一起保存；Bearer 方式会自动添加 Bearer 前缀。')}</small>
        </label>}
        {current.auth !== 'none' && current.credentialSource === 'connection' && <p className="ui-hint sm:col-span-2">
          {t('使用上方当前连接的 API Key；上传地址必须与接口地址同源，不会借用其他连接的密钥。')}
        </p>}
      </div>
      <details className="ui-card p-3">
        <summary className="cursor-pointer text-xs text-canvas-text">{t('附加参数与成功判断')}</summary>
        <div className="mt-3 space-y-3">
          <div className="space-y-2">
            <span className="ui-label">{t('附加表单参数')}</span>
            {fields.map((field, index) => <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <input className="ui-input w-full" aria-label={t('表单参数名 {index}', { index: index + 1 })} placeholder="purpose" value={field.name}
                onChange={(event) => patch({ formFields: fields.map((item, position) => position === index ? { ...item, name: event.target.value } : item) })} />
              <input className="ui-input w-full" aria-label={t('表单参数值 {index}', { index: index + 1 })} placeholder="generation" value={field.value}
                onChange={(event) => patch({ formFields: fields.map((item, position) => position === index ? { ...item, value: event.target.value } : item) })} />
              <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label={t('删除表单参数 {index}', { index: index + 1 })}
                onClick={() => patch({ formFields: fields.filter((_, position) => position !== index) })}>{t('删除')}</button>
            </div>)}
            <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={fields.length >= 20}
              onClick={() => patch({ formFields: [...fields, { name: '', value: '' }] })}>{t('添加表单参数')}</button>
            <p className="ui-hint">{t('用于 purpose=generation 等固定参数；密钥请在鉴权配置中填写。')}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="ui-field">
              <span className="ui-label">{t('成功标记路径（可选）')}</span>
              <input className="ui-input w-full" placeholder="success" value={current.successPath ?? ''}
                onChange={(event) => patch({ successPath: event.target.value })} />
            </label>
            <label className="ui-field">
              <span className="ui-label">{t('成功标记期望值')}</span>
              <input className="ui-input w-full" placeholder="true" value={current.successValue ?? 'true'} disabled={!current.successPath?.trim()}
                onChange={(event) => patch({ successValue: event.target.value })} />
            </label>
          </div>
          {(current.maxFileBytes || current.allowedExtensions) && <p className="ui-hint">
            {current.maxFileBytes && t('模板单张上传上限：{size}', { size: current.maxFileBytes % (1024 * 1024) === 0
              ? `${current.maxFileBytes / (1024 * 1024)} MiB` : `${current.maxFileBytes / 1_000_000} MB` })}
            {current.allowedExtensions && ` · ${current.allowedExtensions.join(' / ')}`}
          </p>}
        </div>
      </details>
      <p className="ui-hint">{t('已有公网链接直接使用；Base64 和直接文件上传协议仍按模型设置传图。关闭后恢复默认上传方式。')}</p>
    </div>}
  </section>;
}
