import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  mergeDramaExtractIntoLibrary,
  normalizeAssetKey,
  parseDramaExtractResponse,
  postProcessDramaExtractOutput,
} from '../../src/services/dramaAssetExtract';
import {
  buildDramaAssetImagePrompt,
  buildCharacterLookbookPrompt,
  formatDramaAssetTextBrief,
  listDramaAssetsFlat,
} from '../../src/services/dramaAssetPrompt';
import type { DramaAssetLibrary, DramaCharacter } from '../../src/types/dramaAssets';
import { emptyDramaAssetLibrary } from '../../src/types/dramaAssets';
import { DRAMA_EXTRACT_MARKER } from '../../src/types/dramaAssets';

describe('normalizeAssetKey', () => {
  it('strips spaces and punctuation', () => {
    expect(normalizeAssetKey('沈 仪')).toBe('沈仪');
    expect(normalizeAssetKey('现代电影院（夜）')).toBe('现代电影院');
  });
});

describe('parseDramaExtractResponse', () => {
  it('parses character JSON and rejects lookbook instructions in shape', () => {
    const raw = JSON.stringify({
      kind: 'character',
      items: [
        {
          name: '主角',
          identity: '都市上班族',
          summary: '电影院独坐的中年男人',
          visualNotes: '短黑发，疲惫眼神，深灰卫衣',
          wardrobeDefault: '深灰卫衣+黑裤',
          importance: 'main',
        },
      ],
    });
    const parsed = parseDramaExtractResponse(raw, 'character');
    expect(parsed.kind).toBe('character');
    expect(parsed.characters).toHaveLength(1);
    expect(parsed.characters[0].name).toBe('主角');
    expect(parsed.characters[0].identity).toBe('都市上班族');
    expect(parsed.scenes).toHaveLength(0);
  });

  it('parses fenced JSON for scenes', () => {
    const raw = '```json\n' + JSON.stringify({
      kind: 'scene',
      items: [{ name: '电影院', summary: '暗场银幕', visualNotes: '冷光', importance: 'main' }],
    }) + '\n```';
    const parsed = parseDramaExtractResponse(raw, 'scene');
    expect(parsed.scenes[0].name).toBe('电影院');
  });

  it('throws on empty items', () => {
    expect(() =>
      parseDramaExtractResponse(JSON.stringify({ kind: 'prop', items: [] }), 'prop'),
    ).toThrow(/items/);
  });
});

describe('postProcessDramaExtractOutput', () => {
  it('returns markdown and parsed on success', () => {
    const prompt = `${DRAMA_EXTRACT_MARKER.character}\n剧本…`;
    const json = JSON.stringify({
      kind: 'character',
      items: [
        {
          name: '阿宁',
          identity: '学生',
          summary: '安静的女孩',
          visualNotes: '齐肩发',
          importance: 'main',
        },
      ],
    });
    const result = postProcessDramaExtractOutput(prompt, json);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('character');
    expect(result.parsed?.characters[0].name).toBe('阿宁');
    expect(result.output).toContain('人物');
    expect(result.output).toContain('阿宁');
  });

  it('falls back when JSON invalid', () => {
    const prompt = `${DRAMA_EXTRACT_MARKER.scene}\n`;
    const result = postProcessDramaExtractOutput(prompt, '不是 JSON');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('scene');
    expect(result.output).toContain('未规范化');
  });
});

describe('mergeDramaExtractIntoLibrary', () => {
  it('preserves id and image bindings on re-extract same name', () => {
    const existing: DramaAssetLibrary = {
      version: 1,
      characters: [
        {
          kind: 'character',
          id: 'char_keep_me',
          key: '主角',
          name: '主角',
          summary: '旧简介',
          visualNotes: '旧外形',
          identity: '旧身份',
          importance: 'main',
          confirmed: true,
          createdAt: 1000,
          updatedAt: 1000,
          source: 'ai',
          imageNodeId: 'node-img-1',
          imageUrl: 'https://example.com/a.png',
        },
      ],
      scenes: [],
      props: [],
    };

    const parsed = parseDramaExtractResponse(
      JSON.stringify({
        kind: 'character',
        items: [
          {
            name: '主角',
            identity: '新身份',
            summary: '新简介',
            visualNotes: '新外形',
            importance: 'main',
          },
        ],
      }),
      'character',
    );

    const next = mergeDramaExtractIntoLibrary(existing, parsed);
    expect(next.characters).toHaveLength(1);
    expect(next.characters[0].id).toBe('char_keep_me');
    expect(next.characters[0].imageNodeId).toBe('node-img-1');
    expect(next.characters[0].imageUrl).toBe('https://example.com/a.png');
    expect(next.characters[0].confirmed).toBe(true);
    expect(next.characters[0].summary).toBe('新简介');
    expect(next.characters[0].identity).toBe('新身份');
    expect(next.characters[0].source).toBe('merge');
  });

  it('appends new characters without dropping existing', () => {
    const existing = emptyDramaAssetLibrary();
    existing.characters.push({
      kind: 'character',
      id: 'c1',
      key: '甲',
      name: '甲',
      summary: '甲',
      visualNotes: '',
      identity: '甲',
      importance: 'main',
      confirmed: false,
      createdAt: 1,
      updatedAt: 1,
      source: 'ai',
    });
    const parsed = parseDramaExtractResponse(
      JSON.stringify({
        kind: 'character',
        items: [{ name: '乙', identity: '乙', summary: '乙', visualNotes: '', importance: 'minor' }],
      }),
      'character',
    );
    const next = mergeDramaExtractIntoLibrary(existing, parsed);
    expect(next.characters.map((c) => c.name).sort()).toEqual(['乙', '甲']);
  });
});

describe('buildDramaAssetImagePrompt', () => {
  const character: DramaCharacter = {
    kind: 'character',
    id: 'c1',
    key: '主角',
    name: '主角',
    summary: '电影院独坐的中年男人',
    visualNotes: '短黑发，深灰卫衣',
    identity: '都市上班族',
    gender: '男',
    ageBand: '约35岁',
    wardrobeDefault: '深灰卫衣+黑裤',
    importance: 'main',
    confirmed: false,
    createdAt: 1,
    updatedAt: 1,
    source: 'ai',
  };

  it('builds lookbook prompt without empty noise', () => {
    const p = buildCharacterLookbookPrompt(character);
    expect(p).toContain('定妆');
    expect(p).toContain('主角');
    expect(p).toContain('深灰卫衣');
    expect(p).not.toMatch(/undefined/);
  });

  it('routes by asset kind', () => {
    const p = buildDramaAssetImagePrompt(character);
    expect(p).toContain('lookbook');
  });

  it('formats text brief for @drama fallback', () => {
    const text = formatDramaAssetTextBrief(character);
    expect(text).toContain('人物');
    expect(text).toContain('主角');
    expect(text).toContain('外形');
  });
});

describe('listDramaAssetsFlat', () => {
  it('concatenates kinds', () => {
    const lib = emptyDramaAssetLibrary();
    expect(listDramaAssetsFlat(lib)).toEqual([]);
  });
});

describe('extractJsonObject', () => {
  it('extracts object from surrounding prose', () => {
    const obj = extractJsonObject('说明\n{"kind":"prop","items":[{"name":"刀"}]}\n完');
    expect((obj as { kind: string }).kind).toBe('prop');
  });
});
