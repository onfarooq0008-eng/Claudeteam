FROM node:22-slim

# git/ca-certificates are used by Claude Code; Claude Code CLI powers the "Claude Code" accounts
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# Run as a non-root user; /app/data holds accounts, chat history and the shared workspace
RUN useradd -m -u 1001 app \
 && mkdir -p /app/data \
 && chown -R app:app /app
USER app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    DATA_DIR=/app/data

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fs http://127.0.0.1:${PORT}/healthz || exit 1

# The app refuses to start on 0.0.0.0 unless APP_PASSWORD is set
CMD ["node", "server.js"]
