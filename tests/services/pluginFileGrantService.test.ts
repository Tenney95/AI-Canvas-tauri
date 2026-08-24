import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  read: vi.fn(),
}));

vi.mock('../../src/services/fileService', () => ({
  selectAgentTextFiles: mocks.select,
  readAgentAuthorizedTextFile: mocks.read,
}));

import {
  authorizePluginTextFile,
  clearPluginFileGrants,
  readPluginGrantedTextFile,
} from '../../src/services/plugins/pluginFileGrantService';

beforeEach(() => {
  vi.clearAllMocks();
  clearPluginFileGrants();
  mocks.select.mockResolvedValue([{
    path: '/private/example.txt',
    fileName: 'example.txt',
    size: 12,
    extension: 'txt',
  }]);
  mocks.read.mockResolvedValue('hello');
});

describe('plugin file grants', () => {
  it('keeps the absolute path private and binds reads to one plugin node', async () => {
    const grant = await authorizePluginTextFile('plugin-a', 'node-a');
    expect(grant).toMatchObject({ displayName: 'example.txt', size: 12, extension: 'txt' });
    expect(grant).not.toHaveProperty('path');

    await expect(readPluginGrantedTextFile('plugin-a', 'node-b', grant!.grantId))
      .rejects.toThrow('不属于当前节点');
    await expect(readPluginGrantedTextFile('plugin-b', 'node-a', grant!.grantId))
      .rejects.toThrow('不属于当前节点');

    await expect(readPluginGrantedTextFile('plugin-a', 'node-a', grant!.grantId))
      .resolves.toMatchObject({ content: 'hello', file: { displayName: 'example.txt' } });
    expect(mocks.read).toHaveBeenCalledWith('/private/example.txt', 256 * 1024);
  });

  it('revokes grants when a plugin is disabled or its node is deleted', async () => {
    const grant = await authorizePluginTextFile('plugin-a', 'node-a');
    clearPluginFileGrants('plugin-a');
    await expect(readPluginGrantedTextFile('plugin-a', 'node-a', grant!.grantId))
      .rejects.toThrow('授权不存在');
  });
});
