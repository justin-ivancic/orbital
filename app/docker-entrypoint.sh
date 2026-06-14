#!/bin/sh
set -eu

APP_DATA_DIR="${APP_DATA_DIR:-/app/data}"
APP_RUN_USER="${APP_RUN_USER:-node}"
export APP_DATA_DIR

mkdir -p "$APP_DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  if ! gosu "$APP_RUN_USER" sh -c 'test -w "$APP_DATA_DIR"'; then
    if chown -R "$APP_RUN_USER:$APP_RUN_USER" "$APP_DATA_DIR"; then
      true
    else
      echo "Warning: could not change ownership of $APP_DATA_DIR; starting as root so existing root-owned data remains writable." >&2
      exec "$@"
    fi
  fi

  exec gosu "$APP_RUN_USER" "$@"
fi

exec "$@"
