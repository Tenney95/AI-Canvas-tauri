import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedModelExecutionProtocol } from '../../src/types/aiTypes';
import type { CharacterImageTaskRecovery } from '../../src/types/media';
import { registerCharacterImageTaskContext } from '../../src/services/characterImageTaskContext';
import { PollTaskFailedError } from '../../src/services/pollTask';

const driver = vi.hoisted(() => ({
  state: { config: { providers: { gateway: { apiKey: 'secret-key', baseUrl: 'https://gateway.example/v1' } }, generalModels: [] }, workflows: [] },
  submit: vi.fn(), poll: vi.fn(), fetch: vi.fn(), protocols: [] as NormalizedModelExecutionProtocol[], events: [] as string[],
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => driver.state } }));
vi.mock('../../src/services/ai/apimartGen', () => ({ fetchApimartTask: driver.fetch }));
vi.mock('../../src/services/ai/modelProtocol', () => ({ submitModelProtocol: driver.submit }));
vi.mock('../../src/services/ai/modelProtocolPoll', () => ({
  pollResolvedModelProtocol: driver.poll,
  resolvePoll: (_base: string, poll: unknown) => poll,
}));
vi.mock('../../src/services/ai/generateImage', () => ({ characterImageRecoveryProtocols: () => driver.protocols }));
vi.mock('../../src/services/ai/providerCatalogService', () => ({ getProviderDefinition: () => ({ id: 'custom-openai' }) }));
vi.mock('../../src/services/indexedDb/nativeMediaTaskRepository', () => ({ normalizeNativeMediaProviderBase: (value: string) => value.replace(/\/+$/, '') }));
vi.mock('../../src/services/nativeModelProtocolTask', () => ({
  nativeProtocolQueryPaths: () => ['submit.data.task_id'],
  nativeProtocolQueryDigest: async (_id: string, protocol: NormalizedModelExecutionProtocol) => protocol.poll?.path === '/tasks/{{submit.data.task_id}}' ? 'b'.repeat(64) : 'c'.repeat(64),
  captureNativeProtocolContext: () => ({ submit: { data: { task_id: 'job-1' } } }),
  resolveNativeProtocolContext: (_protocol: unknown, _id: string, context: unknown) => context,
}));
import { executeCharacterProtocol, recoverCharacterImageTask } from '../../src/services/characterImageTaskRecovery';

const protocol = { version: 1, mode: 'async', submit: { method: 'POST', path: '/images/generations' },
  response: { taskIdPath: 'data.task_id' }, poll: { method: 'GET', path: '/tasks/{{submit.data.task_id}}' } } as NormalizedModelExecutionProtocol;
const receipt = (): CharacterImageTaskRecovery => ({ version: 1, kind: 'protocol', connectionId: 'gateway',
  providerBase: 'https://gateway.example/v1', modelRef: 'general/image', configurationDigest: 'a'.repeat(64), expectedCount: 1,
  query: { modelId: 'image', digest: 'b'.repeat(64) }, tasks: [{ taskId: 'job-1', recoveryContext: { submit: { data: { task_id: 'job-1' } } } }] });

beforeEach(() => { vi.clearAllMocks(); driver.events.length = 0; driver.protocols = [protocol];
  driver.poll.mockResolvedValue({ urls: ['https://files.example/image.png'] }); });

describe('character image protocol receipts', () => {
  it('writes the remote identity before polling and keeps the submission body out of the recovery seed', async () => {
    driver.submit.mockImplementation(async (options) => { await options.beforeSubmit(); driver.events.push('submit');
      return { taskId: 'job-1', poll: protocol.poll, recoveryContext: { submit: { data: { task_id: 'job-1' } } } }; });
    const done = new Error('delivered');
    const destination = registerCharacterImageTaskContext({ assertCurrent: vi.fn(), execute: async (plan) => {
      expect(plan.recovery).toEqual({ kind: 'protocol', query: { modelId: 'image', digest: 'b'.repeat(64) } });
      const results = await plan.execute(async () => { driver.events.push('intent'); }, async (id) => {
        expect(id).toBe('job-1'); driver.events.push('receipt');
      }, 'c6fce9e9-dd80-4abf-83bd-cd3c941b7632');
      expect(results).toEqual([{ url: 'https://files.example/image.png' }]); throw done;
    } });
    driver.poll.mockImplementation(async () => { driver.events.push('poll'); return { urls: ['https://files.example/image.png'] }; });
    await expect(executeCharacterProtocol(destination.beforeSubmit, { apiKey: 'secret-key', baseUrl: 'https://gateway.example/v1',
      protocol, variables: { model: 'image', prompt: 'private prompt' } })).rejects.toBe(done);
    expect(driver.events).toEqual(['intent', 'submit', 'receipt', 'poll']);
    destination.release();
  });

  it('only queries the retained task and rejects a changed contract without submitting', async () => {
    expect(await recoverCharacterImageTask(receipt(), 'operation')).toEqual([{ url: 'https://files.example/image.png' }]);
    expect(driver.submit).not.toHaveBeenCalled();
    driver.poll.mockClear(); driver.protocols = [];
    await expect(recoverCharacterImageTask(receipt(), 'operation')).rejects.toThrow('查询合同已变化');
    expect(driver.submit).not.toHaveBeenCalled(); expect(driver.poll).not.toHaveBeenCalled();
  });

  it('returns already completed candidates for retention if a later original task cannot be queried', async () => {
    const original = receipt(); original.tasks.push({ taskId: 'job-2', recoveryContext: { submit: { data: { task_id: 'job-2' } } } });
    driver.poll.mockResolvedValueOnce({ urls: ['https://files.example/first.png'] }).mockRejectedValueOnce(new Error('offline'));
    const results = await recoverCharacterImageTask(original, 'operation');
    expect(results.map((item) => item.url)).toEqual(['https://files.example/first.png']);
    expect(results.incomplete).toBe(true); expect(driver.submit).not.toHaveBeenCalled();
  });

  it('keeps checking the other retained task after one confirmed failure', async () => {
    const original = receipt(); original.tasks.push({ taskId: 'job-2', recoveryContext: { submit: { data: { task_id: 'job-2' } } } });
    driver.poll.mockRejectedValueOnce(new PollTaskFailedError('failed')).mockResolvedValueOnce({ urls: ['https://files.example/second.png'] });
    const results = await recoverCharacterImageTask(original, 'operation');
    expect(results.map((item) => item.url)).toEqual(['https://files.example/second.png']);
    expect(results.incomplete).toBeUndefined(); expect(driver.submit).not.toHaveBeenCalled();
  });
});
