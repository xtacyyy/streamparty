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
const AdmZip = require("adm-zip");
Ffmpeg.setFfmpegPath(ffmpegPath);
Ffmpeg.setFfprobePath(ffprobeStatic.path);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DOWNLOADS_PATH = path.join(__dirname, "downloads");
const client = new WebTorrent();

const SUBTITLE_EXTS = ["srt", "vtt", "ass", "ssa"];
const VIDEO_EXTS = ["mp4", "mkv", "webm", "avi", "mov", "m4v", "ogv", "ogg", "ts"];

const rooms = {};
const roomTorrents = {};

function getRoomState(roomId) {
  return roomTorrents[roomId] || null;
}

function initRoomState(roomId) {
  if (!roomTorrents[roomId]) {
    roomTorrents[roomId] = {
      torrent: null, file: null, videoFiles: [],
      trackInfo: null, subtitleFiles: [], autoSubContent: null
    };
  }
  return roomTorrents[roomId];
}

function getActiveTorrentDirs() {
  const dirs = new Set();
  for (const rs of Object.values(roomTorrents)) {
    if (rs.torrent && rs.torrent.name) dirs.add(path.join(DOWNLOADS_PATH, rs.torrent.name));
  }
  return dirs;
}

function cleanupRoomTorrent(roomId) {
  const rs = roomTorrents[roomId];
  if (!rs) return;
  if (rs.torrent) {
    const infoHash = rs.torrent.infoHash;
    const sharedByOther = Object.entries(roomTorrents).some(
      function(entry) { return entry[0] !== roomId && entry[1].torrent && entry[1].torrent.infoHash === infoHash; }
    );
    if (!sharedByOther) {
      try { client.remove(infoHash, { destroyStore: false }); } catch (e) {}
      console.log("[torrent] removed " + infoHash);
    }
  }
  delete roomTorrents[roomId];
  console.log("[room] cleaned up " + roomId);
}

function srtToVtt(srt) {
  return "WEBVTT\n\n" + srt
    .replace(/\r\n/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}

function parseMovieInfo(filename) {
  const base = filename.replace(/\.[^.]+$/, "");
  const yearMatch = base.match(/[.\s\[(]((19|20)\d{2})[.\s\])]/);
  const year = yearMatch ? yearMatch[1] : null;
  let title = base;
  if (year) {
    title = base.substring(0, base.indexOf(year));
  } else {
    title = base.replace(/\b(1080p|720p|480p|2160p|4K|BluRay|BRRip|WEBRip|WEB-DL|HDTV|x264|x265|HEVC|AAC|DTS|YTS|YIFY)\b.*/i, "");
  }
  title = title.replace(/[.\-_]/g, " ").replace(/\s+/g, " ").trim();
  return { title: title, year: year };
}

async function fetchAutoSubtitle(filename) {
  const apiKey = process.env.SUBDL_API_KEY;
  if (!apiKey) return null;
  const info = parseMovieInfo(filename);
  if (!info.title) return null;
  try {
    const params = new URLSearchParams({ api_key: apiKey, film_name: info.title, languages: "EN", type: "movie" });
    if (info.year) params.set("year", info.year);
    const searchRes = await fetch("https://api.subdl.com/api/v1/subtitles?" + params);
    const searchData = await searchRes.json();
    if (!searchData.status || !searchData.subtitles || !searchData.subtitles.length) return null;
    const sub = searchData.subtitles.find(function(s) { return s.language === "EN"; }) || searchData.subtitles[0];
    if (!sub || !sub.url) return null;
    const zipUrl = "https://dl.subdl.com" + sub.url;
    const zipRes = await fetch(zipUrl);
    if (!zipRes.ok) return null;
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    const srtEntry = entries.find(function(e) { return e.entryName.toLowerCase().endsWith(".srt"); });
    if (!srtEntry) return null;
    return srtToVtt(srtEntry.getData().toString("utf8"));
  } catch (e) {
    console.log("[sub-auto] error:", e.message);
    return null;
  }
}

function infoHashFromMagnet(magnet) {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : null;
}

function selectFileForRoom(roomId, fileIndex) {
  const rs = getRoomState(roomId);
  if (!rs || !rs.videoFiles.length) return false;
  const file = rs.videoFiles[fileIndex];
  if (!file) return false;

  rs.videoFiles.forEach(function(f) { try { f.deselect(); } catch (e) {} });
  try { file.select(); } catch (e) {}

  rs.file = file;
  rs.trackInfo = null;
  rs.autoSubContent = null;
  if (rs.torrent) rs.torrent.strategy = "sequential";

  console.log("[torrent][" + roomId + "] file selected: " + file.name);

  fetchAutoSubtitle(file.name).then(function(vtt) { rs.autoSubContent = vtt; });

  const externalSubs = rs.subtitleFiles.map(function(f, i) {
    return {
      index: "ext:" + i,
      lang: "und",
      title: f.name.replace(/\.[^.]+$/, "").replace(/\./g, " ").trim()
    };
  });

  setTimeout(function() {
    Ffmpeg.ffprobe("http://localhost:" + PORT + "/stream?room=" + encodeURIComponent(roomId), function(err, meta) {
      const streams = err ? [] : (meta.streams || []);
      const embeddedSubs = streams.filter(function(s) { return s.codec_type === "subtitle"; }).map(function(s) {
        return {
          index: s.index,
          lang: (s.tags && s.tags.language) || "und",
          title: (s.tags && s.tags.title) || ((s.tags && s.tags.language) ? s.tags.language.toUpperCase() : "Embedded " + s.index)
        };
      });
      const audio = streams.filter(function(s) { return s.codec_type === "audio"; }).map(function(s, i) {
        return {
          index: s.index,
          lang: (s.tags && s.tags.language) || "und",
          title: (s.tags && s.tags.title) || ((s.tags && s.tags.language) ? s.tags.language.toUpperCase() : "Track " + (i + 1))
        };
      });
      rs.trackInfo = { subtitles: externalSubs.concat(embeddedSubs), audio: audio };
      console.log("[tracks][" + roomId + "] " + rs.trackInfo.subtitles.length + " subtitle(s), " + rs.trackInfo.audio.length + " audio track(s)");
    });
  }, 3000);

  return true;
}

function getDiskUsage() {
  try {
    const stat = fs.statfsSync(DOWNLOADS_PATH);
    return 1 - (stat.bfree / stat.blocks);
  } catch (e) { return 0; }
}

function checkDisk() {
  try {
    if (!fs.existsSync(DOWNLOADS_PATH)) return;
    const usage = getDiskUsage();
    if (usage <= 0.80) return;
    const activeDirs = getActiveTorrentDirs();
    const entries = [];
    for (const entry of fs.readdirSync(DOWNLOADS_PATH)) {
      const full = path.join(DOWNLOADS_PATH, entry);
      try { entries.push({ full: full, mtime: fs.statSync(full).mtimeMs }); } catch (e) {}
    }
    entries.sort(function(a, b) { return a.mtime - b.mtime; });
    for (const entry of entries) {
      if (getDiskUsage() <= 0.80) break;
      if (activeDirs.has(entry.full)) continue;
      try { fs.rmSync(entry.full, { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) { console.error("[disk] cleanup error:", e.message); }
}
setInterval(checkDisk, 10 * 60 * 1000);

const server = http.createServer(function(req, res) {
  const u = new NodeURL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // POST /api/load
  if (req.method === "POST" && u.pathname === "/api/load") {
    let body = "";
    req.on("data", function(d) { body += d; });
    req.on("end", function() {
      let magnet, roomId;
      try {
        const parsed = JSON.parse(body);
        magnet = parsed.magnet;
        roomId = parsed.roomId;
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      if (!magnet) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing magnet" })); return; }
      if (!roomId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing roomId" })); return; }

      const rs = initRoomState(roomId);
      const newHash = infoHashFromMagnet(magnet);
      const curHash = rs.torrent && rs.torrent.infoHash ? rs.torrent.infoHash.toLowerCase() : null;

      if (newHash && curHash && newHash === curHash) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, loading: !rs.file }));
        return;
      }

      if (rs.torrent) {
        const oldHash = rs.torrent.infoHash;
        const sharedByOther = Object.entries(roomTorrents).some(function(entry) {
          return entry[0] !== roomId && entry[1].torrent && entry[1].torrent.infoHash === oldHash;
        });
        if (!sharedByOther) {
          try { client.remove(oldHash, { destroyStore: false }); } catch (e) {}
        }
        rs.torrent = null; rs.file = null; rs.videoFiles = [];
        rs.trackInfo = null; rs.subtitleFiles = []; rs.autoSubContent = null;
      }

      console.log("[torrent][" + roomId + "] loading: " + magnet.slice(0, 80));

      const setupTorrent = function(torrent) {
        rs.torrent = torrent;
        rs.trackInfo = null; rs.subtitleFiles = []; rs.autoSubContent = null;
        rs.file = null; rs.videoFiles = [];

        rs.subtitleFiles = torrent.files.filter(function(f) {
          return SUBTITLE_EXTS.includes(f.name.split(".").pop().toLowerCase());
        });
        rs.subtitleFiles.forEach(function(f) { f.select(); });

        rs.videoFiles = torrent.files
          .filter(function(f) { return VIDEO_EXTS.includes(f.name.split(".").pop().toLowerCase()); })
          .sort(function(a, b) { return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }); });

        if (rs.videoFiles.length === 0) {
          console.log("[torrent][" + roomId + "] no video files found");
          return;
        }

        if (rs.videoFiles.length === 1) {
          selectFileForRoom(roomId, 0);
          const pieceCount = torrent.pieces.length;
          const criticalEnd = Math.max(10, Math.floor(pieceCount * 0.1));
          try { torrent.critical(0, criticalEnd); } catch (e) {}
          notifyRoom(roomId, { type: "torrentready", file: rs.videoFiles[0].name });
        } else {
          rs.videoFiles.forEach(function(f) { try { f.deselect(); } catch (e) {} });
          console.log("[torrent][" + roomId + "] " + rs.videoFiles.length + " files — awaiting selection");
          notifyRoom(roomId, {
            type: "awaitingfileselect",
            files: rs.videoFiles.map(function(f, i) { return { index: i, name: f.name, size: f.length }; })
          });
        }
      };

      const existingTorrent = newHash
        ? (client.torrents.find(function(t) { return t.infoHash === newHash; }) || null)
        : null;

      if (existingTorrent) {
        setupTorrent(existingTorrent);
      } else {
        try {
          client.add(magnet, { path: DOWNLOADS_PATH }, setupTorrent);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to add torrent: " + e.message }));
          return;
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, loading: true }));
    });
    return;
  }

  // POST /api/selectfile
  if (req.method === "POST" && u.pathname === "/api/selectfile") {
    let body = "";
    req.on("data", function(d) { body += d; });
    req.on("end", function() {
      let roomId, fileIndex;
      try {
        const parsed = JSON.parse(body);
        roomId = parsed.roomId;
        fileIndex = parseInt(parsed.fileIndex);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const rs = getRoomState(roomId);
      if (!rs) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Room not found" })); return; }
      if (!rs.videoFiles.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "No files loaded yet" })); return; }

      const ok = selectFileForRoom(roomId, fileIndex);
      if (!ok) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid file index" })); return; }

      notifyRoom(roomId, { type: "torrentready", file: rs.file ? rs.file.name : null });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, file: rs.file ? rs.file.name : null }));
    });
    return;
  }

  // GET /api/tracks
  if (req.method === "GET" && u.pathname === "/api/tracks") {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    const trackData = (rs && rs.trackInfo) || { subtitles: [], audio: [], probing: !!(rs && rs.file) };
    res.end(JSON.stringify(Object.assign({}, trackData, { hasAutoSub: !!(rs && rs.autoSubContent) })));
    return;
  }

  // GET /subtitle/auto
  if (req.method === "GET" && u.pathname === "/subtitle/auto") {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    if (!rs || !rs.autoSubContent) { res.writeHead(404); res.end("No auto subtitle available"); return; }
    res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(rs.autoSubContent);
    return;
  }

  // GET /subtitle/:trackId
  if (req.method === "GET" && u.pathname.startsWith("/subtitle/")) {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    const trackId = u.pathname.split("/")[2];
    if (!rs || !rs.file) { res.writeHead(404); res.end("Not found"); return; }

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (trackId.startsWith("ext:")) {
      const extIdx = parseInt(trackId.replace("ext:", ""));
      const subFile = rs.subtitleFiles[extIdx];
      if (!subFile) { res.writeHead(404); res.end("Subtitle file not found"); return; }
      res.writeHead(200);
      const fileExt = subFile.name.split(".").pop().toLowerCase();
      if (fileExt === "vtt") {
        subFile.createReadStream().pipe(res);
      } else {
        let buf = "";
        const stream = subFile.createReadStream();
        stream.on("data", function(c) { buf += c.toString(); });
        stream.on("end", function() { res.end(srtToVtt(buf)); });
        stream.on("error", function() { res.end("WEBVTT\n\n"); });
      }
      return;
    }

    const idx = parseInt(trackId);
    if (isNaN(idx)) { res.writeHead(400); res.end("Bad track id"); return; }
    const videoExt = rs.file.name.split(".").pop().toLowerCase();
    const inputFormat = videoExt === "mkv" ? "matroska" : videoExt;
    res.writeHead(200);
    const ff = Ffmpeg()
      .input(rs.file.createReadStream())
      .inputFormat(inputFormat)
      .outputOptions(["-map 0:" + idx, "-f webvtt"])
      .on("error", function(e) { console.error("[sub]", e.message); try { res.end(); } catch (_) {} })
      .pipe(res, { end: true });
    req.on("close", function() { try { ff.kill("SIGKILL"); } catch (_) {} });
    return;
  }

  // GET /api/status
  if (req.method === "GET" && u.pathname === "/api/status") {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    if (!rs || !rs.torrent) { res.writeHead(200); res.end(JSON.stringify({ loading: true, ready: false })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ready: !!rs.file,
      loading: !rs.file,
      awaitingFileSelect: rs.videoFiles.length > 1 && !rs.file,
      name: rs.torrent.name,
      file: rs.file ? rs.file.name : null,
      size: rs.file ? rs.file.length : null,
      streamUrl: rs.file ? "/stream?room=" + encodeURIComponent(roomId) : null,
      files: rs.videoFiles.map(function(f, i) { return { index: i, name: f.name, size: f.length }; }),
      progress: rs.torrent.progress,
      downloadSpeed: rs.torrent.downloadSpeed,
      numPeers: rs.torrent.numPeers,
      done: rs.torrent.done
    }));
    return;
  }

  // GET /stream
  if (req.method === "GET" && u.pathname === "/stream") {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    if (!rs || !rs.file) { res.writeHead(404); res.end("No active stream"); return; }

    const activeFile = rs.file;
    const activeTorrent = rs.torrent;
    const audioParam = u.searchParams.get("audio");
    const compatMode = u.searchParams.get("compat") === "1";
    const transcodeMode = u.searchParams.get("transcode") === "1";
    const ext = activeFile.name.split(".").pop().toLowerCase();
    const inputFormat = ext === "mkv" ? "matroska" : ext;

    if (audioParam !== null) {
      const audioIdx = parseInt(audioParam);
      res.writeHead(200, { "Content-Type": "video/mp4" });
      const ff = Ffmpeg()
        .input(activeFile.createReadStream())
        .inputFormat(inputFormat)
        .outputOptions(["-map 0:v:0", "-map 0:a:" + audioIdx, "-c:v copy", "-c:a aac", "-b:a 192k", "-f mp4", "-movflags frag_keyframe+empty_moov"])
        .on("error", function(e) { console.error("[audio remux]", e.message); try { res.end(); } catch (_) {} })
        .pipe(res, { end: true });
      req.on("close", function() { try { ff.kill("SIGKILL"); } catch (_) {} });
      return;
    }

    if (compatMode || transcodeMode || !["mp4", "m4v"].includes(ext)) {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      const videoOpts = transcodeMode
        ? ["-c:v libx264", "-preset ultrafast", "-crf 23", "-pix_fmt yuv420p", "-profile:v main", "-level 4.0"]
        : ["-c:v copy"];
      const ff = Ffmpeg()
        .input(activeFile.createReadStream())
        .inputFormat(inputFormat)
        .inputOptions(["-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err", "-analyzeduration", "10000000", "-probesize", "10000000"])
        .outputOptions(["-map 0:v:0", "-map 0:a:0"].concat(videoOpts).concat(["-c:a aac", "-ac 2", "-b:a 192k", "-f mp4", "-movflags frag_keyframe+empty_moov+default_base_moof"]))
        .on("error", function(e) { console.error("[compat remux]", e.message); try { res.end(); } catch (_) {} })
        .pipe(res, { end: true });
      req.on("close", function() { try { ff.kill("SIGKILL"); } catch (_) {} });
      return;
    }

    const fileSize = activeFile.length;
    const mimeTypes = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", mov: "video/quicktime", ogv: "video/ogg", ogg: "video/ogg", ts: "video/mp2t", m4v: "video/mp4" };
    const contentType = mimeTypes[ext] || "video/mp4";
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024 * 1024, fileSize - 1);
      const chunkSize = end - start + 1;
      if (activeTorrent) {
        const pieceLen = activeTorrent.pieceLength;
        const startPiece = Math.floor(start / pieceLen);
        const endPiece = Math.floor(end / pieceLen);
        try { activeTorrent.critical(startPiece, endPiece + 2); } catch (e) {}
      }
      res.writeHead(206, { "Content-Range": "bytes " + start + "-" + end + "/" + fileSize, "Accept-Ranges": "bytes", "Content-Length": chunkSize, "Content-Type": contentType });
      const stream = activeFile.createReadStream({ start: start, end: end });
      stream.pipe(res);
      stream.on("error", function(e) { console.error("[stream]", e.message); res.end(); });
    } else {
      res.writeHead(200, { "Content-Length": fileSize, "Content-Type": contentType, "Accept-Ranges": "bytes" });
      const stream = activeFile.createReadStream();
      stream.pipe(res);
      stream.on("error", function(e) { console.error("[stream]", e.message); res.end(); });
    }
    return;
  }

  // GET /api/search
  if (req.method === "GET" && u.pathname === "/api/search") {
    const q = u.searchParams.get("q");
    if (!q) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing q" })); return; }
    (async function() {
      const enc = encodeURIComponent(q);
      const responses = await Promise.all([
        fetch("https://v3-cinemeta.strem.io/catalog/movie/top/search=" + enc + ".json"),
        fetch("https://v3-cinemeta.strem.io/catalog/series/top/search=" + enc + ".json")
      ]);
      const bodies = await Promise.all(responses.map(function(r) { return r.json(); }));
      const results = [].concat(
        (bodies[0].metas || []).slice(0, 6).map(function(m) { return Object.assign({}, m, { type: "movie" }); }),
        (bodies[1].metas || []).slice(0, 4).map(function(s) { return Object.assign({}, s, { type: "series" }); })
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    })().catch(function(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // GET /api/streams
  if (req.method === "GET" && u.pathname === "/api/streams") {
    const imdb = u.searchParams.get("imdb");
    const type = u.searchParams.get("type") || "movie";
    const season = u.searchParams.get("season");
    const episode = u.searchParams.get("episode");
    if (!imdb) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing imdb" })); return; }
    const url = (type === "series" && season && episode)
      ? "https://torrentio.strem.fun/stream/series/" + imdb + ":" + season + ":" + episode + ".json"
      : "https://torrentio.strem.fun/stream/movie/" + imdb + ".json";
    (async function() {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data.streams || []));
    })().catch(function(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // Static
  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    const htmlPath = path.join(__dirname, "public", "index.html");
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); res.end("index.html not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(htmlPath).pipe(res);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

const wss = new WebSocketServer({ server: server, path: "/ws" });
wss.on("connection", function(ws) {
  ws._roomId = null;
  ws._name = "Viewer";
  ws.on("message", function(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === "join") {
      if (!rooms[msg.roomId]) rooms[msg.roomId] = new Set();
      ws._roomId = msg.roomId;
      ws._name = msg.name || "Viewer";
      rooms[msg.roomId].add(ws);
      broadcast(msg.roomId, ws, JSON.stringify({ type: "joined", sender: ws._name }));
      console.log("[room] " + ws._name + " joined " + msg.roomId + " (" + rooms[msg.roomId].size + " total)");
      return;
    }
    if (["play", "pause", "seek", "chat", "magnet", "subtitle", "subtitle_upload", "fileselect"].indexOf(msg.type) !== -1 && ws._roomId) {
      broadcast(ws._roomId, ws, JSON.stringify(Object.assign({}, msg, { sender: ws._name })));
    }
  });
  ws.on("close", function() {
    const rid = ws._roomId;
    if (rid && rooms[rid]) {
      rooms[rid].delete(ws);
      broadcast(rid, ws, JSON.stringify({ type: "left", sender: ws._name }));
      if (rooms[rid].size === 0) {
        delete rooms[rid];
        setTimeout(function() {
          if (!rooms[rid]) cleanupRoomTorrent(rid);
        }, 30000);
      }
    }
  });
});

function broadcast(roomId, sender, data) {
  if (!rooms[roomId]) return;
  for (const ws of rooms[roomId]) {
    if (ws !== sender && ws.readyState === 1) ws.send(data);
  }
}

function notifyRoom(roomId, data) {
  if (!rooms[roomId]) return;
  const msg = JSON.stringify(Object.assign({}, data, { sender: "server" }));
  for (const ws of rooms[roomId]) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

server.listen(PORT, function() { console.log("\n  flikroom running at http://localhost:" + PORT + "\n"); });
