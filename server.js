import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import geminiModule from "./gemini.cjs";

const { askGemini } = geminiModule;
const execAsync = promisify(exec);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = String(process.env.OLLAMA_MODEL || "llama3.2").trim();
const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads");
const WINDOWS_DOWNLOADS = {
  spotify: { file: "SpotifySetup.exe", url: "https://download.scdn.co/SpotifySetup.exe" },
  discord: { file: "DiscordSetup.exe", url: "https://discord.com/api/download?platform=win" },
  steam: { file: "SteamSetup.exe", url: "https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe" },
  ollama: { file: "OllamaSetup.exe", url: "https://ollama.com/download/OllamaSetup.exe" }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/features", express.static(path.join(__dirname, "docs")));

// ═══════════════════════════════════════
// PLATFORM DETECTION
// ═══════════════════════════════════════

const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'
const IS_WINDOWS = PLATFORM === "win32";
const IS_MAC = PLATFORM === "darwin";
const IS_LINUX = PLATFORM === "linux";

function run(command, timeout = 12000) {
  return new Promise((resolve) => {
    exec(command, { timeout, shell: true, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: (stdout || "").trim(),
        error: (stderr || error?.message || "").trim()
      });
    });
  });
}

function reply(res, text, extra = {}) {
  return res.json({
    ok: true,
    reply: text,
    ...extra
  });
}

function has(text, words) {
  return words.some((word) => text.includes(word));
}

function clean(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s:/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quote(text) {
  if (IS_WINDOWS) {
    return `"${String(text).replace(/"/g, '\\"')}"`;
  }
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

async function downloadWindowsInstaller(appName) {
  const key = String(appName || "").trim().toLowerCase();
  const installer = WINDOWS_DOWNLOADS[key];
  if (!installer) {
    throw new Error(`${appName} does not have a supported direct Windows installer. Use its official store or website.`);
  }
  await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
  const response = await fetch(installer.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Official download returned HTTP ${response.status}.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new Error("The official download was empty.");
  const destination = path.join(DOWNLOADS_DIR, installer.file);
  await fs.promises.writeFile(destination, data);
  return { destination, bytes: data.length };
}

function isPermittedMusicLicense(value) {
  return /creativecommons\.org|publicdomain|public domain|cc0/i.test(String(value || ""));
}

async function downloadLegalMusic(title) {
  const searchUrl = "https://archive.org/advancedsearch.php?q=" +
    encodeURIComponent(`title:("${title}") AND mediatype:audio`) +
    "&fl[]=identifier,title&rows=10&page=1&output=json";
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) throw new Error("The legal music search service is unavailable.");
  const searchData = await searchResponse.json();
  const docs = Array.isArray(searchData?.response?.docs) ? searchData.response.docs : [];

  for (const doc of docs) {
    const identifier = String(doc.identifier || "").trim();
    if (!identifier) continue;
    const metadataResponse = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
    if (!metadataResponse.ok) continue;
    const metadata = await metadataResponse.json();
    const license = [
      metadata?.metadata?.licenseurl,
      metadata?.metadata?.license,
      metadata?.metadata?.rights
    ].filter(Boolean).join(" ");
    if (!isPermittedMusicLicense(license)) continue;

    const files = Array.isArray(metadata.files) ? metadata.files : [];
    const audio = files
      .filter((file) => /\.(mp3|ogg|flac|wav)$/i.test(String(file.name || "")))
      .sort((a, b) => /\.(mp3)$/i.test(b.name) - /\.(mp3)$/i.test(a.name))[0];
    if (!audio?.name) continue;

    const safeTitle = String(doc.title || title).replace(/[<>:"/\\|?*]+/g, "_").trim().slice(0, 100);
    const extension = path.extname(audio.name).toLowerCase() || ".audio";
    const destination = path.join(DOWNLOADS_DIR, `${safeTitle || "legal-music"}${extension}`);
    const fileResponse = await fetch(`https://archive.org/download/${encodeURIComponent(identifier)}/${audio.name}`);
    if (!fileResponse.ok) continue;
    const data = Buffer.from(await fileResponse.arrayBuffer());
    if (!data.length) continue;
    await fs.promises.mkdir(DOWNLOADS_DIR, { recursive: true });
    await fs.promises.writeFile(destination, data);
    return { destination, bytes: data.length, license, source: identifier };
  }
  throw new Error(`No Creative Commons or public-domain recording was found for "${title}".`);
}

async function findLegalMusicPreview(title) {
  const query = String(title || "").trim();
  if (!query) throw new Error("Tell me which music to play.");
  const searchUrl = "https://archive.org/advancedsearch.php?q=" +
    encodeURIComponent(`title:("${query}") AND mediatype:audio`) +
    "&fl[]=identifier,title&rows=10&page=1&output=json";
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) throw new Error("The legal music search service is unavailable.");
  const searchData = await searchResponse.json();
  const docs = Array.isArray(searchData?.response?.docs) ? searchData.response.docs : [];

  for (const doc of docs) {
    const identifier = String(doc.identifier || "").trim();
    if (!identifier) continue;
    const metadataResponse = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
    if (!metadataResponse.ok) continue;
    const metadata = await metadataResponse.json();
    const license = [
      metadata?.metadata?.licenseurl,
      metadata?.metadata?.license,
      metadata?.metadata?.rights
    ].filter(Boolean).join(" ");
    if (!isPermittedMusicLicense(license)) continue;
    const audio = (Array.isArray(metadata.files) ? metadata.files : [])
      .filter((file) => /\.(mp3|ogg|wav)$/i.test(String(file.name || "")))
      .sort((a, b) => /\.(mp3)$/i.test(b.name) - /\.(mp3)$/i.test(a.name))[0];
    if (!audio?.name) continue;
    return {
      title: String(doc.title || query),
      url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(audio.name)}`,
      license,
      source: identifier
    };
  }
  throw new Error(`No Creative Commons or public-domain playable recording was found for "${query}".`);
}

async function askOllama(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(OLLAMA_BASE_URL + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          { role: "system", content: "You are JARVIS, a concise, helpful local personal AI assistant. Do not claim to control devices or perform actions unless JARVIS local tools confirm it." },
          { role: "user", content: message }
        ]
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `Ollama returned HTTP ${response.status}`);
    const text = String(data?.message?.content || "").trim();
    if (!text) throw new Error("Ollama returned no text.");
    return text;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Ollama timed out after 45 seconds.");
    if (error?.code === "ECONNREFUSED" || /fetch failed/i.test(String(error?.message))) {
      throw new Error(`Ollama is not running at ${OLLAMA_BASE_URL}. Start Ollama and run: ollama pull ${OLLAMA_MODEL}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════
// DESKTOP OPEN URL / APP
// ═══════════════════════════════════════

async function openUrl(url) {
  let cmd;
  if (IS_WINDOWS) cmd = `start "" ${quote(url)}`;
  else if (IS_MAC) cmd = `open ${quote(url)}`;
  else cmd = `xdg-open ${quote(url)}`;
  return run(cmd);
}

async function openPath(filePath) {
  let cmd;
  if (IS_WINDOWS) cmd = `start "" ${quote(filePath)}`;
  else if (IS_MAC) cmd = `open ${quote(filePath)}`;
  else cmd = `xdg-open ${quote(filePath)}`;
  return run(cmd);
}

// Common desktop apps
const KNOWN_APPS = {
  chrome: IS_WINDOWS ? "chrome" : IS_MAC ? "Google Chrome" : "google-chrome",
  "google chrome": IS_WINDOWS ? "chrome" : IS_MAC ? "Google Chrome" : "google-chrome",
  firefox: "firefox",
  edge: IS_WINDOWS ? "msedge" : "microsoft-edge",

  notepad: IS_WINDOWS ? "notepad" : IS_MAC ? "TextEdit" : "gedit",
  calculator: IS_WINDOWS ? "calc" : IS_MAC ? "Calculator" : "gnome-calculator",
  terminal: IS_WINDOWS ? "wt" : IS_MAC ? "Terminal" : "gnome-terminal",
  files: IS_WINDOWS ? "explorer" : IS_MAC ? "Finder" : "nautilus",
  "file manager": IS_WINDOWS ? "explorer" : IS_MAC ? "Finder" : "nautilus",

  code: "code",
  "vs code": "code",
  vscode: "code",
  spotify: "spotify",
  discord: "discord",
  slack: "slack"
};

async function launchKnownApp(name) {
  const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
  console.log(`[JARVIS APP] Requested: ${normalized}`);

  const app = KNOWN_APPS[normalized];
  if (!app) {
    return { ok: false, reason: "unknown", appName: normalized };
  }

  let cmd;
  if (IS_WINDOWS) {
    cmd = `start "" ${app}`;
  } else if (IS_MAC) {
    cmd = `open -a ${quote(app)}`;
  } else {
    cmd = `${app} >/dev/null 2>&1 &`;
  }

  const result = await run(cmd);
  return {
    ok: result.ok || true,
    appName: normalized,
    packageName: app
  };
}

// ═══════════════════════════════════════
// TIMERS
// ═══════════════════════════════════════

const timers = new Map();
let timerId = 1;

function createTimer(seconds, label) {
  const id = timerId++;
  const timeout = setTimeout(async () => {
    timers.delete(id);
    console.log(`[JARVIS TIMER] Timer ${id} complete`);
  }, seconds * 1000);

  timers.set(id, {
    id,
    label,
    seconds,
    created: Date.now(),
    timeout
  });
  return id;
}

function cancelAllTimers() {
  for (const timer of timers.values()) clearTimeout(timer.timeout);
  timers.clear();
}

// ═══════════════════════════════════════
// FILE HELPERS
// ═══════════════════════════════════════

const HOME = os.homedir();
const FILE_ROOTS = [
  HOME,
  path.join(HOME, "Desktop"),
  path.join(HOME, "Documents"),
  path.join(HOME, "Downloads"),
  path.join(HOME, "Pictures")
];

const MAX_FILE_RESULTS = 40;
const MAX_SEARCH_DEPTH = 6;

function normalizeFileQuery(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shellSafeFileName(text) {
  return String(text || "")
    .replace(/[^a-zA-Z0-9._ -]/g, "")
    .trim();
}

async function searchFiles(fileQuery, options = {}) {
  const queryText = normalizeFileQuery(fileQuery);
  if (!queryText) return [];

  const safeQuery = shellSafeFileName(queryText);
  if (!safeQuery) return [];

  const results = [];
  for (const root of FILE_ROOTS) {
    if (!fs.existsSync(root)) continue;

    let command;
    if (IS_WINDOWS) {
      command = `powershell -NoProfile -Command "Get-ChildItem -Path '${root}' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { \( _.Name -like '* \){safeQuery}*' } | Select-Object -First ${MAX_FILE_RESULTS} -ExpandProperty FullName"`;
    } else {
      command =
        `find ${quote(root)} -maxdepth ${MAX_SEARCH_DEPTH} -type f -iname \( {quote("*" + safeQuery + "*")} -print 2>/dev/null | head - \){MAX_FILE_RESULTS}`;
    }

    const result = await run(command, 20000);
    if (result.ok && result.output) {
      results.push(
        ...result.output
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
      );
    }
    if (results.length >= MAX_FILE_RESULTS) break;
  }
  return [...new Set(results)].slice(0, MAX_FILE_RESULTS);
}

async function searchAllFilesByExtension(extension) {
  const safeExt = shellSafeFileName(extension).replace(/^\./, "").toLowerCase();
  if (!safeExt) return [];

  const results = [];
  for (const root of FILE_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let command;
    if (IS_WINDOWS) {
      command = `powershell -NoProfile -Command "Get-ChildItem -Path '\( {root}' -Recurse -File -Filter '*. \){safeExt}' -ErrorAction SilentlyContinue | Select-Object -First ${MAX_FILE_RESULTS} -ExpandProperty FullName"`;
    } else {
      command =
        `find ${quote(root)} -maxdepth ${MAX_SEARCH_DEPTH} -type f -iname \( {quote("*." + safeExt)} -print 2>/dev/null | head - \){MAX_FILE_RESULTS}`;
    }
    const result = await run(command, 20000);
    if (result.ok && result.output) {
      results.push(
        ...result.output
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
      );
    }
  }
  return [...new Set(results)].slice(0, MAX_FILE_RESULTS);
}

function formatFileResults(results) {
  if (!results.length) return "I couldn't find any matching files.";
  if (results.length === 1) return `I found it here: ${results[0]}`;
  const shown = results.slice(0, 8);
  let text = `I found ${results.length} matching files. Here are the first ${shown.length}:\n`;
  shown.forEach((f, i) => (text += `${i + 1}. ${f}\n`));
  if (results.length > shown.length) text += `…and ${results.length - shown.length} more.`;
  return text.trim();
}

async function handleFileCommand(query, res) {
  const normalized = normalizeFileQuery(query);

  // Open file manager
  if (
    /^(?:please\s+)?(?:open|launch|start|show)\s+(?:the\s+)?(?:file\s+manager|files|file\s+browser|explorer|finder)$/i.test(
      normalized
    )
  ) {
    const result = await launchKnownApp("file manager");
    return reply(res, result.ok ? "Opening the file manager." : "I couldn't open the file manager.", {
      mode: "offline",
      fileAction: "open_manager"
    });
  }

  // Find / locate
  const findMatch = normalized.match(
    /^(?:please\s+)?(?:find|search\s+for|locate|where\s+is|where's|show\s+me)\s+(?:the\s+)?(?:file\s+)?(.+?)\s*$/i
  );
  if (findMatch) {
    let name = findMatch[1].trim().replace(/\s+(?:file|document)$/i, "").trim();

    const extensionMatch = name.match(/^all\s+([a-z0-9]+)\s*(?:files?)?$/i);
    if (extensionMatch) {
      const results = await searchAllFilesByExtension(extensionMatch[1]);
      return reply(res, formatFileResults(results), {
        mode: "offline",
        fileAction: "search",
        query: name,
        count: results.length,
        results
      });
    }

    name = name.replace(/^my\s+/i, "").replace(/^the\s+/i, "").trim();
    const results = await searchFiles(name);
    return reply(res, formatFileResults(results), {
      mode: "offline",
      fileAction: "search",
      query: name,
      count: results.length,
      results
    });
  }

  // Open specific file
  const openMatch = normalized.match(/^(?:please\s+)?open\s+(?:the\s+)?file\s+(.+)$/i);
  if (openMatch) {
    const name = openMatch[1].trim();
    const results = await searchFiles(name);
    if (!results.length) {
      return reply(res, `I couldn't find a file named ${name}.`, {
        mode: "offline",
        fileAction: "open_file",
        count: 0
      });
    }
    const filePath = results[0];
    const result = await openPath(filePath);
    return reply(
      res,
      result.ok ? `Opening ${filePath}.` : `I found ${filePath} but could not open it.`,
      { mode: "offline", fileAction: "open_file", path: filePath }
    );
  }

  return null;
}

// ═══════════════════════════════════════
// SYSTEM INFO HELPERS
// ═══════════════════════════════════════

async function getBattery() {
  try {
    if (IS_LINUX) {
      const r = await run("upower -i $(upower -e | grep BAT) 2>/dev/null | grep -E 'percentage|state'");
      if (r.output) return r.output.replace(/\n/g, ". ");
    }
    if (IS_MAC) {
      const r = await run("pmset -g batt");
      if (r.output) return r.output.split("\n").slice(0, 2).join(". ");
    }
    if (IS_WINDOWS) {
      const r = await run(
        `powershell -NoProfile -Command "(Get-WmiObject Win32_Battery).EstimatedChargeRemaining"`
      );
      if (r.output) return `Battery approximately ${r.output}% remaining.`;
    }
  } catch {}
  return null;
}

async function getStorage() {
  try {
    if (IS_WINDOWS) {
      const r = await run(
        `powershell -NoProfile -Command "Get-PSDrive C | Select-Object Used,Free"`
      );
      return r.output || null;
    }
    const r = await run("df -h / 2>/dev/null | tail -1");
    const parts = r.output.split(/\s+/);
    if (parts.length >= 5) {
      return `Storage usage is ${parts[4]}, with ${parts[3]} available.`;
    }
  } catch {}
  return null;
}

async function getDeviceInfo() {
  const hostname = os.hostname();
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const cpus = os.cpus()?.[0]?.model || "Unknown CPU";
  const mem = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  return `Device: ${hostname}. Platform: ${platform} \( {release} ( \){arch}). CPU: ${cpus}. Memory: ${mem} GB.`;
}

// ═══════════════════════════════════════
// COMMAND ENGINE
// ═══════════════════════════════════════

app.post("/api/command", async (req, res) => {
  const original = String(req.body.command || "").trim();
  if (!original) return reply(res, "I didn't hear a command.");

  const command = clean(original);
  const query = command
    .replace(/\b(jarvis|hey jarvis|okay jarvis|ok jarvis)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Local file assistant
  const fileResponse = await handleFileCommand(query, res);
  if (fileResponse !== null) return fileResponse;

  // Greetings
  if (has(query, ["hello", "hi", "hey", "good morning", "good afternoon", "good evening"])) {
    return reply(res, "Good to hear from you. JARVIS is online and ready.");
  }

  // Status
  if (has(query, ["are you online", "are you there", "system status", "jarvis status", "status"])) {
    return reply(res, "All core JARVIS systems are online. Running in desktop mode.");
  }

  // Time
  if (
    has(query, [
      "what time is it",
      "what is the time",
      "current time",
      "time now",
      "tell me the time"
    ])
  ) {
    const time = new Date().toLocaleTimeString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit"
    });

    return reply(res, `The current time is ${time}.`);
  }

  // Date
  if (
    has(query, [
      "what is today's date",
      "what is the date",
      "today's date",
      "current date",
      "what day is it"
    ])
  ) {
    const date = new Date().toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    });
    return reply(res, `Today is ${date}.`);
  }

  // Battery
  if (has(query, ["battery", "battery level", "battery percentage", "how much battery"])) {
    const bat = await getBattery();
    return reply(res, bat || "I couldn't retrieve battery status on this machine.");
  }

  // Storage
  if (has(query, ["storage", "free space", "disk space", "how much storage"])) {
    const stor = await getStorage();
    return reply(res, stor || "I couldn't retrieve storage information.");
  }

  // Device info
  if (
    has(query, [
      "device information",
      "device info",
      "system information",
      "system info",
      "tell me about my device"
    ])
  ) {
    return reply(res, await getDeviceInfo());
  }

  // Network
  if (
    has(query, [
      "network",
      "internet status",
      "am i connected",
      "check internet",
      "wifi status"
    ])
  ) {
    const r = await run(IS_WINDOWS ? "ping -n 1 8.8.8.8" : "ping -c 1 -W 2 8.8.8.8");
    return reply(
      res,
      r.ok ? "Internet connection is active." : "I couldn't confirm an active Internet connection."
    );
  }

  // Google search
  const search = query.match(/^(?:search google for|google search for|search for|google)\s+(.+)$/);
  if (search) {
    const text = encodeURIComponent(search[1]);
    await openUrl(`https://www.google.com/search?q=${text}`);
    return reply(res, `Searching Google for ${search[1]}.`);
  }

  const youtubeSearch = query.match(/^(?:search|find|play|watch|show)\s+(.+?)\s+(?:on|in)\s+youtube$/);
  if (youtubeSearch) {
    const text = encodeURIComponent(youtubeSearch[1]);
    await openUrl(`https://www.youtube.com/results?search_query=${text}`);
    return reply(res, `Searching YouTube for ${youtubeSearch[1]}.`);
  }

  // YouTube / Google / URL
  if (has(query, ["open youtube", "launch youtube"])) {
    await openUrl("https://youtube.com");
    return reply(res, "Opening YouTube.");
  }
  if (has(query, ["open google", "launch google"])) {
    await openUrl("https://google.com");
    return reply(res, "Opening Google.");
  }

  const urlMatch = query.match(/^(?:open|launch|visit)\s+(https?:\/\/\S+)$/);
  if (urlMatch) {
    await openUrl(urlMatch[1]);
    return reply(res, "Opening the requested website.");
  }

  // Timer
  const timer = query.match(/(?:set )?(?:a )?timer (?:for )?(\d+)\s*(seconds?|minutes?|hours?)/i);
  if (timer) {
    let seconds = Number(timer[1]);
    const unit = timer[2].toLowerCase();
    if (unit.startsWith("minute")) seconds *= 60;
    if (unit.startsWith("hour")) seconds *= 3600;
    const id = createTimer(seconds, "");
    return reply(res, `Timer ${id} set for ${timer[1]} ${unit}.`);
  }

  if (has(query, ["cancel timer", "cancel all timers", "stop timer", "stop all timers"])) {
    const count = timers.size;
    cancelAllTimers();
    return reply(res, count ? `Cancelled \( {count} timer \){count === 1 ? "" : "s"}.` : "There were no active timers.");
  }

  // App launcher
  if (/^(?:please )?(?:open|launch|start)\s+/.test(query)) {
    let appName = query
      .replace(/^(?:please )?(?:open|launch|start)\s+/, "")
      .replace(/^my\s+/, "")
      .replace(/^the\s+/, "")
      .trim();

    const result = await launchKnownApp(appName);
    if (result.ok) {
      return reply(res, `Opening ${appName}.`, { app: appName });
    }
    if (result.reason === "unknown") {
      return reply(
        res,
        `I don't have a launcher mapping for "${appName}" yet. You can add it to KNOWN_APPS in server.js.`
      );
    }
    return reply(res, `I tried to open ${appName} but the system did not allow it.`);
  }

  // Help
  if (has(query, ["what can you do", "help", "commands"])) {
    return reply(
      res,
      "I can tell the time and date, check battery and storage, open websites and apps, search Google, set timers, find local files, and answer general questions with my AI core."
    );
  }

  // Gemini fallback
  try {
    console.log(`[JARVIS AI] User: ${original}`);
    const aiResponse = await askGemini(original);
    console.log(`[JARVIS AI] JARVIS: ${aiResponse}`);
    return reply(res, aiResponse, { mode: "gemini" });
  } catch (error) {
    console.warn("[JARVIS AI] Gemini unavailable:", error.message);
    try {
      console.log(`[JARVIS AI] Trying local Ollama model ${OLLAMA_MODEL}...`);
      const localResponse = await askOllama(original);
      console.log(`[JARVIS AI] Local Ollama response from ${OLLAMA_MODEL}`);
      return reply(res, localResponse, { mode: "ollama", model: OLLAMA_MODEL, fallback: true });
    } catch (localError) {
      console.error("[JARVIS AI] Local Ollama unavailable:", localError.message);
      return res.status(503).json({
        ok: false,
        reply: `Gemini is unavailable (${error.message}), and the local model is unavailable (${localError.message}). Install/start Ollama and run "ollama pull ${OLLAMA_MODEL}", or check your Gemini key.`,
        mode: "offline"
      });
    }
  }
});

// ═══════════════════════════════════════
// VOICE ENDPOINT (compatibility)
// ═══════════════════════════════════════

app.post("/api/voice", async (req, res) => {
  return reply(res, "Use the VOICE button — speech recognition runs in the browser on desktop.");
});

// Timers & status
app.get("/api/timers", (req, res) => {
  const active = [...timers.values()].map((timer) => ({
    id: timer.id,
    label: timer.label,
    seconds: timer.seconds,
    remaining: Math.max(
      0,
      Math.ceil((timer.created + timer.seconds * 1000 - Date.now()) / 1000)
    )
  }));
  res.json({ ok: true, timers: active });
});

app.get("/api/status", (req, res) => {
  res.json({
    online: true,
    name: "JARVIS",
    mode: "desktop",
    platform: PLATFORM,
    voice: true,
    timers: timers.size,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/download", async (req, res) => {
  const appName = String(req.body.app || "").trim();
  if (!appName) return res.status(400).json({ ok: false, reply: "Tell me which app to download." });
  try {
    const result = await downloadWindowsInstaller(appName);
    return reply(res, `${appName} installer downloaded to ${result.destination}. It was not opened or installed.`, {
      mode: "download",
      path: result.destination,
      bytes: result.bytes
    });

  } catch (error) {
    return res.status(400).json({ ok: false, reply: error.message, mode: "download" });
  }
});

app.post("/api/music/download", async (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ ok: false, reply: "Tell me the music title to download." });
  try {
    const result = await downloadLegalMusic(title);
    return reply(res, `Legal music download saved to ${result.destination}. License verified as ${result.license}.`, {
      mode: "legal-music-download",
      path: result.destination,
      bytes: result.bytes,
      source: result.source
    });

  } catch (error) {
    return res.status(404).json({ ok: false, reply: error.message, mode: "legal-music-download" });
  }
});

app.post("/api/music/preview", async (req, res) => {
  const title = String(req.body.title || "").trim();
  try {
    const result = await findLegalMusicPreview(title);
    return reply(res, `Playing ${result.title} in the JARVIS background player.`, {
      mode: "music-preview",
      ...result
    });
  } catch (error) {
    return res.status(404).json({ ok: false, reply: error.message, mode: "music-preview" });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`JARVIS ONLINE (Desktop) → http://127.0.0.1:${PORT}`);
  console.log(`Platform: ${PLATFORM}`);
});