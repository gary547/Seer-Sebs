FROM gcr.io/cloud-sql-connectors/cloud-sql-proxy@sha256:54e23cad9aeeedbf88ab75f993146631b878035f702b31c51885a932e0c7286c AS cloud-sql-proxy

FROM postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193 AS ca-certificates

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /workspace

COPY gcp/package.json gcp/package-lock.json ./gcp/
RUN npm ci --prefix gcp --ignore-scripts --fund=false --audit=false

COPY tsconfig.gcp.json tsconfig.gcp.build.json ./
COPY gcp ./gcp

RUN ./gcp/node_modules/.bin/tsc -p tsconfig.gcp.build.json

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

WORKDIR /app

COPY gcp/package.json gcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --fund=false --audit=false \
  && npm cache clean --force

COPY --from=build /workspace/dist/gcp ./dist/gcp
COPY --from=ca-certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=cloud-sql-proxy /cloud-sql-proxy /usr/local/bin/cloud-sql-proxy
COPY gcp/scripts/migrate-database.mjs gcp/scripts/managed-migrate-database.mjs ./gcp/scripts/
COPY gcp/database/bootstrap/run-managed-database-transfer.sh /usr/local/bin/run-managed-database-transfer

RUN chmod 0555 /usr/local/bin/cloud-sql-proxy /usr/local/bin/run-managed-database-transfer \
  && chown -R node:node /app

USER node

ENTRYPOINT ["/usr/local/bin/run-managed-database-transfer"]
