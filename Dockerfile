# AirGuard Web: build the React app, then run the Node API serving it.
FROM node:20.17.0-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:20.17.0-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server/src ./server/src
COPY --from=web /src/web/dist ./web/dist
# data/db.json lives in a volume (users' token hashes + contacts)
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/manifest.webmanifest || exit 1
CMD ["node", "server/src/server.js"]
