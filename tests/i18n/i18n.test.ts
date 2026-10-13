import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectLocale, getLocale, normalizeLocale, setLocale, t } from '../../src/i18n';
import enUS from '../../src/i18n/locales/en-US/index';
import jaJP from '../../src/i18n/locales/ja-JP';
import koKR from '../../src/i18n/locales/ko-KR';

afterEach(() => {
  setLocale('zh-CN');
});

describe('i18n runtime', () => {
  it('falls back to the Chinese source text when a translation is missing', () => {
    setLocale('en-US');
    expect(t('这条文案没有英文词条')).toBe('这条文案没有英文词条');
  });

  it('translates and interpolates named placeholders', () => {
    setLocale('en-US');
    expect(t('设置')).toBe('Settings');
    expect(t('发现新版本 v{version}', { version: '1.2.3' })).toBe('New version v1.2.3 available');
  });

  it('translates into Japanese and Korean', () => {
    setLocale('ja-JP');
    expect(t('设置')).toBe('設定');
    expect(t('新建项目')).toBe('新規プロジェクト');

    setLocale('ko-KR');
    expect(t('设置')).toBe('설정');
    expect(t('新建项目')).toBe('새 프로젝트');
  });

  it('keeps unknown placeholders literal instead of printing undefined', () => {
    setLocale('en-US');
    expect(t('资产 · 新增短剧资产 ({count})')).toBe('Assets · {count} new drama asset(s)');
  });

  it('normalizes BCP-47 tags and falls back to Chinese for unsupported languages', () => {
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeLocale('en-GB')).toBe('en-US');
    expect(normalizeLocale('ja')).toBe('ja-JP');
    expect(normalizeLocale('ja-JP')).toBe('ja-JP');
    expect(normalizeLocale('ko')).toBe('ko-KR');
    expect(normalizeLocale('ko-KR')).toBe('ko-KR');
    expect(normalizeLocale('fr-FR')).toBe('zh-CN');
    expect(normalizeLocale(undefined)).toBe('zh-CN');
  });

  it('treats an empty language setting as "follow the system"', () => {
    setLocale('en-US');
    setLocale(undefined);
    expect(getLocale()).toBe(detectLocale());
  });
});

/**
 * 中文原文即 key：改动源码里的中文文案会静默丢失翻译。
 * 这条用例扫描全仓，把已经不存在于源码的词条揪出来。
 * en-US 是基准字典，ja-JP / ko-KR 的 key 集合必须与之完全一致。
 */
describe('locale dictionaries', () => {
  const SRC = join(__dirname, '../../src');
  const DICTS = { enUS, jaJP, koKR } as const;

  function collectSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // 词条文件本身当然包含 key，扫描时必须跳过，否则这条用例永远通过
      if (entry.name === 'locales') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectSources(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(readFileSync(full, 'utf8'));
    }
    return out;
  }

  it('has no entry whose Chinese source text disappeared from the codebase', () => {
    const sources = collectSources(SRC).join('\n');
    // 多个字典共用大量 key，每个唯一 key 只扫描一次源码，保留逐字典的完整断言。
    const keys = new Set(Object.values(DICTS).flatMap((dict) => Object.keys(dict)));
    // 含反斜杠或换行的 key 会被 TS 转义改写，源码原始文本与运行时字符串值不一致，
    // 无法可靠比对，跳过这类 key 的孤儿检测。
    const missingKeys = new Set([...keys].filter(
      (key) => !key.includes('\\') && !key.includes('\n') && !sources.includes(key),
    ));
    for (const [name, dict] of Object.entries(DICTS)) {
      const orphans = Object.keys(dict).filter(
        (key) => missingKeys.has(key),
      );
      expect(orphans, `${name} 存在源码中已消失的孤儿词条`).toEqual([]);
    }
  });

  it('has no dictionary key that is missing from en-US', () => {
    // en-US 是基准字典。日/韩暂缓维护，允许缺词条（回落中文），但不允许出现 en-US 没有的 key。
    const base = new Set(Object.keys(enUS));
    for (const [name, dict] of Object.entries(DICTS)) {
      const unknown = Object.keys(dict).filter((key) => !base.has(key));
      expect(unknown, `${name} 存在 en-US 中没有的 key`).toEqual([]);
    }
  });

  it('declares the same placeholders on both sides of every entry', () => {
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort();
    for (const [name, dict] of Object.entries(DICTS)) {
      const mismatched = Object.entries(dict)
        .filter(([zh, value]) => placeholders(zh).join() !== placeholders(value).join())
        .map(([zh]) => zh);
      expect(mismatched, `${name} 存在占位符不一致的词条`).toEqual([]);
    }
  });
});
