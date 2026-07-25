ARG XRAY_CORE_VERSION=26.5.9
FROM ghcr.io/xtls/xray-core:${XRAY_CORE_VERSION} AS xray
FROM node:24-alpine AS build
ARG PROXYHUB_VERSION=development
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG BUILD_ENVIRONMENT=development
ARG DEPLOY_MODE=source
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY release/version.json release/version.json
COPY scripts/release/generate-version.mjs scripts/release/generate-version.mjs
COPY apps/agent/package.json apps/agent/package.json
COPY packages/diagnostics-core/package.json packages/diagnostics-core/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/xray-manager/package.json packages/xray-manager/package.json
RUN pnpm install --filter @proxyhub/agent... --frozen-lockfile
COPY apps/agent apps/agent
COPY packages/diagnostics-core packages/diagnostics-core
COPY packages/shared packages/shared
COPY packages/xray-manager packages/xray-manager
RUN node scripts/release/generate-version.mjs \
  && pnpm --filter @proxyhub/agent... build

FROM node:24-alpine
ARG PROXYHUB_VERSION=development
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG BUILD_ENVIRONMENT=development
ARG DEPLOY_MODE=source
RUN corepack enable
COPY --from=xray /usr/local/bin/xray /usr/local/bin/xray
WORKDIR /app
COPY --from=build /app /app
ENV PROXYHUB_GIT_SHA=${VCS_REF}
ENV PROXYHUB_BUILD_TIME=${BUILD_DATE}
ENV PROXYHUB_BUILD_ENVIRONMENT=${BUILD_ENVIRONMENT}
ENV PROXYHUB_DEPLOY_MODE=${DEPLOY_MODE}
LABEL org.opencontainers.image.title="ProxyHub Agent"
LABEL org.opencontainers.image.version="${PROXYHUB_VERSION}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.source="https://github.com/TNMMDLA/ProxyHub"
EXPOSE 3001
CMD ["pnpm", "--filter", "@proxyhub/agent", "start"]
