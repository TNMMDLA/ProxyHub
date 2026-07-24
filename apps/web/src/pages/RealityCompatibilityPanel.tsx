import type { CompatibilityView } from './reality-compatibility-state';

export function RealityCompatibilityPanel({ result }: { result: CompatibilityView }) {
  if (!result) {
    return (
      <div className="reality-compatibility is-untested">
        <b>Not tested</b>
        <span>TLS availability and Reality compatibility are verified separately.</span>
      </div>
    );
  }
  if (result.status === 'ERROR') {
    return (
      <div className="reality-compatibility is-error">
        <b>Test failed</b>
        <span>{result.message}</span>
      </div>
    );
  }
  const compatible = result.status === 'COMPATIBLE';
  return (
    <div className={`reality-compatibility ${compatible ? 'is-compatible' : 'is-incompatible'}`}>
      <header>
        <b>{compatible ? 'Compatible' : 'Incompatible'}</b>
        <span>
          {result.xrayVersion} · {(result.durationMs / 1000).toFixed(1)}s
        </span>
      </header>
      <div className="compatibility-stages">
        <span>TLS precheck: {result.tlsPrecheck.status}</span>
        <span>Reality handshake: {result.realityHandshake.status}</span>
        <span>End-to-end traffic: {result.endToEndTraffic.status}</span>
      </div>
      {result.diagnostics.map((diagnostic) => (
        <small key={diagnostic}>{diagnostic}</small>
      ))}
    </div>
  );
}
