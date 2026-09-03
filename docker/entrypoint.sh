#!/bin/bash
set -eu

mkdir -p "${DATA_DIR:-/data}"
bun run start &
web_pid=$!

cleanup() {
  kill "$web_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT
wait "$web_pid"
