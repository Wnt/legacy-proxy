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
# apk packages (here and in the runtime stage) come from the pinned base
# image's Alpine release branch and are verified against the signing keys
# inside that pinned image. They are not version-pinned: Alpine drops
# superseded versions from its mirrors, which would break rebuilds.
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY package.json package-lock.json tsconfig.json ./
# better-sqlite3's install script would otherwise download an unverified
# prebuilt binary from GitHub; compile it from the lockfile-verified npm
# tarball against the base image's own Node headers instead.
ENV npm_config_build_from_source=better-sqlite3 \
    npm_config_nodedir=/usr/local
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
 && npm_config_build_from_source=better-sqlite3 npm_config_nodedir=/usr/local \
    npm ci --omit=dev --no-audit --no-fund \
 && apk del .build \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
USER proxy
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
