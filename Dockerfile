# Konuşgaç server + web client in one image.
#   docker build -t konusgac .
#   docker run -d -p 3001:3001 -p 40000:40000/udp -p 40000:40000/tcp -e KONUSGAC_RTC_ADDRESS=<sunucunun IP'si> -v konusgac-veri:/data konusgac
# Debian (glibc) rather than Alpine: the voice server (mediasoup) ships ready-built for it.
FROM node:24-bookworm-slim AS build
WORKDIR /app
# The desktop package's Electron is not needed on a server.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
RUN npm ci
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web
RUN npm run build

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source=https://github.com/atunca96/konusgac \
      org.opencontainers.image.description="Konuşgaç sunucusu" \
      org.opencontainers.image.licenses=AGPL-3.0-only
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    KONUSGAC_RTC_PORT=40000 \
    KONUSGAC_DB=/data/konusgac.db \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Only the server's runtime packages: no build tools, no Electron. The voice server's worker
# binary comes from the build stage, so this stage downloads nothing extra.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
RUN npm ci --omit=dev --ignore-scripts --workspace @konusgac/server && npm cache clean --force
COPY --from=build /app/node_modules/mediasoup/worker/out/Release/mediasoup-worker node_modules/mediasoup/worker/out/Release/mediasoup-worker
COPY packages/shared packages/shared
COPY packages/server/src packages/server/src
COPY --from=build /app/packages/web/dist packages/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# 3001: web and API (behind HTTPS); 40000 UDP and TCP: voice and video.
EXPOSE 3001 40000/udp 40000/tcp
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3001/api/config').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "node_modules/tsx/dist/cli.mjs", "packages/server/src/index.ts"]
