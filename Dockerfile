FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG VITE_API_BASE_URL="/api"
ARG VITE_MAP_TILE_URL=""
ARG VITE_LOGISTICS_OFFLINE_IMAGERY_URL=""
ARG VITE_LOGISTICS_BUILDINGS_URL=""
ARG VITE_CESIUM_ION_TOKEN=""
ARG VITE_DEM_TERRAIN_URL=""
ARG VITE_ENABLE_WORLD_IMAGERY="true"
ARG VITE_ENABLE_WORLD_TERRAIN="false"
ARG VITE_ENABLE_OSM_BUILDINGS="false"
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_MAP_TILE_URL=$VITE_MAP_TILE_URL
ENV VITE_LOGISTICS_OFFLINE_IMAGERY_URL=$VITE_LOGISTICS_OFFLINE_IMAGERY_URL
ENV VITE_LOGISTICS_BUILDINGS_URL=$VITE_LOGISTICS_BUILDINGS_URL
ENV VITE_CESIUM_ION_TOKEN=$VITE_CESIUM_ION_TOKEN
ENV VITE_DEM_TERRAIN_URL=$VITE_DEM_TERRAIN_URL
ENV VITE_ENABLE_WORLD_IMAGERY=$VITE_ENABLE_WORLD_IMAGERY
ENV VITE_ENABLE_WORLD_TERRAIN=$VITE_ENABLE_WORLD_TERRAIN
ENV VITE_ENABLE_OSM_BUILDINGS=$VITE_ENABLE_OSM_BUILDINGS
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/simulation/package.json ./packages/simulation/package.json
RUN npm ci
COPY apps ./apps
COPY packages ./packages
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ARG PLATFORM_VERSION="0.1.0"
ENV PLATFORM_VERSION=$PLATFORM_VERSION
ARG DEBIAN_MIRROR=""
RUN if [ -n "$DEBIAN_MIRROR" ]; then sed -i "s|http://deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends curl fontconfig fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/simulation/package.json ./packages/simulation/package.json
COPY --from=build /app/packages/simulation/dist ./packages/simulation/dist
RUN mkdir -p /app/data/simulation-runs /app/data/evaluation-results /app/data/v3-files /app/data/map
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
