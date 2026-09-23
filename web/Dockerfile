# Build context: repository root.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/spec-types/package.json packages/spec-types/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @agentspace/web...
COPY packages/spec-types packages/spec-types
COPY web web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @agentspace/web build

FROM node:22-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=4801 HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output keeps the monorepo layout (outputFileTracingRoot = repo root).
COPY --from=build --chown=node:node /repo/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/web/.next/static ./web/.next/static
COPY --from=build --chown=node:node /repo/web/public ./web/public
USER node
EXPOSE 4801
CMD ["node", "web/server.js"]
