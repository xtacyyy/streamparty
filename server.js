const http = require("http");
const fs = require("fs");
const path = require("path");
const WebTorrent = require("webtorrent");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const client = new WebTorrent();
let activeTorrent = null;
let activeFile = null;

const VIDEO_EXTS = ["mp4", "mkv", "webm", "avi", "mov", "m4v", "ogv", "ogg", "ts"];

// ── Rooms: { roomId -> Set of ws connections } ──
const rooms = {};

function findVideoFile(torrent) {
  return torrent.files.reduce((best, f) => {
    const ext = f.name.split(".").pop().toLowerCase();
    if (VIDEO_EXTS.includes(ext)) return (!best || f.length > best.length) ? f : best;
    return best;
  }, null);
}

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── POST /api/load — load a magnet link ──
  if (req.method === "POST" && u.pathname === "/api/load") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      let magnet;
      try { magnet = JSON.parse(body).magnet; } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }
      if (!magnet) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing magnet" })); return; }

      // Remove old torrent
      if (activeTorrent) {
        try { client.remove(activeTorrent.infoHash); } catch (e) {}
        activeTorrent = null;
        activeFile = null;
      }

      console.log("[torrent] loading:", magnet.slice(0, 80));

      const torrent = client.add(magnet, { path: path.join(__dirname, "downloads") });

      torrent.once("ready", () => {
        activeTorrent = torrent;
        const file = findVideoFile(torrent);
        if (!file) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "No video file found", files: torrent.files.map(f => f.name) }));
          return;
        }
        activeFile = file;
        file.select();
        console.log("[torrent] ready:", file.name, `(${(file.length / 1024 / 1024).toFixed(1)} MB)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          name: torrent.name,
          file: file.name,
          size: file.length,
          streamUrl: "/stream"
        }));
      });

      torrent.once("error", e => {
        console.error("[torrent] error:", e.message);
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      });

      setTimeout(() => {
        if (!activeTorrent && !res.headersSent) {
          res.writeHead(408);
          res.end(JSON.stringify({ error: "Timeout: could not find torrent metadata after 30s" }));
        }
      }, 30000);
    });
    return;
  }

  // ── GET /api/status — torrent download stats ──
  if (req.method === "GET" && u.pathname === "/api/status") {
    if (!activeTorrent) { res.writeHead(404); res.end(JSON.stringify({ error: "No active torrent" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: activeTorrent.name,
      file: activeFile?.name,
      size: activeFile?.length,
      progress: activeTorrent.progress,
      downloadSpeed: activeTorrent.downloadSpeed,
      numPeers: activeTorrent.numPeers,
      done: activeTorrent.done
    }));
    return;
  }

  // ── GET /stream — stream video with range support ──
  if (req.method === "GET" && u.pathname === "/stream") {
    if (!activeFile) { res.writeHead(404); res.end("No active stream"); return; }

    const fileSize = activeFile.length;
    const rangeHeader = req.headers.range;
    const ext = activeFile.name.split(".").pop().toLowerCase();
    const mimeTypes = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", mov: "video/quicktime", ogv: "video/ogg", ogg: "video/ogg", ts: "video/mp2t", m4v: "video/mp4" };
    const contentType = mimeTypes[ext] || "video/mp4";

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
      });

      const stream = activeFile.createReadStream({ start, end });
      stream.pipe(res);
      stream.on("error", e => { console.error("[stream] error:", e.message); res.end(); });
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      const stream = activeFile.createReadStream();
      stream.pipe(res);
      stream.on("error", e => { console.error("[stream] error:", e.message); res.end(); });
    }
    return;
  }

  // ── GET / — serve the app HTML ──
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    const htmlPath = path.join(__dirname, "public", "index.html");
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); res.end("index.html not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(htmlPath).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ── WebSocket Server — room sync ──
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws._roomId = null;
  ws._name = "Viewer";

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Join a room
    if (msg.type === "join") {
      const roomId = msg.roomId;
      if (!rooms[roomId]) rooms[roomId] = new Set();
      ws._roomId = roomId;
      ws._name = msg.name || "Viewer";
      rooms[roomId].add(ws);
      // Notify others
      broadcast(roomId, ws, JSON.stringify({ type: "joined", sender: ws._name }));
      console.log(`[room] ${ws._name} joined ${roomId} (${rooms[roomId].size} total)`);
      return;
    }

    // Relay sync events to everyone else in the room
    if (["play", "pause", "seek", "chat", "magnet"].includes(msg.type) && ws._roomId) {
      broadcast(ws._roomId, ws, JSON.stringify({ ...msg, sender: ws._name }));
    }
  });

  ws.on("close", () => {
    if (ws._roomId && rooms[ws._roomId]) {
      rooms[ws._roomId].delete(ws);
      broadcast(ws._roomId, ws, JSON.stringify({ type: "left", sender: ws._name }));
      if (rooms[ws._roomId].size === 0) delete rooms[ws._roomId];
    }
  });
});

function broadcast(roomId, sender, data) {
  if (!rooms[roomId]) return;
  for (const ws of rooms[roomId]) {
    if (ws !== sender && ws.readyState === 1) ws.send(data);
  }
}

server.listen(PORT, () => {
  console.log(`\n  stream.party running at http://localhost:${PORT}\n`);
});
