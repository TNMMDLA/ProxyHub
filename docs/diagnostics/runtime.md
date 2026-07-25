# Runtime diagnostics

Runtime diagnostics combine Server process identity with authenticated Agent observations. They include ProxyHub version, Git SHA, build time, deploy mode, process uptime, Agent event-loop lag and memory, Xray version, PID, process/heartbeat/listening/config state, and Reality runner availability.

Resource scope is explicit. Agent RSS is `process`, cgroup values are `cgroup`, Xray observations are `container`, and Node runtime values that cannot be proven to represent the host use `unknown`. Container restart counts are reported as unavailable because ProxyHub deliberately does not mount `/var/run/docker.sock`; operators can inspect them from the VPS with `docker compose ps`.

Overview uses the existing Xray health inspection. Deep diagnostics additionally validates the active config with the pinned Xray binary. Validation does not rewrite or restart Xray.
