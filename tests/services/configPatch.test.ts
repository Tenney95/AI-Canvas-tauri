import { describe, expect, it } from 'vitest';
import { applyConfigPatch, ConfigConflictError, configWithoutSecrets, createConfigPatch } from '../../src/services/configPatch';

describe('configuration three-way merge', () => {
  it('merges independent nested fields and keeps the current unrelated values', () => {
    const base = { theme: 'dark', providers: { a: { name: 'A', baseUrl: 'old' } } };
    const next = { ...base, providers: { a: { ...base.providers.a, name: 'B' } } };
    const current = { theme: 'light', providers: { a: { name: 'A', baseUrl: 'new' } } };
    expect(applyConfigPatch(current, createConfigPatch(base, next))).toEqual({ theme: 'light', providers: { a: { name: 'B', baseUrl: 'new' } } });
  });
  it('rejects competing updates to the same field but accepts an idempotent retry', () => {
    const patch = createConfigPatch({ theme: 'dark' }, { theme: 'light' });
    expect(() => applyConfigPatch({ theme: 'system' }, patch)).toThrow(ConfigConflictError);
    expect(applyConfigPatch({ theme: 'light' }, patch)).toEqual({ theme: 'light' });
  });
  it('treats arrays as a single field and protects deletions from concurrent edits', () => {
    const base = { folders: ['one'], provider: { name: 'A' } };
    expect(() => applyConfigPatch({ ...base, folders: ['other'] }, createConfigPatch(base, { ...base, folders: ['two'] }))).toThrow(ConfigConflictError);
    expect(() => applyConfigPatch({ folders: ['one'], provider: { name: 'B' } }, createConfigPatch(base, { folders: ['one'] }))).toThrow(ConfigConflictError);
    expect(applyConfigPatch(base, createConfigPatch(base, { folders: ['one'] }))).toEqual({ folders: ['one'] });
  });
  it('does not resurrect a provider deleted while another window adds a field', () => {
    const base = { providers: { a: { name: 'A' } } };
    const next = { providers: { a: { name: 'A', url: 'new' } } };
    expect(() => applyConfigPatch({ providers: {} }, createConfigPatch(base, next))).toThrow(ConfigConflictError);
  });
  it('strips credentials from a baseline and rejects prototype mutation paths', () => {
    const source = { providers: { a: { apiKey: 'fixture-key', apiKeyRef: 'secret:provider/a' } }, dreaminaAuth: { cookie: 'fixture-cookie' } };
    expect(configWithoutSecrets(source)).toEqual({ providers: { a: { apiKeyRef: 'secret:provider/a' } }, dreaminaAuth: {} });
    expect(source.providers.a.apiKey).toBe('fixture-key');
    expect(() => applyConfigPatch({}, [{ path: ['__proto__', 'polluted'], before: undefined, after: true }])).toThrow('配置字段无效');
  });
});
