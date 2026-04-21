FROM node:20-slim

# Install Chromium and all required system deps
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Detect and expose the real Chromium path at build time
RUN which chromium || which chromium-browser || echo "chromium not found"

# Skip Puppeteer's bundled Chromium download entirely
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Create non-root user
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && chown -R pptruser:pptruser /app
USER pptruser

EXPOSE 3000

CMD ["node", "server.js"]
