# Portabel: läuft identisch auf Railway, Render und Fly.io.
FROM node:22-slim

WORKDIR /app

# Nur Manifeste zuerst -> besseres Layer-Caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY landing.html impressum.html datenschutz.html agb.html ./

ENV NODE_ENV=production
# Host setzt $PORT; unsere App liest process.env.PORT
EXPOSE 3000

CMD ["node", "src/server.js"]
