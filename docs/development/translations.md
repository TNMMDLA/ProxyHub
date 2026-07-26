# Translation maintenance

Add every user-visible string to the relevant namespace in both `en` and `zh-CN`. Keep key
structure, plural suffixes, and interpolation variable names identical. Prefer natural,
action-specific Simplified Chinese; destructive buttons must say what will be deleted.

Do not place HTML, executable links, credentials, tokens, UUIDs, private keys, or environment
values in translation resources. Technical product and protocol names such as ProxyHub, Xray,
VLESS, Reality, Mihomo, sing-box, ETag, YAML, and JSON remain accurate.

Run the i18n tests and `pnpm format:check` before committing. Missing production keys fall back to
English; development logs a safe missing-key warning.
