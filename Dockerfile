FROM oven/bun:1.3.12-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

COPY docker/entrypoint.sh /usr/local/bin/codewiki
RUN chmod +x /usr/local/bin/codewiki && mkdir -p /data

ENV DATA_DIR=/data \
  LOCAL_EMBEDDING_CACHE_DIR=/data/huggingface \
  API_ORIGIN=http://localhost:3001 \
  APP_ORIGIN=http://localhost:3000

VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/codewiki"]
