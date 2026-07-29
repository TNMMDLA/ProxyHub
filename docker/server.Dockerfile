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
COPY apps/server/package.json apps/server/package.json
COPY packages/diagnostics-core/package.json packages/diagnostics-core/package.json
COPY packages/network-performance-core/package.json packages/network-performance-core/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/users-core/package.json packages/users-core/package.json
COPY packages/xray-manager/package.json packages/xray-manager/package.json
COPY packages/policy-core/package.json packages/policy-core/package.json
COPY packages/rule-set-core/package.json packages/rule-set-core/package.json
RUN pnpm install --filter @proxyhub/server... --frozen-lockfile
COPY apps/server apps/server
COPY packages/diagnostics-core packages/diagnostics-core
COPY packages/network-performance-core packages/network-performance-core
COPY packages/shared packages/shared
COPY packages/users-core packages/users-core
COPY packages/xray-manager packages/xray-manager
COPY packages/policy-core packages/policy-core
COPY packages/rule-set-core packages/rule-set-core
COPY scripts/runtime/verify-workspace-packages.mjs scripts/runtime/verify-workspace-packages.mjs
RUN node scripts/release/generate-version.mjs \
  && pnpm --filter @proxyhub/server db:generate \
  && pnpm --filter @proxyhub/server... build \
  && node scripts/runtime/verify-workspace-packages.mjs

FROM node:24-alpine
ARG PROXYHUB_VERSION=development
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG BUILD_ENVIRONMENT=development
ARG DEPLOY_MODE=source
RUN corepack enable \
  && apk add --no-cache sqlite \
  && sqlite3 --version
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
ENV PROXYHUB_GIT_SHA=${VCS_REF}
ENV PROXYHUB_BUILD_TIME=${BUILD_DATE}
ENV PROXYHUB_BUILD_ENVIRONMENT=${BUILD_ENVIRONMENT}
ENV PROXYHUB_DEPLOY_MODE=${DEPLOY_MODE}
LABEL org.opencontainers.image.title="ProxyHub Server"
LABEL org.opencontainers.image.version="${PROXYHUB_VERSION}"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.source="https://github.com/TNMMDLA/ProxyHub"
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @proxyhub/server db:migrate && pnpm --filter @proxyhub/server start"]
