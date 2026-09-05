# syntax=docker/dockerfile:1

FROM node:24.20.0-alpine3.23@sha256:0388af2af070cd4736a1567cfed02469ba117848845b4165d87a333edb53d2ca AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:24.20.0-alpine3.23@sha256:0388af2af070cd4736a1567cfed02469ba117848845b4165d87a333edb53d2ca AS runtime

RUN addgroup -g 10001 -S nodejs && adduser -S -u 10001 -G nodejs nodejs

WORKDIR /app

COPY --from=deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --chown=10001:10001 package.json ./
COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 migrations ./migrations
COPY --chown=10001:10001 scripts/migrate.mjs ./scripts/migrate.mjs

USER 10001:10001

ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown

ENV NODE_ENV=production
ENV PORT=3000
ENV APP_VERSION=$APP_VERSION
ENV GIT_SHA=$GIT_SHA
ENV BUILD_DATE=$BUILD_DATE

LABEL org.opencontainers.image.title="mini-commerce"
LABEL org.opencontainers.image.description="Mini Commerce production service"
LABEL org.opencontainers.image.version=$APP_VERSION
LABEL org.opencontainers.image.revision=$GIT_SHA
LABEL org.opencontainers.image.created=$BUILD_DATE

EXPOSE 3000
EXPOSE 3001

CMD ["node", "--import", "./src/register-instrumentation-hooks.js", "--import", "./src/instrumentation.js", "src/server.js"]
