# 🎬 stream.party

Watch torrents together, in real time, from anywhere. Drop a magnet link, share the room, and you're all watching the same frame at the same moment — play, pause, seek, it all syncs instantly. Oh, and there's a chat sidebar because obviously.

No accounts. No installs. Just vibes.

---

## 🚀 Deploy on Render (free tier)

1. Go to [render.com](https://render.com) and sign up
2. Click **New** → **Web Service** → connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Hit **Create Web Service** and grab your URL
6. Send it to your friends and start watching

## 🚂 Deploy on Railway (also free)

1. Go to [railway.app](https://railway.app) and sign up
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your repo — Railway auto-detects Node and runs `npm start`
4. Click **Generate Domain**, share the link, done

## 💻 Run locally

```bash
npm install
node server.js
# Open http://localhost:3000
```

---

## How it works

- You paste a magnet link (or a `.torrent` URL) — the **server** handles all the downloading, peer discovery, the whole thing
- Video is streamed to your browser over HTTP with range requests, just like a real streaming service
- A WebSocket keeps everyone in the room perfectly in sync — play, pause, seek, it all broadcasts instantly to the whole party
- Built-in chat sidebar for the running commentary

## A few thing