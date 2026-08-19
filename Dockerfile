# Playwright's image already carries Chromium plus every system library it needs.
# Giữ tag khớp với playwright-core trong package.json, nếu không browser trong
# image sẽ lệch revision so với thư viện.
FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app
ENV DATA_FILE=/app/data/db.json

# NODE_ENV chỉ đặt sau khi build: `npm ci` với NODE_ENV=production sẽ bỏ qua
# devDependencies, mà TypeScript và Tailwind nằm trong đó.
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
ENV NODE_ENV=production

# The JSON file lives on a volume so configs and alert history survive redeploys.
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 3000
# The poller boots with the server via instrumentation.ts, so this is all it takes.
CMD ["npm", "run", "start"]
