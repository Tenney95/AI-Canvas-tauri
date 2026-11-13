/**
 * qualityRatioSelector — 回归测试：image resolution and quality selector。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPortal } from 'react-dom';

const driver = vi.hoisted(() => ({ open: false }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: () => [driver.open, (open: boolean) => { driver.open = open; }],
  useRef: () => ({ current: null }),
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}));
vi.mock('react-dom', () => ({ createPortal: vi.fn((content: unknown) => content) }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
import QualityRatioSelector from '../../src/components/nodes/shared/QualityRatioSelector';

interface ElementLike { props: Record<string, unknown> & { children?: unknown } }
function elements(tree: unknown): ElementLike[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ElementLike;
  return [element, ...elements(element.props.children)];
}
function render(props: Partial<Parameters<typeof QualityRatioSelector>[0]> = {}) {
  return elements(QualityRatioSelector({ imageSize: '2K', aspectRatio: '16:9', onChangeAspectRatio: vi.fn(), ...props }));
}
function summary(tree: ElementLike[]) {
  return tree.find((element) => element.props['data-ui-schema-menu-trigger'] === 'qualityRatio')!.props;
}
function qualityOptions(tree: ElementLike[]) {
  return tree.find((element) => element.props['data-ui-schema-field'] === 'imageQuality');
}
function backgroundOptions(tree: ElementLike[]) {
  return elements(tree.find((element) => element.props['data-ui-schema-field'] === 'imageBackground'))
    .filter((element) => 'data-ui-schema-value' in element.props);
}
beforeEach(() => { driver.open = false; vi.mocked(createPortal).mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('image resolution and quality selector', () => {
  it('accepts capability ratio strings without adding undeclared defaults', () => {
    driver.open = true;
    const onChangeAspectRatio = vi.fn();
    const tree = render({ ratios: ['2:3', '3:1'], imageSizes: ['1k', '4k'], showAdaptive: false, onChangeAspectRatio });
    const area = tree.find((element) => element.props['data-ui-schema-field'] === 'aspectRatio');
    const options = elements(area).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.map((element) => element.props['data-ui-schema-value'])).toEqual(['2:3', '3:1']);
    expect(elements(area).map((element) => element.props.className)).toEqual(expect.arrayContaining([
      'img-rp-icon img-rp-p23', 'img-rp-icon img-rp-ultra',
    ]));
    (options[0].props.onClick as () => void)();
    expect(onChangeAspectRatio).toHaveBeenCalledWith('2:3');
    const sizes = elements(tree.find((element) => element.props['data-ui-schema-field'] === 'imageSize'))
      .filter((element) => 'data-ui-schema-value' in element.props);
    expect(sizes.map((element) => element.props['data-ui-schema-value'])).toEqual(['1k', '4k']);
  });

  it('disables the trigger and hides an open popup while generation is pending', () => {
    driver.open = true;
    const tree = render({ disabled: true });
    expect(summary(tree).disabled).toBe(true);
    expect(summary(tree)['aria-expanded']).toBe(false);
    expect(tree.some((element) => element.props['data-ui-schema-field'] === 'imageSize')).toBe(false);
    expect(driver.open).toBe(false);
  });

  it('portals the workbench popup to the viewport while retaining the shared panel', () => {
    driver.open = true;
    const body = {};
    vi.stubGlobal('document', { body });
    const tree = render({ fixedMenu: true });
    const popup = tree.find((element) => element.props.role === 'dialog');
    expect(popup?.props['aria-label']).toBe('16:9 · 2K');
    expect(createPortal).toHaveBeenCalledWith(popup, body);
  });

  it('retains the shared size/ratio pill and omits undeclared generation quality', () => {
    driver.open = true;
    const tree = render({ imageQuality: 'max' });
    expect(summary(tree)['aria-label']).toBe('16:9 · 2K');
    expect(qualityOptions(tree)).toBeUndefined();
    expect(tree.some((element) => element.props.children === '分辨率')).toBe(true);
  });

  it('renders only declared raw quality values and changes quality independently', () => {
    driver.open = true;
    const onChangeImageQuality = vi.fn();
    const onChangeImageSize = vi.fn();
    const values = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    const tree = render({ imageQualities: values, imageQuality: 'high', onChangeImageQuality, onChangeImageSize });
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.map((element) => element.props.children)).toEqual(values);
    expect(options.filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['high']);
    (options.at(-1)!.props.onClick as () => void)();
    expect(onChangeImageQuality).toHaveBeenCalledWith('max');
    expect(onChangeImageSize).not.toHaveBeenCalled();
    expect(summary(tree).title).toBe('16:9 · 2K · high');
  });

  it('uses a declared default and hides stale quality after a model capability changes', () => {
    driver.open = true;
    const tree = render({ imageQuality: 'max', imageQualities: ['low', 'medium', 'high'], defaultImageQuality: 'medium' });
    expect(summary(tree)['aria-label']).toBe('16:9 · 2K · medium');
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['medium']);
    expect(options.some((element) => element.props.children === 'max')).toBe(false);
  });

  it('does not invent auto or a first-option default for a model with no declared default', () => {
    driver.open = true;
    const tree = render({ imageQualities: ['low', 'medium', 'high'] });
    expect(summary(tree)['aria-label']).toBe('16:9 · 2K');
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.some((element) => element.props['aria-pressed'])).toBe(false);
    expect(options.some((element) => element.props.children === 'auto')).toBe(false);
  });

  it('shows a fixed provider quality as a single declared choice', () => {
    driver.open = true;
    const tree = render({ imageQualities: ['high'], defaultImageQuality: 'high', showImageSize: false });
    expect(summary(tree)['aria-label']).toBe('16:9 · high');
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.map((element) => element.props.children)).toEqual(['high']);
    expect(options[0].props['aria-pressed']).toBe(true);
  });

  it('displays the canonical spelling for a case-insensitive saved quality', () => {
    driver.open = true;
    const tree = render({ imageQualities: ['low', 'high'], imageQuality: 'HIGH' });
    expect(summary(tree)['aria-label']).toBe('16:9 · 2K · high');
    const options = elements(qualityOptions(tree)).filter((element) => 'data-ui-schema-value' in element.props);
    expect(options.filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['high']);
  });

  it('hides undeclared backgrounds and defaults declared backgrounds to an omitted API field', () => {
    driver.open = true;
    expect(backgroundOptions(render({ imageBackground: 'transparent' }))).toEqual([]);
    const tree = render({ imageBackgrounds: ['auto', 'opaque', 'transparent'] });
    const options = backgroundOptions(tree);
    expect(options.map((element) => element.props['data-ui-schema-value'])).toEqual(['', 'auto', 'opaque', 'transparent']);
    expect(options.map((element) => element.props.children)).toEqual(['接口默认', '自动', '不透明', '透明']);
    expect(options.filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['接口默认']);
    expect(summary(tree)['aria-label']).toBe('16:9 · 2K');
  });

  it('only offers declared transparent support and changes background independently', () => {
    driver.open = true;
    const onChangeImageBackground = vi.fn();
    const onChangeImageQuality = vi.fn();
    const onChangeAspectRatio = vi.fn();
    const tree = render({ imageBackgrounds: ['transparent'], imageQuality: 'high', imageQualities: ['high'],
      onChangeImageBackground, onChangeImageQuality, onChangeAspectRatio });
    const options = backgroundOptions(tree);
    expect(options.map((element) => element.props['data-ui-schema-value'])).toEqual(['', 'transparent']);
    (options[1].props.onClick as () => void)();
    expect(onChangeImageBackground).toHaveBeenCalledWith('transparent');
    expect(onChangeImageQuality).not.toHaveBeenCalled();
    expect(onChangeAspectRatio).not.toHaveBeenCalled();
  });

  it('keeps an explicit API default instead of displaying a configurable background default', () => {
    driver.open = true;
    const onChangeImageBackground = vi.fn();
    const props = { imageBackgrounds: ['auto', 'transparent'], defaultImageBackground: 'transparent', onChangeImageBackground };
    const inherited = render(props);
    expect(backgroundOptions(inherited).filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['透明']);
    (backgroundOptions(inherited)[0].props.onClick as () => void)();
    expect(onChangeImageBackground).toHaveBeenCalledWith('');
    const omitted = render({ ...props, imageBackground: '' });
    expect(backgroundOptions(omitted).filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['接口默认']);
    expect(summary(omitted)['aria-label']).toBe('16:9 · 2K');
  });

  it('does not offer cancellation for a fixed background contract and displays canonical values', () => {
    driver.open = true;
    const fixed = render({ imageBackgrounds: ['transparent'], defaultImageBackground: 'transparent', imageBackgroundIsFixed: true, imageBackground: '' });
    expect(backgroundOptions(fixed).map((element) => element.props['data-ui-schema-value'])).toEqual(['transparent']);
    expect(backgroundOptions(fixed)[0].props['aria-pressed']).toBe(true);
    const saved = render({ imageBackgrounds: ['auto', 'transparent'], imageBackground: 'TRANSPARENT' });
    expect(summary(saved).title).toBe('16:9 · 2K · 透明背景');
    expect(backgroundOptions(saved).filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['透明']);
  });

  it('still offers API default for a dynamic single-choice background with a configured default', () => {
    driver.open = true;
    const onChangeImageBackground = vi.fn();
    const props = { imageBackgrounds: ['transparent'], defaultImageBackground: 'transparent', onChangeImageBackground };
    const inherited = render(props);
    expect(backgroundOptions(inherited).map((element) => element.props['data-ui-schema-value'])).toEqual(['', 'transparent']);
    (backgroundOptions(inherited)[0].props.onClick as () => void)();
    expect(onChangeImageBackground).toHaveBeenCalledWith('');
    const omitted = render({ ...props, imageBackground: '' });
    expect(backgroundOptions(omitted).filter((element) => element.props['aria-pressed']).map((element) => element.props.children)).toEqual(['接口默认']);
    expect(summary(omitted)['aria-label']).toBe('16:9 · 2K');
  });
});
