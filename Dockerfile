# syntax=docker/dockerfile:1.7

FROM node:22.23.4-bookworm-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./

# Production dependencies only, installed from scratch.
FROM base AS deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Distroless: Node.js and its runtime libraries only, no shell or package manager.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
ARG SWITCHBOARD_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/coreprocess/switchboard" \
      org.opencontainers.image.description="Connects Microsoft Teams channels to Claude Managed Agents" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    SWITCHBOARD_VERSION=${SWITCHBOARD_VERSION} \
    TZ=UTC \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# numeric, so Kubernetes can verify runAsNonRoot (distroless' nonroot user)
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/index.js"]
