# Subscription Compatibility Matrix

## Validation status

| Output / client      | Validation level                 | Fixed target              | Current status                                          |
| -------------------- | -------------------------------- | ------------------------- | ------------------------------------------------------- |
| Mihomo YAML          | Official core CLI                | Mihomo `v1.19.28`         | Passed locally on Windows; Linux CI/VPS gate configured |
| sing-box JSON        | Official core CLI                | sing-box `1.13.12`        | Passed locally on Windows; Linux CI/VPS gate configured |
| Raw VLESS list       | Parser/encoding and Golden tests | RFC 3986-style VLESS URIs | Passed unit and deterministic output tests              |
| Clash Verge Rev      | GUI import/runtime               | Not fixed                 | Not verified                                            |
| Mihomo Party         | GUI import/runtime               | Not fixed                 | Not verified                                            |
| sing-box GUI clients | GUI import/runtime               | Not fixed                 | Not verified                                            |

“Core CLI passed” means the generated file was accepted by the pinned official command-line validation mode. It does not prove GUI import UX, QR/share handling, platform networking, or end-to-end proxy traffic. Those rows remain explicitly unverified until the Linux VPS smoke test records real client imports.

## Rule capability matrix

| Match type       | Mihomo    | sing-box                                | Raw VLESS               |
| ---------------- | --------- | --------------------------------------- | ----------------------- |
| `DOMAIN`         | Supported | Supported                               | Not applicable; warning |
| `DOMAIN_SUFFIX`  | Supported | Supported                               | Not applicable; warning |
| `DOMAIN_KEYWORD` | Supported | Supported                               | Not applicable; warning |
| `DOMAIN_REGEX`   | Supported | Supported                               | Not applicable; warning |
| `IP_CIDR`        | Supported | Supported                               | Not applicable; warning |
| `IP_CIDR6`       | Supported | Supported                               | Not applicable; warning |
| `GEOIP`          | Supported | Unsupported; warning with rule identity | Not applicable; warning |
| `GEOSITE`        | Supported | Unsupported; warning with rule identity | Not applicable; warning |
| `DST_PORT`       | Supported | Supported                               | Not applicable; warning |
| `NETWORK`        | Supported | Supported                               | Not applicable; warning |

All formats support deterministic node filtering and ordering. Mihomo and sing-box implement ordered routing plus `DIRECT`, `REJECT`, and `NODE_POOL` actions. Raw VLESS intentionally emits only enabled node URIs; routing rules and default actions are not representable and produce capability warnings rather than silently claiming support.

V0.3 Rule Sets are expanded into the same unified rule stream before adapter compilation. CI-generated compatibility files include a cached Rule Set reference and continue through Mihomo `v1.19.28` and sing-box `1.13.12` real-core validation. This validates core syntax only; the GUI client rows remain not verified.

## Known boundaries

- sing-box deliberately omits `GEOIP` and `GEOSITE` instead of emitting deprecated or misleading route syntax.
- No deprecated sing-box block outbound is generated; reject rules use the current route `reject` action.
- Temporarily `OFFLINE` but enabled nodes remain in subscriptions. Administrative disablement removes a node.
- A disabled referenced pool produces a warning; a missing pool or pool with no enabled members is a compile error.
- Client-core versions change independently of ProxyHub. Any version update requires new checksums, Golden review, and CI validation before changing `validatedAgainst`.
