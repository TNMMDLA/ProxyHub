# Network Performance Test

ProxyHub V0.4 Phase 1 adds an explicit, on-demand benchmark for one enabled VLESS/TCP/REALITY/Vision node. It runs on the ProxyHub server through an isolated temporary Xray client.

> This is a server-side benchmark. It measures the ProxyHub server's direct path and the selected node tunnel. It does not measure the final user's ISP-to-VPS path and must not be presented as the user's real Internet speed.

The feature does not change policies, node pools, subscriptions, routing, or the formal Xray configuration. V0.4 Phase 2 is outside this scope.

## Execution flow

1. An administrator or operator starts a run from the Nodes page.
2. Server validates the node and creates a `QUEUED` database record.
3. Agent obtains the single benchmark lock, creates a mode-`0700` temporary directory, and writes a mode-`0600` client configuration.
4. Agent runs `xray run -test` against that temporary configuration.
5. Agent starts a separate Xray client with a random loopback-only SOCKS inbound.
6. Each configured target is tested sequentially over both the direct path and the temporary tunnel.
7. Results and the safe environment snapshot are scored and persisted.
8. The temporary Xray process and directory are removed on success, failure, timeout, or cancellation.

The formal Xray PID and active configuration are not applied, reloaded, or restarted. Runtime CI records their identity before and after a benchmark and requires both to remain unchanged.

## Target registry

ProxyHub does not ship a permanent public speed-test endpoint. Operators must configure one to five controlled HTTPS targets:

```dotenv
PROXYHUB_NETWORK_PERF_TARGETS_JSON=[{"id":"provider-a","label":"Provider A","smallRequestUrl":"https://speed.example/small","downloadUrl":"https://speed.example/download","enabled":true,"maxDownloadBytes":16777216}]
```

Each entry requires a unique `id`, a display `label`, a small-request URL, and a streaming download URL. `maxDownloadBytes` is bounded from 64 KiB to 100 MiB. An optional upload definition is reserved for a later compatible implementation; V0.4 Phase 1 reports upload as `NOT_AVAILABLE`.

An empty registry safely disables new runs and produces a real unavailable/empty state. It never falls back to an undocumented endpoint.

## Metrics

For each target, the Agent makes five small requests and two bounded download samples by default.

- `latencyMedianMs`: median time to first response byte for successful small requests.
- `latencyP95Ms`: nearest-rank 95th percentile of successful small-request first-byte times.
- `jitterMs`: mean absolute difference between consecutive successful first-byte samples.
- `downloadMbps`: median streaming throughput from the successful download samples.
- `efficiencyPercent`: `tunnel Mbps / direct Mbps × 100`, bounded to 0–200%. It is unavailable when the direct baseline is zero or invalid.
- `successRatePercent`: successful tunneled requests divided by all attempted tunneled requests.

Raw bodies are streamed and discarded. They are never retained in memory as a complete response and never persisted.

With at least three successful targets, a tunneled result below 35% of the cross-target median is marked as a target-path outlier. This supports analysis without allowing one target to silently define the complete node result.

## Score algorithm

The overall score is transparent and bounded to 0–100:

```text
overall =
  min(100, median efficiency) × 50%
  + min(100, request success rate) × 30%
  + min(100, median stability) × 20%

stability per target =
  max(0, 100 - jitter / median latency × 100)
```

Ratings are `EXCELLENT` (85+), `GOOD` (70+), `FAIR` (50+), `POOR` (30+), `CRITICAL` (below 30), or `UNKNOWN`. Missing or non-finite inputs never become an artificial zero-speed success. A run is `COMPLETED` when every target succeeds, `PARTIAL` when at least one target succeeds, and `FAILED` when none succeed.

The score is diagnostic evidence only. ProxyHub does not automatically change policies, node pools, or subscriptions based on it.

## Safety boundaries

- HTTPS is mandatory; URLs with credentials, loopback/private/link-local/metadata addresses, and unsafe DNS answers are rejected.
- DNS is resolved and pinned for each connection. All redirect destinations are revalidated, which blocks DNS rebinding and redirect-to-private attacks.
- Redirect count, target count, response bytes, per-target time, and global run time are bounded.
- Only one benchmark may run per Agent. Concurrent starts return a stable busy error.
- Cancellation is explicit, and interrupted Server records are recovered as `INTERRUPTED` after restart.
- Temporary cleanup only accepts recognized ProxyHub prefixes, rejects symbolic links, and also removes stale recognized directories on Agent startup.
- Node credentials move only over the authenticated Server-to-Agent channel. API responses, audit metadata, notifications, and persisted result JSON exclude UUIDs, private keys, tokens, and complete node configuration.
- Test-only private addressing and insecure TLS require `PROXYHUB_NETWORK_PERF_TEST_MODE=true`. Keep it `false` in production.
- No Docker socket, shell endpoint, arbitrary port scanner, automatic benchmark, or background schedule is introduced.

## Storage and history

`NetworkPerformanceRun` stores safe run metadata, score components, analysis codes, and environment JSON. `NetworkPerformanceTargetResult` stores the bounded per-target metrics. The additive V0.4 migration preserves all prior tables and data.

History is limited to the ten most recent runs per node. Run start, completion, failure, and cancellation produce safe audit metadata. Ordinary low performance does not create a critical notification; runner-internal or cleanup failures can create an operational warning or critical notification.

## Environment variables

| Variable                                  | Default                           | Constraint                                                                          |
| ----------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `PROXYHUB_NETWORK_PERF_TARGETS_JSON`      | empty                             | JSON array containing 1–5 enabled HTTPS targets                                     |
| `PROXYHUB_NETWORK_PERF_TIMEOUT_MS`        | `120000`                          | Global limit, 30–300 seconds                                                        |
| `PROXYHUB_NETWORK_PERF_TARGET_TIMEOUT_MS` | `20000`                           | Per-target limit, 5–60 seconds                                                      |
| `PROXYHUB_NETWORK_PERF_NODE_HOST`         | `host.docker.internal` in Compose | Address used by the isolated client to reach the selected host-network Xray inbound |
| `PROXYHUB_NETWORK_PERF_TEST_MODE`         | `false`                           | CI/development-only private-address and insecure-TLS opt-in                         |

## Validation

Run the focused suite with:

```bash
pnpm test:network-performance
```

The Docker runtime regression uses an internal test-profile fixture, performs completed, busy, cancellation, and timeout scenarios, scans API responses for secrets, checks history and diagnostics, and confirms that the formal Xray process/configuration identity did not change. Real target quality and host-network behavior still require the Linux VPS checklist.
