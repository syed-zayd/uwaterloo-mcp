# ------------------------------------------------------------
# 1. Build Stage
# ------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
COPY api/ ./api/
RUN npm run build

# ------------------------------------------------------------
# 2. Production Stage
# ------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Install system dependencies required for Chromium (Puppeteer automated sign-in)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-freefont-ttf \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    LEARN_SESSION_FILE=/app/data/.learn-session

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Create directory for persistent session store and set ownership
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8787

CMD ["node", "dist/src/index.js"]
