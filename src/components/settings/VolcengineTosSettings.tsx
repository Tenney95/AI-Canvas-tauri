import { useT } from '../../i18n';
import { Icon } from '@iconify/react';
import { useId, useState } from 'react';
import type { VolcengineTosConfig, VolcengineTosCredentials } from '../../types/volcengineTos';
import { openExternal } from './providerConnection/providerConnectionShared';

const SAVED_CREDENTIAL_MASK = '••••••••••••••••';

export default function VolcengineTosSettings({ config, onChange, credentials, onCredentialsChange, disabled = false }: {
  config?: VolcengineTosConfig;
  onChange: (config: VolcengineTosConfig | undefined) => void;
  credentials: VolcengineTosCredentials;
  onCredentialsChange: (credentials: VolcengineTosCredentials) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const fieldId = useId();
  const [editing, setEditing] = useState({ accessKeyId: false, secretAccessKey: false });
  return <section className="provider-config-section mb-3" aria-label={t('火山方舟 TOS 上传配置')}>
    <div className="provider-section-heading">
      <div>
        <h4>{t('私有 TOS 参考素材上传')}</h4>
        <p>{t('图片、视频和音频统一上传到自己的北京区私有 Bucket，外部素材链接也通过 TOS 转存。')}</p>
      </div>
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="ui-field">
        <span className="ui-label">{t('TOS Bucket 名称')}</span>
        <input className="ui-input w-full" value={config?.bucket ?? ''} disabled={disabled} placeholder="my-private-bucket"
          onChange={(event) => onChange({ bucket: event.target.value, region: 'cn-beijing', credentialRef: config?.credentialRef ?? '' })} />
        <small className="ui-hint">{t('填写已创建的私有 Bucket，区域须为北京。')}</small>
      </label>
      <label className="ui-field">
        <span className="ui-label">{t('区域')}</span>
        <input className="ui-input w-full" value={t('北京（cn-beijing）')} readOnly disabled={disabled} />
      </label>
      {([
        ['accessKeyId', 'TOS Access Key（AK）', '填写 TOS Access Key'],
        ['secretAccessKey', 'TOS Secret Key（SK）', '填写 TOS Secret Key'],
      ] as const).map(([field, label, placeholder]) => <div key={field} className="ui-field">
        <label className="ui-label" htmlFor={`${fieldId}-${field}`}>{t(label)}</label>
        <input id={`${fieldId}-${field}`} type="password" autoComplete="new-password"
          className="ui-input w-full" disabled={disabled}
          value={config?.credentialRef && !editing[field] && !credentials[field] ? SAVED_CREDENTIAL_MASK : credentials[field]}
          placeholder={t(placeholder)}
          onFocus={() => setEditing((current) => ({ ...current, [field]: true }))}
          onBlur={() => setEditing((current) => ({ ...current, [field]: false }))}
          onChange={(event) => onCredentialsChange({ ...credentials, [field]: event.target.value })} />
      </div>)}
    </div>
    <div className="ui-stack ui-stack--tight mt-3">
      <p className="ui-hint">{t('AK/SK 保存后仅显示掩码，不支持再次查看；更新时须重新填写两项。方舟 API Key 不能代替，也不会借用下方虚拟人像库凭据。')}</p>
      <p className="ui-hint">{t('生成参考素材与人像库上传共用这套 TOS 配置。TOS 存储和请求按云服务计费。')}</p>
      <p className="ui-hint">{t('使用参考素材前请先配置 TOS；人像库仍需单独启用并配置入库 AK/SK，提交后等待素材变为可用。')}</p>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" className="provider-external-link" disabled={disabled}
        onClick={() => void openExternal('https://console.volcengine.com/iam/keymanage/')}>
        <Icon icon="mdi:open-in-new" width="13" />{t('前往获取 AK/SK')}
      </button>
      {(config || credentials.accessKeyId || credentials.secretAccessKey) && <button type="button" disabled={disabled}
        className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { onChange(undefined); onCredentialsChange({ accessKeyId: '', secretAccessKey: '' }); }}>
        {t('清除 TOS 配置')}
      </button>}
    </div>
  </section>;
}
