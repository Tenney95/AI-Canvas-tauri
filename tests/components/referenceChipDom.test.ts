import { describe, expect, it } from 'vitest';
import { buildReferenceChipEl } from '../../src/components/shared/referenceChipDom';

class ElementStub {
  className = ''; textContent = ''; title = ''; contentEditable = ''; src = ''; alt = ''; draggable = true;
  attributes: Record<string, string> = {}; style: Record<string, string> = {}; children: ElementStub[] = [];
  classList = { add: (name: string) => { this.className += ` ${name}`; } };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  appendChild(child: ElementStub) { this.children.push(child); return child; }
}
const documentStub = {
  createElement: (tag: string) => new ElementStub(tag),
  createElementNS: (_namespace: string, tag: string) => new ElementStub(tag),
} as unknown as Document;

describe('UI Kit reference chip', () => {
  it('keeps the compact node identity and media index separate from the title', () => {
    const chip = buildReferenceChipEl(documentStub, { label: '角色参考图', kind: 'image', badge: '#39', mediaIndex: '(图1)', thumbnailUrl: 'data:image/jpeg;base64,AA==' }) as unknown as ElementStub;
    expect(chip.contentEditable).toBe('false');
    expect(chip.children.slice(1).map((item) => item.textContent)).toEqual(['#39', '(图1)']);
    expect(chip.title).toBe('角色参考图 (#39)');
    expect(chip.children[0].children[0].src).toBe('data:image/jpeg;base64,AA==');
  });
  it('renders names as literal text rather than HTML and falls back without a thumbnail', () => {
    const label = '<img src=x onerror=alert(1)>';
    const chip = buildReferenceChipEl(documentStub, { label, kind: 'text', iconText: 'T' }) as unknown as ElementStub;
    expect(chip.children[0].textContent).toBe('T');
    expect(chip.children[1].textContent).toBe(label);
    expect(chip.children[1].children).toHaveLength(0);
  });
  it('preserves the host video icon even when a video thumbnail exists', () => {
    const chip = buildReferenceChipEl(documentStub, { label: '视频', kind: 'video', iconPath: 'M3 5h12v14H3z', thumbnailUrl: 'data:image/jpeg;base64,AA==' }) as unknown as ElementStub;
    expect(chip.children[0].children[0].tagName).toBe('svg');
    expect(chip.children[0].children[0].children[0].attributes.d).toBe('M3 5h12v14H3z');
  });
});
