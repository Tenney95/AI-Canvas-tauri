import { useId, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import type { GlobalImageHostingConfig, ImageHostingConfig, PublicImageHostingProvider } from '../../types/imageHosting';
import { normalizeGlobalImageHostingConfig, PUBLIC_IMAGE_HOSTING_TEMPLATES } from '../../services/imageHostingTemplates';
import { deleteImageHostingCredential, persistImageHosting } from '../../services/imageHostingService';
import { configValuesEqual as sameSettings } from '../../services/configPatch';
import { openExternal } from './providerConnection/providerConnectionShared';
import Select from '../shared/Select';

function copySettings(config?: GlobalImageHostingConfig): GlobalImageHostingConfig {
  return { provider: config?.provider ?? 'uguu', configs: structuredClone(config?.configs ?? {}) };
}

function credentialInUse(ref: string): boolean {
  const { config } = useAppStore.getState();
  return Object.values(config.imageHosting?.configs ?? {}).some((item) => item?.credentialRef === ref)
    || Object.values(config.providers).some((item) => item.imageHosting?.credentialRef === ref);
}

export default function GlobalImageHostingSettings() {
  const t = useT();
  const id = useId();
  const saved = useAppStore((state) => state.config.imageHosting);
  const hydrated = useAppStore((state) => state.configHydrated);
  const [editing, setEditing] = useState(false);
  const [baseline, setBaseline] = useState<GlobalImageHostingConfig>();
  const [draft, setDraft] = useState<GlobalImageHostingConfig>(() => copySettings());
  const [keys, setKeys] = useState<Partial<Record<PublicImageHostingProvider, string>>>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const template = PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === draft.provider);
  const selectedLabel = PUBLIC_IMAGE_HOSTING_TEMPLATES.find((item) => item.id === (saved?.provider ?? 'uguu'))?.label;
  const current = template ? normalizeGlobalImageHostingConfig(draft.provider, { ...template.config, ...draft.configs[draft.provider] }) : undefined;
  const optionalKey = draft.provider === 'catbox';
  const needsKey = optionalKey || draft.provider === 'imagekit' || draft.provider === 'bohe';
  const keyLabel = draft.provider === 'catbox' ? t('User hash（可选）')
    : draft.provider === 'bohe' ? t('API Token')
    : draft.provider === 'imagekit' ? t('Private API Key') : t('图床 API Key');
  const cloudName = current?.uploadUrl.match(/^https:\/\/api\.cloudinary\.com\/v1_1\/([^/]+)\/(?:auto|image)\/upload$/)?.[1] ?? '';
  const uploadPreset = current?.formFields?.find((field) => field.name === 'upload_preset')?.value ?? '';

  const begin = () => {
    setBaseline(saved);
    setDraft(copySettings(saved));
    setKeys({});
    setError('');
    setEditing(true);
  };
  const patch = (value: Partial<ImageHostingConfig>) => {
    if (!current) return;
    setDraft((previous) => ({ ...previous, configs: { ...previous.configs, [previous.provider]: { ...current, ...value } } }));
    setError('');
  };
  const cleanUnusedCredential = async (ref?: string) => {
    if (!ref || credentialInUse(ref)) return;
    try { await deleteImageHostingCredential(ref); }
    catch { useAppStore.getState().showToast(t('旧图床凭据未能清理，请稍后重试'), 'error'); }
  };
  const save = async () => {
    if (busyRef.current || !current || !hydrated) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    let next: GlobalImageHostingConfig | undefined;
    let newRef: string | undefined;
    const previousRef = baseline?.configs?.[draft.provider]?.credentialRef;
    try {
      if (!sameSettings(useAppStore.getState().config.imageHosting, baseline)) throw new Error(t('图床配置已变化，请取消后重新打开配置'));
      const config: ImageHostingConfig = { ...current, enabled: true, credentialSource: 'separate' };
      const key = keys[draft.provider]?.trim() ?? '';
      if (optionalKey) {
        config.auth = key || config.credentialRef ? 'form' : 'none';
        config.authField = 'userhash';
      }
      if (config.auth === 'none') delete config.credentialRef;
      if (draft.provider === 'bohe') {
        let endpoint: URL;
        try { endpoint = new URL(config.uploadUrl.trim()); }
        catch { throw new Error(t('请从会员后台复制完整的 HTTPS 上传 API 地址')); }
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          throw new Error(t('上传 API 地址须为不含账号、查询参数或片段的完整 HTTPS 地址'));
        }
        config.uploadUrl = endpoint.href;
      }
      if (draft.provider === 'cloudinary') {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cloudName) || cloudName.includes('{{')) throw new Error(t('请填写有效的 Cloud name'));
        if (!uploadPreset.trim()) throw new Error(t('请填写允许 unsigned 上传的 Upload preset'));
        config.formFields = [{ name: 'upload_preset', value: uploadPreset.trim() }];
      }
      const persisted = await persistImageHosting(config, key);
      if (!persisted) throw new Error(t('图床配置保存失败'));
      if (persisted.credentialRef !== current.credentialRef) newRef = persisted.credentialRef;
      if (!sameSettings(useAppStore.getState().config.imageHosting, baseline)) throw new Error(t('图床配置已变化，请取消后重新打开配置'));
      next = { provider: draft.provider, configs: { ...baseline?.configs, [draft.provider]: persisted } };
      useAppStore.getState().updateConfig({ imageHosting: next });
      if (!sameSettings(useAppStore.getState().config.imageHosting, next)) throw new Error(t('当前无法修改设置，请稍后重试'));
      await useAppStore.getState().saveConfig({ silent: true, throwOnError: true });
      setEditing(false);
      setKeys({});
      await cleanUnusedCredential(previousRef);
      useAppStore.getState().showToast(t('图床设置已保存'), 'success');
    } catch (cause) {
      const state = useAppStore.getState();
      const committed = state.configPersistedBaseline;
      const committedSettings = committed && typeof committed === 'object' && 'imageHosting' in committed ? committed.imageHosting : undefined;
      if (next && sameSettings(committedSettings, next)) {
        // 已提交后的目录同步失败仍保留配置和新凭据，交给设置页的重试入口处理。
        setBaseline(state.config.imageHosting);
        setDraft(copySettings(state.config.imageHosting));
        setKeys({});
        setError(t('图床配置已保存，但设置同步未完成，请按设置顶部提示重试'));
        await cleanUnusedCredential(previousRef);
      } else {
        if (next && sameSettings(state.config.imageHosting, next)) state.updateConfig({ imageHosting: baseline });
        await cleanUnusedCredential(newRef);
        setError(cause instanceof Error ? cause.message : t('图床配置保存失败'));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return <section className="ui-card mb-2" aria-label={t('图床设置')}>
    <div className="ui-card__header">
      <div className="min-w-0 flex-1">
        <h3 className="ui-card__title">{t('图床')} · {selectedLabel ?? t('待重新选择')}</h3>
        <p className="ui-card__desc">{t('本地图片、视频和音频需要公网链接，且当前连接没有对应上传方式时，使用这里的服务。')}</p>
        {(saved?.provider ?? 'uguu') === 'uguu' && <p className="ui-card__desc">{t('Uguu 临时链接约 3 小时后过期。')}</p>}
        {!selectedLabel && <p role="alert" className="ui-error">{t('已保存的服务不在音视频兼容列表中，请重新选择；原配置和密钥仍保留。')}</p>}
      </div>
      {!editing && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm shrink-0" disabled={!hydrated}
        aria-expanded={false} aria-controls={`${id}-editor`} onClick={begin}>{t('配置')}</button>}
    </div>
    {editing && <div id={`${id}-editor`} className="ui-card__body space-y-3">
      <label className="ui-field">
        <span className="ui-label">{t('图片、视频与音频托管服务')}</span>
        <Select<PublicImageHostingProvider> fixedMenu value={draft.provider} disabled={busy} onChange={(provider) => {
          setDraft((previous) => ({ ...previous, provider })); setError('');
        }}>
          {!template && <option value={draft.provider} disabled>{t('请选择兼容图片、视频和音频的服务')}</option>}
          {PUBLIC_IMAGE_HOSTING_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </Select>
        {template ? <small className="ui-hint">{t(template.description)}</small>
          : <small className="ui-error">{t('已保存的图床类型不可用，请重新选择')}</small>}
      </label>
      {needsKey && current && <label className="ui-field">
        <span className="ui-label">{keyLabel}</span>
        <input type="password" autoComplete="new-password" className="ui-input w-full" disabled={busy}
          value={keys[draft.provider] ?? ''} placeholder={current.credentialRef ? t('已保存密钥，留空保持不变')
            : optionalKey ? t('留空使用游客上传') : t('填写此图床的密钥')}
          onChange={(event) => setKeys((previous) => ({ ...previous, [draft.provider]: event.target.value }))} />
        <small className="ui-hint">{t('密钥保存在本机凭据存储中，留空保留已保存密钥。')}</small>
        {optionalKey && current.credentialRef && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm w-fit" disabled={busy}
          onClick={() => { patch({ credentialRef: undefined, auth: 'none' }); setKeys((previous) => ({ ...previous, [draft.provider]: '' })); }}>
          {t('移除密钥，改用游客上传')}
        </button>}
      </label>}
      {draft.provider === 'bohe' && current && <label className="ui-field">
        <span className="ui-label">{t('薄荷图床上传 API 地址')}</span>
        <input type="url" className="ui-input w-full" aria-label={t('薄荷图床上传 API 地址')} value={current.uploadUrl} disabled={busy}
          placeholder="https://your-api-domain/api/upload/" onChange={(event) => patch({ uploadUrl: event.target.value })} />
        <small className="ui-hint">{t('从会员后台复制完整上传 API 地址，应用不会猜测接口域名。')}</small>
        <small className="ui-hint">{t('API 需要高级会员，并在后台开启；免费网页上传不代表免费 API。')}</small>
      </label>}
      {draft.provider === 'cloudinary' && current && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="ui-field">
          <span className="ui-label">{t('Cloud name')}</span>
          <input className="ui-input w-full" value={cloudName.includes('{{') ? '' : cloudName} disabled={busy} placeholder="my-cloud"
            onChange={(event) => patch({ uploadUrl: `https://api.cloudinary.com/v1_1/${event.target.value}/auto/upload` })} />
        </label>
        <label className="ui-field">
          <span className="ui-label">{t('Upload preset')}</span>
          <input className="ui-input w-full" value={uploadPreset} disabled={busy} placeholder="unsigned-preset"
            onChange={(event) => patch({ formFields: [{ name: 'upload_preset', value: event.target.value }] })} />
          <small className="ui-hint">{t('请先创建 unsigned 上传预设，并允许图片、视频和音频格式。')}</small>
        </label>
      </div>}
      <p className="ui-hint">{t('只列出兼容图片、视频和音频的服务。厂商对应类型的专用上传优先；连接自定义图片上传仍只处理图片。上传失败会停止，不会改传其他服务。')}</p>
      <p className="ui-hint">{t('本应用公共上传上限：图片 32 MiB、视频 64 MiB、音频 32 MiB；同时遵循服务和账号的文件限制。')}</p>
      {template && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => void openExternal(template.docsUrl)}>{t('查看服务文档')}</button>}
      {error && <p role="alert" className="ui-error">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => { setEditing(false); setKeys({}); setError(''); }}>{t('取消')}</button>
        <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !hydrated || !template} onClick={() => void save()}>
          {busy ? t('正在保存…') : t('保存图床设置')}
        </button>
      </div>
    </div>}
  </section>;
}
