# Playwright's image already carries Chromium plus every system library it needs.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_URL=file:/app/data/dev.db

COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

COPY . .
RUN npm run build

# The SQLite file lives on a volume so configs and alert history survive redeploys.
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 3000
# The poller boots with the server via instrumentation.ts, so this is all it takes.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run start"]
