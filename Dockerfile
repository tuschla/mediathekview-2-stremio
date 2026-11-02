FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94

WORKDIR /app
# No runtime dependencies: Node runs the TypeScript sources directly (type stripping).
COPY package.json ./
COPY src ./src

ENV PORT=7000
EXPOSE 7000
USER node

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "src/server.ts"]
