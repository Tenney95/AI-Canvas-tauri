import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerMediaAgentTools } from '../../../src/services/chat/tools/mediaTools';
import {
  clearAgentToolRegistryForTests,
  prepareAgentToolCall,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';

const context: Omit<AgentToolContext, 'signal'> = {
  taskId: 'task-media',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  mode: 'collaborative',
};

beforeEach(() => {
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    nodes: [{
      id: 'n1',
      type: 'source-image',
      position: { x: 0, y: 0 },
      data: { type: 'source-image', label: '首帧', imageUrl: 'asset://first-frame.png' },
    }],
    projects: [{
      id: 'project-1',
      name: '测试项目',
      createdAt: 1,
      updatedAt: 1,
      settings: {
        generation: {
          videoAspectRatio: '16:9',
          videoResolution: '1080p',
          videoDuration: 10,
        },
      },
    }],
  });
  registerMediaAgentTools();
});

describe('media_generate display parameters', () => {
  it('uses the project default media model when modelRef is omitted', () => {
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        settings: { ...project.settings, defaultModels: { video: 'general/video-default' } },
      })),
    }));
    const prepared = prepareAgentToolCall({
      callId: 'call-default',
      toolId: 'media_generate',
      input: { kind: 'video', prompt: '普通镜头', deliveryMode: 'chat' },
    }, context);

    expect(prepared).toMatchObject({ ok: true });
    if (prepared.ok) expect(prepared.prepared.input).toMatchObject({ modelRef: 'general/video-default' });
  });

  it('autonomous routing ranks user model descriptions and overrides the default', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          custom: { name: '自定义', apiKey: 'secret', baseUrl: 'https://example.com' },
        },
        generalModels: [
          { id: 'video-default', name: '通用视频', modelId: 'video-a', category: 'video', providerConfigId: 'custom' },
          { id: 'video-anime', name: '动画专用', description: '擅长二次元动画与运镜', modelId: 'video-b', category: 'video', providerConfigId: 'custom' },
        ],
      },
      projects: state.projects.map((project) => ({
        ...project,
        settings: {
          ...project.settings,
          defaultModels: { video: 'general/video-default' },
          modelAutoRouting: true,
        },
      })),
    }));
    const prepared = prepareAgentToolCall({
      callId: 'call-auto',
      toolId: 'media_generate',
      input: { kind: 'video', prompt: '二次元 动画 运镜', deliveryMode: 'chat' },
    }, { ...context, mode: 'autonomous' });

    expect(prepared).toMatchObject({ ok: true });
    if (prepared.ok) expect(prepared.prepared.input).toMatchObject({ modelRef: 'general/video-anime' });
  });

  it('locks project video defaults before approval and exposes them in the display', () => {
    const prepared = prepareAgentToolCall({
      callId: 'call-1',
      toolId: 'media_generate',
      input: {
        kind: 'video',
        prompt: '基于 @{n1:首帧} 生成向前推进镜头',
        deliveryMode: 'canvas',
      },
    }, context);

    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    expect(prepared.prepared.input).toMatchObject({
      aspectRatio: '16:9',
      resolution: '1080p',
      duration: 10,
    });
    expect(prepared.prepared.definition.buildInputDisplay?.(
      prepared.prepared.input,
      context,
    )).toMatchObject({
      fields: expect.arrayContaining([
        { label: '画面比例', value: '16:9', source: 'resolved' },
        { label: '分辨率', value: '1080p', source: 'resolved' },
        { label: '时长', value: '10 秒', source: 'resolved' },
      ]),
      references: [{ kind: 'node', id: 'n1', label: '首帧', mediaKind: 'image' }],
    });
  });

  it('keeps explicit video parameters instead of replacing them with project defaults', () => {
    const prepared = prepareAgentToolCall({
      callId: 'call-2',
      toolId: 'media_generate',
      input: {
        kind: 'video',
        prompt: '竖屏人物镜头',
        deliveryMode: 'chat',
        aspectRatio: '9:16',
        resolution: '720p',
        duration: 6,
      },
    }, context);

    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    expect(prepared.prepared.input).toMatchObject({
      aspectRatio: '9:16',
      resolution: '720p',
      duration: 6,
    });
  });

  it('keeps omitted custom API video fields unspecified and accepts model-specific values', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          custom: { name: '自定义', apiKey: '', baseUrl: 'https://gateway.example.com' },
        },
        generalModels: [{
          id: 'video-custom',
          name: '自定义视频',
          modelId: 'video-custom-upstream',
          category: 'video',
          providerConfigId: 'custom',
          videoCapability: {
            ratios: ['7:4'],
            resolutions: ['2K'],
            maxDuration: 30,
          },
        }],
      },
      projects: state.projects.map((project) => ({
        ...project,
        settings: { ...project.settings, defaultModels: { video: 'general/video-custom' } },
      })),
    }));

    const omitted = prepareAgentToolCall({
      callId: 'call-custom-default',
      toolId: 'media_generate',
      input: { kind: 'video', prompt: '自定义镜头', deliveryMode: 'chat' },
    }, context);
    expect(omitted).toMatchObject({ ok: true });
    if (omitted.ok) {
      expect(omitted.prepared.input).toMatchObject({ modelRef: 'general/video-custom' });
      expect(omitted.prepared.input).not.toHaveProperty('aspectRatio');
      expect(omitted.prepared.input).not.toHaveProperty('resolution');
      expect(omitted.prepared.input).not.toHaveProperty('duration');
    }

    const explicit = prepareAgentToolCall({
      callId: 'call-custom-explicit',
      toolId: 'media_generate',
      input: {
        kind: 'video',
        prompt: '自定义镜头',
        deliveryMode: 'chat',
        aspectRatio: '7:4',
        resolution: '2K',
        duration: 30,
      },
    }, context);
    expect(explicit).toMatchObject({ ok: true });
    if (explicit.ok) {
      expect(explicit.prepared.input).toMatchObject({
        aspectRatio: '7:4',
        resolution: '2K',
        duration: 30,
      });
    }
  });
});
