import type { SupportedLocale } from './index';

function dateOf(value: string | Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatDateTime(value: string | Date | number, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(dateOf(value));
}

export function formatNumber(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatPercent(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatRelativeTime(
  value: string | Date | number,
  locale: SupportedLocale,
  now = Date.now(),
): string {
  const seconds = Math.round((dateOf(value).getTime() - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

export function formatFileSize(bytes: number, locale: SupportedLocale): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
}

export function formatDuration(milliseconds: number, locale: SupportedLocale): string {
  if (milliseconds < 1000) return `${formatNumber(milliseconds, locale)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60)
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(seconds)} s`;
  const minutes = new Intl.NumberFormat(locale).format(Math.round(seconds / 60));
  return locale === 'zh-CN' ? `${minutes} 分钟` : `${minutes} min`;
}
