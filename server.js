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
const client = new WebTorrent();
let activeTorrent = null;
let activeFile = null;
let activeTrackInfo = null;
let activeSubtitleFiles = [];
let autoSubContent = null;

const SUBTITLE_EXTS = ["srt", "vtt", "ass", "ssa"];

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

    if (!searchData.status || !searchData.subtitles?.length) {
      console.log("[sub-auto] no results from subdl");
      return null;
    }

    // Prefer full-season or synced subs, take first available
    const sub = searchData.subtitles.find(s => s.language === "EN") || searchData.subtitles[0];
    if (!sub?.url) { console.log("[sub-auto] no download URL in result"); return null; }

    // subdl returns a zip archive
    const zipUrl = `https://dl.subdl.com${sub.url}`;
    console.log(`[sub-auto] downloading zip: ${zipUrl}`);
    const zipRes = await fetch(zipUrl);
    if (!zipRes.ok) { console.log("[sub-auto] zip download failed:", zipRes.status); return null; }

    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    // Pick the first SRT file in the archive
    const srtEntry = entries.find(e => e.entryName.toLowerCase().endsWith(".srt"));
    if (!srtEntry) { console.log("[sub-auto] no .srt found inside zip"); return null; }

    const srtContent = srtEntry.getData().toString("utf8");
    const vtt = srtToVtt(srtContent);
    console.log(`[sub-auto] fetched "${srtEntry.entryName}" (${srtContent.length} bytes)`);
    return vtt;
  } catch(e) {
    console.log("[sub-auto] error:", e.message);
    return null;
  }
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
        activeTrackInfo = null;
        activeSubtitleFiles = [];
        autoSubContent = null;
      }
      console.log("[torrent] loading:", magnet.slice(0, 80));

      const setupTorrent = (torrent) => {
        activeTorrent = torrent;
        activeTrackInfo = null;
        activeSubtitleFiles = [];
        autoSubContent = null;
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

        // Auto-fetch subtitle from OpenSubtitles
        fetchAutoSubtitle(file.name).then(vtt => { autoSubContent = vtt; });

        // Build external subtitle track list immediately
        const externalSubs = activeSubtitleFiles.map((f, i) => ({
          index: `ext:${i}`,
          lang: "und",
          title: f.name.replace(/\.[^.]+$/, "").replace(/\./g, " ").trim()
        }));

        // Probe embedded tracks after a short delay
        setTimeout(() => {
          Ffmpeg.ffprobe(`http://localhost:${PORT}/stream`, (err, meta) => {
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
            activeTrackInfo = { subtitles: [...externalSubs, ...embeddedSubs], audio };
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
    const trackData = activeTrackInfo || { subtitles: [], audio: [], probing: !!activeFile };
    res.end(JSON.stringify({ ...trackData, hasAutoSub: !!autoSubContent }));
    return;
  }

  if (req.method === "GET" && u.pathname === "/subtitle/auto") {
    if (!autoSubContent) { res.writeHead(404); res.end("No auto subtitle available"); return; }
    res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(autoSubContent);
    return;
  }

  if (req.method === "GET" && u.pathname.startsWith("/subtitle/")) {
    const trackId = u.pathname.split("/")[2];
    if (!activeFile) { res.writeHead(404); res.end("Not found"); return; }

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // External subtitle file (ext:N)
    if (trackId.startsWith("ext:")) {
      const extIdx = parseInt(trackId.replace("ext:", ""));
      const subFile = activeSubtitleFiles[extIdx];
      if (!subFile) { res.writeHead(404); res.end("Subtitle file not found"); return; }
      res.writeHead(200);
      const fileExt = subFile.name.split(".").pop().toLowerCase();
      if (fileExt === "vtt") {
        subFile.createReadStream().pipe(res);
      } else {
        // SRT/ASS → read fully then convert
        let buf = "";
        const stream = subFile.createReadStream();
        stream.on("data", c => buf += c.toString());
        stream.on("end", () => res.end(srtToVtt(buf)));
        stream.on("error", () => res.end("WEBVTT\n\n"));
      }
      return;
    }

    // Embedded subtitle stream (numeric ffmpeg stream index)
    const idx = parseInt(trackId);
    if (isNaN(idx)) { res.writeHead(400); res.end("Bad track id"); return; }
    const videoExt = activeFile.name.split(".").pop().toLowerCase();
    const inputFormat = videoExt === "mkv" ? "matroska" : videoExt;
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

    const audioParam = u.searchParams.get("audio");
    const compatMode = u.searchParams.get("compat") === "1";
    const ext = activeFile.name.split(".").pop().toLowerCase();
    const inputFormat = ext === "mkv" ? "matroska" : ext;

    // Audio track remux via ffmpeg
    if (audioParam !== null) {
      const audioIdx = parseInt(audioParam);
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

    // iOS / compat mode — repackage as fragmented MP4, copy video, stereo AAC audio
    // Use the local HTTP stream as input so ffmpeg can make range requests and seek properly
    if (compatMode || !["mp4", "m4v"].includes(ext)) {
      console.log(`[compat] remuxing: ${activeFile.name}`);
      res.writeHead(200, { "Content-Type": "video/mp4" });
      const ff = Ffmpeg()
        .input(`http://localhost:${PORT}/stream`)  // seekable via range requests
        .outputOptions([
          "-map 0:v:0", "-map 0:a:0",
          "-c:v copy",                             // no video re-encode — just repackage
          "-c:a aac", "-ac 2", "-b:a 192k",        // downmix to stereo AAC for iOS
          "-f mp4", "-movflags frag_keyframe+empty_moov+default_base_moof"
        ])
        .on("error", e => { console.error("[compat remux]", e.message); try { res.end(); } catch(_) {} })
        .pipe(res, { end: true });
      req.on("close", () => { try { ff.kill("SIGKILL"); } catch(_) {} });
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
      res.end(JSON.stringify(data.streams || []))