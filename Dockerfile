# Base images are pinned as tag@sha256:<multi-arch index digest>. To bump, change
# the tag and digest together: docker buildx imagetools inspect <image>:<tag>
FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
RUN apk add --no-cache sqlite-libs tini \
 && addgroup -S proxy \
 && adduser -S proxy -G proxy \
 && mkdir -p /data \
 && chown -R proxy:proxy /data
COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .build python3 make g++ sqlite-dev \
 && npm ci --omit=dev --no-audit --no-fund \
 && apk del .build \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
USER proxy
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
