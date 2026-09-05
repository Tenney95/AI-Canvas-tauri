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
  it('统一使用 28px，并且不再整体缩放扩展按钮', () => {
    expect(source).toContain('--ai-canvas-action-size: 28px;');
    expect(source).toContain('height: var(--ai-canvas-action-size);');
    expect(source).not.toMatch(/legacy-topbar-container"\]\s*\{\s*zoom:/);
  });

  it('扩展图标居中，并隐藏 Image Feed 文字', () => {
    expect(source).toContain('.rgthree-button-icon,');
    expect(source).toContain('align-items: center;');
    expect(source).toContain('.comfyui-button[title^="Show Image Feed"] span');
  });
});
