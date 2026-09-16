#!/bin/sh
set -eu

IMAGE="prom/prometheus:v2.55.1"
if command -v promtool >/dev/null 2>&1; then
  exec promtool check rules infra/monitoring/alerts.yml
fi
exec docker run --rm --entrypoint=/bin/promtool -v "$(pwd)/infra/monitoring:/rules:ro" "$IMAGE" check rules /rules/alerts.yml
