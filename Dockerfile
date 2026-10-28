# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY next.config.ts tsconfig.json next-env.d.ts ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build -- --webpack
RUN node -e "const fs=require('node:fs'); const ts=require('typescript'); fs.writeFileSync('next.config.mjs', ts.transpileModule(fs.readFileSync('next.config.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText)" \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG CODEX_VERSION=0.165.0
RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --omit=dev @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CODEX_HOME=/home/node/.codex \
    VMESTE_RECOGNITION_PROVIDER=codex \
    VMESTE_DAILY_RECOGNITION_LIMIT=0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.mjs ./next.config.mjs
COPY --from=build --chown=node:node /app/src/lib/pdf-render-worker.mjs ./src/lib/pdf-render-worker.mjs
COPY --from=build --chown=node:node /app/scripts/cloud-worker*.mjs ./scripts/
COPY --from=build --chown=node:node /app/scripts/run-remote-worker.mjs ./scripts/
RUN mkdir -p /app/.local /home/node/.codex /home/node/.local/state/vmeste \
    && chown -R node:node /app /home/node/.codex /home/node/.local \
    && chmod 700 /app/.local /home/node/.codex /home/node/.local/state/vmeste
COPY --chown=node:node --chmod=600 deploy/codex.config.toml /home/node/.codex/config.toml
USER node
# There is intentionally no EXPOSE or host port mapping. Only the queue consumer calls this API.
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/recognize',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/run-remote-worker.mjs"]
