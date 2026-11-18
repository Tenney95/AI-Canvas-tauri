/**
 * modelProtocolEditor — 回归测试：model protocol editor。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ModelProtocolEditor from '../../src/components/settings/ModelProtocolEditor';
import { getDefaultCustomProtocol } from '../../src/services/ai/modelProtocol';
import type { ProviderModelSelection } from '../../src/types';

function renderEditor(model: ProviderModelSelection, workflowMode = false): string {
  return renderToStaticMarkup(createElement(ModelProtocolEditor, {
    model, workflowMode, apiKey: '', baseUrl: 'https://gateway.example/v1',
    onChange: () => {}, onImageReferenceRequestModeChange: () => {},
    onValidityChange: () => {}, onClose: () => {},
  }));
}

describe('model protocol editor', () => {
  it('keeps an unavailable plugin reference selected and explains the native health requirement', () => {
    const html = renderEditor({ id: 'model', name: 'model', category: 'text', provider: 'p', executionProfile: {
      preset: 'plugin', plugin: { pluginId: 'missing.responses', presetId: 'responses' },
    } });
    expect(html).toContain('value="plugin:missing.responses/responses" disabled="" selected=""');
    expect(html).toContain('协议插件未就绪');
    expect(html).not.toContain('声明式协议 JSON');
  });
  it('opens an unconfigured video model in custom JSON with three explicit APIMart templates', () => {
    const html = renderEditor({ id: 'custom-video', name: 'Video', category: 'video', provider: 'gateway' });
    expect(html).toContain('value="custom" selected=""');
    expect(html).toContain('声明式协议 JSON');
    expect(html).toContain('真实试跑配置');
    expect(html).toContain('文生视频（无参考素材）');
    expect(html).toContain('首尾帧（不混用参考素材）');
    expect(html).toContain('多参考素材（不使用首尾帧）');
    expect(html).not.toContain('https://cdn.example/reference');
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>JSON</);
    for (const name of ['SD2.0', 'SD2.5', 'H3']) {
      expect(html).toContain(`填入 ${name} 视频预设（APIMart）`);
    }
  });

  it('preserves an existing named video protocol instead of selecting custom JSON', () => {
    const html = renderEditor({ id: 'video', name: 'Video', category: 'video', provider: 'gateway',
      executionProfile: { preset: 'agnes-video' } });
    expect(html).toContain('value="agnes-video" selected=""');
    expect(html).not.toContain('声明式协议 JSON');
  });

  it.each(['image', 'text'] as const)('shows only JSON editing for a custom %s protocol', (category) => {
    const html = renderEditor({
      id: `${category}-model`, name: `${category} model`, category, provider: 'gateway',
      executionProfile: { preset: 'custom', protocol: getDefaultCustomProtocol(category) },
    });
    expect(html).toContain('声明式协议 JSON');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('执行模式');
    expect(html).toContain('本地请求预览');
    expect(html).toContain('示例变量 JSON');
    expect(html).toContain('响应示例与路径校验');
  });

  it('keeps a named image preset compact inside the model settings', () => {
    const html = renderEditor({
      id: 'gateway-image', name: 'GPT Image', category: 'image', provider: 'gateway',
      executionProfile: { preset: 'gpt-image-gateway-json' },
    });
    expect(html).toContain('GPT Image');
    expect(html).not.toContain('声明式协议 JSON');
    expect(html).not.toContain('执行模式');
  });

  it.each(['anthropic-chat', 'openai-responses'] as const)('offers native adapters for a text model (%s)', (preset) => {
    const html = renderEditor({
      id: 'chat-model', name: 'Chat model', category: 'text', provider: 'gateway',
      executionProfile: { preset },
    });
    expect(html).toContain('OpenAI Responses');
    expect(html).toContain(`value="${preset}" selected=""`);
    expect(html).toContain('Anthropic Messages');
    expect(html).toContain('Google Gemini generateContent');
    expect(html).not.toContain('声明式协议 JSON');
  });

  it('keeps workflow form editing and the actual binary download task ID variable', () => {
    const protocol = getDefaultCustomProtocol('video');
    protocol.submit.path = '/videos';
    protocol.response.taskIdPath = 'id';
    protocol.poll!.path = '/videos/{{submit.id}}';
    protocol.poll!.response.result = {
      download: { method: 'GET', path: '/videos/{{submit.id}}/content' }, mimeType: 'video/mp4',
    };
    const html = renderEditor({ id: 'video', name: 'Video', category: 'video', provider: 'gateway',
      executionProfile: { preset: 'custom', protocol } }, true);
    expect(html).toContain('结果下载路径（GET）');
    expect(html).toContain('{{submit.id}}');
    expect(html).toContain('复制给AI修改');
    expect(html).not.toContain('视频 JSON 预设');
  });
});
