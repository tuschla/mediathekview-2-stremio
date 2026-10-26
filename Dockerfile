FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

WORKDIR /app
# No runtime dependencies: Node runs the TypeScript sources directly (type stripping).
COPY package.json ./
COPY src ./src

ENV PORT=7000
EXPOSE 7000
USER node

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "src/server.ts"]
