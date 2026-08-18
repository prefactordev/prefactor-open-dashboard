# Two stages: build the frontend with dev dependencies, then ship a runtime
# with NO node_modules at all — the server is zero-dependency Node, so the
# final image is just Node + this repo's files + the built dist/.
#
# Run it (the password is REQUIRED — the server refuses to expose itself
# beyond localhost without one, and in a container it must bind 0.0.0.0):
#
#   docker build -t prefactor-open-dashboard .
#   docker run -p 8788:8788 -v pfdash-data:/data \
#     -e DASHBOARD_PASSWORD=change-me \
#     -e PREFACTOR_API_TOKEN=eyJ... \
#     prefactor-open-dashboard
#
# The /data volume keeps the cache and saved token across restarts; without
# it every start re-backfills your whole history.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npx tsc --noEmit && npx vite build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    BIND_HOST=0.0.0.0 \
    PORT=8788
COPY package.json server.mjs ./
COPY server ./server
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 8788
# Drop root: the server only needs to read its files and write /data.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
CMD ["node", "server.mjs"]
