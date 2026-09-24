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
COPY server/package.json server/
RUN [ -s /tmp/extra-ca.pem ] && export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; pnpm install --frozen-lockfile --filter @agentspace/server...
COPY spec spec
COPY packages/spec-types packages/spec-types
COPY server server
RUN [ -s /tmp/extra-ca.pem ] && export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem; pnpm --filter @agentspace/server build \
 && pnpm --filter @agentspace/server deploy --legacy --prod /out \
 && cp -r server/dist /out/dist

FROM node:22-slim
ENV NODE_ENV=production PORT=4800 HOST=0.0.0.0 AGENTSPACE_DB=/data/agentspace.db
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4800
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:4800/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
