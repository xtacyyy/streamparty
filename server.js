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

// ── Per-room WebSocket connections ──
const rooms = {};

// ── Per-room torrent state ──
// roomTorrents[roomId] = { torrent, file, videoFiles, trackInfo, subtitleFiles, autoSubContent }
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
    if (rs.torrent?.name) dirs.add(path.join(DOWNLOADS_PATH, rs.torrent.name));
  }
  return dirs;
}

function cleanupRoomTorrent(roomId) {
  const rs = roomTorrents[roomId];
  if (!rs) return;
  if (rs.torrent) {
    const infoHash = rs.torrent.infoHash;
    const sharedByOther = Object.entries(roomTorrents).some(
      ([id, s]) => id !== roomId && s.torrent?.infoHash === infoHash
    );
    if (!sharedByOther) {
      try { client.remove(infoHash, { destroyStore: false }); } catch (e) {}
      console.log(`[torrent] removed ${infoHash} (no more rooms using it)`);
    }
  }
  delete roomTorrents[roomId];
  console.log(`[room] torrent state cleaned up for ${roomId}`);
}

// ── Utilities ──
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
  return { title, year };
}

async function fetchAutoSubtitle(filename) {
  const apiKey = process.env.SUBDL_API_KEY;
  if (!apiKey) { console.log("[sub-auto] no SUBDL_API_KEY set, skipping"); return null; }
  const { title, year } = parseMovieInfo(filename);
  if (!title) return null;
  console.log(`[sub-auto] searching subdl: "${title}" (${year || "?"})`);
  try {
    const params = new URLSearchParams({ api_key: apiKey, film_name: title, languages: "EN", type: "movie" });
    if (year) params.set("year", year);
    const searchRes = await fetch(`https://api.subdl.com/api/v1/subtitles?${params}`);
    const searchData = await searchRes.json();
    if (!searchData.status || !searchData.subtitles?.length) { console.log("[sub-auto] no results from subdl"); return null; }
    const sub = searchData.subtitles.find(s => s.language === "EN") || searchData.subtitles[0];
    if (!sub?.url) { console.log("[sub-auto] no download URL in result"); return null; }
    const zipUrl = `https://dl.subdl.com${sub.url}`;
    console.log(`[sub-auto] downloading zip: ${zipUrl}`);
    const zipRes = await fetch(zipUrl);
    if (!zipRes.ok) { console.log("[sub-auto] zip download failed:", zipRes.status); return null; }
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    const srtEntry = entries.find(e => e.entryName.toLowerCase().endsWith(".srt"));
    if (!srtEntry) { console.log("[sub-auto] no .srt found inside zip"); return null; }
    const srtContent = srtEntry.getData().toString("utf8");
    const vtt = srtToVtt(srtContent);
    console.log(`[sub-auto] fetched "${srtEntry.entryName}" (${srtContent.length} bytes)`);
    return vtt;
  } catch (e) {
    console.log("[sub-auto] error:", e.message);
    return null;
  }
}

function infoHashFromMagnet(magnet) {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : null;
}

// ── Select a specific video file within a room's torrent ──
function selectFileForRoom(roomId, fileIndex) {
  const rs = getRoomState(roomId);
  if (!rs || !rs.videoFiles.length) return false;
  const file = rs.videoFiles[fileIndex];
  if (!file) return false;

  // Deselect all video files, then select the chosen one
  rs.videoFiles.forEach(f => { try { f.deselect(); } catch (e) {} });
  try { file.select(); } catch (e) {}

  rs.file = file;
  rs.trackInfo = null;
  rs.autoSubContent = null;

  if (rs.torrent) rs.torrent.strategy = "sequential";

  console.log(`[torrent][${roomId}] file selected: ${file.name}`);

  fetchAutoSubtitle(file.name).then(vtt => { rs.autoSubContent = vtt; });

  const externalSubs = rs.subtitleFiles.map((f, i) => ({
    index: `ext:${i}`,
    lang: "und",
    title: f.name.replace(/\.[^.]+$/, "").replace(/\./g, " ").trim()
  }));

  setTimeout(() => {
    Ffmpeg.ffprobe(`http://localhost:${PORT}/stream?room=${encodeURIComponent(roomId)}`, (err, meta) => {
      const streams = err ? [] : (meta.streams || []);
      const embeddedSubs = streams.filter(s => s.codec_type === "subtitle").map(s => ({
        index: s.index,
        lang: s.tags?.language || "und",
        title: s.tags?.title || (s.tags?.language ? s.tags.language.toUpperCase() : `Embedded ${s.index}`)
      }));
      const audio = streams.filter(s => s.codec_type === "audio").map((s, i) => ({
        index: s.index,
        lang: s.tags?.language || "und",
        title: s.tags?.title || (s.tags?.language ? s.tags.language.toUpperCase() : `Track ${i + 1}`)
      }));
      rs.trackInfo = { subtitles: [...externalSubs, ...embeddedSubs], audio };
      console.log(`[tracks][${roomId}] ${rs.trackInfo.subtitles.length} subtitle(s), ${rs.trackInfo.audio.length} audio track(s)`);
    });
  }, 3000);

  return true;
}

// ── Disk cleanup ──
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
    console.log(`[disk] usage ${Math.round(usage * 100)}% > 80%, cleaning...`);
    const activeDirs = getActiveTorrentDirs();
    const entries = [];
    for (const entry of fs.readdirSync(DOWNLOADS_PATH)) {
      const full = path.join(DOWNLOADS_PATH, entry);
      try { entries.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch (e) {}
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (getDiskUsage() <= 0.80) break;
      if (activeDirs.has(entry.full)) continue;
      try { fs.rmSync(entry.full, { recursive: true, force: true }); console.log(`[disk] removed ${entry.full}`); } catch (e) {}
    }
  } catch (e) { console.error("[disk] cleanup error:", e.message); }
}
setInterval(checkDisk, 10 * 60 * 1000);

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── POST /api/load ──
  if (req.method === "POST" && u.pathname === "/api/load") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      let magnet, roomId;
      try {
        const parsed = JSON.parse(body);
        magnet = parsed.magnet;
        roomId = parsed.roomId;
      } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }
      if (!magnet) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing magnet" })); return; }
      if (!roomId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing roomId" })); return; }

      const rs = initRoomState(roomId);
      const newHash = infoHashFromMagnet(magnet);
      const curHash = rs.torrent?.infoHash?.toLowerCase();

      if (newHash && curHash && newHash === curHash) {
        console.log(`[torrent][${roomId}] already active, skipping reload`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, loading: !rs.file }));
        return;
      }

      if (rs.torrent) {
        const oldHash = rs.torrent.infoHash;
        const sharedByOther = Object.entries(roomTorrents).some(
          ([id, s]) => id !== roomId && s.torrent?.infoHash === oldHash
        );
        if (!sharedByOther) {
          try { client.remove(oldHash, { destroyStore: false }); } catch (e) {}
        }
        rs.torrent = null; rs.file = null; rs.videoFiles = [];
        rs.trackInfo = null; rs.subtitleFiles = []; rs.autoSubContent = null;
      }

      console.log(`[torrent][${roomId}] loading: ${magnet.slice(0, 80)}`);

      const setupTorrent = (torrent) => {
        rs.torrent = torrent;
        rs.trackInfo = null; rs.subtitleFiles = []; rs.autoSubContent = null;
        rs.file = null; rs.videoFiles = [];

        rs.subtitleFiles = torrent.files.filter(f =>
          SUBTITLE_EXTS.includes(f.name.split(".").pop().toLowerCase())
        );
        rs.subtitleFiles.forEach(f => f.select());
        if (rs.subtitleFiles.length) console.log(`[torrent][${roomId}] ${rs.subtitleFiles.length} subtitle file(s)`);

        // All video files sorted by path for natural episode ordering
        rs.videoFiles = torrent.files
          .filter(f => VIDEO_EXTS.includes(f.name.split(".").pop().toLowerCase()))
          .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));

        if (rs.videoFiles.length === 0) {
          console.log(`[torrent][${roomId}] no video files found`);
          return;
        }

        if (rs.videoFiles.length === 1) {
          // Single file — auto-select
          selectFileForRoom(roomId, 0);
          const pieceCount = torrent.pieces.length;
          const criticalEnd = Math.max(10, Math.floor(pieceCount * 0.1));
          try { torrent.critical(0, criticalEnd); } catch (e) {}
          console.log(`[torrent][${roomId}] single file auto-selected: ${rs.videoFiles[0].name}`);
        } else {
          // Multiple files — deselect all video files, wait for user to pick
          rs.videoFiles.forEach(f => { try { f.deselect(); } catch (e) {} });
          console.log(`[torrent][${roomId}] ${rs.videoFiles.length} video files found — awaiting selection`);
        }
      };

      const existingTorrent = newHash
        ? (client.torrents.find(t => t.infoHash === newHash) || null)
        : null;
      if (existingTorrent) {
        console.log(`[torrent][${roomId}] reusing existing torrent ${newHash}`);
        setupTorrent(existingTorrent);
      } else {
        try {
          client.add(magnet, { path: DOWNLOADS_PATH }, setupTorrent);
        } catch (e) {
          console.error(`[torrent][${roomId}] client.add error:`, e.message);
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

  // ── POST /api/selectfile ──
  if (req.method === "POST" && u.pathname === "/api/selectfile") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
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
      if (!rs.videoFiles.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "No video files loaded yet" })); return; }

      const ok = selectFileForRoom(roomId, fileIndex);
      if (!ok) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid file index" })); return; }

      // Broadcast to room so all clients switch to the same file
      if (rooms[roomId]) {
        const msg = JSON.stringify({ type: "fileselect", fileIndex, sender: "server" });
        for (const ws of rooms[roomId]) {
          if (ws.readyState === 1) ws.send(msg);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, file: rs.file?.name }));
    });
    return;
  }

  // ── GET /api/tracks ──
  if (req.method === "GET" && u.pathname === "/api/tracks") {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    const trackData = rs?.trackInfo || { subtitles: [], audio: [], probing: !!(rs?.file) };
    res.end(JSON.stringify({ ...trackData, hasAutoSub: !!(rs?.autoSubContent) }));
    return;
  }

  // ── GET /subtitle/auto ──
  if (req.method === "GET" && u.pathname === "/subtitle/auto") {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    if (!rs?.autoSubContent) { res.writeHead(404); res.end("No auto subtitle available"); return; }
    res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(rs.autoSubContent);
    return;
  }

  // ── GET /subtitle/:trackId ──
  if (req.method === "GET" && u.pathname.startsWith("/subtitle/")) {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    const trackId = u.pathname.split("/")[2];
    if (!rs?.file) { res.writeHead(404); res.end("Not found"); return; }

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
        stream.on("data", c => buf += c.toString());
        stream.on("end", () => res.end(srtToVtt(buf)));
        stream.on("error", () => res.end("WEBVTT\n\n"));
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
      .outputOptions([`-map 0:${idx}`, "-f webvtt"])
      .on("error", e => { console.error("[sub]", e.message); try { res.end(); } catch (_) {} })
      .pipe(res, { end: true });
    req.on("close", () => { try { ff.kill("SIGKILL"); } catch (_) {} });
    return;
  }

  // ── GET /api/status ──
  if (req.method === "GET" && u.pathname === "/api/status") {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    if (!rs?.torrent) { res.writeHead(200); res.end(JSON.stringify({ loading: true, ready: false })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ready: !!rs.file,
      loading: !rs.file,
      awaitingFileSelect: rs.videoFiles.length > 1 && !rs.file,
      name: rs.torrent.name,
      file: rs.file?.name,
      size: rs.file?.length,
      streamUrl: rs.file ? `/stream?room=${encodeURIComponent(roomId)}` : null,
      files: rs.videoFiles.map((f, i) => ({ index: i, name: f.name, size: f.length })),
      progress: rs.torrent.progress,
      downloadSpeed: rs.torrent.downloadSpeed,
      numPeers: rs.torrent.numPeers,
      done: rs.torrent.done
    }));
    return;
  }

  // ── GET /stream ──
  if (req.method === "GET" && u.pathname === "/stream") {
    const roomId = u.searchParams.get("room");
    const rs = roomId ? getRoomState(roomId) : null;
    if (!rs?.file) { res.writeHead(404); res.end("No active stream"); return; }

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
        .outputOptions(["-map 0:v:0", `-map 0:a:${audioIdx}`, "-c:v copy", "-c:a aac", "-b:a 192k", "-f mp4", "-movflags frag_keyframe+empty_moov"])
        .on("error", e => { console.error("[audio remux]", e.message); try { res.end(); } catch (_) {} })
        .pipe(res, { end: true });
      req.on("close", () => { try { ff.kill("SIGKILL"); } catch (_) {} });
      return;
    }

    if (compatMode || transcodeMode || !["mp4", "m4v"].includes(ext)) {
      console.log(`[compat][${roomId}] ${transcodeMode ? "transcoding" : "remuxing"}: ${activeFile.name}`);
      res.writeHead(200, { "Content-Type": "video/mp4" });
      const videoOpts = transcodeMode
        ? ["-c:v libx264", "-preset ultrafast", "-crf 23", "-pix_fmt yuv420p", "-profile:v main", "-level 4.0"]
        : ["-c:v copy"];
      const ff = Ffmpeg()
        .input(activeFile.createReadStream())
        .inputFormat(inputFormat)
        .outputOptions([
          "-map 0:v:0", "-map 0:a:0",
          ...videoOpts,
          "-c:a aac", "-ac 2", "-b:a 192k",
          "-f mp4", "-movflags frag_keyframe+empty_moov+default_base_moof"
        ])
        .on("error", e => { console.error("[compat remux]", e.message); try { res.end(); } catch (_) {} })
        .pipe(res, { end: true });
      req.on("close", () => { try { ff.kill("SIGKILL"); } catch (_) {} });
      return;
    }

    const fileSize = activeFile.length;
    const mimeTypes = {
      mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
      avi: "video/x-msvideo", mov: "video/quicktime", ogv: "video/ogg",
      ogg: "video/ogg", ts: "video/mp2t", m4v: "video/mp4"
    };
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

  // ── GET /api/search ──
  if (req.method === "GET" && u.pathname === "/api/search") {
    const q = u.searchParams.get("q");
    if (!q) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing q" })); return; }
    (async () => {
      const enc = encodeURIComponent(q);
      const [mr, sr] = await Promise.all([
        fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${enc}.json`),
        fetch(`https://v3-cinemeta.strem.io/catalog/series/top/search=${enc}.json`)
      ]);
      const [movies, series] = await Promise.all([mr.json(), sr.json()]);
      const results = [
        ...(movies.metas || []).slice(0, 6).map(m => ({ ...m, type: "movie" })),
        ...(series.metas || []).slice(0, 4).map(s => ({ ...s, type: "series" }))
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    })().catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // ── GET /api/streams ──
  if (req.method === "GET" && u.pathname === "/api/streams") {
    const imdb = u.searchParams.get("imdb");
    const type = u.searchParams.get("type") || "movie";
    const season = u.searchParams.get("season");
    const episode = u.searchParams.get("episode");
    if (!imdb) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing imdb" })); return; }
    const url = (type === "series" && season && episode)
      ? `https://torrentio.strem.fun/stream/series/${imdb}:${season}:${episode}.json`
      : `https://torrentio.strem.fun/stream/movie/${imdb}.json`;
    (async () => {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await r.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data.streams || []));
    })().catch(e => { res.write