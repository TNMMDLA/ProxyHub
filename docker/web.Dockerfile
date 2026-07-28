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
COPY apps/web/package.json apps/web/package.json
COPY packages/diagnostics-core/package.json packages/diagnostics-core/package.json
COPY packages/network-performance-core/package.json packages/network-performance-core/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --filter @proxyhub/web... --frozen-lockfile
COPY apps/web apps/web
COPY packages/diagnostics-core packages/diagnostics-core
COPY packages/network-performance-core packages/network-performance-core
COPY packages/shared packages/shared
RUN node scripts/release/generate-version.mjs \
  && pnpm --filter @proxyhub/web... build

FROM nginx:1.29-alpine
ARG PROXYHUB_VERSION=development
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
LABEL org.opencontainers.image.title="ProxyHub Web"
LABEL org.opencontainers.image.version="${PROXYHUB_VERSION}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.source="https://github.com/TNMMDLA/ProxyHub"
EXPOSE 80
