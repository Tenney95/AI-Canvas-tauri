/**
 * chatImageReferenceService — 回归测试：chat image references。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as files from '../../../src/services/fileService';
import { useAppStore } from '../../../src/store/useAppStore';
import {
  attachConversationFiles, formatChatImageReference, parseChatImageReferences,
  readChatImageReference, stripChatImageReferences,
} from '../../../src/services/chat/chatImageReferenceService';
import { clearConversationFileGrants, listConversationFileGrants } from '../../../src/services/chat/fileGrantService';
import { resolvePromptToChatContent, resolvePromptWithImageRefs } from '../../../src/services/ai/promptResolver';
import { prepareAssistantVisualMessages } from '../../../src/services/chat/assistantVisualContext';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../../src/services/chat/assistantScope';
import * as core from '../../../src/services/fs/core';
import * as nativeProjects from '../../../src/services/indexedDb/nativeProjectRepository';
import { nativeChatImagePaths } from '../../../src/utils/chatImageReference';
import type { ProjectModelTransferExchange } from '../../../src/types/projectModelTransfer';

const fileName = 'chat-ref-11111111-1111-4111-8111-111111111111.png';
const dataUrl = 'data:image/png;base64,QUJDRA==';
const image = { fileName, label: '人物|参考}.png', size: 4 };

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1', projectLoadStatus: 'ready', activeConversationId: 'chat-1',
    projects: [{ id: 'project-1', name: 'Project', createdAt: 1, updatedAt: 1 }],
    conversations: [{ id: 'chat-1', projectId: 'project-1', title: 'Chat', titleSource: 'user', pinned: false,
      archived: false, agentMode: 'collaborative', createdAt: 1, updatedAt: 1, messageCount: 0 }] });
});

afterEach(() => { vi.restoreAllMocks(); clearConversationFileGrants('chat-1'); });

describe('chat image references', () => {
  it('stores general chat references in their own scope without opening or creating a project', async () => {
    useAppStore.setState((state) => ({ currentProjectId: null,
      conversations: state.conversations.map((conversation) => ({ ...conversation, projectId: GENERAL_ASSISTANT_SCOPE_ID })) }));
    vi.spyOn(files, 'selectAgentTextFiles').mockResolvedValue([{ path: 'selected/reference.png', fileName: '参考.png', extension: 'png', size: 4 }]);
    vi.spyOn(files, 'readAgentSelectedImage').mockResolvedValue({ bytes: new Uint8Array([1, 2, 3, 4]), extension: 'png' });
    const save = vi.spyOn(files, 'saveBinaryToProjectData').mockResolvedValue({ filePath: 'general/reference.png', assetUrl: 'asset://general' });
    expect(await attachConversationFiles('chat-1')).toEqual({ images: 1, texts: 0, failed: 0 });
    expect(save).toHaveBeenCalledWith(expect.any(Uint8Array), GENERAL_ASSISTANT_SCOPE_ID, expect.any(String), { throwOnError: true });
    expect(useAppStore.getState().currentProjectId).toBeNull();
    expect(useAppStore.getState().projects.map((project) => project.id)).toEqual(['project-1']);
  });

  it('round-trips labels without persisting paths or letting delimiters escape the reference', () => {
    const raw = formatChatImageReference(image);
    expect(parseChatImageReferences(`看看 ${raw}`)).toMatchObject([{ fileName, label: image.label, raw }]);
    expect(stripChatImageReferences(`看看 ${raw}`)).toBe('看看');
    expect(() => formatChatImageReference({ ...image, fileName: '../secret.png' })).toThrow('无效');
    expect(parseChatImageReferences('@image{../../secret.png|secret}')).toEqual([]);
    expect(parseChatImageReferences(formatChatImageReference({ ...image, label: '😀'.repeat(121) }))[0].label).toBe('😀'.repeat(120));
  });

  it('imports images and keeps text authorization separate without adding canvas nodes', async () => {
    vi.spyOn(files, 'selectAgentTextFiles').mockResolvedValue([
      { path: 'selected/reference.png', fileName: '人物.png', extension: 'png', size: 4 },
      { path: 'selected/note.md', fileName: 'note.md', extension: 'md', size: 8 },
    ]);
    vi.spyOn(files, 'readAgentSelectedImage').mockResolvedValue({ bytes: new Uint8Array([1, 2, 3, 4]), extension: 'png' });
    const save = vi.spyOn(files, 'saveBinaryToProjectData').mockResolvedValue({ filePath: 'project/saved.png', assetUrl: 'asset://saved' });
    expect(await attachConversationFiles('chat-1')).toEqual({ images: 1, texts: 1, failed: 0 });
    const draft = useAppStore.getState().chatImageDrafts['chat-1'];
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({ label: '人物.png', size: 4 });
    expect(save).toHaveBeenCalledWith(expect.any(Uint8Array), 'project-1', expect.stringMatching(/^chat-ref-.*\.png$/), { throwOnError: true });
    expect(listConversationFileGrants('chat-1')).toMatchObject([{ displayName: 'note.md' }]);
    expect(JSON.stringify(draft)).not.toContain('selected/');
    expect(JSON.stringify(draft)).not.toContain('base64');
    expect(useAppStore.getState().nodes).toEqual([]);
  });

  it('does not attach a late selection to another conversation or project', async () => {
    let finish: ((selection: files.AgentTextFileSelection[]) => void) | undefined;
    vi.spyOn(files, 'selectAgentTextFiles').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const save = vi.spyOn(files, 'saveBinaryToProjectData');
    const pending = attachConversationFiles('chat-1');
    useAppStore.setState({ currentProjectId: 'project-2' });
    finish?.([{ path: 'selected/a.png', fileName: 'a.png', extension: 'png', size: 4 }]);
    await expect(pending).rejects.toThrow('已切换');
    expect(save).not.toHaveBeenCalled();
    expect(useAppStore.getState().chatImageDrafts).toEqual({});
  });

  it('reports excess images while retaining the accepted attachments', async () => {
    vi.spyOn(files, 'selectAgentTextFiles').mockResolvedValue(Array.from({ length: 7 }, (_, index) => ({
      path: `selected/${index}.png`, fileName: `${index}.png`, extension: 'png', size: 4,
    })));
    vi.spyOn(files, 'readAgentSelectedImage').mockResolvedValue({ bytes: new Uint8Array(4), extension: 'png' });
    vi.spyOn(files, 'saveBinaryToProjectData').mockResolvedValue({ filePath: 'project/saved.png', assetUrl: 'asset://saved' });
    expect(await attachConversationFiles('chat-1')).toEqual({ images: 6, texts: 0, failed: 1 });
    expect(useAppStore.getState().chatImageDrafts['chat-1']).toHaveLength(6);
  });

  it('resolves chat and generation inputs from the requested project and deduplicates the same image', async () => {
    const root = vi.spyOn(files, 'getProjectDataDir').mockResolvedValue('project-root');
    vi.spyOn(files, 'readFileToDataUrl').mockResolvedValue(dataUrl);
    const raw = formatChatImageReference(image);
    const chat = await resolvePromptToChatContent(`看看 ${raw} ${raw}`, { projectId: 'captured-project' });
    expect(root).toHaveBeenCalledWith('captured-project');
    expect(chat.content).toEqual(expect.arrayContaining([{ type: 'image_url', image_url: { url: dataUrl } }]));
    expect((chat.content as unknown[]).length).toBe(2);
    const generated = await resolvePromptWithImageRefs(`修改 ${raw}`);
    expect(generated.imageUrls).toEqual([dataUrl]);
    expect(generated.prompt).toBe('修改 图片1');
    const messages = await prepareAssistantVisualMessages({ projectId: 'project-1', supportsVision: true,
      messages: [{ role: 'user', content: `看看 ${raw}` }] });
    expect(messages[0].content).toEqual(expect.arrayContaining([{ type: 'image_url', image_url: { url: dataUrl } }]));
    expect(useAppStore.getState().messages).toEqual([]);
  });

  it('rejects traversal, missing files and cancellation instead of sending only the text', async () => {
    const root = vi.spyOn(files, 'getProjectDataDir').mockResolvedValue('project-root');
    vi.spyOn(files, 'readFileToDataUrl').mockResolvedValue(null);
    await expect(readChatImageReference('project-1', '../private.png')).rejects.toThrow('无效');
    expect(root).not.toHaveBeenCalled();
    await expect(readChatImageReference('project-1', fileName)).rejects.toThrow('不可用');
    const controller = new AbortController(); controller.abort();
    await expect(readChatImageReference('project-1', fileName, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the destination project binding for a copied chat image without rewriting the message', async () => {
    const localRelativePath = `imports/archive-copy-root-0/${fileName}`;
    const exchange = {
      identities: [{ kind: 'storage-root', localId: 'primary-root', sourceId: 'logical-root' }],
      fileBindings: [{ rootRef: 'logical-root', relativePath: fileName, localRelativePath }],
    } as ProjectModelTransferExchange;
    const bindings = nativeChatImagePaths('primary-root', exchange);
    expect(bindings.get(fileName)).toBe(localRelativePath);
    expect(nativeChatImagePaths('other-root', exchange)).toEqual(new Map());
    expect(nativeChatImagePaths('primary-root', { ...exchange,
      fileBindings: [{ ...exchange.fileBindings[0], localRelativePath: 'imports/copy-root-0/unrelated.png' }],
    })).toEqual(new Map());
    vi.spyOn(core, 'getNativeProjectOwner').mockReturnValue('copied-owner');
    vi.spyOn(files, 'getProjectDataDir').mockResolvedValue('copied-root');
    const readBindings = vi.spyOn(nativeProjects, 'readNativeProjectChatImagePaths').mockResolvedValue(bindings);
    const read = vi.spyOn(files, 'readFileToDataUrl').mockResolvedValue(dataUrl);

    expect(await readChatImageReference('copied-canvas', fileName)).toBe(dataUrl);
    expect(readBindings).toHaveBeenCalledWith('copied-owner', { signal: undefined });
    expect(read).toHaveBeenCalledWith(`copied-root/${localRelativePath}`, expect.objectContaining({ kind: 'image' }));
  });
});
