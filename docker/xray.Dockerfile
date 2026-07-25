ARG XRAY_CORE_VERSION=26.5.9
FROM ghcr.io/xtls/xray-core:${XRAY_CORE_VERSION} AS xray

FROM alpine:3.22
ARG PROXYHUB_VERSION=development
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG XRAY_CORE_VERSION=26.5.9
COPY --from=xray /usr/local/bin/xray /usr/local/bin/xray
COPY docker/xray-entrypoint.sh /opt/proxyhub/xray-entrypoint.sh
RUN chmod 0755 /opt/proxyhub/xray-entrypoint.sh \
  && mkdir -p /etc/xray /var/run/proxyhub \
  && xray version
LABEL org.opencontainers.image.title="ProxyHub Xray Runtime"
LABEL org.opencontainers.image.version="${PROXYHUB_VERSION}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.source="https://github.com/TNMMDLA/ProxyHub"
LABEL org.opencontainers.image.base.name="ghcr.io/xtls/xray-core:${XRAY_CORE_VERSION}"
ENTRYPOINT ["/bin/sh", "/opt/proxyhub/xray-entrypoint.sh"]
