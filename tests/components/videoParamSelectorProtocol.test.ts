import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modelProtocolUsesVariable } from '../../src/services/ai/modelProtocol';
import { analyzeModelProtocolExamples } from '../../src/services/ai/modelProtocolImport';
import { resolveVideoSubmissionControls } from '../../src/services/ai/videoRequestResolver';
import VideoParamSelector, {
  resolveGeneralVideoControlSupport,
  resolveGeneralVideoModel,
  resolveGeneralVideoParameterDisplayState,
} from '../../src/components/nodes/shared/VideoParamSelector';

describe('ComfyUI 时长显示与提交一致', () => {
  it.each([
    { name: '没有保存秒数和帧数', controls: {}, seconds: 5 },
    { name: '明确选择 3 秒', controls: { seedanceDuration: 3 }, seconds: 3 },
    { name: '旧节点保留 77 帧', controls: { videoFrames: 77, videoFps: 24 }, seconds: 3 },
    { name: '3 秒优先于旧的 121 帧', controls: { seedanceDuration: 3, videoFrames: 121 }, seconds: 3 },
  ])('$name', ({ controls, seconds }) => {
    const props = { provider: 'comfyui', selectedModel: 'builtin-minimax-h3-i2v', ...controls };
    const html = renderToStaticMarkup(createElement(VideoParamSelector, props));
    const submitted = resolveVideoSubmissionControls({ ...props, workflowId: props.selectedModel });

    expect(submitted.seedanceDuration).toBe(seconds);
    expect(html).toContain(`时长${seconds}s`);
  });
});

describe('VideoParamSelector 自定义协议参数识别', () => {
  it('保留导入协议的比例、分辨率和秒数变量', () => {
    const imported = analyzeModelProtocolExamples({
      submitRequest: `
curl https://api.paipu.net/v1/videos \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "future-provider-video-model",
    "prompt": "cinematic train station",
    "duration": 5,
    "aspect_ratio": "16:9",
    "resolution": "720p"
  }'`,
      submitResponse: '{"id":"task_1","status":"queued"}',
      pollRequest: 'curl https://api.paipu.net/v1/videos/task_1 -H "Authorization: Bearer YOUR_API_KEY"',
      pollResponse: '{"id":"task_1","status":"completed","metadata":{"url":"https://cdn.example/video.mp4"}}',
    });
    const source = JSON.stringify(imported.protocol);

    expect(modelProtocolUsesVariable(source, 'aspectRatio', 'seedanceRatio')).toBe(true);
    expect(modelProtocolUsesVariable(source, 'resolution', 'seedanceResolution')).toBe(true);
    expect(modelProtocolUsesVariable(source, 'duration', 'seedanceDuration')).toBe(true);
    expect(modelProtocolUsesVariable(source, 'videoFrames')).toBe(false);
  });

  it('兼容模板变量花括号内的空格', () => {
    expect(modelProtocolUsesVariable('{"resolution":"{{ seedanceResolution }}"}', 'seedanceResolution'))
      .toBe(true);
  });

  it('兼容节点保存的内部 ID、真实模型 ID 和 Provider 前缀引用', () => {
    const models = [{
      id: 'provider-custom-abc123',
      name: 'H3video 2K',
      modelId: 'lec-h3video-2k',
      category: 'video' as const,
      providerConfigId: 'custom-video',
      videoCapability: { ratios: ['16:9'], frameRates: [24] },
    }];

    expect(resolveGeneralVideoModel(models, 'general/provider-custom-abc123', 'general'))
      .toBe(models[0]);
    expect(resolveGeneralVideoModel(models, 'lec-h3video-2k', 'custom-video'))
      .toBe(models[0]);
    expect(resolveGeneralVideoModel(models, 'custom-video/lec-h3video-2k', 'custom-video'))
      .toBe(models[0]);
  });

  it('通用视频控件只暴露 capability 明确声明的能力', () => {
    expect(resolveGeneralVideoControlSupport({
      ratios: ['16:9'],
      frameRates: [24],
      supportsAudio: false,
    })).toEqual({
      resolution: false,
      ratio: true,
      duration: false,
      frameRate: true,
      audio: false,
    });
  });

  it('缺少 capability 时保持未知，不套用 Seedance 参数', () => {
    expect(resolveGeneralVideoControlSupport(undefined)).toEqual({
      resolution: false,
      ratio: false,
      duration: false,
      frameRate: false,
      audio: false,
    });
  });

  it('可选枚举和单侧范围不会被误当成模型默认值', () => {
    expect(resolveGeneralVideoParameterDisplayState({
      resolutions: ['2K'],
      ratios: ['7:4'],
      frameRates: [30],
      minDuration: 10,
      supportsAudio: true,
    }, {})).toEqual({
      resolution: undefined,
      ratio: undefined,
      duration: undefined,
      frameRate: undefined,
      generateAudio: undefined,
    });

    expect(resolveGeneralVideoParameterDisplayState({
      defaultResolution: '2K',
      defaultRatio: '7:4',
      defaultFrameRate: 30,
      defaultDuration: 20,
    }, {})).toMatchObject({
      resolution: '2K',
      ratio: '7:4',
      frameRate: 30,
      duration: 20,
    });
  });
});
