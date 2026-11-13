import { useT } from '../../i18n';
import type { VolcengineTosConfig, VolcengineTosCredentials } from '../../types/volcengineTos';

export default function VolcengineTosSettings({ config, onChange, credentials, onCredentialsChange, disabled = false }: {
  config?: VolcengineTosConfig;
  onChange: (config: VolcengineTosConfig | undefined) => void;
  credentials: VolcengineTosCredentials;
  onCredentialsChange: (credentials: VolcengineTosCredentials) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return <section className="provider-config-section" aria-label={t('火山方舟 TOS 上传配置')}>
    <div className="provider-section-heading">
      <div>
        <h4>{t('私有 TOS 参考素材上传')}</h4>
        <p>{t('本地图片、视频和音频上传到自己的北京区私有 Bucket，不使用公共图床。')}</p>
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
      <label className="ui-field">
        <span className="ui-label">{t('TOS Access Key（AK）')}</span>
        <input type="password" autoComplete="new-password" className="ui-input w-full" disabled={disabled} value={credentials.accessKeyId}
          placeholder={config?.credentialRef ? t('已保存，留空保留') : t('填写 TOS Access Key')}
          onChange={(event) => onCredentialsChange({ ...credentials, accessKeyId: event.target.value })} />
      </label>
      <label className="ui-field">
        <span className="ui-label">{t('TOS Secret Key（SK）')}</span>
        <input type="password" autoComplete="new-password" className="ui-input w-full" disabled={disabled} value={credentials.secretAccessKey}
          placeholder={config?.credentialRef ? t('已保存，留空保留') : t('填写 TOS Secret Key')}
          onChange={(event) => onCredentialsChange({ ...credentials, secretAccessKey: event.target.value })} />
      </label>
    </div>
    <p className="ui-hint">{t('AK/SK 随连接一起保存到本机凭据存储；更新时须同时填写两项。方舟 API Key 不能代替，也不会借用下方虚拟人像库凭据。')}</p>
    <p className="ui-hint">{t('通过公网 PUT 上传；北京内网签名链接仅交给方舟读取。TOS 存储和请求按云服务计费。')}</p>
    <p className="ui-hint">{t('未配置时仍可使用已有公网素材链接；生成时遇到本地素材会提示配置 TOS。此设置不自动创建私域素材资产。')}</p>
    {(config || credentials.accessKeyId || credentials.secretAccessKey) && <button type="button" disabled={disabled}
      className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { onChange(undefined); onCredentialsChange({ accessKeyId: '', secretAccessKey: '' }); }}>
      {t('清除 TOS 配置')}
    </button>}
  </section>;
}
