import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// bridge.js 是原样注入 ComfyUI 页面的 IIFE，没法 import，直接把 inferCategory 抠出来求值
const source = readFileSync(new URL('../../src-tauri/src/media/comfyui/bridge.js', import.meta.url), 'utf8');
const match = source.match(/const inferCategory = \(output\) => \{[\s\S]*?\r?\n {2}\};/);
if (!match) throw new Error('bridge.js 里找不到 inferCategory');
const inferCategory = new Function(`${match[0]}\nreturn inferCategory;`)() as (
  output: Record<string, unknown>,
) => string;

const baseNameMatch = source.match(/const workflowBaseName = \(value\) =>[\s\S]*?\.trim\(\);/);
if (!baseNameMatch) throw new Error('bridge.js 里找不到 workflowBaseName');
const workflowBaseName = new Function(`${baseNameMatch[0]}\nreturn workflowBaseName;`)() as (
  value: unknown,
) => string;

const itemNameMatch = source.match(/const workflowItemName = \(workflow\) => workflowBaseName\([\s\S]*?\r?\n {2}\);/);
if (!itemNameMatch) throw new Error('bridge.js 里找不到 workflowItemName');
const workflowItemName = new Function(
  'workflowBaseName',
  `${itemNameMatch[0]}\nreturn workflowItemName;`,
)(workflowBaseName) as (workflow: unknown) => string;

describe('bridge.js workflowBaseName', () => {
  it('去掉目录、扩展名和 ComfyUI 自动加的重名后缀', () => {
    expect(workflowBaseName('minimax-h3-i2v.json')).toBe('minimax-h3-i2v');
    expect(workflowBaseName('workflows/minimax-h3-i2v (3)')).toBe('minimax-h3-i2v');
    expect(workflowBaseName('C:\\wf\\minimax-h3-i2v (12).json')).toBe('minimax-h3-i2v');
    expect(workflowBaseName('')).toBe('');
    expect(workflowBaseName(undefined)).toBe('');
  });

  it('从当前工作流对象直接读取标签名称', () => {
    expect(workflowItemName({ filename: 'Z-Image-turbo文生图.json' })).toBe('Z-Image-turbo文生图');
    expect(workflowItemName({ path: 'workflows/角色立绘 (2).json' })).toBe('角色立绘');
    expect(workflowItemName({ name: '场景概念图' })).toBe('场景概念图');
    expect(workflowItemName('直接传入的工作流.json')).toBe('直接传入的工作流');
  });
});

describe('bridge.js inferCategory', () => {
  it('图生视频里的音频/文本中间节点不再把分类带偏', () => {
    expect(inferCategory({
      '114': { class_type: 'LoadImage', inputs: {} },
      '105': { class_type: 'MiniMaxH3PromptEnhancerLegacyQwenLLM', inputs: {} },
      '120': { class_type: 'LoadAudio', inputs: {} },
      '130': { class_type: 'MiniMaxHailuoVideo', inputs: { image: ['114', 0], prompt: ['105', 0], audio: ['120', 0] } },
      '140': { class_type: 'SaveVideo', inputs: { video: ['130', 0] } },
    })).toBe('ai-video');
  });

  it('产出是音频的工作流仍然归到音频', () => {
    expect(inferCategory({
      '1': { class_type: 'LoadAudio', inputs: {} },
      '2': { class_type: 'IndexTTS', inputs: { reference: ['1', 0] } },
      '3': { class_type: 'SaveAudio', inputs: { audio: ['2', 0] } },
    })).toBe('ai-audio');
  });

  it('文生图工作流归到图像', () => {
    expect(inferCategory({
      '4': { class_type: 'CheckpointLoaderSimple', inputs: {} },
      '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1] } },
      '3': { class_type: 'KSampler', inputs: { model: ['4', 0], positive: ['6', 0] } },
      '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
    })).toBe('ai-image');
  });

  it('全是中间节点（找不到产出节点）时退回全量判断', () => {
    expect(inferCategory({
      '1': { class_type: 'LoadImage', inputs: { self: ['1', 0] } },
    })).toBe('ai-image');
  });
});

describe('bridge.js actionbar tiny 尺寸', () => {
  it('统一使用 24px，并且不再整体缩放扩展按钮', () => {
    expect(source).toContain('--ai-canvas-action-size: 24px;');
    expect(source).not.toContain('--ai-canvas-action-size: 28px;');
    expect(source).toContain('height: var(--ai-canvas-action-size);');
    expect(source).toContain('max-height: var(--ai-canvas-action-size);');
    expect(source).not.toMatch(/legacy-topbar-container"\]\s*\{\s*zoom:/);
  });

  it('按钮内容居中并按文字、图标类型优化 padding', () => {
    expect(source).toContain('--ai-canvas-action-icon-size: 14px;');
    expect(source).toContain('display: inline-flex;');
    expect(source).toContain('justify-content: center;');
    expect(source).toContain('padding: 0 6px;');
    expect(source).toContain('padding: 0;');
    expect(source).toContain('line-height: 1;');
  });

  it('所有可见控件与 Crystools 监视块同步 24px 高度', () => {
    expect(source).toContain('.actionbar-container > [data-testid="action-bar-buttons"],');
    expect(source).toContain('.actionbar-container .actionbar [data-pc-section="contentcontainer"],');
    expect(source).toContain('.crystools-monitors-container,');
    expect(source).toContain('.crystools-monitor,');
    expect(source).toContain('.crystools-content {');
    expect(source).toContain('.actionbar-container .batch-count,');
  });

  it('批次与运行模式箭头使用专用小尺寸，扩展图标保持居中', () => {
    expect(source).toContain('--ai-canvas-action-chevron-width: 7px;');
    expect(source).toContain('--ai-canvas-action-chevron-height: 4px;');
    expect(source).toContain('.actionbar-container .batch-count button > svg,');
    expect(source).toContain('[data-testid="queue-mode-menu-trigger"] > svg');
    expect(source).toContain('.rgthree-button-icon,');
    expect(source).toContain('align-items: center;');
    expect(source).toContain('.actionbar-container .queue-button-group');
    expect(source).toContain('.actionbar-container .batch-count > div');
    expect(source).toContain('.comfyui-button[aria-label^="Show Image Feed"] span');
  });

  it('管理器按钮只保留图标，并使用稳定的 aria-label 匹配', () => {
    expect(source).toContain('.comfyui-button[aria-label="ComfyUI Manager"] {');
    expect(source).toContain('.comfyui-button[aria-label="ComfyUI Manager"] span {');
    expect(source).not.toContain('.comfyui-button[title="ComfyUI Manager"]');
  });

  it('图像流按钮只保留图标，并兼容本地化标题', () => {
    expect(source).toContain('.comfyui-button[aria-label^="Show Image Feed"] {');
    expect(source).toContain('.comfyui-button[aria-label^="Show Image Feed"] span {');
    expect(source).not.toContain('.comfyui-button[title^="Show Image Feed"]');
  });

  it('K Monitor 按钮去掉 Monitor 文字，只保留 K 标识', () => {
    expect(source).toContain('button.comfyui-button[aria-label$="Monitor"] span,');
    expect(source).toContain('button.comfyui-button[title$="Monitor"] span {');
    expect(source).toMatch(/button\.comfyui-button\[title\$="Monitor"\] span\s*\{[^}]*display: none !important;/s);
    expect(source).toContain('button.comfyui-button[aria-label$="Monitor"]::before,');
    expect(source).toContain('content: "𝙆";');
  });

  it('Crystools 进度条与占用率数值都在进度块内靠右显示', () => {
    expect(source).toMatch(/\.crystools-slider\s*\{[^}]*right: 0;[^}]*left: auto;/s);
    expect(source).toMatch(/\.crystools-label\s*\{[^}]*justify-content: flex-end;/s);
    expect(source).toMatch(/\.crystools-label\s*\{[^}]*text-align: right;/s);
    expect(source).toMatch(/\.crystools-label\s*\{[^}]*padding-right: 3px;/s);
  });
});

describe('bridge.js ComfyUI 左侧工具栏', () => {
  it('隐藏按钮文字标题，只保留图标', () => {
    expect(source).toMatch(/\.side-toolbar-container \.side-bar-button-label\s*\{[^}]*display: none !important;/s);
  });
});

describe('bridge.js ComfyUI 顶部用户入口', () => {
  it('隐藏已登录与未登录用户按钮，且不影响 AI Canvas 窗口控制按钮', () => {
    expect(source).toMatch(/\[data-testid="current-user-button"\],\s*\[data-testid="login-button"\]\s*\{[^}]*display: none !important;/s);
    expect(source).toContain('class="ai-canvas-window-button" data-window-action="minimize"');
    expect(source).toContain('class="ai-canvas-window-button" data-window-action="maximize"');
    expect(source).toContain('class="ai-canvas-window-button ai-canvas-close" data-window-action="close"');
  });
});
