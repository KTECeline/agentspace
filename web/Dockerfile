# Build context: repository root.
FROM node:22-slim AS build
# Optional, off by default: an extra CA for networks that intercept TLS (see CONTRIBUTING.md).
# PEM text, used only by the install/build steps of this stage; the runtime image never has it.
ARG EXTRA_CA_CERT=""
RUN if [ -n "$EXTRA_CA_CERT" ]; then printf '%s\n' "$EXTRA_CA_CERT" > /tmp/extra-ca.pem; fi
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/spec-types/package.json packages/spec-types/
COPY web/package.json web/
RUN [ -s /tmp/extra-ca.pem ] && export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; pnpm install --frozen-lockfile --filter @agentspace/web...
COPY packages/spec-types packages/spec-types
COPY web web
ENV NEXT_TELEMETRY_DISABLED=1
RUN [ -s /tmp/extra-ca.pem ] && export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; pnpm --filter @agentspace/web build

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
