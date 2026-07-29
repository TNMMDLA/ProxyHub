import { describe, expect, it } from 'vitest';
import i18n, {
  detectLocale,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  persistLocale,
  resources,
} from './index';
import {
  formatDateTime,
  formatBytes,
  formatDuration,
  formatFileSize,
  formatNumber,
  formatPercent,
  formatRelativeTime,
} from './formatters';

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      Object.entries(flatten(child, prefix ? `${prefix}.${key}` : key)),
    ),
  );
}

function variables(value: string): string[] {
  return [...value.matchAll(/\{\{([^},\s]+)/gu)].map((match) => match[1] ?? '').sort();
}

describe('web localization foundation', () => {
  it.each([
    ['zh', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
    ['en', 'en'],
    ['fr', null],
  ] as const)('normalizes %s to %s', (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  it('prefers the saved locale', () => {
    expect(
      detectLocale({ getItem: (key) => (key === LOCALE_STORAGE_KEY ? 'en' : null) }, ['zh-CN']),
    ).toBe('en');
  });

  it.each([
    [['zh-CN'], 'zh-CN'],
    [['zh-Hans'], 'zh-CN'],
    [['en-US'], 'en'],
    [['fr-FR'], 'en'],
  ] as const)('detects browser languages', (languages, expected) => {
    expect(detectLocale(null, languages)).toBe(expected);
  });

  it('survives unavailable local storage', () => {
    const storage = {
      getItem: () => {
        throw new Error('disabled');
      },
    };
    expect(detectLocale(storage, ['zh-CN'])).toBe('zh-CN');
    expect(() => persistLocale('en')).not.toThrow();
  });

  it('loads English and Simplified Chinese resources', () => {
    expect(resources.en.common.save).toBe('Save');
    expect(resources['zh-CN'].common.save).toBe('保存');
  });

  it('falls back to English for missing Chinese keys', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('errors:REQUEST_FAILED')).toBe('请求失败。');
    expect(i18n.options.fallbackLng).toEqual(['en']);
  });

  it('keeps locale resource keys and interpolation parameters in parity', () => {
    const english = flatten(resources.en);
    const chinese = flatten(resources['zh-CN']);
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english)) {
      expect(variables(chinese[key] ?? ''), key).toEqual(variables(english[key] ?? ''));
    }
  });

  it('contains no executable or secret-like translation content', () => {
    const content = Object.values({
      ...flatten(resources.en),
      ...flatten(resources['zh-CN']),
    }).join('\n');
    expect(content).not.toMatch(/<script|javascript:|BEGIN (?:RSA |EC )?PRIVATE KEY/iu);
    expect(content).not.toMatch(/\/sub\/[A-Za-z0-9_-]{20,}/u);
  });

  it('formats dates in both locales', () => {
    const value = new Date('2026-07-25T02:30:00.000Z');
    expect(formatDateTime(value, 'en')).toMatch(/2026/u);
    expect(formatDateTime(value, 'zh-CN')).toMatch(/2026/u);
  });

  it('formats relative time in both locales', () => {
    const now = Date.parse('2026-07-25T02:30:00.000Z');
    const value = now - 120_000;
    expect(formatRelativeTime(value, 'en', now)).toContain('minute');
    expect(formatRelativeTime(value, 'zh-CN', now)).toContain('分钟');
  });

  it('formats numbers, percentages, sizes and durations', () => {
    expect(formatNumber(1024, 'en')).toContain('1,024');
    expect(formatPercent(0.5, 'zh-CN')).toContain('50');
    expect(formatFileSize(1024 * 1024, 'en')).toBe('1 MB');
    expect(formatDuration(1500, 'en')).toBe('1.5 s');
    expect(formatBytes('1125899906842624', 'en')).toBe('1 PB');
    expect(formatBytes(1536n, 'en')).toBe('1.5 KB');
  });
});
