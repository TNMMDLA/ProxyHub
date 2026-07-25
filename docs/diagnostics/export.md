# Diagnostics export

Administrators can download a bounded JSON diagnostics bundle for support. Export uses the same validated domain schema as the API, recursively redacts secret-like keys and values, replaces absolute paths, caps strings and collections, and rejects the entire export with `DIAGNOSTICS_EXPORT_REDACTION_FAILED` if the final secret scan fails.

The bundle excludes authorization headers, cookies, passwords, tokens, encryption material, Reality UUID/private key/Short ID values, complete Xray configs, subscription output, database rows, environment variables, and absolute host/container paths. Export creation writes one audit record; normal overview polling does not.

Review a bundle before sharing it. Redaction is defense in depth and does not replace normal access controls.
