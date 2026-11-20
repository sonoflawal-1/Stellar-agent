# syntax=docker/dockerfile:1

# ---- Build stage: install all deps and compile TypeScript ----
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies (including dev deps needed for the build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy sources and build
COPY tsconfig.json* ./
COPY src ./src
RUN npm run build

# Prune dev dependencies for the runtime image
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Copy compiled output, migrations, and production dependencies
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY migrations ./migrations

# Create a non-root user and hand over ownership of the app directory
RUN useradd -r -u 10001 indexer \
    && chown -R indexer:indexer /app

USER indexer

EXPOSE 8080

# Container healthcheck against the service health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run migrations (with advisory lock) on every start, then start the indexer
CMD ["sh","-c","node dist/migrate.js && node dist/index.js"]