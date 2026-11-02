import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputHistoryEntry } from '../../src/types';
import { CompactHistoryRow, HistoryDownloadActions } from '../../src/components/OutputHistoryPanel';
import { setLocale } from '../../src/i18n';

const entry: OutputHistoryEntry = { id: 'history-1', projectId: 'p', nodeId: 'n', nodeLabel: '图片', timestamp: 1,
  prompt: '原提示词', output: '', nodeType: 'ai-image', provider: 'runninghubwf', model: 'wf', status: 'download_pending',
  recoveryTask: { projectId: 'p', nodeId: 'n', taskId: 'task-1', attemptId: 'attempt-1' } };
const noop = () => undefined;
beforeEach(() => setLocale('zh-CN'));

describe('输出历史的下载按钮', () => {
  it('提供重新下载与放弃，下载时同时禁用，来源不确定时禁用重试', () => {
    const render = (busy: boolean, available = true) => renderToStaticMarkup(<HistoryDownloadActions entry={entry}
      busy={busy} exists available={available} onRetry={noop} onAbandon={noop} />);
    const ready = render(false);
    expect(ready).toContain('重新下载'); expect(ready).toContain('放弃'); expect(ready).not.toContain('disabled');
    const busy = render(true);
    expect(busy).toContain('下载中…'); expect(busy.match(/disabled=""/g)).toHaveLength(2);
    expect(render(false, false).match(/disabled=""/g)).toHaveLength(1);
  });
  it('固定历史小窗也展示待下载和按钮，旧下载失败不显示为生成失败', () => {
    const render = (record: OutputHistoryEntry) => renderToStaticMarkup(<CompactHistoryRow entry={record} exists
      onLocate={noop} onDelete={noop} videoExpanded={false} onVideoExpandedChange={noop}
      recoveryBusy={false} recoveryAvailable={!!record.recoveryTask} onRetry={vi.fn()} onAbandon={vi.fn()} />);
    const pending = render(entry);
    expect(pending).toContain('待下载'); expect(pending).toContain('重新下载'); expect(pending).not.toContain('>失败<');
    const legacy = render({ ...entry, status: 'error', recoveryTask: undefined, error: '生成媒体未能写入项目目录：下载媒体失败' });
    expect(legacy).toContain('无法确认原下载任务'); expect(legacy).not.toContain('>失败<');
    expect(render({ ...entry, status: 'error', recoveryTask: undefined, error: '模型明确拒绝请求' })).toContain('>失败<');
    const abandoned = render({ ...entry, status: 'abandoned', recoveryTask: undefined });
    expect(abandoned).toContain('已放弃下载'); expect(abandoned).not.toContain('重新下载');
  });
});
