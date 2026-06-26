#!/bin/bash
# prvis-aria deploy script
set -e

echo "=== prvis-aria deploy ==="

# Build sandbox template image (pre-built base — not in docker compose)
echo "[1/3] Building sandbox template image..."
docker build -t aria-sandbox-template:latest -f aria-sandbox/Dockerfile.template aria-sandbox/

# Wipe Kafka data volume if --fresh flag passed
if [[ "$1" == "--fresh" ]]; then
  echo "[2/3] Fresh deploy — wiping Kafka data volume..."
  docker compose down --remove-orphans
  docker volume rm prvis-aria_kafka-data 2>/dev/null || true
else
  echo "[2/3] Stopping stack..."
  docker compose down --remove-orphans
fi

# Build and start all services
echo "[3/3] Starting stack..."
docker compose up -d --build

echo ""
echo "=== Stack status ==="
docker compose ps

echo ""
echo "=== aria-intake health ==="
sleep 5
curl -s http://localhost:8000/health | python3 -m json.tool 2>/dev/null || echo "Not ready yet"
