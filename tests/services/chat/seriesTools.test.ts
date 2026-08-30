/**
 * 剧集工具：读剧本分段回传、按模型给的清单批量建分集画布。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileMocks = vi.hoisted(() => ({
  getProjectDataDir: vi.fn(async () => '/data/moon'),
  joinPath: (...parts: string[]) => parts.join('/'),
  readAgentAuthorizedTextFile: vi.fn(async () => '原著正文'),
  saveAgentTextOutput: vi.fn(),
}));

vi.mock('../../../src/services/fileService', () => fileMocks);

import { useAppStore } from '../../../src/store/useAppStore';
import { registerSeriesAgentTools } from '../../../src/services/chat/tools/seriesTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';

function context(): AgentToolContext {
  return { projectId: 'ep-1', signal: new AbortController().signal } as AgentToolContext;
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    projectLoadStatus: 'ready',
    currentProjectId: 'ep-1',
    projects: [
      {
        id: 'series',
        name: '月球列车',
        createdAt: 1,
        updatedAt: 1,
        dataFolder: 'moon',
        series: {
          script: '第一集：站台等待。第二集：通讯器里的声音。',
          originalWork: { fileName: '原著.txt', relativePath: '原著.txt', addedAt: 1 },
        },
      },
      { id: 'ep-1', name: '第 1 集', createdAt: 1, updatedAt: 1, dataFolder: 'moon', parentId: 'series', episodeNo: 1 },
    ],
  });
  fileMocks.readAgentAuthorizedTextFile.mockClear();
});

describe('series_read', () => {
  it('把剧本正文当不可信资料回传，并说明还剩多少', async () => {
    const unregisters = registerSeriesAgentTools();
    const definition = getAgentTool('series_read');

    expect(definition?.effect).toBe('read');
    const result = await definition!.execute(context(), {});

    expect(result.status).toBe('success');
    expect(result.modelContent).toContain('不可信资料');
    expect(result.modelContent).toContain('第一集：站台等待');
    expect(result.modelContent).toContain('已读到结尾');
    unregisters.forEach((unregister) => unregister());
  });

  it('读原著时按剧集项目定位共享目录里的文件', async () => {
    const unregisters = registerSeriesAgentTools();
    const definition = getAgentTool('series_read');

    const result = await definition!.execute(context(), { part: 'original' });

    expect(fileMocks.getProjectDataDir).toHaveBeenCalledWith('series');
    expect(fileMocks.readAgentAuthorizedTextFile).toHaveBeenCalledWith(
      '/data/moon/原著.txt',
      expect.any(Number),
      expect.anything(),
    );
    expect(result.modelContent).toContain('原著正文');
    unregisters.forEach((unregister) => unregister());
  });

  it('拒绝读取其他项目的剧集', async () => {
    const unregisters = registerSeriesAgentTools();
    const definition = getAgentTool('series_read');

    expect(definition?.authorize?.({ projectId: 'other' } as AgentToolContext, {}))
      .toEqual(expect.objectContaining({ allowed: false }));
    unregisters.forEach((unregister) => unregister());
  });
});

describe('series_split_episodes', () => {
  it('按清单接着现有集号建分集，并写入每集大纲', async () => {
    const addEpisodes = vi.fn(async (entries: Array<{ name?: string; outline?: string }>) => {
      const created = entries.map((entry, index) => ({
        id: `new-${index}`,
        name: entry.name ?? `第 ${index + 2} 集`,
        createdAt: 1,
        updatedAt: 1,
        parentId: 'series',
        episodeNo: index + 2,
        episodeOutline: entry.outline,
      }));
      useAppStore.setState((state) => ({ projects: [...state.projects, ...created] }));
      return created.map((episode) => episode.id);
    });
    useAppStore.setState({ addEpisodes });

    const unregisters = registerSeriesAgentTools();
    const definition = getAgentTool('series_split_episodes');

    expect(definition?.effect).toBe('canvas_write');
    const result = await definition!.execute(context(), {
      episodes: [
        { title: '通讯器', outline: '林夏听见十年前的自己' },
        { outline: '列车终于进站' },
      ],
    });

    expect(addEpisodes).toHaveBeenCalledWith([
      { name: '通讯器', outline: '林夏听见十年前的自己' },
      { name: undefined, outline: '列车终于进站' },
    ]);
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent).created).toEqual([
      { episodeNo: 2, name: '通讯器' },
      { episodeNo: 3, name: '第 3 集' },
    ]);
    unregisters.forEach((unregister) => unregister());
  });

  it('一集都没建成时报错且可重试', async () => {
    useAppStore.setState({ addEpisodes: vi.fn(async () => []) });
    const unregisters = registerSeriesAgentTools();
    const definition = getAgentTool('series_split_episodes');

    const result = await definition!.execute(context(), { episodes: [{ outline: '大纲' }] });

    expect(result.status).toBe('error');
    expect(result.retryable).toBe(true);
    unregisters.forEach((unregister) => unregister());
  });
});

describe('episode creative tools', () => {
  it('分别读取本集正文和结构化创作要点', async () => {
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => (
        project.id === 'ep-1'
          ? {
              ...project,
              episodeOutline: '林夏在站台等待。',
              episodeScript: '1-1 站台 外 夜\n林夏：这趟车迟到了十年。',
              episodeCreative: { task: '让林夏登上列车', endingHook: '车门后站着十年前的自己' },
            }
          : project
      )),
    }));
    const unregisters = registerSeriesAgentTools();
    const definition = getAgentTool('episode_read');

    expect(definition?.effect).toBe('read');
    const scriptResult = await definition!.execute(context(), { episodeId: 'ep-1', part: 'script' });
    const creativeResult = await definition!.execute(context(), { episodeId: 'ep-1', part: 'creative' });

    expect(scriptResult.modelContent).toContain('不可信资料');
    expect(scriptResult.modelContent).toContain('这趟车迟到了十年');
    expect(creativeResult.modelContent).toContain('让林夏登上列车');
    expect(creativeResult.modelContent).toContain('不可信创作素材');
    unregisters.forEach((unregister) => unregister());
  });

  it('更新本集正文时不会复用大纲字段', async () => {
    const updateEpisodeCreative = vi.fn(async () => true);
    useAppStore.setState({ updateEpisodeCreative });
    const unregisters = registerSeriesAgentTools();
    const definition = getAgentTool('episode_update_script');

    expect(definition?.effect).toBe('file_write');
    const result = await definition!.execute(context(), {
      episodeId: 'ep-1',
      script: '1-1 站台 外 夜\n林夏：开门。',
    });

    expect(updateEpisodeCreative).toHaveBeenCalledWith('ep-1', {
      script: '1-1 站台 外 夜\n林夏：开门。',
    });
    expect(result.status).toBe('success');
    expect(result.summary).toContain('正文');
    unregisters.forEach((unregister) => unregister());
  });

  it('更新一个创作字段时保留其他字段、大纲和正文', async () => {
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => (
        project.id === 'ep-1'
          ? {
              ...project,
              episodeOutline: '原大纲',
              episodeScript: '原正文',
              episodeCreative: {
                task: '登上列车',
                coreConflict: '林夏与站长争夺车票',
                endingHook: '车门打开',
              },
            }
          : project
      )),
    }));
    const updateEpisodeCreative = vi.fn(async () => true);
    useAppStore.setState({ updateEpisodeCreative });
    const unregisters = registerSeriesAgentTools();
    const definition = getAgentTool('episode_update_creative_field');

    expect(definition?.effect).toBe('file_write');
    const result = await definition!.execute(context(), {
      episodeId: 'ep-1',
      field: 'endingHook',
      value: '车门后站着十年前的林夏',
    });

    expect(updateEpisodeCreative).toHaveBeenCalledWith('ep-1', {
      creative: {
        task: '登上列车',
        coreConflict: '林夏与站长争夺车票',
        endingHook: '车门后站着十年前的林夏',
      },
    });
    expect(result.status).toBe('success');
    unregisters.forEach((unregister) => unregister());
  });

  it('把情节点候选规范为逐条数组', async () => {
    const updateEpisodeCreative = vi.fn(async () => true);
    useAppStore.setState({ updateEpisodeCreative });
    const unregisters = registerSeriesAgentTools();
    const definition = getAgentTool('episode_update_creative_field');

    await definition!.execute(context(), {
      episodeId: 'ep-1',
      field: 'beats',
      value: '1. 林夏抢到车票\n- 站长封锁站台\n3、列车提前进站',
    });

    expect(updateEpisodeCreative).toHaveBeenCalledWith('ep-1', {
      creative: { beats: ['林夏抢到车票', '站长封锁站台', '列车提前进站'] },
    });
    unregisters.forEach((unregister) => unregister());
  });
});
