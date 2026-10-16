# Build, digest and SBOM record
# - The deployed image is built from a reviewed commit of this repository by
#   the ops repository's tools/img-build (BuildKit, pushed to the local
#   registry). Production runs it by digest: the image@sha256 reference is
#   recorded in the ops repo's legacy-proxy Deployment manifest
#   (deploy/prod/cutover/25-legacy-proxy.yaml), so moving a tag changes nothing.
# - Images published to GHCR by .github/workflows/docker.yml get a signed
#   build provenance attestation; verify with
#     gh attestation verify oci://ghcr.io/<owner>/legacy-proxy:<tag> --owner <owner>
# - SBOM for a deployed digest: generate it from the image itself, e.g.
#     syft <registry>/webmail/legacy-proxy@sha256:<digest> -o spdx-json
#   or build with `docker buildx build --sbom=true ...` and read it with
#     docker buildx imagetools inspect <image>@sha256:<digest> --format '{{ json .SBOM }}'
#   Keep the SBOM next to the recorded digest when a new image is deployed.
#
# Base images are pinned as tag@sha256:<multi-arch index digest>. To bump, change
# the tag and digest together: docker buildx imagetools inspect <image>:<tag>
FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# This stage only runs tsc, so no dependency lifecycle script runs here
# (esbuild's and better-sqlite3's install scripts can fetch binaries outside
# the lockfile).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
# Alpine packages (this RUN and the next) are deliberately left unpinned
# (owner decision, audit deploy-4): pinning apk versions breaks rebuilds
# whenever Alpine rotates packages out of its mirrors. They come from the
# pinned base's own release branch, verified against its signing keys.
RUN apk add --no-cache sqlite-libs tini \
 && addgroup -S proxy \
 && adduser -S proxy -G proxy \
 && mkdir -p /data \
 && chown -R proxy:proxy /data
COPY package.json package-lock.json ./
# Lifecycle scripts are off; the one native module, better-sqlite3, is then
# compiled from its lockfile-verified tarball against the base image's Node
# headers, never from a prebuilt binary downloaded from GitHub. The toolchain
# apk packages are unpinned on purpose, as above.
RUN apk add --no-cache --virtual .build python3 make g++ sqlite-dev \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm_config_build_from_source=better-sqlite3 npm_config_nodedir=/usr/local \
    npm rebuild better-sqlite3 \
 && apk del .build \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
USER proxy
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
