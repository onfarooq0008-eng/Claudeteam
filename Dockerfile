FROM node:22-slim

# Tools your agents can use from the shell: git, curl, python3 (npm/node come with the base image)
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js docker-entrypoint.sh ./
COPY public ./public

RUN useradd -m -u 1001 app \
 && chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R app:app /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    DATA_DIR=/app/data

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fs http://127.0.0.1:${PORT}/healthz || exit 1

# Starts as root only to fix volume permissions, then runs the app as the non-root "app" user.
# The app refuses to start on 0.0.0.0 unless APP_PASSWORD is set.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
