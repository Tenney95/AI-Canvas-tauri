import { describe, expect, it } from 'vitest';
import { comfyComboOptions } from '../../src/services/comfyInputSpecs';

describe('ComfyUI COMBO 选项声明', () => {
  it.each([
    [[['simple', 'karras'], {}]],
    [['COMBO', { options: ['simple', 'karras'] }]],
  ])('兼容旧数组和显式 COMBO，保留原值及次序', (declaration) => {
    const snapshot = structuredClone(declaration);
    expect(comfyComboOptions(declaration)).toEqual(['simple', 'karras']);
    expect(declaration).toEqual(snapshot);
  });

  it('保留数字、布尔及空选项，交给具体字段验证类型', () => {
    expect(comfyComboOptions(['COMBO', { options: [0, 1, false] }])).toEqual([0, 1, false]);
    expect(comfyComboOptions(['COMBO', { options: [] }])).toEqual([]);
  });

  it.each([
    null, {}, 'COMBO', ['COMBO'], ['COMBO', null], ['COMBO', []],
    ['COMBO', { options: 'simple' }], ['STRING', { options: ['simple'] }],
    ['COMBO', { remote: { route: 'https://untrusted.test/options' } }],
    ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'branch', inputs: {} }] }],
  ].map((declaration) => [declaration]))('未知或需远程读取的声明不推断选项：%j', (declaration) => {
    expect(comfyComboOptions(declaration)).toBeUndefined();
  });
});
