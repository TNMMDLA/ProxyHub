ARG XRAY_CORE_VERSION=26.5.9
FROM ghcr.io/xtls/xray-core:${XRAY_CORE_VERSION} AS xray
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/xray-manager/package.json packages/xray-manager/package.json
RUN pnpm install --filter @proxyhub/agent... --frozen-lockfile=false
COPY apps/agent apps/agent
COPY packages/shared packages/shared
COPY packages/xray-manager packages/xray-manager
RUN pnpm --filter @proxyhub/agent... build

FROM node:24-alpine
RUN corepack enable
COPY --from=xray /usr/bin/xray /usr/local/bin/xray
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3001
CMD ["pnpm", "--filter", "@proxyhub/agent", "start"]
