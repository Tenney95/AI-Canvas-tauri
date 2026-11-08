import { describe, expect, it } from 'vitest';
import {
  assertEpisodeEditorReady,
  EpisodeEditorWriteBlockedError,
  isEpisodeEditorWriteLocked,
  prepareEpisodeEditorRebase,
  registerEpisodeEditorSession,
  settleEpisodeEditorSessions,
  withEpisodeEditorWrite,
} from '../../src/services/episodeEditorSessionService';

describe('episode editor write coordination', () => {
  it('blocks applying a background result while the original episode has a dirty draft', () => {
    let dirty = true;
    const close = registerEpisodeEditorSession('dirty-original', () => ({ dirty, saving: false }));
    expect(() => assertEpisodeEditorReady('dirty-original')).toThrow('未保存');
    expect(() => assertEpisodeEditorReady('dirty-original')).toThrow(EpisodeEditorWriteBlockedError);
    expect(() => assertEpisodeEditorReady('another-episode')).not.toThrow();
    dirty = false;
    expect(() => assertEpisodeEditorReady('dirty-original')).not.toThrow();
    close();
  });

  it('keeps an unconfirmed dirty editor blocked after unmount until an explicit save or discard', () => {
    const close = registerEpisodeEditorSession('lost-editor', () => ({ dirty: true, saving: false }));
    close();
    expect(() => assertEpisodeEditorReady('lost-editor')).toThrow('未保存');
    expect(() => assertEpisodeEditorReady('lost-editor')).toThrow(EpisodeEditorWriteBlockedError);
    settleEpisodeEditorSessions('lost-editor');
    expect(() => assertEpisodeEditorReady('lost-editor')).not.toThrow();
  });

  it('does not clear a live dirty editor when settling a previous editor', () => {
    let dirty = true;
    const close = registerEpisodeEditorSession('live-editor', () => ({ dirty, saving: false }));
    settleEpisodeEditorSessions('live-editor');
    expect(() => assertEpisodeEditorReady('live-editor')).toThrow('未保存');
    dirty = false;
    close();
  });

  it('holds a write lease across asynchronous persistence and releases it on failure', async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const operation = withEpisodeEditorWrite('write-lease', async () => {
      await gate;
      throw new Error('storage unavailable');
    });
    expect(isEpisodeEditorWriteLocked('write-lease')).toBe(true);
    await expect(withEpisodeEditorWrite('write-lease', async () => undefined)).rejects.toMatchObject({
      code: 'EPISODE_EDITOR_WRITE_BLOCKED', message: expect.stringContaining('正在保存'),
    });
    finish?.();
    await expect(operation).rejects.toThrow('storage unavailable');
    expect(isEpisodeEditorWriteLocked('write-lease')).toBe(false);
  });

  it('rebases a clean local copy only after confirmed persistence and preserves a later draft version', () => {
    let version = 1;
    let local = 'saved original';
    const close = registerEpisodeEditorSession('rebase-editor', () => ({ dirty: false, saving: false }), () => {
      const capturedVersion = version;
      return () => { if (version === capturedVersion) local = ''; };
    });
    const rebase = prepareEpisodeEditorRebase('rebase-editor');
    expect(local).toBe('saved original');
    version += 1;
    local = 'new local draft';
    rebase();
    expect(local).toBe('new local draft');
    prepareEpisodeEditorRebase('rebase-editor')();
    expect(local).toBe('');
    close();
  });
});
