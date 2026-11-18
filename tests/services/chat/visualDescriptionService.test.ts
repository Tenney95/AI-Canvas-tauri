/**
 * visualDescriptionService — 回归测试：project visual description cache。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateText = vi.hoisted(() => vi.fn(async () => '一只橘猫坐在窗边，逆光，浅景深'));
vi.mock('../../../src/services/ai/generateText', () => ({ generateText }));

import { useAppStore } from '../../../src/store/useAppStore';
import {
  getOrCreateVisualDescription,
  resolveProjectVisionModel,
} from '../../../src/services/chat/visualDescriptionService';

beforeEach(() => {
  generateText.mockClear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState((state) => ({
    currentProjectId: 'project-visual-cache',
    projects: [{
      id: 'project-visual-cache',
      name: '视觉缓存',
      createdAt: 1,
      updatedAt: 1,
      settings: { visionModelId: 'general/vision-model' },
    }],
    config: {
      ...state.config,
      providers: {
        ...state.config.providers,
        vision: { name: 'Vision', apiKey: 'secret', baseUrl: 'https://vision.example/v1' },
      },
      generalModels: [{
        id: 'vision-model',
        name: '视觉模型',
        modelId: 'vision-vendor-model',
        category: 'text',
        providerConfigId: 'vision',
        inputModalities: ['text', 'image'],
      }],
    },
  }));
});

describe('project visual description cache', () => {
  it('uses the explicit project vision model', () => {
    expect(resolveProjectVisionModel('project-visual-cache')).toEqual({
      model: 'general/vision-model',
      provider: 'general',
    });
  });

  it('falls back to an active vision model when the saved preference uses a retired connection', () => {
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project, settings: { ...project.settings, visionModelId: 'general/old-vision' },
      })),
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'old-sora': { name: 'Sora2U', catalogId: 'sora2u', apiKey: 'synthetic-key', baseUrl: 'https://sora2u.com' },
        },
        generalModels: [{
          id: 'old-vision', name: '旧视觉模型', modelId: 'old-vision-model', category: 'text',
          providerConfigId: 'old-sora', inputModalities: ['text', 'image'],
        }, ...(state.config.generalModels ?? [])],
      },
    }));

    expect(resolveProjectVisionModel('project-visual-cache')).toEqual({
      model: 'general/vision-model', provider: 'general',
    });
  });

  it.each([
    ['deepseek-flash', undefined, true],
    ['DeepSeek-V4.1-Flash', undefined, true],
    ['deepseek-flash', ['text'], false],
    ['deepseek-v4-pro', undefined, false],
  ] as const)('resolves project assistant %s with declared modalities %j', (modelId, inputModalities, supported) => {
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        settings: { defaultModels: { text: 'general/vision-model' } },
      })),
      config: {
        ...state.config,
        assistantModelId: 'general/unavailable-model',
        providers: { vision: state.config.providers.vision },
        generalModels: [{
          id: 'vision-model',
          name: 'DeepSeek',
          modelId,
          category: 'text',
          providerConfigId: 'vision',
          ...(inputModalities ? { inputModalities: [...inputModalities] } : {}),
        }],
      },
    }));

    expect(resolveProjectVisionModel('project-visual-cache')).toEqual(supported
      ? { model: 'general/vision-model', provider: 'general' }
      : null);
  });

  it('binds descriptions to content fingerprints and reuses unchanged images', async () => {
    const imageDataUrl = 'data:image/png;base64,Q0FDSEU=';
    const first = await getOrCreateVisualDescription({
      projectId: 'project-visual-cache',
      imageDataUrl,
    });
    const second = await getOrCreateVisualDescription({
      projectId: 'project-visual-cache',
      imageDataUrl,
    });

    expect(first.description).toContain('橘猫');
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain(imageDataUrl);
  });
});
