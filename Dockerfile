FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npx tsc -b && npx vite build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
# data/ is a mounted volume holding the local connection registry and credentials; the app
# has no reason to run as uid 0 to read it. node:22-alpine ships the unprivileged
# "node" user (uid 1000) — create the mount point owned by it so the volume inherits.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3001
CMD ["npx", "tsx", "server/index.ts"]
