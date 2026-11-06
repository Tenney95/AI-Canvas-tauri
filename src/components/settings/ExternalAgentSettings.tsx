import { useEffect, useId, useState } from 'react';
import { useT } from '../../i18n';
import { CODEX_EXTERNAL_SECRET_KEY, type ExternalAgentStatus } from '../../types/externalAgent';
import { deleteAppSecret, writeAppSecret } from '../../services/providerSecretService';
import { configureCodexRuntime, getExternalAgentStatus, registerCodexRuntime, removeCodexRuntime } from '../../services/chat/externalAgents/externalAgentRegistry';

function explanation(code?: string): string {
  switch (code) {
    case 'CODEX_DESKTOP_REQUIRED': return '外部执行器仅在桌面端可用';
    case 'CODEX_NOT_REGISTERED': return '请先登记你信任的 Codex 程序';
    case 'CODEX_KEY_NOT_CONFIGURED': return '请保存用于本次外部执行器的 OpenAI API 凭据';
    case 'CODEX_DISABLED': return '执行器已停用';
    case 'CODEX_IDENTITY_CHANGED': return '程序或凭据身份已变化，请重新登记并确认团队配置';
    case 'CODEX_VERSION_UNSUPPORTED': return '只支持 Codex 0.167.0，请选择对应版本';
    case 'CODEX_REGISTRATION_CANCELLED': return '已取消登记';
    case 'CODEX_EXECUTABLE_REJECTED': return '请选择原生 Codex 可执行文件，不能使用命令脚本或链接';
    default: return '外部执行器操作失败，请检查登记、版本与凭据状态';
  }
}

export default function ExternalAgentSettings() {
  const t = useT();
  const keyId = useId();
  const [status, setStatus] = useState<ExternalAgentStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void getExternalAgentStatus().then((value) => { if (active) setStatus(value); })
      .catch(() => { if (active) setError(t('读取外部执行器状态失败')); });
    return () => { active = false; };
  }, [t]);

  const perform = async (action: () => Promise<ExternalAgentStatus>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { setStatus(await action()); }
    catch (reason) { setError(t(explanation(typeof reason === 'string' ? reason : undefined))); }
    finally { setBusy(false); }
  };
  const saveKey = () => perform(async () => {
    const value = key.trim();
    if (status?.enabled) await configureCodexRuntime(false);
    if (!value || !(await writeAppSecret(CODEX_EXTERNAL_SECRET_KEY, value))) throw new Error('secret-write');
    setKey('');
    return getExternalAgentStatus();
  });
  const clearKey = () => perform(async () => {
    if (status?.enabled) await configureCodexRuntime(false);
    if (!(await deleteAppSecret(CODEX_EXTERNAL_SECRET_KEY))) throw new Error('secret-delete');
    setKey('');
    return getExternalAgentStatus();
  });

  return <section className="space-y-3" aria-label={t('外部执行器')}>
    <div className="ui-card p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-canvas-text">Codex App Server</h3>
        <span className="ui-badge">{status?.available ? t('可用') : t('未就绪')}</span>
      </div>
      <p className="text-xs text-canvas-text-secondary">{t('让外部 Codex 作为团队成员返回候选成果。仅支持 0.167.0，不接管现有 Codex 会话。')}</p>
      <div className="ui-alert ui-alert--warning text-xs" role="note">{t('登记的本机程序拥有当前用户进程权限，摘要登记不构成系统沙箱。任务材料会发送到 OpenAI API 并可能计费；不复用 ChatGPT 订阅额度。')}</div>
      <dl className="grid grid-cols-2 gap-2 text-xs text-canvas-text-secondary">
        <dt>{t('程序登记')}</dt><dd>{status?.registered ? t('已登记') : t('未登记')}</dd>
        <dt>{t('协议版本')}</dt><dd>{status?.version ?? '—'}</dd>
        <dt>{t('API 凭据')}</dt><dd>{status?.configured ? t('已配置') : t('未配置')}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-btn ui-btn--sm" disabled={busy || !status || status.errorCode === 'CODEX_DESKTOP_REQUIRED'} onClick={() => void perform(registerCodexRuntime)}>{t('选择并登记 Codex')}</button>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy || !status?.registered} onClick={() => void perform(removeCodexRuntime)}>{t('移除登记')}</button>
        <button type="button" className="ui-btn ui-btn--sm" aria-pressed={status?.enabled ?? false} disabled={busy || !status?.registered || (!status.enabled && (!status.compatible || !status.configured))}
          onClick={() => void perform(() => configureCodexRuntime(!status?.enabled))}>{status?.enabled ? t('停用执行器') : t('启用执行器')}</button>
      </div>
      <div className="ui-field">
        <label className="ui-label" htmlFor={keyId}>{t('OpenAI API Key')}</label>
        <input id={keyId} className="ui-input" type="password" autoComplete="new-password" maxLength={8192} value={key} disabled={busy || status?.errorCode === 'CODEX_DESKTOP_REQUIRED'} onChange={(event) => setKey(event.target.value)} />
        <p className="text-xs text-canvas-text-muted">{t('凭据仅保存到本机原生凭据存储，保存后输入框清空。')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={busy || !key.trim()} onClick={() => void saveKey()}>{t('保存凭据')}</button>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy || !status?.configured} onClick={() => void clearKey()}>{t('清除凭据')}</button>
      </div>
      {status?.errorCode && <p className="text-xs text-canvas-text-muted">{t(explanation(status.errorCode))}</p>}
      {error && <p role="alert" className="ui-alert ui-alert--danger text-xs">{error}</p>}
    </div>
  </section>;
}
