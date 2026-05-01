FROM node:20-slim

WORKDIR /app

# Dependencies for native modules (WebTorrent uses some)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps first (cached layer if package.json unchanged)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# Downloads go to a named volume (mounted at runtime)
RUN mkdir -p downloads

EXPOSE 3000

CMD ["node", "server.js"]
