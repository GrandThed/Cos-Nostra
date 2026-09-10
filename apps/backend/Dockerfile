# Build context is the repository root (Railway root directory "/"), because the npm
# lockfile lives there. Only the backend workspace is installed.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
RUN npm ci --workspace apps/backend --include-workspace-root=false --omit=dev

COPY packages/shared packages/shared
COPY apps/backend apps/backend

USER node
EXPOSE 3000
# Railway runs `npm run migrate -w apps/backend` as the pre-deploy command in this same image.
CMD ["npm", "start", "-w", "apps/backend"]
