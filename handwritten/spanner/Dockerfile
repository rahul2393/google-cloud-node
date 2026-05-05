# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS local-lib
WORKDIR /workspace/spanner
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --ignore-scripts; \
    else \
      echo "package-lock.json not found; using npm install"; \
      npm install --ignore-scripts; \
    fi
COPY . .
RUN npm run compile \
 && mkdir -p /tmp/spanner-pack \
 && npm pack --pack-destination /tmp/spanner-pack \
 && cp /tmp/spanner-pack/google-cloud-spanner-*.tgz /tmp/google-cloud-spanner.tgz

FROM node:22-bookworm-slim AS app-base
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*
COPY bypass-performance/package*.json ./
RUN npm install --omit=dev
COPY bypass-performance/main.js ./main.js
USER node
ENTRYPOINT ["node", "/app/main.js"]

FROM app-base AS runtime-npm
ARG SPANNER_VERSION=8.7.0
USER root
RUN npm install --omit=dev "@google-cloud/spanner@${SPANNER_VERSION}" \
 && npm cache clean --force \
 && node -e "console.log(require('@google-cloud/spanner/package.json').version)"
USER node

FROM app-base AS runtime-local
COPY --from=local-lib /tmp/google-cloud-spanner.tgz /tmp/google-cloud-spanner.tgz
USER root
RUN npm install --omit=dev /tmp/google-cloud-spanner.tgz \
 && npm cache clean --force \
 && node -e "console.log(require('@google-cloud/spanner/package.json').version)"
USER node
