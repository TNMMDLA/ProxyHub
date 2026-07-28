import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enCommon from './locales/en/common.json';
import enNavigation from './locales/en/navigation.json';
import enErrors from './locales/en/errors.json';
import zhCommon from './locales/zh-CN/common.json';
import zhNavigation from './locales/zh-CN/navigation.json';
import zhErrors from './locales/zh-CN/errors.json';
import enAuth from './locales/en/auth.json';
import zhAuth from './locales/zh-CN/auth.json';
import enSettings from './locales/en/settings.json';
import zhSettings from './locales/zh-CN/settings.json';
import enDashboard from './locales/en/dashboard.json';
import zhDashboard from './locales/zh-CN/dashboard.json';
import enSubscriptions from './locales/en/subscriptions.json';
import zhSubscriptions from './locales/zh-CN/subscriptions.json';
import enActivity from './locales/en/activity.json';
import zhActivity from './locales/zh-CN/activity.json';
import enResources from './locales/en/resources.json';
import zhResources from './locales/zh-CN/resources.json';
import enDiagnostics from './locales/en/diagnostics.json';
import zhDiagnostics from './locales/zh-CN/diagnostics.json';
import enSecurity from './locales/en/security.json';
import zhSecurity from './locales/zh-CN/security.json';
import enNetworkPerformance from './locales/en/networkPerformance.json';
import zhNetworkPerformance from './locales/zh-CN/networkPerformance.json';

export const supportedLocales = ['en', 'zh-CN'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];
export const LOCALE_STORAGE_KEY = 'proxyhub.locale';

export function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
  if (value === 'en' || value === 'zh-CN') return value;
  if (value && /^(?:zh|zh-cn|zh-hans)(?:-|$)/iu.test(value)) return 'zh-CN';
  return null;
}

export function detectLocale(
  storage?: Pick<Storage, 'getItem'> | null,
  browserLanguages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages,
): SupportedLocale {
  try {
    const activeStorage =
      storage === undefined && typeof window !== 'undefined' ? window.localStorage : storage;
    const saved = normalizeLocale(activeStorage?.getItem(LOCALE_STORAGE_KEY));
    if (saved) return saved;
  } catch {
    // Storage may be disabled; browser detection remains available.
  }
  for (const language of browserLanguages) {
    const normalized = normalizeLocale(language);
    if (normalized) return normalized;
  }
  return 'en';
}

export function persistLocale(locale: SupportedLocale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The in-memory i18next locale still changes for this session.
  }
}

export const resources = {
  en: {
    common: enCommon,
    navigation: enNavigation,
    errors: enErrors,
    auth: enAuth,
    settings: enSettings,
    dashboard: enDashboard,
    subscriptions: enSubscriptions,
    activity: enActivity,
    resources: enResources,
    diagnostics: enDiagnostics,
    security: enSecurity,
    networkPerformance: enNetworkPerformance,
  },
  'zh-CN': {
    common: zhCommon,
    navigation: zhNavigation,
    errors: zhErrors,
    auth: zhAuth,
    settings: zhSettings,
    dashboard: zhDashboard,
    subscriptions: zhSubscriptions,
    activity: zhActivity,
    resources: zhResources,
    diagnostics: zhDiagnostics,
    security: zhSecurity,
    networkPerformance: zhNetworkPerformance,
  },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: detectLocale(),
  fallbackLng: 'en',
  supportedLngs: supportedLocales,
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
  showSupportNotice: false,
  saveMissing: import.meta.env.DEV,
  ...(import.meta.env.DEV
    ? {
        missingKeyHandler: (_languages: readonly string[], namespace: string, key: string) =>
          console.warn(`Missing translation: ${namespace}:${key}`),
      }
    : {}),
});

export async function changeLocale(locale: SupportedLocale): Promise<void> {
  persistLocale(locale);
  await i18n.changeLanguage(locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

if (typeof document !== 'undefined') document.documentElement.lang = detectLocale();

export default i18n;
