FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/xray-manager/package.json packages/xray-manager/package.json
COPY packages/policy-core/package.json packages/policy-core/package.json
COPY packages/rule-set-core/package.json packages/rule-set-core/package.json
RUN pnpm install --filter @proxyhub/server... --frozen-lockfile
COPY apps/server apps/server
COPY packages/shared packages/shared
COPY packages/xray-manager packages/xray-manager
COPY packages/policy-core packages/policy-core
COPY packages/rule-set-core packages/rule-set-core
COPY scripts/runtime/verify-workspace-packages.mjs scripts/runtime/verify-workspace-packages.mjs
RUN pnpm --filter @proxyhub/server db:generate \
  && pnpm --filter @proxyhub/server... build \
  && node scripts/runtime/verify-workspace-packages.mjs

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @proxyhub/server db:migrate && pnpm --filter @proxyhub/server start"]
