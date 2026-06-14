FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=4300
ENV APP_DATA_DIR=/app/data

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 4300

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4300) + '/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["npm", "run", "start"]
