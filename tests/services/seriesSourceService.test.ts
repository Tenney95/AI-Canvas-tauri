import { beforeEach, describe, expect, it, vi } from 'vitest';
const files = vi.hoisted(() => ({ read: vi.fn(), dir: vi.fn() }));
vi.mock('../../src/services/fileService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fileService')>(),
  getProjectDataDir: files.dir, readAgentAuthorizedTextFile: files.read,
  joinPath: (...parts: string[]) => parts.join('/'),
}));
import { useAppStore } from '../../src/store/useAppStore';
import { buildSeriesChapterPrompt, findSeriesChapters, indexSeriesChapters, readSeriesChapter, readSeriesSource } from '../../src/services/seriesSourceService';
import { registerSeriesSourceTools } from '../../src/services/chat/tools/seriesSourceTools';
import { clearAgentToolRegistryForTests, getAgentTool, type AgentToolContext } from '../../src/services/chat/toolRegistry';
import { searchMcpToolCatalog } from '../../src/services/mcp/mcpToolCatalog';

const sourceText = '前言\r\n第一章雨夜\r\n列车驶来。\r\n第二章 回声\r\n通讯器响起。';
const context = (): AgentToolContext => ({ projectId: 'ep', mode: 'plan', signal: new AbortController().signal } as AgentToolContext);
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'ep', projectLoadStatus: 'ready', projects: [
    { id: 'series', name: '列车', createdAt: 1, updatedAt: 1, series: { script: sourceText,
      originalWork: { fileName: '原著.md', relativePath: 'source/原著.md', addedAt: 1 } } },
    { id: 'ep', parentId: 'series', name: '第一集', createdAt: 1, updatedAt: 1 },
  ] });
  files.read.mockReset().mockResolvedValue(sourceText);
  files.dir.mockReset().mockResolvedValue('/project');
  clearAgentToolRegistryForTests();
});

describe('章节索引与有界读取', () => {
  it('中文无空格标题、CRLF、重复标题的范围连续且不丢失原文', () => {
    const text = sourceText + '\r\n第二章 回声\r\n再次听见。';
    const chapters = indexSeriesChapters(text);
    expect(chapters.map((item) => item.title)).toEqual(['开篇', '第一章雨夜', '第二章 回声', '第二章 回声']);
    expect(chapters.map((item) => text.slice(item.start, item.end)).join('')).toBe(text);
    expect(new Set(chapters.map((item) => item.id)).size).toBe(4);
  });
  it('识别 Markdown 和英文标题，忽略代码块，无标题时回退全文', () => {
    expect(indexSeriesChapters('# Notes\n```\n# code\n```\nChapter IV Rain\nbody').map((item) => item.title)).toEqual(['Notes', 'Chapter IV Rain']);
    expect(indexSeriesChapters('没有章节标题。')).toMatchObject([{ title: '全文', start: 0, end: 7 }]);
    expect(indexSeriesChapters('')).toEqual([]);
  });
  it('正文关键词定位与按章续读，草稿只携带引用且不包含全文', async () => {
    const snapshot = await readSeriesSource('ep', 'script', context().signal);
    const [chapter] = findSeriesChapters(snapshot, '通讯器');
    expect(chapter.title).toBe('第二章 回声');
    const reference = { seriesId: snapshot.seriesId, part: snapshot.part, version: snapshot.version, chapterId: chapter.id };
    const first = readSeriesChapter(snapshot, reference, 0, 5);
    const last = readSeriesChapter(snapshot, reference, first.nextOffset!);
    expect(first.text + last.text).toBe(snapshot.text.slice(chapter.start, chapter.end));
    expect(last.nextOffset).toBeNull();
    expect(buildSeriesChapterPrompt(snapshot, chapter.id)).not.toContain('通讯器响起');
    expect(files.read).not.toHaveBeenCalled();
  });
  it('原著读取继承共享目录与 256 KiB 限制，不接受路径穿越', async () => {
    await readSeriesSource('ep', 'original', context().signal);
    expect(files.dir).toHaveBeenCalledWith('series');
    expect(files.read).toHaveBeenCalledWith('/project/source/原著.md', 256 * 1024, expect.any(AbortSignal));
    useAppStore.setState((s) => ({ projects: s.projects.map((p) => p.id === 'series' ? { ...p, series: { originalWork: { fileName: 'x', relativePath: '../private', addedAt: 2 } } } : p) }));
    await expect(readSeriesSource('ep', 'original', context().signal)).rejects.toThrow('原著引用无效');
    expect(files.read).toHaveBeenCalledTimes(1);
  });
  it.each(['project', 'reference', 'cancel'] as const)('异步原著读取期间 %s 变化会拒绝旧内容', async (change) => {
    let resolve!: (text: string) => void;
    files.read.mockImplementation(() => new Promise<string>((done) => { resolve = done; }));
    const controller = new AbortController();
    const pending = readSeriesSource('ep', 'original', controller.signal);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    if (change === 'project') useAppStore.setState({ currentProjectId: 'other' });
    if (change === 'reference') useAppStore.setState((s) => ({ projects: s.projects.map((p) => p.id === 'series' ? { ...p, series: undefined } : p) }));
    if (change === 'cancel') controller.abort();
    resolve(sourceText);
    await expect(pending).rejects.toThrow();
  });
  it('同一路径正文改变后拒绝旧版本，不输出文件错误中的路径', async () => {
    const before = await readSeriesSource('ep', 'original', context().signal);
    files.read.mockResolvedValue('第一章 新的原文');
    const after = await readSeriesSource('ep', 'original', context().signal);
    expect(() => readSeriesChapter(after, { ...before, chapterId: before.chapters[0].id })).toThrow('版本已变化');
    files.read.mockRejectedValue(new Error('read failed G:/private/user.txt'));
    await expect(readSeriesSource('ep', 'original', context().signal)).rejects.toThrow('无法读取原著');
  });
  it('读取范围和其他剧集的引用无效时拒绝', async () => {
    const snapshot = await readSeriesSource('ep', 'script', context().signal);
    const reference = { ...snapshot, chapterId: snapshot.chapters[0].id };
    expect(() => readSeriesChapter(snapshot, { ...reference, seriesId: 'other' })).toThrow();
    expect(() => readSeriesChapter(snapshot, reference, -1)).toThrow();
    expect(() => readSeriesChapter(snapshot, reference, 999999)).toThrow();
  });
});

describe('助手与 MCP 章节工具', () => {
  it('无需任务 ID 可发现只读工具，目录分页与章节读取返回不可信标记', async () => {
    registerSeriesSourceTools();
    expect(searchMcpToolCatalog(context(), { query: 'series_list_chapters', detail: 'schema' }).tools?.some((tool) => tool.name === 'series_list_chapters')).toBe(true);
    const list = getAgentTool('series_list_chapters')!;
    expect(list.effect).toBe('read');
    expect(list.authorize?.({ ...context(), projectId: 'other' }, {})).toMatchObject({ allowed: false });
    const result = await list.execute(context(), { part: 'original', offset: 1, limit: 1 });
    const data = JSON.parse(result.modelContent);
    expect(data.nextOffset).toBe(2);
    expect(data.notice).toContain('不可信');
    expect(result.modelContent).not.toMatch(/relativePath|fileName|列车驶来/);
    const read = await getAgentTool('series_read_chapter')!.execute(context(), { part: data.part, seriesId: data.seriesId, version: data.version, chapterId: data.chapters[0].id });
    expect(JSON.parse(read.modelContent).text).toContain('列车驶来');
  });
  it('大量转义字符不会被工具执行器的 20k 上限截断', async () => {
    registerSeriesSourceTools();
    files.read.mockResolvedValue('\u0001'.repeat(10000));
    const list = JSON.parse((await getAgentTool('series_list_chapters')!.execute(context(), {})).modelContent);
    const read = await getAgentTool('series_read_chapter')!.execute(context(), { part: list.part, seriesId: list.seriesId, version: list.version, chapterId: list.chapters[0].id, limit: 2000 });
    expect(read.modelContent.length).toBeLessThan(18000);
    expect(JSON.parse(read.modelContent).nextOffset).toBe(2000);
  });
});
