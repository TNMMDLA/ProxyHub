import type { TrafficAccountingService } from './accounting.js';

export function startTrafficAccountingScheduler(
  service: TrafficAccountingService,
  intervalMs: number,
): () => void {
  let stopped = false;
  const run = () => {
    if (!stopped) void service.tick().catch(() => undefined);
  };
  void service
    .markRecoveryPending()
    .then(run)
    .catch(() => undefined);
  const interval = setInterval(run, intervalMs);
  interval.unref();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
