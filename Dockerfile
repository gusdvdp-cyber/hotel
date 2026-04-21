FROM node:20

# Install shared libraries required by Puppeteer's bundled Chromium
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libx11-xcb1 \
    fonts-liberation \
    wget \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Let Puppeteer download its own compatible Chromium during npm install
RUN npm install --omit=dev

COPY . .

# Create non-root user
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && chown -R pptruser:pptruser /app \
    && chown -R pptruser:pptruser /root/.npm 2>/dev/null || true

USER pptruser

EXPOSE 3000

CMD ["node", "server.js"]
