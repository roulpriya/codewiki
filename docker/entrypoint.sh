#!/bin/bash
set -eu

mkdir -p "${DATA_DIR:-/data}"
bun run start -- --host 0.0.0.0 &
web_pid=$!
bun run api &
api_pid=$!

cleanup() {
  kill "$web_pid" "$api_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT
wait -n "$web_pid" "$api_pid"
