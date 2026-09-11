import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); });

describe('settings close lifecycle', () => {
  it('collects debounced changes before freezing and waits for save completion', async () => {
    const queue = await import('../../src/services/configPersistenceQueue');
    const events: string[] = [];
    let finish!: () => void;
    let dirty = false;
    queue.registerSettingsProducer(async () => {
      expect(queue.isSettingsClosing()).toBe(true);
      expect(queue.areSettingsMutationsFrozen()).toBe(false);
      events.push('collect'); dirty = true;
    });
    queue.registerSettingsPersistence('config', {
      hasUnsaved: () => dirty,
      flush: async () => {
        expect(queue.areSettingsMutationsFrozen()).toBe(true);
        events.push('save');
        await queue.enqueueConfigPersistence(() => new Promise<void>((resolve) => { finish = resolve; }));
        dirty = false; events.push('committed');
      },
    });
    let done = false;
    const closing = queue.prepareSettingsClose().then((result) => { done = true; return result; });
    await vi.waitFor(() => expect(events).toEqual(['collect', 'save']));
    expect(done).toBe(false);
    finish(); expect(await closing).toBe(true);
    expect(events).toEqual(['collect', 'save', 'committed']);
    queue.resumeSettingsPersistence();
    expect(queue.areSettingsMutationsFrozen()).toBe(false);
  });

  it('keeps failure visible until an explicit retry succeeds', async () => {
    const queue = await import('../../src/services/configPersistenceQueue');
    let unsaved = true;
    const write = vi.fn(async () => { unsaved = false; });
    queue.registerSettingsPersistence('toolbar', { hasUnsaved: () => unsaved, flush: async (retry) => { if (retry) await write(); } });
    expect(await queue.prepareSettingsClose()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(await queue.prepareSettingsClose(true)).toBe(true);
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not allow destruction on producer failure, and resumes after cancel', async () => {
    const queue = await import('../../src/services/configPersistenceQueue');
    const remove = queue.registerSettingsProducer(async () => { throw new Error('fixture-private'); });
    expect(await queue.prepareSettingsClose()).toBe(false);
    queue.resumeSettingsPersistence();
    expect(queue.isSettingsClosing()).toBe(false);
    remove();
    expect(await queue.prepareSettingsClose()).toBe(true);
  });

  it('drains later operations and records failure without blocking subsequent attempts', async () => {
    const queue = await import('../../src/services/configPersistenceQueue');
    const events: number[] = [];
    const first = queue.enqueueConfigPersistence(async () => {
      events.push(1);
      void queue.enqueueConfigPersistence(async () => { events.push(2); });
    });
    await queue.drainConfigPersistence(); await first;
    expect(events).toEqual([1, 2]);
    await expect(queue.enqueueConfigPersistence(async () => { throw new Error('fixture'); })).rejects.toThrow();
    await queue.drainConfigPersistence();
    expect(queue.getConfigPersistenceState()).toEqual({ pending: 0, failed: true });
    await queue.enqueueConfigPersistence(async () => {});
    expect(queue.getConfigPersistenceState()).toEqual({ pending: 0, failed: false });
  });
});
