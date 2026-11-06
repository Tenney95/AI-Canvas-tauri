/**
 * projectArchiveSerialization — 回归测试：project archive background serialization。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyStoryGraph } from '../../src/services/storyGraphService';
import type {
  ProjectArchiveJsonEntry,
  ProjectArchiveSerializationResponse,
} from '../../src/services/projectArchiveSerialization';

class SerializationWorker {
  static instances: SerializationWorker[] = [];
  static failPost = false;
  readonly url: URL;
  readonly options: WorkerOptions;
  onmessage: ((event: MessageEvent<ProjectArchiveSerializationResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((_entries: ProjectArchiveJsonEntry[]) => {
    if (SerializationWorker.failPost) throw new DOMException('fixture clone failure', 'DataCloneError');
  });

  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    SerializationWorker.instances.push(this);
  }

  emit(response: ProjectArchiveSerializationResponse) {
    this.onmessage?.({ data: response } as MessageEvent<ProjectArchiveSerializationResponse>);
  }
}

beforeEach(() => {
  vi.resetModules();
  SerializationWorker.instances = [];
  SerializationWorker.failPost = false;
  vi.stubGlobal('Worker', SerializationWorker);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('project archive background serialization', () => {
  it('拒绝夹带候选或运行态的故事图，合法正式图仍交给固定 Worker', async () => {
    const { serializeProjectArchiveEntries } = await import('../../src/services/projectArchiveSerialization');
    const graph = createEmptyStoryGraph('graph');
    await expect(serializeProjectArchiveEntries([{ path: 'project.json', value: {
      id: 'series', series: { storyGraph: { ...graph, candidate: {} } },
    } }])).rejects.toThrow();
    expect(SerializationWorker.instances).toHaveLength(0);
    const entries = [{ path: 'project.json', value: { id: 'series', series: { storyGraph: graph } } }];
    const pending = serializeProjectArchiveEntries(entries);
    const worker = SerializationWorker.instances[0];
    expect(worker.postMessage.mock.calls[0][0][0].value).toEqual(entries[0].value);
    worker.emit({ ok: true, entries: [{ path: 'project.json', content: JSON.stringify(entries[0].value) }] });
    await expect(pending).resolves.toHaveLength(1);
  });
  it('sends structured entries to the fixed module worker and releases it after a result', async () => {
    const { serializeProjectArchiveEntries } = await import('../../src/services/projectArchiveSerialization');
    const entries = [{ path: 'project.json', value: { id: 'project', nodes: [{ text: '中文\n正文' }] } }];
    const pending = serializeProjectArchiveEntries(entries);
    const worker = SerializationWorker.instances[0];
    expect(worker.url.pathname).toMatch(/projectArchiveSerializationWorker\.ts$/);
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith(entries);
    const result = [{ path: 'project.json', content: JSON.stringify(entries[0].value) }];
    worker.emit({ ok: true, entries: result });

    await expect(pending).resolves.toEqual(result);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
  });

  it('terminates a timed-out worker and permits a later retry without accumulating workers', async () => {
    vi.useFakeTimers();
    const { serializeProjectArchiveEntries } = await import('../../src/services/projectArchiveSerialization');
    const entries = [{ path: 'project.json', value: { id: 'project' } }];
    const pending = serializeProjectArchiveEntries(entries);
    const rejected = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(SerializationWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    const retry = serializeProjectArchiveEntries(entries);
    SerializationWorker.instances[1].emit({ ok: true, entries: [{ path: 'project.json', content: '{"id":"project"}' }] });
    await expect(retry).resolves.toHaveLength(1);
    expect(SerializationWorker.instances[1].terminate).toHaveBeenCalledOnce();
  });

  it('rejects concurrent serialization instead of starting unbounded workers', async () => {
    const { serializeProjectArchiveEntries } = await import('../../src/services/projectArchiveSerialization');
    const entries = [{ path: 'chat.json', value: [] }];
    const pending = serializeProjectArchiveEntries(entries);

    await expect(serializeProjectArchiveEntries(entries)).rejects.toThrow('正在整理');
    expect(SerializationWorker.instances).toHaveLength(1);
    SerializationWorker.instances[0].emit({ ok: true, entries: [{ path: 'chat.json', content: '[]' }] });
    await pending;
  });

  it('releases workers after clone failures and rejects unavailable background execution', async () => {
    const { serializeProjectArchiveEntries } = await import('../../src/services/projectArchiveSerialization');
    SerializationWorker.failPost = true;
    await expect(serializeProjectArchiveEntries([{ path: 'project.json', value: {} }])).rejects.toThrow('无法交给后台');
    expect(SerializationWorker.instances[0].terminate).toHaveBeenCalledOnce();
    vi.stubGlobal('Worker', undefined);
    await expect(serializeProjectArchiveEntries([{ path: 'project.json', value: {} }])).rejects.toThrow('无法启动');
  });

  it('preserves JSON bytes, property order and array semantics in the worker', async () => {
    const postMessage = vi.fn();
    const scope = { onmessage: null as ((event: MessageEvent<ProjectArchiveJsonEntry[]>) => void) | null, postMessage };
    vi.stubGlobal('self', scope);
    await import('../../src/services/projectArchiveSerializationWorker');
    const entries = [{ path: 'project.json', value: { name: '中文 😀', optional: undefined,
      numbers: [1, undefined, null], createdAt: new Date('2026-10-20T00:00:00Z'), text: '换行\n\t"内容"' } },
    { path: 'chat.json', value: { messages: [] } }];

    scope.onmessage!({ data: entries } as MessageEvent<ProjectArchiveJsonEntry[]>);

    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ ok: true,
      entries: entries.map(({ path, value }) => ({ path, content: JSON.stringify(value) })),
    });
  });

  it('returns only a failure flag when JSON cannot represent an entry', async () => {
    const postMessage = vi.fn();
    const scope = { onmessage: null as ((event: MessageEvent<ProjectArchiveJsonEntry[]>) => void) | null, postMessage };
    vi.stubGlobal('self', scope);
    await import('../../src/services/projectArchiveSerializationWorker');

    scope.onmessage!({
      data: [{ path: 'project.json', value: { privateText: 'private fixture', big: 1n } }],
    } as MessageEvent<ProjectArchiveJsonEntry[]>);

    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ ok: false });
  });
});
