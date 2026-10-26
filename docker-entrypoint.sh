#!/bin/sh
# Make the data folder (and any mounted volume) writable by the app user, then drop root.
mkdir -p /app/data
chown -R app:app /app/data 2>/dev/null || true
export HOME=/home/app
exec setpriv --reuid=app --regid=app --init-groups node /app/server.js
