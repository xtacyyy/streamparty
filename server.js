import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath, URL as NodeURL } from "url";
import { createRequire } from "module";
import WebTorrent from "webtorrent";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const Ffmpeg = require("fluent-ffmpeg");
Ffmpeg.setFfmpegPath(ffmpegPath);
Ffmpeg.setFfprobePath(ffprobeStatic.path);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const client = new WebTorrent();
let activeTorrent = null;
let activeFile = null;
let activeTrackInfo = null;
let activeSubtitleFiles = []; // external .srt/.vtt files from torrent

const SUBTITLE_EXTS = ["srt", "vtt", "ass", "ssa"];

function srtToVtt(srt) {
  return "WEBVTT\n\n" + srt
    .replace(/\r\n/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}

function infoHashFromMagnet(magnet) {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : null;
}

const VIDEO_EXTS = ["mp4", "mkv", "webm", "avi", "mov", "m4v", "ogv", "ogg", "ts"];
const rooms = {};

function findVideoFile(torrent) {
  return torrent.files.reduce((best, f) => {
    const ext = f.name.split(".").pop().toLowerCase();
    if (VIDEO_EXTS.includes(ext)) return (!best || f.length > best.length) ? f : best;
    return best;
  }, null);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "POST" && u.pathname === "/api/load") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      let magnet;
      try { magnet = JSON.parse(body).magnet; } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }
      if (!magnet) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing magnet" })); return; }
      // If the same torrent is already active, don't disrupt it
      const newHash = infoHashFromMagnet(magnet);
      const curHash = activeTorrent?.infoHash?.toLowerCase();
      if (newHash && curHash && newHash === curHash) {
        console.log("[torrent] already active, skipping reload");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, loading: !activeFile }));
        return;
      }

      // Different torrent — remove previous and add fresh
      if (activeTorrent) {
        try { client.remove(activeTorrent.infoHash); } catch (e) {}
        activeTorrent = null;
        activeFile = null;
      }
      console.log("[torrent] loading:", magnet.slice(0, 80));

      const setupTorrent = (torrent) => {
        activeTorrent = torrent;
        activeTrackInfo = null;
        activeSubtitleFiles = [];
        const file = findVideoFile(torrent);
        if (!file) { console.log("[torrent] no video file found"); return; }
        activeFile = file;

        // Find and select external subtitle files
        activeSubtitleFiles = torrent.files.filter(f => {
          const ext = f.name.split(".").pop().toLowerCase();
          return SUBTITLE_EXTS.includes(ext);
        });
        activeSubtitleFiles.forEach(f => f.select());
        if (activeSubtitleFiles.length) console.log(`[torrent] found ${activeSubtitleFiles.length} subtitle file(s):`, activeSubtitleFiles.map(f => f.name).join(", "));

        torrent.files.forEach(f => {
          if (f === file || activeSubtitleFiles.includes(f)) return;
          f.deselect();
        });
        torrent.strategy = "sequential";
        const pieceCount = torrent.pieces.length;
        const criticalEnd = Math.max(10, Math.floor(pieceCount * 0.1));
        try { torrent.critical(0, criticalEnd); } catch(e) {}
        console.log("[torrent] ready:", file.name, "| pieces:", pieceCount, "| critical: 0-" + criticalEnd);

        // Probe tracks after a short delay to let the stream warm up
        setTimeout(() => {
          Ffmpeg.ffprobe(`http://localhost:${PORT}/stream`, (err, meta) => {
            if (err) { console.log("[tracks] probe failed:", err.message); activeTrackInfo = { subtitles: [], audio: [] }; return; }
            const streams = meta.streams || [];
            activeTrackInfo = {
              subtitles: streams.filter(s => s.codec_type === "subtitle").map(s => ({
                index: s.index,
                lang: s.tags?.language || "und",
                title: s.tags?.title || (s.tags?.language ? s.tags.language.toUpperCase() : `Track ${s.index}`)
              })),
              audio: streams.filter(s => s.codec_type === "audio").map((s, i) => ({
                index: s.index,
                lang: s.tags?.language || "und",
                title: s.tags?.title || (s.tags?.language ? s.tags.language.toUpperCase() : `Track ${i + 1}`)
              }))
            };
            console.log(`[tracks] ${activeTrackInfo.subtitles.length} subtitle(s), ${activeTrackInfo.audio.length} audio track(s)`);
          });
        }, 3000);
      };

      client.add(magnet, { path: path.join(__dirname, "downloads") }, setupTorrent);
      client.once("error", e => console.error("[torrent] error:", e.message));

      // Return immediately — frontend polls /api/status for readiness
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, loading: true }));
    });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/tracks") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(activeTrackInfo || { subtitles: [], audio: [], probing: !!activeFile }));
    return;
  }

  if (req.method === "GET" && u.pathname.startsWith("/subtitle/")) {
    const idx = parseInt(u.pathname.split("/")[2]);
    if (!activeFile || isNaN(idx)) { res.writeHead(404); res.end("Not found"); return; }
    const ext = activeFile.name.split(".").pop().toLowerCase();
    const inputFormat = ext === "mkv" ? "matroska" : ext;
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.writeHead(200);
    const ff = Ffmpeg()
      .input(activeFile.createReadStream())
      .inputFormat(inputFormat)
      .outputOptions([`-map 0:${idx}`, "-f webvtt"])
      .on("error", e => { console.error("[sub]", e.message); try { res.end(); } catch(_) {} })
      .pipe(res, { end: true });
    req.on("close", () => { try { ff.kill("SIGKILL"); } catch(_) {} });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/status") {
    if (!activeTorrent) { res.writeHead(200); res.end(JSON.stringify({ loading: true, ready: false })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ready: !!activeFile,
      loading: !activeFile,
      name: activeTorrent.name,
      file: activeFile?.name,
      size: activeFile?.length,
      streamUrl: activeFile ? "/stream" : null,
      progress: activeTorrent.progress,
      downloadSpeed: activeTorrent.downloadSpeed,
      numPeers: activeTorrent.numPeers,
      done: activeTorrent.done
    }));
    return;
  }

  if (req.method === "GET" && u.pathname === "/stream") {
    if (!activeFile) { res.writeHead(404); res.end("No active stream"); return; }

    // Audio track remux via ffmpeg
    const audioParam = u.searchParams.get("audio");
    if (audioParam !== null) {
      const audioIdx = parseInt(audioParam);
      const ext = activeFile.name.split(".").pop().toLowerCase();
      const inputFormat = ext === "mkv" ? "matroska" : ext;
      res.writeHead(200, { "Content-Type": "video/mp4" });
      const ff = Ffmpeg()
        .input(activeFile.createReadStream())
        .inputFormat(inputFormat)
        .outputOptions(["-map 0:v:0", `-map 0:a:${audioIdx}`, "-c:v copy", "-c:a aac", "-b:a 192k", "-f mp4", "-movflags frag_keyframe+empty_moov"])
        .on("error", e => { console.error("[audio remux]", e.message); try { res.end(); } catch(_) {} })
        .pipe(res, { end: true });
      req.on("close", () => { try { ff.kill("SIGKILL"); } catch(_) {} });
      return;
    }

    const fileSize = activeFile.length;
    const ext = activeFile.name.split(".").pop().toLowerCase();
    const mimeTypes = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", mov: "video/quicktime", ogv: "video/ogg", ogg: "video/ogg", ts: "video/mp2t", m4v: "video/mp4" };
    const contentType = mimeTypes[ext] || "video/mp4";
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024 * 1024, fileSize - 1);
      const chunkSize = end - start + 1;
      // Mark requested area as critical so it downloads immediately
      if (activeTorrent) {
        const pieceLen = activeTorrent.pieceLength;
        const startPiece = Math.floor(start / pieceLen);
        const endPiece = Math.floor(end / pieceLen);
        try { activeTorrent.critical(startPiece, endPiece + 2); } catch(e) {}
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
      });
      const stream = activeFile.createReadStream({ start, end });
      stream.pipe(res);
      stream.on("error", e => { console.error("[stream]", e.message); res.end(); });
    } else {
      res.writeHead(200, { "Content-Length": fileSize, "Content-Type": contentType, "Accept-Ranges": "bytes" });
      const stream = activeFile.createReadStream();
      stream.pipe(res);
      stream.on("error", e => { console.error("[stream]", e.message); res.end(); });
    }
    return;
  }

  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    const htmlPath = path.join(__dirname, "public", "index.html");
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); res.end("index.html not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(htmlPath).pipe(res);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws._roomId = null;
  ws._name = "Viewer";
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "join") {
      if (!rooms[msg.roomId]) rooms[msg.roomId] = new Set();
      ws._roomId = msg.roomId;
      ws._name = msg.name || "Viewer";
      rooms[msg.roomId].add(ws);
      broadcast(msg.roomId, ws, JSON.stringify({ type: "joined", sender: ws._name }));
      console.log(`[room] ${ws._name} joined ${msg.roomId} (${rooms[msg.roomId].size} total)`);
      return;
    }
    if (["play","pause","seek","chat","magnet"].includes(msg.type) && ws._roomId) {
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

server.listen(PORT, () => console.log(`\n  stream.party running at http://localhost:${PORT}\n`));
