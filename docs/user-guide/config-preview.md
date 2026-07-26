# Sanitized Configuration Preview

Preview uses the production compiler, then removes UUIDs, Short IDs, subscription tokens,
credential-bearing URLs, authorization values, and any private key material. Reality public keys
may remain because they are client-facing public material.

Only sanitized output can be copied. There is no “show unredacted secrets” control. Preview is
limited to 1 MiB, 100 nodes, 2,000 expanded rules, two concurrent compiles, and a ten-second
timeout. Truncation is clearly reported and does not update public state.
