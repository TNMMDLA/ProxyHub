# Diagnostics Center

ProxyHub V0.3.1 Phase 2 adds an administrator-only, read-only Diagnostics Center. The browser makes one aggregated overview request and refreshes it at most every 30 seconds while the page is visible. Server results use a 10-second cache by default, preventing multiple browser tabs from creating Agent polling storms.

Overview checks are intentionally cheap: Server and Agent reachability, Xray health, SQLite connectivity and migration records, database filesystem capacity, current release state, backup archive metadata, and database-only Rule Set and Subscription summaries.

V0.4 Phase 1 adds a lightweight Network Performance summary containing Agent capability, configured target count, current busy state, and the most recent persisted status/time/score. Diagnostics never starts a performance run or downloads benchmark data. Use the explicit action on the Nodes page for an on-demand test.

Manual deep diagnostics add bounded Xray config validation and SQLite `PRAGMA quick_check`. Only one deep scan can run per Server, it has a 30-second default timeout, supports request cancellation, and writes an audit record. It never performs a deployment, restart, configuration apply, migration, backup restore, remote Rule Set fetch, or Reality compatibility test.

Statuses are `HEALTHY`, `WARNING`, `CRITICAL`, `UNKNOWN`, `NOT_AVAILABLE`, and `NOT_APPLICABLE`. `NOT_AVAILABLE` means the deployment does not expose a reliable data source; it is not treated as healthy. Every check includes its source, scope, observation time, freshness, stable ID, and safe recommendations.

Reality compatibility results are not persisted by the current architecture. Diagnostics therefore says “No persisted compatibility result” and only summarizes existing audit records. Use the dedicated Reality Compatibility screen for an explicit test.
