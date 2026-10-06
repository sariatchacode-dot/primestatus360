FROM node:20-slim

# Chromium + Xvfb (virtual framebuffer) + system fonts
# Xvfb is required: canvas.captureStream() needs a real X11 display compositor
# to deliver frames to MediaRecorder. Without it the video is always empty.
RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    xauth \
    fonts-liberation \
    fonts-noto-color-emoji \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Use the system Chromium — skip Puppeteer's bundled download
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
RUN npm prune --omit=dev

EXPOSE 3000
# xvfb-run starts a virtual display (:99, 1280x800 24-bit) so Chromium's
# canvas compositing pipeline works — required for captureStream/MediaRecorder.
CMD ["sh", "-c", "xvfb-run -a -s '-screen 0 1280x800x24' node dist/index.js"]
