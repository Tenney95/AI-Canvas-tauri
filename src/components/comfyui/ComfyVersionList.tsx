import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { ComfyRepository, ComfyVersion } from '../../types/comfyManagement';
import { listComfyVersions } from '../../services/comfyManagementService';
import Tabs from '../shared/Tabs';

interface Props {
  repository: ComfyRepository;
  busy: boolean;
  onSwitch: (reference: string, title: string) => void;
}

export default function ComfyVersionList({ repository, busy, onSwitch }: Props) {
  const t = useT();
  const [versions, setVersions] = useState<ComfyVersion[]>([]);
  const [kind, setKind] = useState<ComfyVersion['kind']>('tag');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    void listComfyVersions(repository.id, refresh > 0).then((next) => {
      if (!disposed) { setVersions(next); setError(''); setLoading(false); }
    }, (cause: unknown) => {
      if (!disposed) { setError(String(cause)); setLoading(false); }
    });
    return () => { disposed = true; };
  }, [repository.id, repository.commit, refresh]);
  const rows = useMemo(() => versions.filter((version) => version.kind === kind && `${version.title} ${version.commit}`.toLowerCase().includes(search.trim().toLowerCase())), [versions, kind, search]);
  return <section className="space-y-3" aria-busy={loading}>
    <div className="ui-row ui-row--between">
      <Tabs<ComfyVersion['kind']> size="sm" className="flex-1" aria-label={t('版本类型')} value={kind} onChange={setKind}
        items={([{ value: 'tag', label: '稳定版' }, { value: 'commit', label: '开发版' }, { value: 'branch', label: '分支' }] as const).map((item) => ({ value: item.value, label: t(item.label) }))} />
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || loading} onClick={() => { setLoading(true); setRefresh((value) => value + 1); }}><Icon icon="lucide:refresh-cw" width={14} className={loading ? 'animate-spin' : ''} />{t('刷新远端版本')}</button>
    </div>
    <input className="ui-input ui-input--sm" type="search" aria-label={t('搜索版本')} placeholder={t('搜索版本或提交 ID…')} value={search} onChange={(event) => setSearch(event.target.value)} />
    {repository.dirty && <div className="ui-alert ui-alert--warning">{t('仓库有本地修改，版本切换和更新会被阻止。请先自行保存或处理修改。')}</div>}
    {error ? <div className="ui-alert ui-alert--danger" role="alert">{error}</div> : loading ? <p className="ui-hint" role="status">{t('正在读取版本列表…')}</p> : <div className="ui-scroll ui-scroll--both max-h-[52vh] rounded-lg border border-canvas-border">
      <table className="ui-table"><thead><tr><th>{t('版本 ID')}</th><th>{t('更新内容')}</th><th>{t('日期')}</th><th>{t('操作')}</th></tr></thead><tbody>
        {rows.map((version) => <tr key={`${version.kind}:${version.reference}`}>
          <td className="font-mono whitespace-nowrap">{version.commit.slice(0, 8)}</td>
          <td className="max-w-sm break-words">{version.title}</td><td className="whitespace-nowrap">{version.date}</td>
          <td>{version.current ? <span className="ui-badge ui-badge--success">{t('当前')}</span> : <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || repository.dirty || repository.removed} onClick={() => onSwitch(version.reference, version.title)}>{t('切换')}</button>}</td>
        </tr>)}
        {!rows.length && <tr><td colSpan={4} className="text-canvas-text-muted">{t('暂无匹配版本；可刷新远端版本或切换版本类型。')}</td></tr>}
      </tbody></table>
    </div>}
  </section>;
}
