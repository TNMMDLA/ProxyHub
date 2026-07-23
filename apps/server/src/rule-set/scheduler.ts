import { prisma } from '../db.js';
import { refreshRuleSet } from './service.js';

export function startRuleSetScheduler(): () => void {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    const due = await prisma.ruleSet.findMany({
      where: {
        enabled: true,
        sourceType: 'REMOTE',
        updateIntervalMinutes: { not: null },
        OR: [{ nextUpdateAt: null }, { nextUpdateAt: { lte: new Date() } }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    due.forEach(({ id }, index) => {
      const timer = setTimeout(() => void refreshRuleSet(id).catch(() => undefined), index * 250);
      timer.unref();
    });
  };
  void run();
  const interval = setInterval(() => void run(), 60_000);
  interval.unref();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
