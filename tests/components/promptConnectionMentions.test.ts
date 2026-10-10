import { describe, expect, it } from 'vitest';
import { mergeAppendedNodeMentions } from '../../src/utils/promptConnectionMentions';

describe('editing while upstream references are appended', () => {
  it('keeps newly connected references when stale editor text is emitted on blur', () => {
    expect(mergeAppendedNodeMentions('镜头描述', '镜头描述', '镜头描述 @{image:参考图}'))
      .toBe('镜头描述 @{image:参考图}');
  });

  it('preserves an edit in the middle of the prose and multiple later connections', () => {
    expect(mergeAppendedNodeMentions('角色走向车站', '角色快速走向车站',
      '角色走向车站 @{video:动作} @{audio:声音}'))
      .toBe('角色快速走向车站 @{video:动作} @{audio:声音}');
  });

  it('does not restore an old capsule that the user deleted while another asset was connected', () => {
    expect(mergeAppendedNodeMentions('描述 @{old:旧素材}', '描述',
      '描述 @{old:旧素材} @{new:新素材}'))
      .toBe('描述 @{new:新素材}');
  });

  it('deduplicates by identity while retaining manually renamed or copied capsules', () => {
    expect(mergeAppendedNodeMentions('描述', '描述 @{new:手动名称} @{new:手动名称}',
      '描述 @{new:新素材} @{other:其他} @{other:其他}'))
      .toBe('描述 @{new:手动名称} @{new:手动名称} @{other:其他}');
  });

  it('keeps line breaks and workflow input text while appending references outside the input', () => {
    expect(mergeAppendedNodeMentions('@wf{6|提示词|prompt}(原文)', '@wf{6|提示词|prompt}(新文)\n',
      '@wf{6|提示词|prompt}(原文) @{image:参考图}'))
      .toBe('@wf{6|提示词|prompt}(新文)\n@{image:参考图}');
  });

  it('handles an initially empty prompt without losing IME text', () => {
    expect(mergeAppendedNodeMentions('', '正在输入中文', '@{image:参考图}'))
      .toBe('正在输入中文 @{image:参考图}');
  });

  it('preserves a pending reference over consecutive input events before the DOM refreshes', () => {
    const first = mergeAppendedNodeMentions('描述', '描述中', '描述 @{image:参考图}');
    expect(mergeAppendedNodeMentions('描述中', '描述中文', `${first} @{audio:声音}`))
      .toBe('描述中文 @{image:参考图} @{audio:声音}');
  });

  it.each([
    ['描述', '描述'],
    ['描述 @{old:旧素材}', '描述'],
    ['描述', '外部改写 @{new:新素材}'],
    ['描述', '描述 外部正文 @{new:新素材}'],
    ['描述', '描述 @asset{library}'],
  ])('keeps local edits when the external change is not a node-reference append (%s → %s)', (previous, current) => {
    expect(mergeAppendedNodeMentions(previous, '用户修改后的内容', current))
      .toBe('用户修改后的内容');
  });
});
