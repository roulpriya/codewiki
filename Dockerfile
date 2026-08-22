FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

COPY docker/entrypoint.sh /usr/local/bin/codewiki
RUN chmod +x /usr/local/bin/codewiki && mkdir -p /data

ENV DATA_DIR=/data \
  API_ORIGIN=http://localhost:3001 \
  APP_ORIGIN=http://localhost:3000

VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/codewiki"]
