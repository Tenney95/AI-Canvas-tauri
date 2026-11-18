import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Effect = { deps: readonly unknown[]; setup: () => void | (() => void); cleanup?: () => void };
type Lease = { src: string; release: () => void };
const hooks = vi.hoisted(() => ({
  state: null as unknown,
  ref: { current: null as unknown },
  callback: undefined as unknown,
  nextEffects: [] as Effect[],
  effects: [] as Effect[],
}));
const media = vi.hoisted(() => ({ acquire: vi.fn<(url: string, signal: AbortSignal) => Promise<Lease>>() }));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useRef: () => hooks.ref,
  useState: <T,>() => [hooks.state as T, (value: T) => { hooks.state = value; }] as const,
  useCallback: <T,>(callback: T) => (hooks.callback ??= callback) as T,
  useLayoutEffect: (setup: Effect['setup'], deps: readonly unknown[]) => { hooks.nextEffects.push({ deps, setup }); },
}));
vi.mock('../../src/services/comfyMediaSource', () => ({
  acquireComfyMediaSource: media.acquire,
  shouldLoadNativeComfyMedia: (url: string) => url.startsWith('http://localhost:8188/view?'),
}));

import { useCharacterVoicePreview } from '../../src/hooks/useCharacterVoicePreview';

const players: FakeAudio[] = [];
const play = vi.fn<(src: string) => Promise<void>>();
class FakeAudio {
  src = '';
  paused = false;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => play(this.src));
  pause = vi.fn();
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
  load = vi.fn();

  constructor() { players.push(this); }
}

function VoicePreviewProbe(context: string, options?: Parameters<typeof useCharacterVoicePreview>[1]) {
  return useCharacterVoicePreview(context, options);
}

function render(context: string, options?: Parameters<typeof useCharacterVoicePreview>[1]) {
  hooks.nextEffects = [];
  return VoicePreviewProbe(context, options);
}

function commit() {
  hooks.nextEffects.forEach((effect, index) => {
    const previous = hooks.effects[index];
    if (previous && effect.deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    previous?.cleanup?.();
    hooks.effects[index] = { ...effect, cleanup: effect.setup() ?? undefined };
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  hooks.state = null;
  hooks.ref = { current: null };
  hooks.callback = undefined;
  hooks.effects = [];
  players.length = 0;
  play.mockReset().mockResolvedValue(undefined);
  media.acquire.mockReset();
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

it('直接地址在点击中开始播放，角色库只在播放成功后显示暂停', async () => {
  const options = { stopOnPause: true };
  const playing = deferred<void>();
  play.mockReturnValueOnce(playing.promise);
  const preview = render('角色', options);
  commit();
  const started = preview.toggle('片段', 'asset://voice.wav');

  expect(play).toHaveBeenCalledExactlyOnceWith('asset://voice.wav');
  expect(media.acquire).not.toHaveBeenCalled();
  expect(render('角色', options).playingId).toBeNull();
  commit();
  playing.resolve(undefined);
  await started;

  expect(render('角色', options).playingId).toBe('片段');
  players[0].onpause?.();
  expect(players[0].pause).not.toHaveBeenCalled();
  players[0].paused = true;
  players[0].onpause?.();
  expect(render('角色', options).playingId).toBeNull();
  expect(players[0].src).toBe('');
});

it('ComfyUI 试听等待时可停止，迟到的租约和媒体事件不会覆盖同 ID 的后续试听', async () => {
  const options = { showPending: true, onError: vi.fn() };
  const pending = deferred<Lease>();
  const oldLease = { src: 'comfy-media://localhost/old', release: vi.fn() };
  const newLease = { src: 'comfy-media://localhost/new', release: vi.fn() };
  const url = 'http://localhost:8188/view?filename=voice.wav';
  media.acquire.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(oldLease).mockResolvedValueOnce(newLease);
  const preview = render('角色A', options);
  commit();
  const first = preview.toggle('声音', url);
  expect(render('角色A', options).playingId).toBe('声音');
  await preview.toggle('声音', url);
  expect(media.acquire.mock.calls[0][1].aborted).toBe(true);
  pending.resolve({ src: 'comfy-media://localhost/stale', release: vi.fn() });
  const stale = await pending.promise;
  await first;
  expect(stale.release).toHaveBeenCalledOnce();
  expect(play).not.toHaveBeenCalled();

  await preview.toggle('声音', url);
  const staleEnd = players[0].onended;
  const staleError = players[0].onerror;
  expect(render('角色B', options).playingId).toBeNull();
  commit();
  expect(oldLease.release).toHaveBeenCalledOnce();

  await render('角色B', options).toggle('声音', url);
  expect(players[1].src).toBe(newLease.src);
  staleEnd?.();
  staleError?.();
  expect(render('角色B', options).playingId).toBe('声音');
  expect(newLease.release).not.toHaveBeenCalled();
  expect(options.onError).not.toHaveBeenCalled();
  players[1].onended?.();
  expect(newLease.release).toHaveBeenCalledOnce();
});

it('只在当前片段的来源变化时停止，保留试听错误与重新播放的入口', async () => {
  const onError = vi.fn();
  const sources: Record<string, string> = { clip: 'clip.wav' };
  const options = { getSource: (id: string) => sources[id], onError, showPending: true };
  const preview = render('角色', options);
  commit();
  await preview.toggle('clip', sources.clip);
  expect(render('角色', options).playingId).toBe('clip');
  commit();

  await preview.toggle('clip', sources.clip);
  await preview.toggle('clip', sources.clip);
  await preview.toggle('空白片段');
  expect(render('角色', options).playingId).toBe('clip');
  commit();
  expect(players[0].pause).toHaveBeenCalledOnce();

  sources.other = 'other.wav';
  expect(render('角色', options).playingId).toBe('clip');
  commit();
  expect(players[1].pause).not.toHaveBeenCalled();

  sources.clip = 'replacement.wav';
  expect(render('角色', options).playingId).toBeNull();
  commit();
  expect(players[1].pause).toHaveBeenCalledOnce();

  play.mockRejectedValueOnce(new Error('播放失败'));
  await preview.toggle('clip', sources.clip);
  expect(render('角色', options).error).toBe(true);
  expect(onError).toHaveBeenCalledOnce();
  await preview.toggle('clip', sources.clip);
  expect(render('角色', options)).toMatchObject({ playingId: 'clip', error: false });
});
