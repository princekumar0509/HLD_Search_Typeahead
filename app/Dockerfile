# Single image used for THREE roles (app replicas, the worker, the one-shot
# seed loader) — same code, different command. One image keeps the build simple
# and guarantees all three run identical logic.
FROM node:20-alpine

WORKDIR /app

# Install deps first so Docker layer-caches them when only source changes.
COPY package.json ./
RUN npm install --omit=dev

# App source, workers, scripts, and static frontend.
COPY src ./src
COPY workers ./workers
COPY scripts ./scripts
COPY public ./public

EXPOSE 3000

# Default command runs an app server; compose overrides it for the worker/seed.
CMD ["node", "src/server.js"]
