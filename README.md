# stream.party

Watch torrents together in real time. Server-side torrent streaming + synchronized playback for everyone in the room.

## Deploy on Railway (free)

1. Go to https://railway.app and sign up
2. Click **New Project** → **Deploy from GitHub repo**
3. Push this folder to a GitHub repo first, then select it
4. Railway auto-detects Node.js and runs `npm start`
5. Click **Generate Domain** to get your public URL
6. Share that URL with friends — everyone opens it and watches in sync

## Deploy on Render (free)

1. Go to https://render.com and sign up
2. Click **New** → **Web Service**
3. Connect your GitHub repo
4. Build command: `npm install`
5. Start command: `node server.js`
6. Click **Create Web Service**

## Run locally

```bash
npm install
node server.js
# Open http://localhost:3000
```

## How it works

- You paste a magnet link — the **server** downloads the torrent (full UDP tracker support, finds all peers)
- The server streams the video to your browser over HTTP with range requests (like Netflix)
- WebSocket keeps everyone in the room in sync — play/pause/seek broadcasts instantly
- Chat sidebar for the party

## Notes

- Only one torrent active at a time per server instance
- For private use — if you want multiple rooms with different torrents simultaneously, you'd need separate deployments
- Downloaded files are stored in `downloads/` temporarily
