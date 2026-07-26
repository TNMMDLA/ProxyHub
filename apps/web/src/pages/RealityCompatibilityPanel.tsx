import type { CompatibilityView } from './reality-compatibility-state';
import { useTranslation } from 'react-i18next';

export function RealityCompatibilityPanel({ result }: { result: CompatibilityView }) {
  const { t } = useTranslation(['resources', 'common']);
  if (!result) {
    return (
      <div className="reality-compatibility is-untested">
        <b>{t('resources:nodes.notTested')}</b>
        <span>{t('resources:nodes.compatibilityNote')}</span>
      </div>
    );
  }
  if (result.status === 'ERROR') {
    return (
      <div className="reality-compatibility is-error">
        <b>{t('resources:nodes.testFailed')}</b>
        <span>{result.message}</span>
      </div>
    );
  }
  const compatible = result.status === 'COMPATIBLE';
  return (
    <div className={`reality-compatibility ${compatible ? 'is-compatible' : 'is-incompatible'}`}>
      <header>
        <b>{compatible ? t('resources:nodes.compatible') : t('resources:nodes.incompatible')}</b>
        <span>
          {result.xrayVersion} · {(result.durationMs / 1000).toFixed(1)}s
        </span>
      </header>
      <div className="compatibility-stages">
        <span>
          {t('resources:nodes.tlsPrecheck')}:{' '}
          {t(`common:statusLabels.${result.tlsPrecheck.status}`)}
        </span>
        <span>
          {t('resources:nodes.realityHandshake')}:{' '}
          {t(`common:statusLabels.${result.realityHandshake.status}`)}
        </span>
        <span>
          {t('resources:nodes.endToEndTraffic')}:{' '}
          {t(`common:statusLabels.${result.endToEndTraffic.status}`)}
        </span>
      </div>
      {result.diagnostics.map((diagnostic) => (
        <small key={diagnostic}>{diagnostic}</small>
      ))}
    </div>
  );
}
