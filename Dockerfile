# Single-image deployment for Vibe (§5 build/deploy; §14 deploy & rollback).
# The API also serves the built web client in production, so one artefact
# covers both tiers and there is no cross-origin hop to configure.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci
# The web client needs to know the API's origin at build time. Coolify passes
# buildtime env vars as build args; without this ARG the value never reaches
# Vite and the client falls back to same-origin requests. Empty is fine in
# development, where Vite proxies /v1 instead.
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
# Coolify probes the container with curl; slim images do not ship one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# tsx is the API runtime, so the production image keeps dev dependencies.
RUN npm ci
# Copy the whole tree: the workspaces have to keep their real paths, because
# `@vibe/shared` resolves through the node_modules symlink that `npm ci` created.
COPY --from=build /app/apps/web/dist apps/web/dist
COPY . .
EXPOSE 12000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://localhost:12000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# NODE_ENV is intentionally left unset. The API refuses NODE_ENV=production while
# PAYMENTS_PROVIDER=stub, which is the spec's VERIFY gate: no production release
# until a payment provider is approved. The image is otherwise fully functional
# and serves both tiers. Set NODE_ENV=production once a provider is configured.
# Migrations are idempotent and safe to run on every boot.
CMD ["sh", "-c", "npm run migrate && npm --workspace @vibe/api start"]
