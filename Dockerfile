FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10.33.2
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
# ffmpeg records event clips from ring-mqtt's RTSP stream (stream copy; no re-encode).
RUN apk add --no-cache ffmpeg tzdata
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3014 \
    DATA_DIR=/data \
    FOOTAGE_ROOT=/footage \
    TZ=America/Chicago
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
EXPOSE 3014
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3014/health || exit 1
CMD ["node", "dist/server.js"]
