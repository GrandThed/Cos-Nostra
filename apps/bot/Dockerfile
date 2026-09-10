# Build context is the repository root (Railway root directory "/"), because the npm
# lockfile lives there. Only the bot workspace is installed.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/bot/package.json apps/bot/
RUN npm ci --workspace apps/bot --include-workspace-root=false --omit=dev

COPY packages/shared packages/shared
COPY apps/bot apps/bot

USER node
EXPOSE 3001
CMD ["npm", "start", "-w", "apps/bot"]
