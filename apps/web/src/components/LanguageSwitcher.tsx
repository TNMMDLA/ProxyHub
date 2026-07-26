import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { changeLocale, type SupportedLocale } from '../i18n';

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation('common');
  const locale: SupportedLocale = i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  return (
    <label className={`language-switcher${compact ? ' compact' : ''}`}>
      <Languages size={17} aria-hidden="true" />
      {compact ? null : <span>{t('language')}</span>}
      <select
        aria-label={t('language')}
        value={locale}
        onChange={(event) => void changeLocale(event.target.value as SupportedLocale)}
      >
        <option value="en">{t('english')}</option>
        <option value="zh-CN">{t('simplifiedChinese')}</option>
      </select>
    </label>
  );
}
