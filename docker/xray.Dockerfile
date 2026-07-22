ARG XRAY_CORE_VERSION=26.5.9
FROM ghcr.io/xtls/xray-core:${XRAY_CORE_VERSION} AS xray

FROM alpine:3.22
COPY --from=xray /usr/bin/xray /usr/local/bin/xray
COPY docker/xray-entrypoint.sh /opt/proxyhub/xray-entrypoint.sh
RUN chmod 0755 /opt/proxyhub/xray-entrypoint.sh \
  && mkdir -p /etc/xray /var/run/proxyhub
ENTRYPOINT ["/bin/sh", "/opt/proxyhub/xray-entrypoint.sh"]
