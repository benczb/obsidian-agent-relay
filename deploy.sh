#!/bin/sh
set -eu
cd "$(dirname "$0")"
: "${KANBAN_ENV_FILE:?Set KANBAN_ENV_FILE to the absolute path of your private deployment.env (see README.md)}"
ENV_FILE="$KANBAN_ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  echo "Runtime env file not found: $ENV_FILE" >&2
  exit 1
fi
if [ "$#" -eq 0 ]; then
  set -- up -d --build
fi
exec docker compose --env-file "$ENV_FILE" -f compose.hub.yaml "$@"
