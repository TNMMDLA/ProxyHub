FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/xray-manager/package.json packages/xray-manager/package.json
RUN pnpm install --filter @proxyhub/server... --frozen-lockfile=false
COPY apps/server apps/server
COPY packages/shared packages/shared
COPY packages/xray-manager packages/xray-manager
RUN pnpm --filter @proxyhub/server db:generate && pnpm --filter @proxyhub/server... build

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @proxyhub/server db:migrate && pnpm --filter @proxyhub/server start"]

