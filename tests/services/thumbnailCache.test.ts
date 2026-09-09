import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriEnv: vi.fn(),
  getProjectDataDir: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: mocks.isTauriEnv,
  getProjectDataDir: mocks.getProjectDataDir,
}));

// Keep the real URL decoder: its platform-specific path handling is part of the IPC contract.
import { prepareProjectThumbnail } from '../../src/services/fs/thumbnailCache';

const SOURCE = 'http://asset.localhost/G%3A%5Cmedia%5Csource.png?_refresh=7';
const PROJECT_DIR = 'G:/data/项目名称-12345678';
const SOURCE_VERSION = 'a'.repeat(64);
const MAX_BYTES = 4 * 1024 * 1024;
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

interface NativeThumbnail {
  sourceVersion: string;
  cachedBytes: number[] | null;
  width: number | null;
  height: number | null;
}

function nativeResult(overrides: Partial<NativeThumbnail> = {}): NativeThumbnail {
  return { sourceVersion: SOURCE_VERSION, cachedBytes: null, width: null, height: null, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function writeCalls() {
  return mocks.invoke.mock.calls.filter(([command]) => command === 'write_project_thumbnail');
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isTauriEnv.mockReturnValue(true);
  mocks.getProjectDataDir.mockResolvedValue(PROJECT_DIR);
  mocks.invoke.mockResolvedValue(nativeResult());
});

describe('prepareProjectThumbnail platform and project routing', () => {
  it.each([
    ['Windows asset host', SOURCE, 'G:\\media\\source.png'],
    ['Windows HTTPS asset host', 'https://asset.localhost/G%3A%5Cmedia%5C%E4%B8%AD%E6%96%87%20%231.png', 'G:\\media\\中文 #1.png'],
    ['Windows file URL', 'file:///G:/media/source.png?revision=5', 'G:/media/source.png'],
    ['macOS asset scheme', 'asset://localhost/%2FUsers%2Fartist%2F%E9%A1%B9%E7%9B%AE%2Fsource.png?_refresh=8', '/Users/artist/项目/source.png'],
    ['Linux asset scheme', 'asset://localhost/%2Fhome%2Fartist%2Fmedia%2Fsource.png', '/home/artist/media/source.png'],
    ['Unix unencoded route', 'asset://localhost//home/artist/media/source.png', '/home/artist/media/source.png'],
    ['UNC asset route', 'http://asset.localhost/%5C%5Cserver%5Cshare%5Csource.png', '\\\\server\\share\\source.png'],
    ['Literal percent escape in filename', 'asset://localhost/%2Fhome%2Fartist%2F%2520.png', '/home/artist/%20.png'],
  ])('uses the decoded source path for %s', async (_label, source, sourcePath) => {
    const session = await prepareProjectThumbnail('episode-id', source, 256, new AbortController().signal);

    expect(session).not.toBeNull();
    expect(mocks.getProjectDataDir).toHaveBeenCalledExactlyOnceWith('episode-id');
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('prepare_project_thumbnail', {
      projectDir: PROJECT_DIR, sourcePath, maxEdge: 256,
    });
  });

  it('captures the resolved project directory and source version for a later write', async () => {
    const session = await prepareProjectThumbnail('episode-id', SOURCE, 512, new AbortController().signal);
    expect(session).not.toBeNull();
    // A rename, project switch, or later prepare must not redirect the captured session.
    mocks.getProjectDataDir.mockResolvedValue('/home/artist/another-project');
    mocks.invoke.mockResolvedValue(nativeResult({ sourceVersion: 'b'.repeat(64) }));
    await prepareProjectThumbnail('another-project', SOURCE, 256, new AbortController().signal);
    await session!.persist(new Blob([Uint8Array.from(WEBP_BYTES)], { type: 'image/webp' }));

    expect(writeCalls()).toEqual([['write_project_thumbnail', {
      projectDir: PROJECT_DIR,
      sourcePath: 'G:\\media\\source.png',
      maxEdge: 512,
      sourceVersion: SOURCE_VERSION,
      bytes: WEBP_BYTES,
    }]]);
    expect(mocks.getProjectDataDir.mock.calls).toEqual([['episode-id'], ['another-project']]);
  });

  it.each([
    'https://cdn.example.com/image.png',
    'http://asset.localhost.example.com/image.png',
    'asset://untrusted/image.png',
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:http://localhost/preview-id',
    'G:\\media\\source.png',
    'asset://localhost/%ZZ',
    'asset://localhost/%2Fhome%2Fsource%00.png',
    'https://user:password@asset.localhost/G%3A%5Cmedia%5Csource.png',
  ])('keeps unsupported or non-file source %s out of disk IPC', async (source) => {
    expect(await prepareProjectThumbnail('project-id', source, 256, new AbortController().signal)).toBeNull();
    expect(mocks.getProjectDataDir).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([undefined, null, ''])('requires a project identity (%s)', async (projectId) => {
    expect(await prepareProjectThumbnail(projectId, SOURCE, 256, new AbortController().signal)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([0, 128, 257, 2048, Number.NaN, Number.POSITIVE_INFINITY])('rejects an unsupported size tier %s', async (edge) => {
    expect(await prepareProjectThumbnail('project-id', SOURCE, edge, new AbortController().signal)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not resolve files or invoke native commands in the browser fallback', async () => {
    mocks.isTauriEnv.mockReturnValue(false);
    expect(await prepareProjectThumbnail('project-id', SOURCE, 256, new AbortController().signal)).toBeNull();
    expect(mocks.getProjectDataDir).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('falls back when the project directory is unavailable', async () => {
    mocks.getProjectDataDir.mockResolvedValue(null);
    expect(await prepareProjectThumbnail('project-id', SOURCE, 256, new AbortController().signal)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('prepareProjectThumbnail cache transport and budgets', () => {
  it.each([
    ['image/webp', WEBP_BYTES],
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]],
  ])('returns native %s bytes as a Blob with dimensions', async (mime, bytes) => {
    mocks.invoke.mockResolvedValue(nativeResult({ cachedBytes: bytes, width: 256, height: 128 }));
    const session = await prepareProjectThumbnail('project-id', SOURCE, 256, new AbortController().signal);

    expect(session?.cached).toMatchObject({ width: 256, height: 128 });
    expect(session?.cached?.blob.type).toBe(mime);
    expect(Array.from(new Uint8Array(await session!.cached!.blob.arrayBuffer()))).toEqual(bytes);
    expect(writeCalls()).toHaveLength(0);
  });

  it('retains a persistence session on a cache miss', async () => {
    const session = await prepareProjectThumbnail('project-id', SOURCE, 1024, new AbortController().signal);
    expect(session?.cached).toBeNull();
    await session!.persist(new Blob([Uint8Array.from(WEBP_BYTES)]));
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0]?.[1]).toMatchObject({ maxEdge: 1024, sourceVersion: SOURCE_VERSION, bytes: WEBP_BYTES });
  });

  it.each([
    ['empty bytes', { cachedBytes: [] }],
    ['oversized bytes', { cachedBytes: new Array<number>(MAX_BYTES + 1) }],
    ['missing width', { width: null }],
    ['zero height', { height: 0 }],
    ['negative width', { width: -1 }],
    ['fractional width', { width: 20.5 }],
    ['width over tier', { width: 257 }],
    ['height over tier', { height: 257 }],
  ])('treats an invalid native hit as a rebuildable miss: %s', async (_label, override) => {
    mocks.invoke.mockResolvedValue(nativeResult({ cachedBytes: WEBP_BYTES, width: 256, height: 128, ...override }));
    const session = await prepareProjectThumbnail('project-id', SOURCE, 256, new AbortController().signal);
    expect(session).not.toBeNull();
    expect(session?.cached).toBeNull();
    await session!.persist(new Blob([Uint8Array.from(WEBP_BYTES)]));
    expect(writeCalls()).toHaveLength(1);
  });

  it('accepts the inclusive 4 MiB boundary for disk reads and writes', async () => {
    const bytes = new Array<number>(MAX_BYTES).fill(0);
    bytes.splice(0, WEBP_BYTES.length, ...WEBP_BYTES);
    mocks.invoke.mockResolvedValue(nativeResult({ cachedBytes: bytes, width: 1024, height: 1024 }));
    const session = await prepareProjectThumbnail('project-id', SOURCE, 1024, new AbortController().signal);
    expect(session?.cached?.blob.size).toBe(MAX_BYTES);
    await session!.persist(session!.cached!.blob);
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0]?.[1].bytes).toHaveLength(MAX_BYTES);
  });

  it.each([0, MAX_BYTES + 1])('does not even read a blob outside the write size budget (%s bytes)', async (size) => {
    const session = await prepareProjectThumbnail('project-id', SOURCE, 256, new AbortController().signal);
    const blob = new Blob();
    Object.defineProperty(blob, 'size', { value: size });
    const read = vi.spyOn(blob, 'arrayBuffer');
    await session!.persist(blob);
    expect(read).not.toHaveBeenCalled();
    expect(writeCalls()).toHaveLength(0);
  });
});

describe('prepareProjectThumbnail cancellation and failure fallback', () => {
  it('does no filesystem work for an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await prepareProjectThumbnail('project-id', SOURCE, 256, controller.signal)).toBeNull();
    expect(mocks.getProjectDataDir).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('stops before IPC when cancelled while resolving the project directory', async () => {
    const pending = deferred<string>();
    mocks.getProjectDataDir.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const prepare = prepareProjectThumbnail('project-id', SOURCE, 256, controller.signal);
    controller.abort();
    pending.resolve(PROJECT_DIR);
    expect(await prepare).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('discards a native prepare result arriving after cancellation', async () => {
    const pending = deferred<NativeThumbnail>();
    mocks.invoke.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const prepare = prepareProjectThumbnail('project-id', SOURCE, 256, controller.signal);
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    controller.abort();
    pending.resolve(nativeResult({ cachedBytes: WEBP_BYTES, width: 256, height: 128 }));
    expect(await prepare).toBeNull();
    expect(writeCalls()).toHaveLength(0);
  });

  it('does not persist after cancellation of a completed prepare', async () => {
    const controller = new AbortController();
    const session = await prepareProjectThumbnail('project-id', SOURCE, 256, controller.signal);
    controller.abort();
    const blob = new Blob([Uint8Array.from(WEBP_BYTES)]);
    const read = vi.spyOn(blob, 'arrayBuffer');
    await session!.persist(blob);
    expect(read).not.toHaveBeenCalled();
    expect(writeCalls()).toHaveLength(0);
  });

  it('rechecks cancellation after reading the blob but before native write', async () => {
    const controller = new AbortController();
    const session = await prepareProjectThumbnail('project-id', SOURCE, 256, controller.signal);
    const pending = deferred<ArrayBuffer>();
    const blob = new Blob([Uint8Array.from(WEBP_BYTES)]);
    vi.spyOn(blob, 'arrayBuffer').mockReturnValue(pending.promise);
    const persist = session!.persist(blob);
    controller.abort();
    pending.resolve(Uint8Array.from(WEBP_BYTES).buffer);
    await persist;
    expect(writeCalls()).toHaveLength(0);
  });

  it.each(['directory', 'native'])('returns null on %s read failure so memory derivation can proceed', async (stage) => {
    if (stage === 'directory') mocks.getProjectDataDir.mockRejectedValue(new Error('unavailable'));
    else mocks.invoke.mockRejectedValue(new Error('denied'));
    await expect(prepareProjectThumbnail('project-id', SOURCE, 256, new AbortController().signal)).resolves.toBeNull();
  });

  it.each(['blob', 'native', 'source-version-changed'])('does not reject the preview on %s persistence failure', async (stage) => {
    const session = await prepareProjectThumbnail('project-id', SOURCE, 256, new AbortController().signal);
    const blob = new Blob([Uint8Array.from(WEBP_BYTES)]);
    if (stage === 'blob') vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('read failed'));
    else if (stage === 'native') mocks.invoke.mockRejectedValue(new Error('read-only disk'));
    else mocks.invoke.mockResolvedValue(false);
    await expect(session!.persist(blob)).resolves.toBeUndefined();
  });
});

describe('project thumbnail background write queue', () => {
  it('serializes native writes and skips a cancelled queued preview without reading its bytes', async () => {
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const sessions = await Promise.all(controllers.map((controller) => (
      prepareProjectThumbnail('project-id', SOURCE, 256, controller.signal)
    )));
    const firstWrite = deferred<boolean>();
    mocks.invoke.mockImplementationOnce(() => firstWrite.promise).mockResolvedValue(true);
    const first = sessions[0]!.persist(new Blob(['first']));
    const queuedBlob = new Blob(['cancelled']);
    const readQueued = vi.spyOn(queuedBlob, 'arrayBuffer');
    const cancelled = sessions[1]!.persist(queuedBlob);
    const third = sessions[2]!.persist(new Blob(['third']));
    controllers[1]!.abort();
    try {
      await vi.waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(readQueued).not.toHaveBeenCalled();
    } finally {
      firstWrite.resolve(true);
      await Promise.all([first, cancelled, third]);
    }
    expect(writeCalls().map(([, args]) => new TextDecoder().decode(Uint8Array.from(args.bytes)))).toEqual(['first', 'third']);
    expect(readQueued).not.toHaveBeenCalled();
  });

  it('drops excess jobs beyond 64 waiting writes while completing the admitted work', async () => {
    const session = await prepareProjectThumbnail('project-id', SOURCE, 256, new AbortController().signal);
    const firstWrite = deferred<boolean>();
    mocks.invoke.mockImplementationOnce(() => firstWrite.promise).mockResolvedValue(true);
    const requests = [session!.persist(new Blob(['active']))];
    // The first write is in flight; these small previews exercise the count limit, not the byte limit.
    for (let index = 0; index < 64; index++) requests.push(session!.persist(new Blob([String(index)])));
    const extra = new Blob(['discardable']);
    const readExtra = vi.spyOn(extra, 'arrayBuffer');
    try {
      await expect(session!.persist(extra)).resolves.toBeUndefined();
      await vi.waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(readExtra).not.toHaveBeenCalled();
    } finally {
      firstWrite.resolve(true);
      await Promise.all(requests);
    }
    expect(writeCalls()).toHaveLength(65);
    expect(readExtra).not.toHaveBeenCalled();
  });

  it('admits 8 MiB of queued blobs and drops an extra byte without blocking the active write', async () => {
    const session = await prepareProjectThumbnail('project-id', SOURCE, 1024, new AbortController().signal);
    const firstWrite = deferred<boolean>();
    mocks.invoke.mockImplementationOnce(() => firstWrite.promise).mockResolvedValue(true);
    const requests = [session!.persist(new Blob(['active']))];
    const large = new Blob([new Uint8Array(MAX_BYTES)]);
    requests.push(session!.persist(large), session!.persist(large));
    const extra = new Blob(['x']);
    const readExtra = vi.spyOn(extra, 'arrayBuffer');
    try {
      await expect(session!.persist(extra)).resolves.toBeUndefined();
      await vi.waitFor(() => expect(writeCalls()).toHaveLength(1));
      expect(readExtra).not.toHaveBeenCalled();
    } finally {
      firstWrite.resolve(true);
      await Promise.all(requests);
    }
    expect(writeCalls().map(([, args]) => args.bytes.length)).toEqual([6, MAX_BYTES, MAX_BYTES]);
    expect(readExtra).not.toHaveBeenCalled();
  });
});
