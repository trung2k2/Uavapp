import os from "os";
import path from "path";
import fs from "fs/promises";
import * as fsSync from "fs";
import net from "net";
import { Client as FtpClient } from "basic-ftp";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function usage() {
  const cmd = "node scripts/download-to-desktop.mjs";
  console.log(`
Usage:
  ${cmd} <remotePath> [options]

Options:
  --host <ip>      FTP host (default: 192.168.42.2 then 192.168.42.1)
  --port <n>       Port (default: 21)
  --out  <dir>     Output dir (default: Desktop/Drone_Data_Downloads)
  --force          Skip file-still-growing check
  --verbose        Print all FTP traffic
  --log  <file>    Write verbose log to file
  --stall-ms <n>   Abort if no data bytes for N ms (default: 120000)
  --basic          Use basic-ftp instead of raw TCP

Notes:
  - Saves to .part first, renames on success (resume supported).
  - Default raw-TCP mode sends RETR right after PASV so embedded
    servers do not timeout before the data connection arrives.
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const out = { remotePath: null, host: null, port: 21, outDir: null,
    force: false, verbose: false, logFile: null, stallMs: 120000, useRaw: true };
  if (args.length === 0 || args.includes("--help") || args.includes("-h"))
    return { help: true, ...out };
  out.remotePath = args.shift();
  while (args.length) {
    const a = args.shift();
    if      (a === "--host")     out.host    = args.shift() ?? null;
    else if (a === "--port")     out.port    = Number(args.shift() ?? 21);
    else if (a === "--out")      out.outDir  = args.shift() ?? null;
    else if (a === "--force")    out.force   = true;
    else if (a === "--verbose")  out.verbose = true;
    else if (a === "--log")      out.logFile = args.shift() ?? null;
    else if (a === "--stall-ms") out.stallMs = Number(args.shift() ?? 120000);
    else if (a === "--raw")      out.useRaw  = true;
    else if (a === "--basic")    out.useRaw  = false;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return { help: false, ...out };
}

function createLogger({ verbose, logFile }) {
  const filePath = logFile ? path.resolve(logFile) : null;
  const queue = [];
  let writing = false;
  async function flush() {
    if (writing || !queue.length || !filePath) return;
    writing = true;
    try { await fs.appendFile(filePath, queue.splice(0).join(""), "utf8"); }
    finally { writing = false; if (queue.length) void flush(); }
  }
  function log(line) {
    const msg = `[${new Date().toISOString()}] ${String(line ?? "")}\n`;
    if (verbose) console.log(String(line ?? ""));
    if (filePath) { queue.push(msg); void flush(); }
  }
  return { log };
}

function splitFtpPath(remotePath) {
  const p = String(remotePath || "");
  const idx = p.lastIndexOf("/");
  if (idx < 0) return { dir: null, name: p };
  return { dir: idx === 0 ? "/" : p.slice(0, idx), name: p.slice(idx + 1) };
}

async function fileSizeOrZero(p) {
  try { return (await fs.stat(p)).size; } catch { return 0; }
}

async function sizeStableCheck(host, port, remoteDir, remoteName, waitMs) {
  const c = new FtpClient(30000);
  try {
    await c.access({ host, port, user: "", password: "", secure: false });
    if (remoteDir) await c.cd(remoteDir);
    const s1 = await c.size(remoteName).catch(() => null);
    if (s1 == null) return { stable: true, size: null };
    await new Promise(r => setTimeout(r, waitMs));
    const s2 = await c.size(remoteName).catch(() => null);
    if (s2 == null) return { stable: true, size: s1 };
    return { stable: s1 === s2, size: s2, previousSize: s1 };
  } finally { c.close(); }
}

// ── Raw TCP FTP ──────────────────────────────────────────────────────────────
// Protocol sequence reverse-engineered from manufacturer pcapng capture:
//   TYPE I  →  200
//   SIZE /full/path/file  →  213 <bytes>   (primes server file handle)
//   PASV  →  227
//   RETR /full/path/file  →  150 Opening BINARY connection
//   [data]
//   226 Operation successful
// Key: SIZE must come before PASV+RETR; all paths are absolute (no CWD).

function rawFtpDownload({ host, port, remotePath, partPath, startAt, stallMs, log }) {
  return new Promise((resolve, reject) => {
    let state        = "AWAIT_BANNER";
    let ctrlBuf      = "";
    let dataSock     = null;
    let fileStream   = null;
    let bytesTotal   = 0;          // bytes written this session
    let lastActivityMs = Date.now();
    let done         = false;
    let restOffset   = startAt;
    let earlyDataBuf = [];         // data arriving before fileStream is open

    function fail(err) {
      if (done) return; done = true;
      if (stallTimer) clearInterval(stallTimer);
      try { ctrl.destroy(); }   catch {}
      try { if (dataSock)   dataSock.destroy(); }  catch {}
      try { if (fileStream) fileStream.close(); }  catch {}
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function succeed() {
      if (done) return; done = true;
      if (stallTimer) clearInterval(stallTimer);
      try { ctrl.destroy(); } catch {}
      if (fileStream) fileStream.end(() => resolve(bytesTotal));
      else            resolve(bytesTotal);
    }

    const stallTimer = Number.isFinite(stallMs) && stallMs > 0
      ? setInterval(() => {
          if (done) { clearInterval(stallTimer); return; }
          const idle = Date.now() - lastActivityMs;
          if (idle >= stallMs) fail(new Error(`Stalled: no data for ${idle}ms`));
        }, 1000)
      : null;

    // ── Control socket ─────────────────────────────────────────────────────
    const ctrl = net.createConnection({ host, port });
    ctrl.setKeepAlive(true, 10000);
    ctrl.setNoDelay(true);
    ctrl.setTimeout(5 * 60 * 1000);
    ctrl.on("timeout", () => { log("Control idle timeout"); fail(new Error("Control idle timeout")); });
    ctrl.on("error",   e  => { log(`Control error: ${e.message}`); fail(e); });
    ctrl.on("close",   () => { if (!done) { if (bytesTotal>0) succeed(); else fail(new Error("Control closed early")); } });

    function send(cmd) { log(`> ${cmd}`); ctrl.write(cmd + "\r\n"); }

    // ── Data socket ────────────────────────────────────────────────────────
    function openDataSocket(dHost, dPort) {
      log(`Opening data socket to ${dHost}:${dPort}`);
      dataSock = net.createConnection({ host: dHost, port: dPort });
      dataSock.setKeepAlive(true, 5000);
      dataSock.setNoDelay(true);

      dataSock.on("error", e => { log(`DATA error: ${e.message}`); if (!done) fail(new Error(`DATA error: ${e.message}`)); });
      dataSock.on("end",   () => { log(`\nDATA end, session bytes=${bytesTotal}`);       if (!done) succeed(); });
      dataSock.on("close", hadErr => {
        log(`DATA close hadErr=${hadErr}, session bytes=${bytesTotal}`);
        if (!done) { if (bytesTotal > 0 || restOffset > 0) succeed(); else fail(new Error("DATA closed before any bytes")); }
      });

      // Buffer data that arrives before fileStream is initialised
      dataSock.on("data", chunk => {
        lastActivityMs = Date.now();
        if (fileStream) {
          bytesTotal += chunk.length;
          if (!fileStream.write(chunk)) { dataSock.pause(); fileStream.once("drain", () => { if (!done) dataSock.resume(); }); }
        } else {
          earlyDataBuf.push(chunk);
        }
        process.stdout.write(`\rDownloading... ${((restOffset + bytesTotal) / 1024 / 1024).toFixed(1)} MB`);
      });

      dataSock.on("connect", () => {
        log(`DATA socket connected to ${dHost}:${dPort}`);
        lastActivityMs = Date.now();

        // Open file for writing now that socket is ready.
        // RETR was already sent on the control channel right after PASV —
        // data may already be arriving (buffered in earlyDataBuf).
        if (!fileStream) {
          try {
            if (restOffset > 0) {
              if (!fsSync.existsSync(partPath)) fsSync.writeFileSync(partPath, "");
              fileStream = fsSync.createWriteStream(partPath, { flags: "r+", start: restOffset });
            } else {
              fileStream = fsSync.createWriteStream(partPath, { flags: "w" });
            }
            fileStream.on("error", e => { log(`File error: ${e.message}`); fail(e); });
          } catch(e) { fail(e); return; }
        }

        // Flush any data that arrived before fileStream was ready
        if (earlyDataBuf.length) {
          for (const chunk of earlyDataBuf) { bytesTotal += chunk.length; fileStream.write(chunk); }
          earlyDataBuf = [];
        }
      });
    }

    // ── Control-channel state machine ──────────────────────────────────────
    function onLine(line) {
      log(`< ${line}`);
      const code = parseInt(line.slice(0, 3), 10);
      if (line.length > 3 && line[3] === "-") return; // multi-line continuation

      switch (state) {
        case "AWAIT_BANNER":
          if (code === 220)               { state = "AWAIT_USER";  send("USER"); }
          else if (code >= 400) fail(new Error(`Banner: ${line}`));
          break;

        case "AWAIT_USER":
          if (code === 230 || code === 202) { state = "AWAIT_TYPE"; send("TYPE I"); }
          else if (code === 331)            { send("PASS "); }
          else if (code >= 400) fail(new Error(`Login: ${line}`));
          break;

        case "AWAIT_TYPE":
          // Manufacturer sequence: TYPE I -> SIZE /fullpath -> PASV -> RETR /fullpath
          if (code === 200)     { state = "AWAIT_SIZE"; send(`SIZE ${remotePath}`); }
          else if (code >= 400) fail(new Error(`TYPE I: ${line}`));
          break;

        case "AWAIT_SIZE":
          // 213 = file size OK; proceed to PASV
          if (code === 213)     { state = "AWAIT_PASV"; send("PASV"); }
          else if (code === 550) { fail(new Error(`File not found: ${remotePath}`)); }
          else if (code >= 400) fail(new Error(`SIZE: ${line}`));
          break;

        case "AWAIT_PASV": {
          if (code === 227) {
            const m = line.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
            if (!m) { fail(new Error(`Bad PASV: ${line}`)); return; }
            const dHost = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
            const dPort = parseInt(m[5]) * 256 + parseInt(m[6]);

            // Open data socket in parallel — fileStream will be set up in
            // the connect handler, which also flushes earlyDataBuf.
            openDataSocket(dHost, dPort);

            // Send RETR IMMEDIATELY after PASV — drone has a very short
            // timer (~100-300ms) and will reply 421 if RETR is delayed.
            // earlyDataBuf handles data that arrives before data socket connects.
            if (restOffset > 0) {
              state = "AWAIT_REST";
              send(`REST ${restOffset}`);
            } else {
              state = "AWAIT_RETR_RESP";
              send(`RETR ${remotePath}`);
            }
          } else if (code >= 400) {
            fail(new Error(`PASV: ${line}`));
          }
          break;
        }

        case "AWAIT_DATA_CONNECT":
          // No longer used — kept for safety.
          break;

        case "AWAIT_REST":
          if (code === 350) {
            state = "AWAIT_RETR_RESP";
            send(`RETR ${remotePath}`);
          } else {
            // REST not supported — restart download from 0
            log("REST not supported, restarting from byte 0");
            restOffset = 0;
            try { if (fileStream) { fileStream.close(); fileStream = null; } } catch {}
            fileStream = fsSync.createWriteStream(partPath, { flags: "w" });
            fileStream.on("error", e => { log(`File error: ${e.message}`); fail(e); });
            state = "AWAIT_RETR_RESP";
            send(`RETR ${remotePath}`);
          }
          break;

        case "AWAIT_RETR_RESP":
          if (code === 125 || code === 150) {
            log("Server confirmed transfer start (125/150)");
            state = "TRANSFERRING";
          } else if (code === 226 || code === 250) {
            succeed(); // empty file or instant complete
          } else if (code >= 400) {
            fail(new Error(`RETR: ${line}`));
          }
          // If server sends nothing / non-standard: data socket handles it.
          break;

        case "TRANSFERRING":
          if (code === 226 || code === 250) { log("Transfer complete signal from server"); }
          else if (code >= 400)             { fail(new Error(`Transfer error: ${line}`)); }
          break;

        default: break;
      }
    }

    ctrl.on("data", buf => {
      ctrlBuf += buf.toString("utf8");
      const lines = ctrlBuf.split(/\r?\n/);
      ctrlBuf = lines.pop() ?? "";
      for (const line of lines) { if (line.trim()) onLine(line); }
    });
  });
}

// ── basic-ftp fallback ───────────────────────────────────────────────────────
async function basicFtpDownload({ host, port, remoteDir, remoteName, remotePath, partPath, startAt, stallMs, log }) {
  // Use full absolute path if available; fall back to remoteDir+remoteName
  const fullRemotePath = remotePath || (remoteDir && remoteDir !== "/" ? `${remoteDir}/${remoteName}` : `/${remoteName}`);
  let pasvFn = null;
  try {
    const t = require("basic-ftp/dist/transfer");
    if (typeof t?.enterPassiveModeIPv4_forceControlHostIP === "function")
      pasvFn = t.enterPassiveModeIPv4_forceControlHostIP;
  } catch {}

  const client = new FtpClient(60 * 60 * 1000);
  client.ftp.verbose = true;
  client.ftp.log = m => log(m);
  let lastActivity = Date.now();
  client.trackProgress(() => { lastActivity = Date.now(); });

  let stallTimer = null;
  if (Number.isFinite(stallMs) && stallMs > 0)
    stallTimer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle >= stallMs) { log(`STALL ${idle}ms, aborting`); try { client.close(); } catch {} }
    }, 1000);

  try {
    if (pasvFn) client.prepareTransfer = pasvFn;
    await client.access({ host, port, user: "", password: "", secure: false });
    try { const s = client.ftp.socket; if (s) { s.setKeepAlive(true, 10000); s.setNoDelay(true); } } catch {}
    // Use absolute path + send SIZE before PASV+RETR (manufacturer-required sequence).
    // No CWD needed when using full paths.
    if (startAt > 0 && !fsSync.existsSync(partPath)) fsSync.writeFileSync(partPath, "");
    lastActivity = Date.now();
    // Prime server file handle right before PASV+RETR
    try { await client.size(fullRemotePath); } catch {}
    await client.downloadTo(partPath, fullRemotePath, startAt);
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    try { client.trackProgress(null); } catch {}
    client.close();
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────
async function downloadFile({ host, port, remotePath, outDir, force, verbose, logFile, stallMs, useRaw }) {
  const { log } = createLogger({ verbose, logFile });
  const parts = splitFtpPath(remotePath);
  const remoteDir  = parts.dir || null;
  const remoteName = parts.name;

  log(`Checking file stability on ${host}:${port}...`);
  const stable = await sizeStableCheck(host, port, remoteDir, remoteName, 1500);
  if (!force && stable.size != null && !stable.stable)
    throw new Error(`File still recording: ${stable.previousSize} -> ${stable.size}. Use --force to override.`);

  const expectedSize = stable.size;
  log(`Remote size: ${expectedSize ?? "unknown"}`);

  const safeBase = path.basename(remoteName).replace(/[\\/:*?"<>|]/g, "_");
  await fs.mkdir(outDir, { recursive: true });
  const finalPath = path.join(outDir, safeBase);
  const partPath  = finalPath + ".part";

  // Already done?
  if (expectedSize != null && expectedSize > 0 && await fileSizeOrZero(finalPath) === expectedSize) {
    console.log(`\nAlready complete: ${finalPath}`);
    return finalPath;
  }

  let startAt = await fileSizeOrZero(partPath);
  if (expectedSize != null && startAt > expectedSize) {
    try { await fs.unlink(partPath); } catch {}
    startAt = 0;
  }

  const resumeNote = startAt > 0 ? ` (resuming from ${(startAt/1024/1024).toFixed(1)} MB)` : "";
  console.log(`\nHost   ${host}:${port}`);
  console.log(`Remote ${remotePath}`);
  console.log(`Local  ${finalPath}${resumeNote}`);
  console.log(`Mode   ${useRaw ? "raw-tcp" : "basic-ftp"}`);
  console.log(`Size   ${expectedSize ? (expectedSize/1024/1024).toFixed(1)+" MB" : "unknown"}`);

  if (useRaw) {
    const bytes = await rawFtpDownload({ host, port, remotePath, partPath, startAt, stallMs, log });
    process.stdout.write("\n");
    log(`Raw TCP done, session bytes: ${bytes}`);
  } else {
    await basicFtpDownload({ host, port, remoteDir, remoteName, remotePath, partPath, startAt, stallMs, log });
    process.stdout.write("\n");
  }

  const gotSize = await fileSizeOrZero(partPath);
  if (expectedSize != null && expectedSize > 0 && gotSize !== expectedSize)
    throw new Error(`Size mismatch: got ${gotSize}, expected ${expectedSize}. .part kept for resume.`);

  try { await fs.unlink(finalPath); } catch {}
  await fs.rename(partPath, finalPath);
  return finalPath;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { usage(); process.exit(0); }
  if (!parsed.remotePath) { usage(); process.exit(1); }

  const desktop = path.join(os.homedir(), "Desktop");
  const outDir  = parsed.outDir ? path.resolve(parsed.outDir) : path.join(desktop, "Drone_Data_Downloads");
  const hostsToTry = parsed.host
    ? [{ host: parsed.host, port: parsed.port || 21 }]
    : [{ host: "192.168.42.2", port: 21 }, { host: "192.168.42.1", port: 21 }];

  let lastErr = null;
  for (const h of hostsToTry) {
    // raw x2, then basic-ftp x2
    const modes = parsed.useRaw ? [true, true, false, false] : [false, false, true, true];
    for (let i = 0; i < modes.length; i++) {
      try {
        console.log(`\nAttempt ${i+1}/${modes.length} on ${h.host}:${h.port} [${modes[i]?"raw-tcp":"basic-ftp"}]`);
        const saved = await downloadFile({ host: h.host, port: h.port, remotePath: parsed.remotePath,
          outDir, force: parsed.force, verbose: parsed.verbose, logFile: parsed.logFile,
          stallMs: parsed.stallMs, useRaw: modes[i] });
        console.log(`\nSaved to: ${saved}`);
        return;
      } catch (e) {
        lastErr = e;
        console.log(`\nError: ${String(e?.message || e)}`);
        await new Promise(r => setTimeout(r, i < 2 ? 1000 : 2500));
      }
    }
  }
  throw lastErr || new Error("All attempts failed");
}

main().catch(e => { console.error(String(e?.stack || e?.message || e)); process.exit(1); });
