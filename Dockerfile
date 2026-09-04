# Build stage — needs dev deps and a toolchain for better-sqlite3.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
# Skip npm's implicit "node-gyp rebuild" for better-sqlite3 (it has a binding.gyp
# but no install script); its bundled N-API prebuild is what gets loaded anyway.
# esbuild's postinstall is a real one, so restore just that.
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY sources ./sources

# The library database lives here — mount a volume so it survives redeploys.
VOLUME ["/data"]
EXPOSE 8080
USER node
CMD ["node", "dist/server/index.js"]
