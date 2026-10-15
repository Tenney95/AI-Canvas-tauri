import { useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import Select from '../shared/Select';
import { useT } from '../../i18n';
import type { ComfyUILaunchSettings } from '../../types/comfyLaunch';
import { DEFAULT_COMFY_LAUNCH_SETTINGS } from '../../types/comfyLaunch';
import { getComfyLaunchSettings, saveComfyLaunchSettings } from '../../services/comfyLaunchSettingsService';

interface Props {
  busy: boolean;
  run: (label: string, operation: () => Promise<string>) => Promise<boolean>;
}

export default function ComfyLaunchSettings({ busy, run }: Props) {
  const t = useT();
  const [settings, setSettings] = useState<ComfyUILaunchSettings | null>(null);
  const [saved, setSaved] = useState<ComfyUILaunchSettings | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    void getComfyLaunchSettings().then((next) => {
      if (!disposed) { setSettings(next); setSaved(next); setError(''); }
    }, (cause: unknown) => {
      if (!disposed) setError(String(cause));
    });
    return () => { disposed = true; };
  }, [reload]);

  if (error) return <div className="ui-alert ui-alert--danger" role="alert">
    <div className="ui-alert__body"><p>{error}</p><div className="ui-row mt-2"><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => setReload((value) => value + 1)}>{t('重试')}</button><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => { setSettings({ ...DEFAULT_COMFY_LAUNCH_SETTINGS }); setSaved(null); setError(''); }}>{t('使用默认设置重新保存')}</button></div></div>
  </div>;
  if (!settings) return <p className="ui-hint" role="status">{t('正在读取启动设置…')}</p>;
  const patch = <K extends keyof ComfyUILaunchSettings>(key: K, value: ComfyUILaunchSettings[K]) =>
    setSettings((current) => current ? { ...current, [key]: value } : current);
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  const fieldClass = 'ui-field min-w-0';

  return <section className="space-y-3">
    <div className="ui-alert ui-alert--info"><Icon icon="lucide:info" width={16} className="ui-alert__icon" /><div className="ui-alert__body">{t('设置在下次通过本应用启动 ComfyUI 时生效。请先在运行控制台停止服务，再重新启动；外部启动的服务需在原启动器中停止。服务只监听本机。')}</div></div>
    <div className="ui-card p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-port">{t('服务端口')}</label>
        <input id="comfy-launch-port" className="ui-input" type="number" min={1024} max={65535} step={1} value={settings.port} disabled={busy} onChange={(event) => patch('port', Number(event.target.value))} />
        <p className="ui-hint">{t('启动时同步本应用默认服务地址，默认端口 8188。')}</p>
      </div>
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-vram">{t('显存模式')}</label>
        <Select id="comfy-launch-vram" value={settings.vramMode} disabled={busy} onChange={(value) => patch('vramMode', value)} options={[
          { value: 'auto', label: t('自动（推荐）') }, { value: 'high', label: t('高显存') },
          { value: 'normal', label: t('标准显存（旧版支持）') }, { value: 'low', label: t('低显存') },
          { value: 'no', label: t('最小显存') }, { value: 'cpu', label: 'CPU' },
        ]} />
        <p className="ui-hint">{t('具体效果由安装版本决定；新版动态显存可能忽略低显存模式。')}</p>
      </div>
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-precision">{t('扩散模型精度')}</label>
        <Select id="comfy-launch-precision" value={settings.precision} disabled={busy} onChange={(value) => patch('precision', value)} options={[
          { value: 'auto', label: t('自动（推荐）') }, { value: 'fp16', label: 'FP16' }, { value: 'bf16', label: 'BF16' }, { value: 'fp32', label: 'FP32' },
        ]} />
      </div>
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-attention">{t('注意力算法')}</label>
        <Select id="comfy-launch-attention" value={settings.attention} disabled={busy} onChange={(value) => patch('attention', value)} options={[
          { value: 'auto', label: t('自动（推荐）') }, { value: 'pytorch', label: 'PyTorch' }, { value: 'split', label: t('Split（节省显存）') }, { value: 'quad', label: 'Quad' },
        ]} />
      </div>
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-preview">{t('生成预览')}</label>
        <Select id="comfy-launch-preview" value={settings.previewMethod} disabled={busy} onChange={(value) => patch('previewMethod', value)} options={[
          { value: 'auto', label: t('沿用安装版本默认值') }, { value: 'none', label: t('关闭预览') },
          { value: 'latent2rgb', label: 'Latent2RGB' }, { value: 'taesd', label: 'TAESD' },
        ]} />
        <p className="ui-hint">{t('TAESD 需要对应的预览模型。')}</p>
      </div>
      <div className={fieldClass}>
        <span className="ui-label" id="comfy-smart-memory-label">{t('禁用智能显存管理')}</span>
        <button type="button" className="ui-switch" role="switch" aria-checked={settings.disableSmartMemory} aria-labelledby="comfy-smart-memory-label" disabled={busy} onClick={() => patch('disableSmartMemory', !settings.disableSmartMemory)} />
        <p className="ui-hint">{t('开启后更积极地卸载模型，后续生成可能需要重新加载。')}</p>
      </div>
    </div>
    <div className="ui-row ui-row--between">
      <p className="ui-hint">{dirty ? t('有未保存的设置') : t('启动设置已保存')}</p>
      <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !dirty || !Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535} onClick={() => void run(t('保存启动设置'), async () => {
        const next = await saveComfyLaunchSettings(settings);
        setSettings(next); setSaved(next);
        return t('启动设置已保存，下次启动生效');
      })}><Icon icon="lucide:save" width={14} />{t('保存设置')}</button>
    </div>
  </section>;
}
