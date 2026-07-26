# Nodes

Create a VLESS Reality node from Nodes. ProxyHub tests the Reality target before saving, generates
the UUID and key material, validates the complete Xray configuration, applies it atomically, and
keeps the previous running configuration if validation or health checks fail.

Before deletion, ProxyHub reports node pool membership. Deletion is blocked when it would leave a
pool empty; remove or replace the dependency first. Use the controlled Share action for an
unredacted single-node URI. Subscription previews are always sanitized.
