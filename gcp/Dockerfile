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

RUN mkdir -p /data/objects \
  && chown -R node:node /data

USER node

EXPOSE 8080
