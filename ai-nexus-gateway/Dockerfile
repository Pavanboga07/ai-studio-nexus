FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm install -D tsx

COPY src ./src
COPY .env.example ./.env.example

ENV PORT=4000
ENV HOST=0.0.0.0
ENV NODE_WS_PATH=/ws/node

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

CMD ["npx", "tsx", "src/server/gatewayMain.ts"]
