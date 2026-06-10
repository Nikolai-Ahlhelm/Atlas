FROM node:26-bookworm-slim

LABEL org.opencontainers.image.title="Atlas"
LABEL org.opencontainers.image.source="https://github.com/Nikolai-Ahlhelm/Atlas"

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY content ./content
COPY locales ./locales
COPY plugins ./plugins

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
