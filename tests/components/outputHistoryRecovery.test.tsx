import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputHistoryEntry } from '../../src/types';
import OutputHistoryPanel, { CompactHistoryRow, HistoryDownloadActions } from '../../src/components/OutputHistoryPanel';
import * as pollManager from '../../src/services/pollManager';
import { useAppStore } from '../../src/store/useAppStore';
import { setLocale } from '../../src/i18n';

const hooks = vi.hoisted(() => ({ snapshots: [] as Array<{ subscribe: unknown; getSnapshot: () => unknown }> }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, useSyncExternalStore: <T,>(subscribe: (notify: () => void) => () => void,
    getSnapshot: () => T, getServerSnapshot?: () => T) => {
    const media = subscribe === pollManager.subscribeMediaTasks;
    if (media) hooks.snapshots.push({ subscribe, getSnapshot });
    return actual.useSyncExternalStore(subscribe, getSnapshot, media ? getSnapshot : getServerSnapshot);
  } };
});

const entry: OutputHistoryEntry = { id: 'history-1', projectId: 'p', nodeId: 'n', nodeLabel: '图片', timestamp: 1,
  prompt: '原提示词', output: '', nodeType: 'ai-image', provider: 'runninghubwf', model: 'wf', status: 'download_pending',
  recoveryTask: { projectId: 'p', nodeId: 'n', taskId: 'task-1', attemptId: 'attempt-1' } };
const noop = () => undefined;
beforeEach(() => setLocale('zh-CN'));

describe('输出历史的下载按钮', () => {
  it('keeps a stable empty recovery snapshot while hidden and reads the latest snapshot after opening', () => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ currentProjectId: 'p', historyPanelOpen: false });
    const initial: ReturnType<typeof pollManager.getMediaTaskSnapshot> = Object.freeze([{ projectId: 'p', nodeId: 'n',
      taskId: 'first-task', submitted: true, historyDownloadPending: true }]);
    const latest = Object.freeze([{ ...initial[0], taskId: 'latest-task' }]);
    const read = vi.spyOn(pollManager, 'getMediaTaskSnapshot').mockReturnValue(initial);
    const render = () => {
      hooks.snapshots = [];
      renderToStaticMarkup(<OutputHistoryPanel />);
      return hooks.snapshots.find((hook) => hook.subscribe === pollManager.subscribeMediaTasks)!.getSnapshot;
    };
    const hidden = render();
    const empty = hidden();
    expect(empty).toEqual([]);
    expect(hidden()).toBe(empty);
    expect(read).not.toHaveBeenCalled();
    read.mockReturnValue(latest);
    expect(hidden()).toBe(empty);
    expect(read).not.toHaveBeenCalled();
    useAppStore.setState({ historyPanelOpen: true });
    const visible = render();
    expect(visible()).toBe(latest);
    useAppStore.setState({ historyPanelOpen: false });
    read.mockClear();
    expect(render()()).toBe(empty);
    expect(read).not.toHaveBeenCalled();
  });

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
