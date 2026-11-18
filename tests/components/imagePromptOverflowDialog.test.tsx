import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImagePromptOverflowView } from '../../src/services/imagePromptOverflowService';

const driver = vi.hoisted(() => ({
  index: 0, slots: [] as unknown[], view: null as ImagePromptOverflowView | null,
  truncate: vi.fn(), close: vi.fn(), optimize: vi.fn(), apply: vi.fn(), preview: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useSyncExternalStore: () => driver.view,
  useState: <T,>(initial: T) => {
    const index = driver.index++;
    if (!(index in driver.slots)) driver.slots[index] = initial;
    return [driver.slots[index], (next: T) => { driver.slots[index] = next; }];
  },
}));
vi.mock('../../src/services/imagePromptOverflowService', () => ({
  getImagePromptOverflow: () => driver.view, subscribeImagePromptOverflow: vi.fn(),
  chooseImagePromptTruncation: driver.truncate, closeImagePromptOverflow: driver.close,
  optimizeImagePrompt: driver.optimize, applyImagePromptOptimization: driver.apply,
  updateImagePromptOverflowPreview: driver.preview,
}));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'modal' }));
vi.mock('../../src/components/shared/PopupCloseButton', () => ({ default: 'close' }));
vi.mock('../../src/components/nodes/shared/ModelSelector', () => ({ default: 'model-selector' }));
vi.mock('../../src/i18n', () => ({ t: (text: string) => text, useT: () => (text: string) => text }));

import ImagePromptOverflowDialog from '../../src/components/nodes/shared/ImagePromptOverflowDialog';
import { ImagePromptOverflowError } from '../../src/services/ai/imagePromptLimits';

interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}
function render() {
  driver.index = 0;
  const element = ImagePromptOverflowDialog();
  if (!element) return [];
  const content = element.type as (props: { view: ImagePromptOverflowView }) => unknown;
  return elements(content(element.props));
}
function button(tree: Element[], label: string) {
  return tree.find((element) => element.type === 'button' && element.props.children === label)!.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  driver.slots = [];
  driver.view = { nodeId: 'image', textModelId: 'general/text',
    overflow: new ImagePromptOverflowError('gpt-image-2.6', '图'.repeat(38_956), 32_000, 12),
    busy: false, preview: '', error: '' };
});

describe('超长图片提示词选择弹窗', () => {
  it('裁剪按钮必须先明确勾选内容丢失提示', () => {
    let tree = render();
    expect(button(tree, '确认裁剪并生成').disabled).toBe(true);
    expect(driver.truncate).not.toHaveBeenCalled();
    const checkbox = tree.find((element) => element.type === 'input' && element.props.type === 'checkbox')!;
    (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    tree = render();
    expect(button(tree, '确认裁剪并生成').disabled).toBe(false);
    (button(tree, '确认裁剪并生成').onClick as () => void)();
    expect(driver.truncate).toHaveBeenCalledOnce();
  });

  it('优化进行中和结果超长时不允许使用预览生图', () => {
    driver.view = { ...driver.view!, preview: '还在生成', busy: true };
    let tree = render();
    expect(button(tree, '使用优化结果继续生图').disabled).toBe(true);
    expect(button(tree, '返回手动精简').disabled).toBe(true);
    driver.view = { ...driver.view, busy: false, preview: '图'.repeat(32_001) };
    tree = render();
    expect(button(tree, '使用优化结果继续生图').disabled).toBe(true);
    driver.view = { ...driver.view, preview: '已精简的描述' };
    tree = render();
    expect(button(tree, '使用优化结果继续生图').disabled).toBe(false);
    expect(driver.apply).not.toHaveBeenCalled();
    (button(tree, '使用优化结果继续生图').onClick as () => void)();
    expect(driver.apply).toHaveBeenCalledOnce();
  });

  it('独立选择文本模型不改模型偏好，返回精简和取消分别关闭流程', () => {
    const tree = render();
    const model = tree.find((element) => element.type === 'model-selector')!;
    expect(model.props).toMatchObject({ nodeType: 'ai-text', persistPreference: false, selectedModel: 'general/text' });
    (button(tree, '返回手动精简').onClick as () => void)();
    expect(driver.close).toHaveBeenCalledWith(true);
    (button(tree, '取消生成').onClick as () => void)();
    expect(driver.close).toHaveBeenCalledWith();
  });
});
