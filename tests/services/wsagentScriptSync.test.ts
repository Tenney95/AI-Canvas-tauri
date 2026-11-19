import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), slots: vi.fn(), apply: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/services/wsagentScriptSlots', () => ({ readWsagentScriptSlots: mocks.slots }));

import { syncWsagentScripts } from '../../src/services/wsagentScriptSync';

const scope = { owner: 'owner', project: 'canvas', peer: 'workspace', assertCurrent: () => {} };
const markdown = '## 第一场\n\n林禾走进候车亭。';

function getScript(content: string, id = 'original') {
  const hash = createHash('sha256').update(content).digest('hex');
  return { id, title: '候车亭', revision: hash, contentDigest: hash, content };
}

function useSlots(content: string) {
  mocks.slots.mockResolvedValue([{ id: 'owner', kind: 'project', title: '候车亭', content, assertCurrent: () => {}, apply: mocks.apply }]);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  const state = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => state.get(key) ?? null, setItem: (key: string, value: string) => state.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe('paired screenplay sync', () => {
  it('imports the sole existing WSAGENT script after the Canvas draft settles', async () => {
    const script = getScript(markdown);
    useSlots('');
    mocks.invoke.mockImplementation(async (command: string) => command.endsWith('_list') ? { scripts: [script] } : { script });
    mocks.apply.mockResolvedValueOnce('deferred').mockResolvedValueOnce('applied');
    expect(await syncWsagentScripts(scope)).toBe('deferred');
    expect(await syncWsagentScripts(scope)).toBe('ready');
    expect(mocks.apply).toHaveBeenLastCalledWith(markdown, scope.assertCurrent);
    expect(mocks.invoke).toHaveBeenCalledWith('wsagent_shared_scripts_read', {
      ownerId: 'owner', id: 'original', expectedRevision: script.revision,
    });
  });

  it('preserves both existing bodies when they differ at first pairing', async () => {
    useSlots('另一版正文');
    mocks.invoke.mockResolvedValue({ scripts: [getScript(markdown)] });
    expect(await syncWsagentScripts(scope)).toBe('conflict');
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('does not guess from several existing WSAGENT documents', async () => {
    useSlots('');
    mocks.invoke.mockResolvedValue({ scripts: [getScript(markdown), getScript('另一版', 'another')] });
    expect(await syncWsagentScripts(scope)).toBe('ambiguous');
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
});
