FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
CMD ["node", "--experimental-sqlite", "src/server.mjs"]
