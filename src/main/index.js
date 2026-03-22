import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { dialog } from 'electron'
import { join } from 'path'
import path from 'path'
import fs from 'fs/promises'
import * as fsSync from 'fs'
import os from 'os'
import net from 'net'
import { pipeline } from 'stream/promises'
import { createRequire } from 'module'
import { Client as FtpClient } from 'basic-ftp'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import SerialService from './serial-service.js'
const { MAIN_VITE_DATA_ADD_HASH_COMMON_KEY } = import.meta.env

const require = createRequire(import.meta.url)

try {
  app.commandLine.appendSwitch('disable-http-cache')
  app.commandLine.appendSwitch('disk-cache-size', '1')
  app.commandLine.appendSwitch('media-cache-size', '1')
} catch {}

let enterPassiveModeIPv4_forceControlHostIP = null
let enterPassiveModeIPv6 = null
let parsePasvResponse = null
let connectForPassiveTransfer = null
try {
  // basic-ftp doesn't export this on the main module surface in some builds.
  // Pull it from the internal transfer module.
  const transfer = require('basic-ftp/dist/transfer')
  if (typeof transfer?.enterPassiveModeIPv4_forceControlHostIP === 'function') {
    enterPassiveModeIPv4_forceControlHostIP = transfer.enterPassiveModeIPv4_forceControlHostIP
  }
  if (typeof transfer?.enterPassiveModeIPv6 === 'function') {
    // Despite the name, this uses EPSV and works fine on IPv4.
    enterPassiveModeIPv6 = transfer.enterPassiveModeIPv6
  }
  if (typeof transfer?.parsePasvResponse === 'function') {
    parsePasvResponse = transfer.parsePasvResponse
  }
  if (typeof transfer?.connectForPassiveTransfer === 'function') {
    connectForPassiveTransfer = transfer.connectForPassiveTransfer
  }
} catch {
  try {
    const transfer = require('basic-ftp/dist/transfer.js')
    if (typeof transfer?.enterPassiveModeIPv4_forceControlHostIP === 'function') {
      enterPassiveModeIPv4_forceControlHostIP = transfer.enterPassiveModeIPv4_forceControlHostIP
    }
    if (typeof transfer?.enterPassiveModeIPv6 === 'function') {
      enterPassiveModeIPv6 = transfer.enterPassiveModeIPv6
    }
    if (typeof transfer?.parsePasvResponse === 'function') {
      parsePasvResponse = transfer.parsePasvResponse
    }
    if (typeof transfer?.connectForPassiveTransfer === 'function') {
      connectForPassiveTransfer = transfer.connectForPassiveTransfer
    }
  } catch {
    enterPassiveModeIPv4_forceControlHostIP = null
    parsePasvResponse = null
    connectForPassiveTransfer = null
  }
}

function forcePasvForDownloads(client) {
  try {
    if (typeof enterPassiveModeIPv4_forceControlHostIP === 'function') {
      client.prepareTransfer = async (ftp) => {
        try {
          // Ensure IPv4 for embedded servers advertising IPv4 endpoints.
          if (ftp && typeof ftp.ipFamily === 'number') ftp.ipFamily = 4
        } catch {}

        const res = await enterPassiveModeIPv4_forceControlHostIP(ftp)

        try {
          const msg = String(res?.message || '')
          let port = null
          try {
            const parsed = typeof parsePasvResponse === 'function' ? parsePasvResponse(msg) : null
            port = parsed?.port || null
          } catch {}
          const ds = ftp?.dataSocket
          const local = ds ? `${ds.localAddress || ''}:${ds.localPort || ''}` : ''
          const remote = ds ? `${ds.remoteAddress || ''}:${ds.remotePort || port || ''}` : (port ? `:${port}` : '')
          writeFtpLog({ msg: `[PASV4] ${msg} dataSocket=${remote} local=${local}` })
        } catch {}

        return res
      }
    }
  } catch {}
}

function preferEpsvForDownloads(client) {
  try {
    if (typeof enterPassiveModeIPv6 !== 'function' || typeof enterPassiveModeIPv4_forceControlHostIP !== 'function') {
      // If internals aren't available, don't override library defaults.
      return
    }

    client.prepareTransfer = async (ftp) => {
      try {
        if (ftp && typeof ftp.ipFamily === 'number') ftp.ipFamily = 4
      } catch {}

      // Try EPSV first (vendor app does this), then fall back to PASV.
      try {
        const res = await enterPassiveModeIPv6(ftp)
        try {
          const ds = ftp?.dataSocket
          const local = ds ? `${ds.localAddress || ''}:${ds.localPort || ''}` : ''
          const remote = ds ? `${ds.remoteAddress || ''}:${ds.remotePort || ''}` : ''
          writeFtpLog({ msg: `[EPSV4] ${String(res?.message || '').trim()} dataSocket=${remote} local=${local}` })
        } catch {}
        return res
      } catch (e) {
        try {
          writeFtpLog({ level: 'error', msg: `[EPSV4] failed; falling back to PASV4: ${String(e?.message || e)}` })
        } catch {}
        const res = await enterPassiveModeIPv4_forceControlHostIP(ftp)
        try {
          const msg = String(res?.message || '')
          let port = null
          try {
            const parsed = typeof parsePasvResponse === 'function' ? parsePasvResponse(msg) : null
            port = parsed?.port || null
          } catch {}
          const ds = ftp?.dataSocket
          const local = ds ? `${ds.localAddress || ''}:${ds.localPort || ''}` : ''
          const remote = ds ? `${ds.remoteAddress || ''}:${ds.remotePort || port || ''}` : (port ? `:${port}` : '')
          writeFtpLog({ msg: `[PASV4] ${String(res?.message || '').trim()} dataSocket=${remote} local=${local}` })
        } catch {}
        return res
      }
    }
  } catch {}
}

function getPreliminaryTimeoutMsForFile(fileInfo, attempt = 1) {
  const sz = typeof fileInfo?.size === 'number' ? fileInfo.size : null
  // Prioritize download completion for large files on unstable drone links.
  // Large files often take longer to return 150/125 under load.
  let baseMs = 15_000
  if (sz != null) {
    if (sz >= 200 * 1024 * 1024) baseMs = 60_000
    else if (sz >= 60 * 1024 * 1024) baseMs = 45_000
    else if (sz >= 10 * 1024 * 1024) baseMs = 20_000
    else baseMs = 12_000
  }

  const retryBumpMs = Math.min(Math.max(0, attempt - 1), 2) * 5_000
  return Math.min(baseMs + retryBumpMs, 70_000)
}

function getRemoteSizeToleranceBytes(remoteSize) {
  // DJI drone FTP SIZE can be slightly different from the actual transferred length.
  // For large files, allow wider tolerance because embedded FTP SIZE can drift.
  const sz = typeof remoteSize === 'number' && Number.isFinite(remoteSize) ? remoteSize : null
  if (sz == null || sz <= 0) return 0
  if (sz >= 1 * 1024 * 1024 * 1024) return 8 * 1024 * 1024
  if (sz >= 200 * 1024 * 1024) return 4 * 1024 * 1024
  if (sz >= 60 * 1024 * 1024) return 2 * 1024 * 1024
  return 8 * 1024
}

function getTransferTimeoutMsForFileSize(sizeBytes) {
  const sz = typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? sizeBytes : null
  if (sz == null) return FTP_TIMEOUT_MS
  if (sz >= 500 * 1024 * 1024) return 90 * 60 * 1000
  if (sz >= 200 * 1024 * 1024) return 60 * 60 * 1000
  if (sz >= 100 * 1024 * 1024) return 45 * 60 * 1000
  if (sz >= 50 * 1024 * 1024) return 30 * 60 * 1000
  return FTP_TIMEOUT_MS
}

function getResumeWindowMsForFile(remotePathOrName, sizeBytes) {
  const name = String(remotePathOrName || '').toLowerCase()
  const isDat = name.endsWith('.dat')
  if (!isDat) return null

  const sz = typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? sizeBytes : null
  if (sz == null) return null
  // For larger DAT files, avoid forcing short resume windows that can abort a
  // still-healthy transfer on slower links.
  if (sz >= 60 * 1024 * 1024) return null
  if (sz >= 40 * 1024 * 1024) return 180_000
  return null
}

async function getFileSizeOrNull(p) {
  try {
    const st = await fs.stat(p)
    return typeof st?.size === 'number' ? st.size : null
  } catch {
    return null
  }
}

async function downloadToWithPreliminaryTimeout(client, localPath, remotePathOrName, preliminaryTimeoutMs = 15_000, startAt = 0, maxTransferWindowMs = null) {
  const ftp = client?.ftp
  if (!ftp || typeof ftp.handle !== 'function') {
    return client.downloadTo(localPath, remotePathOrName, startAt)
  }

  const originalHandle = ftp.handle.bind(ftp)
  let timer = null
  let windowTimer = null
  let sawPreliminary = false
  let lastReplyCode = null
  let lastReplyMessage = null
  let dataDebugAttached = false
  let dataBytes = 0

  ftp.handle = (command, handler) => {
    try {
      // Only guard transfer-start commands.
      const cmd = String(command || '')
      // Guard RETR only. For resumed downloads, basic-ftp sends REST first (expects 350)
      // and then sends RETR internally. Timing out on REST would be incorrect.
      if (cmd.startsWith('RETR')) {
        timer = setTimeout(() => {
          if (sawPreliminary) return
          try {
            // Close the context so we don't leave a pending RETR running on the server.
            // If we keep the control connection open and start issuing new commands,
            // delayed 150/226 from the previous RETR will corrupt the command stream.
            ftp.closeWithError(new Error(`Timeout waiting for preliminary transfer response after ${cmd}`))
          } catch {}
        }, preliminaryTimeoutMs)
      }
    } catch {}

    return originalHandle(command, (res, task) => {
      try {
        if (!(res instanceof Error) && res && typeof res.code === 'number') {
          lastReplyCode = res.code
          lastReplyMessage = res.message
        }
        if (!(res instanceof Error) && (res?.code === 150 || res?.code === 125)) {
          sawPreliminary = true
          if (timer) clearTimeout(timer)
          timer = null

          if (typeof maxTransferWindowMs === 'number' && Number.isFinite(maxTransferWindowMs) && maxTransferWindowMs > 0 && !windowTimer) {
            windowTimer = setTimeout(() => {
              try {
                ftp.closeWithError(new Error(`Resume window timeout after ${maxTransferWindowMs}ms for ${remotePathOrName}`))
              } catch {}
            }, maxTransferWindowMs)
          }

          // Attach data-socket diagnostics at transfer start.
          if (!dataDebugAttached) {
            dataDebugAttached = true
            try {
              const ds = ftp.dataSocket
              if (ds) {
                const tag = `[DATA] ${remotePathOrName}`
                ds.on('data', (chunk) => {
                  try {
                    const len = chunk?.length || 0
                    dataBytes += len
                    if (dataBytes === len && len > 0) {
                      writeFtpLog({ msg: `${tag} first-data bytes=${len} startAt=${startAt}` })
                    }
                  } catch {}
                })
                ds.once('end', () => {
                  try { writeFtpLog({ msg: `${tag} end totalBytes=${dataBytes}` }) } catch {}
                })
                ds.once('close', (hadError) => {
                  try { writeFtpLog({ msg: `${tag} close hadError=${hadError} totalBytes=${dataBytes}` }) } catch {}
                })
                ds.once('timeout', () => {
                  try { writeFtpLog({ level: 'error', msg: `${tag} timeout totalBytes=${dataBytes}` }) } catch {}
                })
                ds.once('error', (err) => {
                  try { writeFtpLog({ level: 'error', msg: `${tag} error ${String(err?.code || '')} ${String(err?.message || err)}` }) } catch {}
                })
              } else {
                writeFtpLog({ level: 'error', msg: `[DATA] ${remotePathOrName} no dataSocket at 150/125` })
              }
            } catch {}
          }
        }
      } catch {}
      return handler(res, task)
    })
  }

  try {
    return await client.downloadTo(localPath, remotePathOrName, startAt)
  } catch (e) {
    // If the server sent a reply like 421 and then closed the socket (FIN), basic-ftp
    // may surface only the FIN error. Preserve the last reply code so retry logic can adapt.
    try {
      if (lastReplyCode != null) {
        const msg = String(e?.message || e)
        const prefix = `${lastReplyCode}${lastReplyMessage ? ' ' + String(lastReplyMessage).trim() : ''}`
        if (!msg.includes(String(lastReplyCode))) {
          const wrapped = new Error(`${prefix} (then: ${msg})`)
          wrapped.cause = e
          throw wrapped
        }
      }
    } catch (wrapErr) {
      throw wrapErr
    }
    throw e
  } finally {
    try { ftp.handle = originalHandle } catch {}
    try {
      if (timer) clearTimeout(timer)
    } catch {}
    try {
      if (windowTimer) clearTimeout(windowTimer)
    } catch {}
  }
}

async function downloadToDronePasvConnectAfterRetr(client, localPath, remotePathOrName, preliminaryTimeoutMs = 15_000, startAt = 0, maxTransferWindowMs = null) {
  const ftp = client?.ftp
  if (!ftp || typeof ftp.handle !== 'function') {
    return client.downloadTo(localPath, remotePathOrName, startAt)
  }
  if (typeof parsePasvResponse !== 'function' || typeof connectForPassiveTransfer !== 'function') {
    // Fallback to library behavior if internals are unavailable.
    return downloadToWithPreliminaryTimeout(client, localPath, remotePathOrName, preliminaryTimeoutMs, startAt)
  }

  const controlHost = ftp?.socket?.remoteAddress
  if (!controlHost) throw new Error(`Failed to determine control host for ${remotePathOrName}`)

  function parseEpsvPort(message) {
    const msg = String(message || '')
    // RFC 2428: 229 Entering Extended Passive Mode (d d d port d)
    // Common: (|||6446|)
    const m = msg.match(/\((.)\1\1\1(\d+)\1\)/)
    if (!m) return null
    const port = Number(m[2])
    return Number.isFinite(port) && port > 0 ? port : null
  }

  // Ask for passive endpoint but DO NOT connect yet.
  let targetPort = null
  let passiveMode = 'PASV'
  try {
    const epsvRes = await client.send('EPSV')
    const p = parseEpsvPort(epsvRes?.message || '')
    if (p) {
      targetPort = p
      passiveMode = 'EPSV'
    } else {
      throw new Error(`Unparseable EPSV reply: ${String(epsvRes?.message || '')}`)
    }
  } catch (e) {
    try {
      writeFtpLog({ level: 'error', msg: `[AFTER-RETR] EPSV failed; falling back to PASV: ${String(e?.message || e)}` })
    } catch {}
    const pasvRes = await client.send('PASV')
    const target = parsePasvResponse(pasvRes?.message || '')
    if (!target || !target.port) {
      throw new Error(`Failed to prepare PASV transfer for ${remotePathOrName}`)
    }
    targetPort = target.port
    passiveMode = 'PASV'
  }

  try {
    writeFtpLog({ msg: `[AFTER-RETR] ${passiveMode} target=${controlHost}:${targetPort} remote=${remotePathOrName}` })
  } catch {}

  // Optional resume.
  if (startAt > 0) {
    try { await client.send(`REST ${startAt}`) } catch {}
  }

  // Send RETR first, then connect data socket. Some DJI embedded FTP variants only
  // send 150 after RETR when the data connection is opened afterwards.
  let preliminaryTimer = null
  let windowTimer = null
  let sawPreliminary = false
  let lastReplyCode = null
  let lastReplyMessage = null

  const controlDone = new Promise((resolve, reject) => {
    try {
      preliminaryTimer = setTimeout(() => {
        if (sawPreliminary) return
        try {
          ftp.closeWithError(new Error(`Timeout waiting for preliminary transfer response after RETR`))
        } catch {}
      }, preliminaryTimeoutMs)
    } catch {}

    ftp.handle(undefined, (res, task) => {
      try {
        if (!(res instanceof Error) && res && typeof res.code === 'number') {
          lastReplyCode = res.code
          lastReplyMessage = res.message
        }
        if (!(res instanceof Error) && (res?.code === 150 || res?.code === 125)) {
          sawPreliminary = true
          if (preliminaryTimer) clearTimeout(preliminaryTimer)
          preliminaryTimer = null

          if (typeof maxTransferWindowMs === 'number' && Number.isFinite(maxTransferWindowMs) && maxTransferWindowMs > 0 && !windowTimer) {
            windowTimer = setTimeout(() => {
              try {
                ftp.closeWithError(new Error(`Resume window timeout after ${maxTransferWindowMs}ms for ${remotePathOrName}`))
              } catch {}
            }, maxTransferWindowMs)
          }
        }
      } catch {}

      if (res instanceof Error) {
        task.reject(res)
      } else if (res?.code === 226 || res?.code === 250) {
        task.resolve(res)
      } else if (typeof res?.code === 'number' && res.code >= 400) {
        const err = new Error(`${res.code} ${res.message || 'FTP error'}`)
        err.code = res.code
        task.reject(err)
      }
      // ignore other replies (including 150/125 which are preliminary)
    }).then(resolve, reject)
  })

  try {
    // Send RETR without waiting for responses; they will be handled by ftp.handle above.
    ftp.send(`RETR ${remotePathOrName}`)

    // Connect data socket after RETR.
    const prevTimeout = ftp.timeout
    try {
      // Data socket connect should happen quickly. If not, we'll likely hit the drone's
      // ~120s watchdog and get 421 anyway.
      ftp.timeout = Math.min(prevTimeout || 0, 10_000) || 10_000
    } catch {}

    await connectForPassiveTransfer(controlHost, targetPort, ftp)

    try {
      ftp.timeout = prevTimeout
    } catch {}

    try {
      const ds = ftp.dataSocket
      const local = ds ? `${ds.localAddress || ''}:${ds.localPort || ''}` : ''
      const remote = ds ? `${ds.remoteAddress || controlHost || ''}:${ds.remotePort || targetPort || ''}` : `${controlHost}:${targetPort}`
      writeFtpLog({ msg: `[AFTER-RETR] dataSocket connected remote=${remote} local=${local}` })
    } catch {}

    const streamOpts = startAt > 0
      ? { flags: 'r+', start: startAt }
      : { flags: 'w' }
    const destination = fsSync.createWriteStream(localPath, streamOpts)
    const dataSocket = ftp.dataSocket
    if (!dataSocket) throw new Error('No data socket available after PASV connect')

    const dataDone = pipeline(dataSocket, destination)
    try {
      await Promise.all([dataDone, controlDone])
    } catch (e) {
      // Prefer surfacing control-channel 4xx/5xx (e.g. 421 Timeout) over any subsequent
      // data-socket error like ECONNRESET.
      try {
        await controlDone
      } catch (controlErr) {
        throw controlErr
      }
      // If we saw a reply code but got a generic error, wrap it.
      try {
        if (lastReplyCode != null) {
          const msg = String(e?.message || e)
          const prefix = `${lastReplyCode}${lastReplyMessage ? ' ' + String(lastReplyMessage).trim() : ''}`
          if (!msg.includes(String(lastReplyCode))) {
            const wrapped = new Error(`${prefix} (then: ${msg})`)
            wrapped.cause = e
            throw wrapped
          }
        }
      } catch (wrapErr) {
        throw wrapErr
      }
      throw e
    }
  } finally {
    try {
      if (preliminaryTimer) clearTimeout(preliminaryTimer)
    } catch {}
    try {
      if (windowTimer) clearTimeout(windowTimer)
    } catch {}
  }
}

async function downloadFileResumable(client, finalLocalPath, remotePathOrName, opts = {}) {
  const preliminaryTimeoutMs = typeof opts.preliminaryTimeoutMs === 'number' ? opts.preliminaryTimeoutMs : 30_000
  const expectedSize = typeof opts.expectedSize === 'number' && Number.isFinite(opts.expectedSize) ? opts.expectedSize : null
  const skipPrime = opts?.skipPrime === true
  const partPath = `${finalLocalPath}.part`

  // If we can determine the remote size, treat an existing complete file as success.
  let remoteSize = expectedSize
  if (remoteSize == null) {
    try {
      remoteSize = await client.size(remotePathOrName)
    } catch {
      remoteSize = null
    }
  }

  if (remoteSize != null && remoteSize > 0) {
    const finalSize = await getFileSizeOrNull(finalLocalPath)
    if (finalSize != null && finalSize >= remoteSize) {
      return { localPath: finalLocalPath, alreadyComplete: true, resumedFrom: null, remoteSize }
    }
  }

  let startAt = (await getFileSizeOrNull(partPath)) ?? 0
  if (remoteSize != null && startAt > remoteSize) {
    try { await fs.unlink(partPath) } catch {}
    startAt = 0
  }

  const maxTransferWindowMs = typeof opts.maxTransferWindowMs === 'number'
    ? opts.maxTransferWindowMs
    : getResumeWindowMsForFile(remotePathOrName, remoteSize)

  if (maxTransferWindowMs != null && startAt > 0) {
    try {
      writeFtpLog({ msg: `FTP DL resume-window active remote=${remotePathOrName} startAt=${startAt} windowMs=${maxTransferWindowMs}` })
    } catch {}
  }

  try {
    const tmo = getTransferTimeoutMsForFileSize(remoteSize)
    if (client?.ftp) client.ftp.timeout = tmo
  } catch {}

  // NOTE: basic-ftp opens destination with "r+" when startAt > 0; file must exist.
  if (startAt > 0) {
    try {
      await fs.access(partPath)
    } catch {
      startAt = 0
    }
  }

  // Prime the server's file handle immediately before PASV+RETR (required by DJI
  // drone FTP). Manufacturer pcapng analysis shows the server needs SIZE right
  // before PASV+RETR for every file download or it sends 421 Timeout.
  // Also ensure binary mode (TYPE I) like the manufacturer app.
  if (!skipPrime) {
    try { await client.send('TYPE I') } catch {}
    try { await client.size(remotePathOrName) } catch {}
  }

  // Default to basic-ftp's standard behaviour (PASV -> connect data -> RETR).
  // Do not attempt fallbacks on the same session: embedded servers may reply with delayed
  // 150/226 for the previous RETR, which corrupts the command stream and triggers 451/RST.
  try {
    await downloadToWithPreliminaryTimeout(client, partPath, remotePathOrName, preliminaryTimeoutMs, startAt, maxTransferWindowMs)
  } catch (e) {
    // If resume/REST is involved and we time out waiting for 150/125, restart from scratch
    // on the next outer retry by deleting the .part file.
    const msg = String(e?.message || e)
    if (startAt > 0 && msg.includes('preliminary transfer response')) {
      try {
        await fs.unlink(partPath)
        writeFtpLog({ msg: `FTP DL resume aborted; deleted .part due to preliminary timeout: ${remotePathOrName}` })
      } catch {}
    }

    if (msg.toLowerCase().includes('resume window timeout')) {
      try {
        const nowSize = await getFileSizeOrNull(partPath)
        const delta = (typeof nowSize === 'number' && typeof startAt === 'number') ? (nowSize - startAt) : null
        writeFtpLog({ msg: `FTP DL resume-window cut remote=${remotePathOrName} startAt=${startAt} nowSize=${nowSize} delta=${delta}` })
      } catch {}
    }
    throw e
  }

  if (remoteSize != null && remoteSize > 0) {
    const partSize = await getFileSizeOrNull(partPath)
    // Allow partSize slightly larger than remoteSize — DJI drone SIZE command
    // can be off by a few bytes vs actual transfer length.
    const tol = getRemoteSizeToleranceBytes(remoteSize)
    const largeFile = remoteSize >= 60 * 1024 * 1024
    // For large files, avoid rejecting completed transfers on noisy SIZE values.
    if (partSize == null || (!largeFile && partSize + tol < remoteSize) || (largeFile && partSize + tol < remoteSize && partSize < 1 * 1024 * 1024)) {
      throw new Error(`Downloaded size mismatch for ${remotePathOrName}: got ${partSize} expected ${remoteSize}`)
    }
  }

  // Promote .part to final.
  try { await fs.unlink(finalLocalPath) } catch {}
  await fs.rename(partPath, finalLocalPath)
  return { localPath: finalLocalPath, alreadyComplete: false, resumedFrom: startAt || 0, remoteSize }
}

let allowedRoots = []

const DEFAULT_DRONE_FTP_HOST = '192.168.42.2'
const FALLBACK_DRONE_FTP_HOST = '192.168.42.2'

const DEFAULT_FTP_PORT = 21

// 60s is often too short for large files over RNDIS/USB tether.
// Use a larger default when file size is unknown to avoid aborting long transfers.
const FTP_TIMEOUT_MS = 60 * 60 * 1000

let ftpLogStream = null
let ftpLogFilePath = null

function ensureFtpLogStream() {
  try {
    if (ftpLogStream) return
    const baseDir = app.getPath('userData')
    const logDir = path.join(baseDir, 'logs')
    try {
      fsSync.mkdirSync(logDir, { recursive: true })
    } catch {}
    ftpLogFilePath = path.join(logDir, 'ftp-debug.log')
    ftpLogStream = fsSync.createWriteStream(ftpLogFilePath, { flags: 'a' })
  } catch {
    ftpLogStream = null
  }
}

function writeFtpLog(payload) {
  try {
    ensureFtpLogStream()
    if (!ftpLogStream) return
    const ts = typeof payload?.ts === 'number' ? payload.ts : Date.now()
    const level = String(payload?.level || 'info').toUpperCase()
    const msg = String(payload?.msg || '')
    const line = `${new Date(ts).toISOString()} ${level} ${msg}\n`
    ftpLogStream.write(line)
  } catch {}
}

function attachBasicFtpVerboseLogging(client, sender, prefix) {
  try {
    if (!client?.ftp) return
    client.ftp.verbose = true
    client.ftp.log = (msg) => {
      try {
        writeFtpLog({ msg: `${prefix} ${String(msg || '').trim()}` })
      } catch {}
    }
  } catch {}
}

function getFtpReplyCode(err) {
  const direct = err?.code
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  if (typeof direct === 'string') {
    const n = Number.parseInt(direct, 10)
    if (Number.isFinite(n)) return n
  }

  const m = String(err?.message || err || '')
  const match = m.match(/\b(\d{3})\b/)
  if (match) {
    const n = Number.parseInt(match[1], 10)
    if (Number.isFinite(n)) return n
  }
  return null
}

function isTransientFtpError(err) {
  const code = getFtpReplyCode(err)
  // Common transient FTP reply codes / transfer interruptions
  if (code === 421 || code === 425 || code === 426) return true

  const m = String(err?.message || err || '').toLowerCase()
  return (
    m.includes('timeout') ||
    m.includes('resume window timeout') ||
    m.includes('control socket') ||
    m.includes('data socket') ||
    m.includes("can't open data connection") ||
    m.includes('421') ||
    m.includes('fin packet unexpectedly') ||
    m.includes('server sent fin') ||
    m.includes('econnreset') ||
    m.includes('socket hang up')
  )
}

function enableFtpTcpKeepAlive(client) {
  try {
    const sock = client?.ftp?.socket
    if (sock && typeof sock.setKeepAlive === 'function') {
      sock.setKeepAlive(false)
    }
    if (sock && typeof sock.setNoDelay === 'function') {
      sock.setNoDelay(true)
    }
  } catch {}
}

function createFtpClient() {
  return new FtpClient(FTP_TIMEOUT_MS)
}

async function accessDroneFtpMinimal(client, { host, port }) {
  // basic-ftp's `access()` convenience call sends FEAT + default settings
  // (TYPE I, STRU F, OPTS UTF8 ON, ...). DJI embedded FTP works better with a
  // minimal login sequence that matches the manufacturer app more closely.
  await client.connect(host, port)
  await client.login('', '')
}

function splitFtpPath(remotePath) {
  const p = String(remotePath || '')
  const idx = p.lastIndexOf('/')
  if (idx < 0) return { dir: null, name: p }
  const name = p.slice(idx + 1)
  const dir = idx === 0 ? '/' : p.slice(0, idx)
  return { dir, name }
}

function normalizeFtpRemotePath(remotePath) {
  let p = String(remotePath || '').trim()
  if (!p) return ''
  p = p.replace(/\\/g, '/')
  // Ensure absolute path; embedded FTP servers can be picky.
  if (!p.startsWith('/')) p = `/${p}`
  // Collapse duplicate slashes.
  p = p.replace(/\/{2,}/g, '/')
  // Remove trailing slash (except root).
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

function getFtpDownloadCandidates(remotePath) {
  const p = normalizeFtpRemotePath(remotePath)
  if (!p) return []
  const parts = splitFtpPath(p)
  const out = []

  // Some drones expose flyctrl logs under /blackbox/flyctrl/ but transfers work
  // more reliably via the shorter /flyctrl/ path (as seen in manufacturer app).
  if (p.startsWith('/blackbox/flyctrl/') && parts?.name) {
    // Prefer the actual path first to avoid 550 spam if /flyctrl doesn't exist.
    out.push(p)
    out.push(`/flyctrl/${parts.name}`)
  } else {
    out.push(p)
  }

  // De-dupe while preserving order.
  return [...new Set(out)]
}

function normalizeDatTextLine(raw) {
  return String(raw || '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildKmlStyleId(seed) {
  const s = String(seed || 'style')
  let hash = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return String(hash >>> 0)
}

function buildDatV3CrcTable() {
  const table = new Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      if ((value & 1) !== 0) {
        value = (value >>> 1) ^ 0x8408
      } else {
        value >>>= 1
      }
    }
    table[i] = value & 0xffff
  }
  return table
}

const DAT_V3_CRC_TABLE = buildDatV3CrcTable()

function calcDatV3PacketChecksum(buffer, start, payloadLengthWithoutTail) {
  let crc = 0x3692
  for (let i = 0; i < payloadLengthWithoutTail; i += 1) {
    crc = (crc >>> 8) ^ DAT_V3_CRC_TABLE[(buffer[start + i] ^ crc) & 0xff]
  }
  return crc & 0xffff
}

function formatDatDateTimeUtc(dateRaw, timeRaw) {
  if (!Number.isFinite(dateRaw) || !Number.isFinite(timeRaw)) return '<nil>'
  const y = Math.floor(dateRaw / 10000)
  const md = dateRaw - y * 10000
  const m = Math.floor(md / 100)
  const d = md - m * 100
  const hh = Math.floor(timeRaw / 10000)
  const ms = timeRaw - hh * 10000
  const mm = Math.floor(ms / 100)
  const ss = ms - mm * 100

  if (y < 2000 || y > 2100) return '<nil>'
  if (m < 1 || m > 12 || d < 1 || d > 31) return '<nil>'
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return '<nil>'

  const pad = (n) => String(n).padStart(2, '0')
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}Z`
}

function isPlausibleLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return false
  return true
}

function decryptDatPayloadV2(buffer, payloadStart, payloadLen, tickNo) {
  const payload = Buffer.allocUnsafe(payloadLen)
  const xorKey = tickNo & 0xff
  for (let i = 0; i < payloadLen; i += 1) {
    payload[i] = buffer[payloadStart + i] ^ xorKey
  }
  return payload
}

function decodeType12RadiansPayload(payload) {
  if (!payload || payload.length < 16) return null
  const lonRad = payload.readDoubleLE(0)
  const latRad = payload.readDoubleLE(8)
  const lon = (lonRad * 180) / Math.PI
  const lat = (latRad * 180) / Math.PI
  if (!isPlausibleLatLon(lat, lon)) return null

  let altitude = null
  if (payload.length >= 20) {
    const altMaybe = payload.readFloatLE(16)
    if (Number.isFinite(altMaybe) && altMaybe >= -1000 && altMaybe <= 12000) altitude = altMaybe
  }

  return { lat, lon, altitude }
}

function reduceKmlTrackPoints(points, targetMaxPoints = 250) {
  if (!Array.isArray(points) || points.length <= 2) return Array.isArray(points) ? points.slice() : []
  if (points.length <= targetMaxPoints) return points.slice()

  function applyMinDistance(minDistance) {
    const reduced = [points[0]]
    let last = points[0]

    for (let i = 1; i < points.length - 1; i += 1) {
      const p = points[i]
      const d = Math.hypot(p.lat - last.lat, p.lon - last.lon)
      if (d >= minDistance) {
        reduced.push(p)
        last = p
      }
    }

    const lastPoint = points[points.length - 1]
    const prev = reduced[reduced.length - 1]
    if (prev !== lastPoint) reduced.push(lastPoint)
    return reduced
  }

  let maxStep = 0
  for (let i = 1; i < points.length; i += 1) {
    const d = Math.hypot(points[i].lat - points[i - 1].lat, points[i].lon - points[i - 1].lon)
    if (d > maxStep) maxStep = d
  }

  let lo = 0
  let hi = Math.max(maxStep, 1e-7)
  let best = points.slice()

  for (let iter = 0; iter < 24; iter += 1) {
    const mid = (lo + hi) / 2
    const candidate = applyMinDistance(mid)
    if (candidate.length > targetMaxPoints) {
      lo = mid
    } else {
      best = candidate
      hi = mid
    }
  }

  return best
}

function cleanKmlTrackPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return []

  const src = points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
  if (src.length <= 2) return src.slice()

  // 1) Normalize altitude and keep values in realistic range.
  const normalized = src.map((p, i) => {
    let altitude = Number.isFinite(p.altitude) ? p.altitude : null
    if (altitude != null && (altitude < -200 || altitude > 12000)) altitude = null

    if (altitude == null) {
      const prev = i > 0 && Number.isFinite(src[i - 1].altitude) ? src[i - 1].altitude : null
      const next = i + 1 < src.length && Number.isFinite(src[i + 1].altitude) ? src[i + 1].altitude : null
      if (prev != null && next != null) altitude = (prev + next) / 2
      else if (prev != null) altitude = prev
      else if (next != null) altitude = next
      else altitude = 0
    }

    return { lat: p.lat, lon: p.lon, altitude }
  })

  // 2) Collapse near-duplicate XY points that often create vertical columns in Google Earth.
  const deduped = []
  const dedupeEps = 2e-6 // ~0.2m
  for (const p of normalized) {
    const last = deduped[deduped.length - 1]
    if (!last) {
      deduped.push({ ...p })
      continue
    }

    const d = Math.hypot(p.lat - last.lat, p.lon - last.lon)
    if (d <= dedupeEps) {
      last.altitude = (last.altitude + p.altitude) / 2
    } else {
      deduped.push({ ...p })
    }
  }

  if (deduped.length <= 2) return deduped

  // 3) Suppress single-point altitude spikes (up/down) that make "needles".
  const cleaned = deduped.map((p) => ({ ...p }))
  const spikeThreshold = 12 // meters
  for (let i = 1; i < cleaned.length - 1; i += 1) {
    const prev = cleaned[i - 1]
    const curr = cleaned[i]
    const next = cleaned[i + 1]

    const dPrev = Math.abs(curr.altitude - prev.altitude)
    const dNext = Math.abs(curr.altitude - next.altitude)
    const baseline = Math.abs(next.altitude - prev.altitude)
    if (dPrev > spikeThreshold && dNext > spikeThreshold && baseline < spikeThreshold / 3) {
      curr.altitude = (prev.altitude + next.altitude) / 2
    }
  }

  return cleaned
}

function dropZeroAltitudeInterior(points) {
  if (!Array.isArray(points) || points.length <= 2) return Array.isArray(points) ? points.slice() : []

  const lastIndex = points.length - 1
  const filtered = points.filter((p, i) => {
    if (i === 0 || i === lastIndex) return true
    const alt = Number.isFinite(p?.altitude) ? p.altitude : 0
    return Math.abs(alt) > 1e-6
  })

  // Keep original track if filtering is too aggressive.
  return filtered.length >= 2 ? filtered : points.slice()
}

function updateCoordinateTrack(track, lat, lon) {
  if (!isPlausibleLatLon(lat, lon)) return
  track.n += 1
  if (lat < track.minLat) track.minLat = lat
  if (lat > track.maxLat) track.maxLat = lat
  if (lon < track.minLon) track.minLon = lon
  if (lon > track.maxLon) track.maxLon = lon

  if (track.hasPrev) {
    const d = Math.hypot(lat - track.prevLat, lon - track.prevLon)
    track.stepSum += d
    if (d > 0.25) track.jumpCount += 1
    if (d < 1e-7) track.stillCount += 1
  }

  track.prevLat = lat
  track.prevLon = lon
  track.hasPrev = true
}

function detectBestDatCoordinateCandidate(buffer) {
  const dataLen = buffer.length
  const minRecLen = 5
  let pos = dataLen >= 256 ? 256 : 0
  let recordIndex = 0
  let sampledRecords = 0

  const sampleStride = 25
  const maxSampledRecords = 120000
  const tracks = new Map()

  function getTrack(key, recordType, encoding, offset) {
    let t = tracks.get(key)
    if (!t) {
      t = {
        key,
        recordType,
        encoding,
        offset,
        n: 0,
        stepSum: 0,
        jumpCount: 0,
        stillCount: 0,
        minLat: Number.POSITIVE_INFINITY,
        maxLat: Number.NEGATIVE_INFINITY,
        minLon: Number.POSITIVE_INFINITY,
        maxLon: Number.NEGATIVE_INFINITY,
        prevLat: 0,
        prevLon: 0,
        hasPrev: false
      }
      tracks.set(key, t)
    }
    return t
  }

  while (pos + minRecLen <= dataLen && sampledRecords < maxSampledRecords) {
    if (buffer[pos] !== 0x55) {
      const next = buffer.indexOf(0x55, pos + 1)
      if (next < 0) break
      pos = next
      continue
    }

    const totalLen = buffer.readUInt16LE(pos + 1)
    if (totalLen < minRecLen || pos + totalLen > dataLen) {
      pos += 1
      continue
    }

    const recordType = buffer[pos + 3]
    const payloadStart = pos + 4
    const payloadEnd = pos + totalLen - 1
    const payloadLen = Math.max(0, payloadEnd - payloadStart)

    if (recordIndex % sampleStride === 0 && payloadLen >= 8) {
      sampledRecords += 1
      const maxIntFloatOffset = Math.min(payloadLen - 8, 56)
      const maxDoubleOffset = Math.min(payloadLen - 16, 48)

      for (let off = 0; off <= maxIntFloatOffset; off += 4) {
        try {
          const latI = buffer.readInt32LE(payloadStart + off) / 1e7
          const lonI = buffer.readInt32LE(payloadStart + off + 4) / 1e7
          const keyI = `${recordType}|int32e7|${off}`
          updateCoordinateTrack(getTrack(keyI, recordType, 'int32e7', off), latI, lonI)
        } catch {}

        try {
          const latF = buffer.readFloatLE(payloadStart + off)
          const lonF = buffer.readFloatLE(payloadStart + off + 4)
          const keyF = `${recordType}|float32|${off}`
          updateCoordinateTrack(getTrack(keyF, recordType, 'float32', off), latF, lonF)
        } catch {}
      }

      for (let off = 0; off <= maxDoubleOffset; off += 4) {
        try {
          const latD = buffer.readDoubleLE(payloadStart + off)
          const lonD = buffer.readDoubleLE(payloadStart + off + 8)
          const keyD = `${recordType}|float64|${off}`
          updateCoordinateTrack(getTrack(keyD, recordType, 'float64', off), latD, lonD)
        } catch {}
      }
    }

    recordIndex += 1
    pos += totalLen
  }

  let best = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (const t of tracks.values()) {
    if (t.n < 30) continue

    const denom = Math.max(1, t.n - 1)
    const jumpRatio = t.jumpCount / denom
    const stillRatio = t.stillCount / denom
    const meanStep = t.stepSum / denom
    const spanLat = t.maxLat - t.minLat
    const spanLon = t.maxLon - t.minLon
    const span = spanLat + spanLon

    if (jumpRatio > 0.5) continue
    if (span < 0.00005) continue
    if (span > 8) continue

    const score =
      t.n * 1.2 -
      jumpRatio * 180 -
      meanStep * 600 -
      Math.abs(stillRatio - 0.15) * 40 -
      Math.max(0, span - 1.5) * 8

    if (score > bestScore) {
      bestScore = score
      best = {
        recordType: t.recordType,
        encoding: t.encoding,
        offset: t.offset,
        score,
        samples: t.n,
        jumpRatio,
        stillRatio,
        meanStep,
        spanLat,
        spanLon,
        span,
        centerLat: (t.minLat + t.maxLat) / 2,
        centerLon: (t.minLon + t.maxLon) / 2
      }
    }
  }

  if (!best) return null

  const isTrusted =
    best.samples >= 80 &&
    best.jumpRatio <= 0.12 &&
    best.meanStep <= 0.02 &&
    best.span >= 0.00005 &&
    best.span <= 2.5

  return {
    ...best,
    isTrusted
  }
}

function readCandidateCoordinatePoint(buffer, payloadStart, payloadLen, recordType, candidate) {
  if (!candidate) return null
  if (recordType !== candidate.recordType) return null
  if (candidate.offset < 0) return null

  let lat = null
  let lon = null
  let altitude = null

  try {
    if (candidate.encoding === 'int32e7') {
      if (candidate.offset + 8 > payloadLen) return null
      lat = buffer.readInt32LE(payloadStart + candidate.offset) / 1e7
      lon = buffer.readInt32LE(payloadStart + candidate.offset + 4) / 1e7

      if (candidate.offset + 12 <= payloadLen) {
        const rawAlt = buffer.readInt32LE(payloadStart + candidate.offset + 8)
        const altScaled = rawAlt / 100
        if (Number.isFinite(altScaled) && altScaled >= -1000 && altScaled <= 12000) altitude = altScaled
      }
    } else if (candidate.encoding === 'float32') {
      if (candidate.offset + 8 > payloadLen) return null
      lat = buffer.readFloatLE(payloadStart + candidate.offset)
      lon = buffer.readFloatLE(payloadStart + candidate.offset + 4)

      if (candidate.offset + 12 <= payloadLen) {
        const altF = buffer.readFloatLE(payloadStart + candidate.offset + 8)
        if (Number.isFinite(altF) && altF >= -1000 && altF <= 12000) altitude = altF
      }
    } else if (candidate.encoding === 'float64') {
      if (candidate.offset + 16 > payloadLen) return null
      lat = buffer.readDoubleLE(payloadStart + candidate.offset)
      lon = buffer.readDoubleLE(payloadStart + candidate.offset + 8)

      if (candidate.offset + 24 <= payloadLen) {
        const altD = buffer.readDoubleLE(payloadStart + candidate.offset + 16)
        if (Number.isFinite(altD) && altD >= -1000 && altD <= 12000) altitude = altD
      }
    }
  } catch {
    return null
  }

  if (!isPlausibleLatLon(lat, lon)) return null
  return { lat, lon, altitude }
}

async function parseDatAndGenerateArtifacts(filePath, outDir, base, stem, inputStat) {
  const buffer = await fs.readFile(filePath)
  const dataLen = buffer.length
  const csvPath = path.join(outDir, `${base}.csv`)
  const kmlPath = path.join(outDir, `${base}.kml`)
  const tombPath = path.join(outDir, `${stem}-tombstone.txt`)

  const csvHeader = 'Sample Number,DateTime GMT,Latitude,Longitude,Altitude_mASL,NumSats,GPSLevel,RC Connected,Fix,OffsetSeconds,DateTime UTC,RecordType,TickNo,DateRaw,TimeRaw,hDOP,pDOP,hAcc,sAcc,VelN_mps,VelE_mps,VelD_mps,Source'
  const csvRows = [csvHeader]
  const textLines = []
  const gpsPoints = []
  const maxCsvRows = 30000
  const rowStride = 250
  const maxGpsPoints = 25000

  let coordinateCandidate = null
  let trustedCoordinateCandidate = null

  const isLikelyDatV3 = dataLen >= 252 && buffer.toString('latin1', 242, 252) === 'DJI_LOG_V3'
  let totalEntries = 0
  let processedEntries = 0

  if (isLikelyDatV3) {
    const minRecLen = 12
    let pos = dataLen >= 256 ? 256 : 0

    while (pos + minRecLen <= dataLen) {
      if (buffer[pos] !== 0x55) {
        const next = buffer.indexOf(0x55, pos + 1)
        if (next < 0) break
        pos = next
        continue
      }

      const totalLen = buffer.readUInt16LE(pos + 1)
      if (totalLen < minRecLen || pos + totalLen > dataLen) {
        pos += 1
        continue
      }

      const checksumRead = buffer.readUInt16LE(pos + totalLen - 2)
      const checksumCalc = calcDatV3PacketChecksum(buffer, pos, totalLen - 2)
      if (checksumRead !== checksumCalc) {
        pos += 1
        continue
      }

      const alwaysZero = buffer[pos + 2]
      if (alwaysZero !== 0) {
        pos += 1
        continue
      }

      totalEntries += 1
      const recordType = buffer.readUInt16LE(pos + 4)
      const tickNo = buffer.readUInt32LE(pos + 6)
      const payloadStart = pos + 10
      const payloadLen = totalLen - 12
      const payloadEnd = payloadStart + payloadLen

      let point = null
      let numSats = null
      let altitude = null
      let dateRaw = null
      let timeRaw = null
      let hdop = null
      let pdop = null
      let hacc = null
      let sacc = null
      let velN = null
      let velE = null
      let velD = null
      let source = 'v3'

      if (payloadLen > 0) {
        const payload = decryptDatPayloadV2(buffer, payloadStart, payloadLen, tickNo)

        // DJI DAT V3 GPS track aligns best with record type 2096.
        // Including sibling types introduces noisy duplicates and zero altitude rows.
        if (recordType === 2096 && payloadLen >= 66) {
          dateRaw = payload.readUInt32LE(0)
          timeRaw = payload.readUInt32LE(4)
          const lon = payload.readInt32LE(8) / 1e7
          const lat = payload.readInt32LE(12) / 1e7
          const alt = payload.readInt32LE(16) / 1000
          velN = payload.readFloatLE(20) / 100
          velE = payload.readFloatLE(24) / 100
          velD = payload.readFloatLE(28) / 100
          hdop = payload.readFloatLE(32)
          pdop = payload.readFloatLE(36)
          hacc = payload.readFloatLE(40)
          sacc = payload.readFloatLE(44)
          const sats = payload.readUInt16LE(64)

          if (isPlausibleLatLon(lat, lon) && hdop < 1000 && pdop < 1000) {
            point = { lat, lon, altitude: Number.isFinite(alt) ? alt : null }
            numSats = sats
            altitude = point.altitude
          }
        } else if (recordType === 12) {
          source = 'v3-type12'
          const decodedType12 = decodeType12RadiansPayload(payload)
          if (decodedType12) {
            point = decodedType12
            altitude = decodedType12.altitude
          }
        }

        if (payloadLen >= 12 && textLines.length < 8000) {
          let printable = 0
          for (const b of payload) {
            if ((b >= 32 && b <= 126) || b === 9) printable += 1
          }
          if (printable / payload.length >= 0.7) {
            const normalized = normalizeDatTextLine(payload.toString('latin1'))
            if (normalized.length >= 8) textLines.push(normalized)
          }
        }
      }

      let latitudeField = '<nil>'
      let longitudeField = '<nil>'
      let altitudeField = '<nil>'
      let gpsLevelField = '<nil>'
      let fixField = '<nil>'
      let numSatsField = '<nil>'
      const dateTimeUtcField = formatDatDateTimeUtc(dateRaw, timeRaw)
      const dateRawField = dateRaw != null ? String(dateRaw) : '<nil>'
      const timeRawField = timeRaw != null ? String(timeRaw) : '<nil>'
      const hdopField = Number.isFinite(hdop) ? hdop.toFixed(3) : '<nil>'
      const pdopField = Number.isFinite(pdop) ? pdop.toFixed(3) : '<nil>'
      const haccField = Number.isFinite(hacc) ? hacc.toFixed(3) : '<nil>'
      const saccField = Number.isFinite(sacc) ? sacc.toFixed(3) : '<nil>'
      const velNField = Number.isFinite(velN) ? velN.toFixed(3) : '<nil>'
      const velEField = Number.isFinite(velE) ? velE.toFixed(3) : '<nil>'
      const velDField = Number.isFinite(velD) ? velD.toFixed(3) : '<nil>'

      if (point) {
        latitudeField = point.lat.toFixed(7)
        longitudeField = point.lon.toFixed(7)
        if (altitude != null) altitudeField = altitude.toFixed(2)
        if (numSats != null) numSatsField = String(numSats)
        gpsLevelField = numSats != null && Number.isFinite(numSats) ? String(Math.max(1, Math.min(5, Math.floor(numSats / 4) + 1))) : '5'
        fixField = 'true'

        const prev = gpsPoints[gpsPoints.length - 1]
        if (gpsPoints.length < maxGpsPoints && (!prev || Math.hypot(prev.lat - point.lat, prev.lon - point.lon) > 1e-7)) {
          gpsPoints.push(point)
        }
      }

      const offsetSeconds = Math.floor(tickNo / 600)
      const keepRow = point || processedEntries % rowStride === 0
      if (keepRow && csvRows.length < maxCsvRows) {
        csvRows.push(
          `${tickNo},<nil>,${latitudeField},${longitudeField},${altitudeField},${numSatsField},${gpsLevelField},<nil>,${fixField},${offsetSeconds},${dateTimeUtcField},${recordType},${tickNo},${dateRawField},${timeRawField},${hdopField},${pdopField},${haccField},${saccField},${velNField},${velEField},${velDField},${source}`
        )
      }
      processedEntries += 1
      pos += totalLen
    }

    coordinateCandidate = gpsPoints.length > 0 ? { recordType: 2096, encoding: 'dat-v3-gps', offset: 8 } : null
    trustedCoordinateCandidate = gpsPoints.length > 0 ? { ok: true } : null
  } else {
    const minRecLen = 12
    let pos = dataLen >= 256 ? 256 : 0

    while (pos + minRecLen <= dataLen) {
      if (buffer[pos] !== 0x55) {
        const next = buffer.indexOf(0x55, pos + 1)
        if (next < 0) break
        pos = next
        continue
      }

      const totalLen = buffer[pos + 1]
      if (totalLen < minRecLen || pos + totalLen > dataLen) {
        pos += 1
        continue
      }

      totalEntries += 1
      const recordType = buffer.readUInt16LE(pos + 4)
      const tickNo = buffer.readUInt32LE(pos + 6)
      const payloadStart = pos + 10
      const payloadLen = totalLen - 12
      const sampleNumber = tickNo
      const offsetSeconds = sampleNumber > 0 ? Math.floor(sampleNumber / 600) : 0

      const payload = payloadLen > 0
        ? decryptDatPayloadV2(buffer, payloadStart, payloadLen, tickNo)
        : Buffer.alloc(0)

      const point = recordType === 12 ? decodeType12RadiansPayload(payload) : null
      let latitudeField = '<nil>'
      let longitudeField = '<nil>'
      let altitudeField = '<nil>'
      let gpsLevelField = '<nil>'
      let fixField = '<nil>'

      if (point) {
        latitudeField = point.lat.toFixed(7)
        longitudeField = point.lon.toFixed(7)
        if (point.altitude != null) altitudeField = point.altitude.toFixed(2)
        gpsLevelField = '5'
        fixField = 'true'

        const prev = gpsPoints[gpsPoints.length - 1]
        if (gpsPoints.length < maxGpsPoints && (!prev || Math.hypot(prev.lat - point.lat, prev.lon - point.lon) > 1e-7)) {
          gpsPoints.push(point)
        }
      }

      const keepRow = point || processedEntries % rowStride === 0
      if (keepRow && csvRows.length < maxCsvRows) {
        csvRows.push(
          `${sampleNumber},<nil>,${latitudeField},${longitudeField},${altitudeField},<nil>,${gpsLevelField},<nil>,${fixField},${offsetSeconds},<nil>,${recordType},${sampleNumber},<nil>,<nil>,<nil>,<nil>,<nil>,<nil>,<nil>,<nil>,<nil>,v1-type12`
        )
      }
      processedEntries += 1

      if (payloadLen >= 12 && textLines.length < 8000) {
        let printable = 0
        for (const b of payload) {
          if ((b >= 32 && b <= 126) || b === 9) printable += 1
        }
        if (printable / payload.length >= 0.7) {
          const decoded = payload.toString('latin1')
          const normalized = normalizeDatTextLine(decoded)
          if (normalized.length >= 8) textLines.push(normalized)
        }
      }

      pos += totalLen
    }

    coordinateCandidate = gpsPoints.length > 0
      ? { recordType: 12, encoding: 'v1-type12-radians', offset: 0, isTrusted: true }
      : null
    trustedCoordinateCandidate = coordinateCandidate
  }

  const kmlSourcePoints = cleanKmlTrackPoints(gpsPoints)
  const kmlFilteredPoints = dropZeroAltitudeInterior(kmlSourcePoints)
  const kmlGpsPoints = reduceKmlTrackPoints(kmlFilteredPoints, 250)

  const startPoint = kmlGpsPoints[0] || null
  const endPoint = kmlGpsPoints.length > 0 ? kmlGpsPoints[kmlGpsPoints.length - 1] : null
  // Build marker polygons in the same style as vendor KML (offset by 0.0001 deg).
  const makeStartMarkerCoords = (center, alt) => {
    if (!center) return ''
    const delta = 0.0001
    const alt2 = alt.toFixed(2)
    return [
      `${(center.lon + delta).toFixed(7)},${(center.lat + delta).toFixed(7)},${alt2}`,
      `${(center.lon - delta).toFixed(7)},${(center.lat + delta).toFixed(7)},${alt2}`,
      `${(center.lon - delta).toFixed(7)},${(center.lat - delta).toFixed(7)},${alt2}`,
      `${(center.lon + delta).toFixed(7)},${(center.lat + delta).toFixed(7)},${alt2}`
    ].join(' ')
  }

  const makeEndMarkerCoords = (center, alt) => {
    if (!center) return ''
    const delta = 0.0001
    const alt2 = alt.toFixed(2)
    return [
      `${(center.lon - delta).toFixed(7)},${(center.lat - delta).toFixed(7)},${alt2}`,
      `${(center.lon - delta).toFixed(7)},${(center.lat + delta).toFixed(7)},${alt2}`,
      `${(center.lon + delta).toFixed(7)},${(center.lat + delta).toFixed(7)},${alt2}`,
      `${(center.lon + delta).toFixed(7)},${(center.lat - delta).toFixed(7)},${alt2}`,
      `${(center.lon - delta).toFixed(7)},${(center.lat - delta).toFixed(7)},${alt2}`
    ].join(' ')
  }

  const startRectangleText = startPoint ? makeStartMarkerCoords(startPoint, startPoint.altitude ?? 0) : ''
  const endRectangleText = endPoint ? makeEndMarkerCoords(endPoint, endPoint.altitude ?? 0) : ''
  
  const pathCoordinatesText = kmlGpsPoints
    .map((p) => `${p.lon.toFixed(7)},${p.lat.toFixed(7)},${(p.altitude ?? 0).toFixed(2)}`)
    .join(' ')
  const pathStyleId = buildKmlStyleId(base)

  const kmlText = [
    "<?xml version='1.0' encoding='UTF-8'?>",
    '<Document>',
    `  <name>${filePath}</name>`,
    `  <description>KML File For ${base} Generated By PAC.</description>`,
    `  <Style id="${pathStyleId}">`,
    '    <LineStyle>',
    '      <color>ff0822c8</color>',
    '      <width>8</width>',
    '    </LineStyle>',
    '  </Style>',
    '  <Style id="startcolor">',
    '    <LineStyle>',
    '      <color>ff000000</color>',
    '      <width>2</width>',
    '    </LineStyle>',
    '  </Style>',
    '  <Style id="endcolor">',
    '    <LineStyle>',
    '      <color>ff000000</color>',
    '      <width>2</width>',
    '    </LineStyle>',
    '  </Style>',
    '  <Placemark>',
    `    <name>KML File For ${base} Generated By PAC.</name>`,
    `    <description>Flight Takeoff Point For for KML File For ${base} Generated By PAC.</description>`,
    '    <styleUrl>#startcolor</styleUrl>',
    '    <LineString>',
    '      <extrude>0</extrude>',
    '      <tessellate>0</tessellate>',
    '      <altitudeMode>clampToGround</altitudeMode>',
    `      <coordinates>${startRectangleText}</coordinates>`,
    '    </LineString>',
    '  </Placemark>',
    '  <Placemark>',
    `    <name>KML File For ${base} Generated By PAC.</name>`,
    `    <description>Flight Termination Point For for KML File For ${base} Generated By PAC.</description>`,
    '    <styleUrl>#endcolor</styleUrl>',
    '    <LineString>',
    '      <extrude>0</extrude>',
    '      <tessellate>0</tessellate>',
    '      <altitudeMode>clampToGround</altitudeMode>',
    `      <coordinates>${endRectangleText}</coordinates>`,
    '    </LineString>',
    '  </Placemark>',
    '  <Placemark>',
    `    <name>KML File For ${base} Generated By PAC.</name>`,
    `    <description><![CDATA[Flight Path for KML File For ${base} Generated By PAC.]]></description>`,
    `    <styleUrl>#${pathStyleId}</styleUrl>`,
    '    <LineString>',
    '      <extrude>0</extrude>',
    '      <tessellate>0</tessellate>',
    '      <altitudeMode>absolute</altitudeMode>',
    `      <coordinates>${pathCoordinatesText}</coordinates>`,
    '    </LineString>',
    '  </Placemark>',
    '</Document>',
    ''
  ].join('\n')

  const analyzedAt = new Date().toISOString()
  const tombText = [
    '###############################################################################',
    `   UAV/UAS/Drone Data Generated By Drone_Data at ${analyzedAt}`,
    '###############################################################################',
    '',
    '',
    'Aircraft Type:\t\tUnknown',
    `Analyzed at:\t\t${analyzedAt}`,
    `Input file:\t\t${filePath}`,
    'AC SN:\t\t\t',
    'Battery SN:\t\t',
    'Mc ID:\t\t\t',
    'Mc VER:\t\t\t',
    'Flight GPS Start UTC:\t0001-01-01T00:00:00Z',
    `Total entries:\t\t${totalEntries.toLocaleString()}`,
    `Processed entries:\t${processedEntries.toLocaleString()}`,
    `Takeoff Altitude:\t${startPoint?.altitude != null ? startPoint.altitude.toFixed(2) : 0}`,
    `KML Fixed Points:\t${kmlGpsPoints.length > 0 ? 2 : 0}`,
    `KML Path Points:\t${kmlGpsPoints.length}`,
    `Flight Start Point:\t${startPoint ? `${startPoint.lat.toFixed(7)},${startPoint.lon.toFixed(7)}` : ''}`,
    `Flight End Point:\t${endPoint ? `${endPoint.lat.toFixed(7)},${endPoint.lon.toFixed(7)}` : ''}`,
    'Homepoints:\t\t',
    'Pilot Locations:\t(experimental)',
    `GPS Candidate:\t${coordinateCandidate ? `${coordinateCandidate.recordType}/${coordinateCandidate.encoding}/@${coordinateCandidate.offset}` : 'none'}`,
    `GPS Candidate Trusted:\t${trustedCoordinateCandidate ? 'true' : 'false'}`,
    '',
    '',
    '####################Raw Text From FlyLog:Value Records ########################',
    ...textLines,
    ''
  ].join('\n')

  await fs.writeFile(csvPath, csvRows.join('\n') + '\n', 'utf8')
  await fs.writeFile(kmlPath, kmlText, 'utf8')
  await fs.writeFile(tombPath, tombText, 'utf8')

  const outputPaths = [
    ['CSV', csvPath],
    ['KML', kmlPath],
    ['TXT', tombPath]
  ]
  const outputs = []
  for (const [type, fp] of outputPaths) {
    const stat = await fs.stat(fp).catch(() => null)
    if (stat) outputs.push({ type, name: path.basename(fp), path: fp, size: stat.size })
  }
  return { outputs, inputSize: inputStat?.size ?? null }
}

let cachedFtpTarget = null
let cachedFtpTargetAt = 0
const FTP_TARGET_CACHE_MS = 10_000

function getLikelyUsbTetherPrefixes() {
  const nets = os.networkInterfaces()
  const prefixes = new Set()

  const preferredPrefixes = ['192.168.42.', '192.168.43.']
  for (const name of Object.keys(nets)) {
    for (const info of nets[name] || []) {
      if (!info || info.family !== 'IPv4' || info.internal) continue
      const addr = info.address
      for (const p of preferredPrefixes) {
        if (addr.startsWith(p)) prefixes.add(p)
      }
    }
  }

  // If we didn't find preferred prefixes, don't guess broadly; fall back to known DJI/RNDIS defaults.
  if (prefixes.size === 0) {
    preferredPrefixes.forEach((p) => prefixes.add(p))
  }

  return [...prefixes]
}

function probeFtpBanner(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { socket.destroy() } catch {}
      resolve(ok)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
    socket.on('data', (buf) => {
      const text = String(buf || '')
      // FTP servers greet with 220
      if (text.includes('220')) {
        clearTimeout(timer)
        finish(true)
      }
    })
    socket.on('connect', () => {
      // If it connects but doesn't send banner quickly, still consider it not confirmed.
    })
  })
}

async function detectFtpTarget() {
  const now = Date.now()
  if (cachedFtpTarget && now - cachedFtpTargetAt < FTP_TARGET_CACHE_MS) return cachedFtpTarget

  const prefixes = getLikelyUsbTetherPrefixes()
  const portsToTry = [DEFAULT_FTP_PORT, 2121, 8021]

  // Try typical device IPs first.
  const hostCandidates = []
  for (const p of prefixes) {
    hostCandidates.push(p + '2')
    hostCandidates.push(p + '1')
  }

  // De-dupe while preserving order
  const seen = new Set()
  const orderedHosts = hostCandidates.filter((h) => {
    if (seen.has(h)) return false
    seen.add(h)
    return true
  })

  for (const host of orderedHosts) {
    for (const port of portsToTry) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await probeFtpBanner(host, port)
      if (ok) {
        cachedFtpTarget = { host, port }
        cachedFtpTargetAt = Date.now()
        return cachedFtpTarget
      }
    }
  }

  // Fallback: keep current defaults even if not confirmed, to avoid hard failure.
  cachedFtpTarget = { host: DEFAULT_DRONE_FTP_HOST, port: DEFAULT_FTP_PORT }
  cachedFtpTargetAt = Date.now()
  return cachedFtpTarget
}

async function resolveFtpTarget(payload) {
  const requestedHost = typeof payload?.host === 'string' && payload.host.trim().length > 0 ? payload.host.trim() : null
  const requestedPort = Number.isFinite(Number(payload?.port)) ? Number(payload.port) : null

  const isAllowedHost = (host) => {
    if (host === DEFAULT_DRONE_FTP_HOST || host === FALLBACK_DRONE_FTP_HOST) return true
    const prefixes = getLikelyUsbTetherPrefixes()
    return prefixes.some((p) => host.startsWith(p))
  }

  if (requestedHost) {
    if (!isAllowedHost(requestedHost)) throw new Error('Host not allowed')
    const port = requestedPort && requestedPort > 0 && requestedPort < 65536 ? requestedPort : DEFAULT_FTP_PORT
    return { host: requestedHost, port }
  }

  return detectFtpTarget()
}

async function ftpListDir({ host, dir }) {
  const requestedHost = typeof host === 'string' && host.trim().length > 0 ? host.trim() : null

  const safeDir = typeof dir === 'string' && dir.trim().length > 0 ? dir.trim() : '/'

  let lastError = null
  const target = requestedHost ? { host: requestedHost, port: DEFAULT_FTP_PORT } : await detectFtpTarget()
  const hostsToTry = requestedHost ? [{ host: requestedHost, port: DEFAULT_FTP_PORT }] : [target, { host: FALLBACK_DRONE_FTP_HOST, port: DEFAULT_FTP_PORT }]

  for (const t of hostsToTry) {
    const client = createFtpClient()
    try {
      attachBasicFtpVerboseLogging(client, null, '[LIST]')
      writeFtpLog({ msg: `FTP LIST connect ${t.host}:${t.port} dir=${safeDir}` })
      await accessDroneFtpMinimal(client, { host: t.host, port: t.port })
      enableFtpTcpKeepAlive(client)
      try { await client.send('TYPE A') } catch {}

      const entries = await client.list(safeDir)
      writeFtpLog({ msg: `FTP LIST ok ${t.host}:${t.port} dir=${safeDir} items=${(entries || []).length}` })
      return {
        host: t.host,
        port: t.port,
        dir: safeDir,
        entries: (entries || []).map((e) => ({
          name: e.name,
          // normalize type: basic-ftp uses numeric FileType (1 File, 2 Directory, 3 Symlink)
          // but some legacy parsing may still yield string markers.
          type: (e?.isDirectory === true || e?.type === 2 || e?.type === 'd') ? 'dir' : 'file',
          size: typeof e.size === 'number' ? e.size : null,
          modifiedAt: e.modifiedAt instanceof Date ? e.modifiedAt.getTime() : null
        }))
      }
    } catch (e) {
      writeFtpLog({ level: 'error', msg: `FTP LIST error ${t.host}:${t.port} dir=${safeDir} code=${getFtpReplyCode(e) || ''} ${String(e?.message || e)}` })
      lastError = e
    } finally {
      client.close()
    }
  }

  throw lastError || new Error('Failed to connect')
}

function normalizeRoot(rootPath) {
  const resolved = path.resolve(rootPath)
  return resolved.endsWith(path.sep) ? resolved : resolved + path.sep
}

function isPathAllowed(absPath) {
  const resolved = path.resolve(absPath)
  return allowedRoots.some((root) => resolved.toLowerCase().startsWith(root.toLowerCase()))
}

async function statfsSafe(mountPath) {
  try {
    if (typeof fs.statfs !== 'function') return { totalBytes: null, freeBytes: null }
    const s = await fs.statfs(mountPath)
    const blockSize = Number(s.bsize || s.frsize || 0)
    const blocks = Number(s.blocks || 0)
    const bavail = Number(s.bavail || s.bfree || 0)
    if (!blockSize || !blocks) return { totalBytes: null, freeBytes: null }
    const totalBytes = blockSize * blocks
    const freeBytes = blockSize * bavail
    return {
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
      freeBytes: Number.isFinite(freeBytes) ? freeBytes : null
    }
  } catch (e) {
    const msg = String(e?.message || '')
    const code = String(e?.code || '')
    const isNoMedia =
      code === 'ENOMEDIUM' ||
      /no\s*media/i.test(msg) ||
      /device\s+is\s+not\s+ready/i.test(msg) ||
      /not\s+ready/i.test(msg)

    return {
      totalBytes: null,
      freeBytes: null,
      status: isNoMedia ? 'no-media' : 'unavailable'
    }
  }
}

function createWindow() {
  // Create the browser window.
  const winDevIco = process.platform === 'win32'
    ? path.join(process.cwd(), 'build', 'icon.ico')
    : null
  const mainWindow = new BrowserWindow({
    width: 1280,
    minWidth: 900,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    ...(process.platform === 'win32' && is.dev ? { icon: winDevIco } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function cleanupChromiumCaches() {
  const roots = new Set()
  try { roots.add(app.getPath('sessionData')) } catch {}
  try { roots.add(app.getPath('userData')) } catch {}

  const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache']
  for (const root of roots) {
    if (!root) continue
    for (const dirName of cacheDirs) {
      try {
        await fs.rm(path.join(root, dirName), { recursive: true, force: true })
      } catch {}
    }
  }

  try {
    await session.defaultSession.clearCache()
  } catch {}
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  // Keep in sync with electron-builder.yml appId
  electronApp.setAppUserModelId('com.electron.app')
  if (is.dev && typeof MAIN_VITE_DATA_ADD_HASH_COMMON_KEY !== 'undefined') {
    console.log('MAIN_VITE_DATA_ADD_HASH_COMMON_KEY', MAIN_VITE_DATA_ADD_HASH_COMMON_KEY)
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('drives:list', async () => {
    const drivelist = require('drivelist')
    const drives = await drivelist.list()

    const simplified = (await Promise.all(
      drives.map(async (d) => {
        const mountpoints = await Promise.all(
          (d.mountpoints || []).map(async (m) => {
            const stats = await statfsSafe(m.path)
            return {
              path: m.path,
              totalBytes: stats.totalBytes,
              freeBytes: stats.freeBytes,
              status: stats.status || 'ok'
            }
          })
        )

        return {
          device: d.device,
          description: d.description,
          size: d.size,
          isUSB: Boolean(d.isUSB),
          isRemovable: Boolean(d.isRemovable),
          isCard: Boolean(d.isCard),
          isSystem: Boolean(d.isSystem),
          isReadOnly: Boolean(d.isReadOnly),
          mountpoints
        }
      })
    )).filter((d) => d.mountpoints.length > 0)

    allowedRoots = simplified
      .filter((d) => d.isUSB || d.isRemovable || d.isCard)
      .flatMap((d) => d.mountpoints.map((m) => normalizeRoot(m.path)))

    return simplified
  })

  ipcMain.handle('fs:readdir', async (_event, dirPath) => {
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
      throw new Error('Invalid path')
    }
    if (!isPathAllowed(dirPath)) {
      throw new Error('Path not allowed')
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const results = await Promise.all(
      entries.map(async (ent) => {
        const fullPath = path.join(dirPath, ent.name)
        let stat = null
        try {
          stat = await fs.stat(fullPath)
        } catch {
          // ignore stat errors
        }
        return {
          name: ent.name,
          path: fullPath,
          type: ent.isDirectory() ? 'dir' : ent.isFile() ? 'file' : 'other',
          size: stat?.size ?? null,
          mtimeMs: stat?.mtimeMs ?? null
        }
      })
    )

    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return results
  })

  ipcMain.handle('ftp:list', async (_event, payload) => {
    const host = payload?.host
    const dir = payload?.dir
    return ftpListDir({ host, dir })
  })

  // Dialog: choose download folder (register once at startup)
  ipcMain.handle('dialog:chooseDownloadDir', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow()
      const res = await dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] })
      if (res.canceled) return null
      return res.filePaths && res.filePaths[0] ? res.filePaths[0] : null
    } catch (e) {
      return null
    }
  })

  // Dialog: pick folder and return all .DAT paths inside (used by Decrypt tab)
  ipcMain.handle('dialog:chooseDatFolder', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow()
      const res = await dialog.showOpenDialog(parent, {
        title: 'Select folder containing .DAT files',
        properties: ['openDirectory']
      })
      if (res.canceled || !res.filePaths?.[0]) return null
      const dir = res.filePaths[0]
      // Recursively find all .DAT files
      const results = []
      async function scan(d) {
        let entries
        try { entries = await fs.readdir(d, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const full = path.join(d, e.name)
          if (e.isDirectory()) await scan(full)
          else if (/\.dat$/i.test(e.name)) results.push(full)
        }
      }
      await scan(dir)
      results.sort()
      return results
    } catch { return null }
  })

  // Dialog: pick one or many .DAT files directly (used by Decrypt tab)
  ipcMain.handle('dialog:chooseDatFiles', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow()
      const res = await dialog.showOpenDialog(parent, {
        title: 'Select .DAT files',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'DAT Files', extensions: ['dat', 'DAT'] }]
      })
      if (res.canceled || !Array.isArray(res.filePaths)) return null
      return res.filePaths.filter((p) => /\.dat$/i.test(String(p || '')))
    } catch {
      return null
    }
  })

  // Dialog: generic folder picker (used by Decrypt tab)
  ipcMain.handle('dialog:chooseFolder', async () => {
    try {
      const parent = BrowserWindow.getFocusedWindow()
      const res = await dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] })
      if (res.canceled) return null
      return res.filePaths?.[0] ?? null
    } catch {
      return null
    }
  })

  ipcMain.handle('decrypt:dat', async (_event, payload) => {
    const { filePath, outputDir } = payload || {}
    if (!filePath || typeof filePath !== 'string') throw new Error('filePath required')

    const outDir = outputDir && typeof outputDir === 'string' && outputDir.length > 0
      ? outputDir
      : path.dirname(filePath)

    await fs.mkdir(outDir, { recursive: true })

    const base = path.basename(filePath)
    const stem = base.replace(/\.dat$/i, '')
    const inputStat = await fs.stat(filePath).catch(() => null)

    // Always process using the new decrypt mechanism.
    try {
      return await parseDatAndGenerateArtifacts(filePath, outDir, base, stem, inputStat)
    } catch (fallbackError) {
      throw new Error(`Failed to decode ${base}. Parser error: ${String(fallbackError?.message || fallbackError)}`)
    }
  })

  ipcMain.handle('decrypt:datcon', async (_event, payload) => {
    const { filePath, outputDir } = payload || {}
    if (!filePath || typeof filePath !== 'string') throw new Error('filePath required')

    const outDir = outputDir && typeof outputDir === 'string' && outputDir.length > 0
      ? outputDir
      : path.dirname(filePath)

    await fs.mkdir(outDir, { recursive: true })

    const base = path.basename(filePath)
    const stem = base.replace(/\.dat$/i, '')
    const inputStat = await fs.stat(filePath).catch(() => null)

    try {
      const result = await parseDatAndGenerateArtifacts(filePath, outDir, base, stem, inputStat)
      return {
        ...result,
        engine: 'src_datcon'
      }
    } catch (fallbackError) {
      throw new Error(`Failed to decode ${base} with DatCon engine. Parser error: ${String(fallbackError?.message || fallbackError)}`)
    }
  })

  ipcMain.handle('ftp:get', async (_event, payload) => {
    const remotePathRaw = payload?.remotePath
    if (typeof remotePathRaw !== 'string' || remotePathRaw.length === 0) {
      throw new Error('Invalid remotePath')
    }
    const remotePath = normalizeFtpRemotePath(remotePathRaw)
    if (!remotePath) throw new Error('Invalid remotePath')

    let lastError = null

    const downloadsDir = (payload && typeof payload.downloadsDir === 'string' && payload.downloadsDir.length > 0)
      ? payload.downloadsDir
      : path.join(app.getPath('downloads'), 'Drone_Data_Downloads')
    await fs.mkdir(downloadsDir, { recursive: true })

    const target = await resolveFtpTarget(payload)
    const targetsToTry = [target]
    if (target.host !== FALLBACK_DRONE_FTP_HOST) targetsToTry.push({ host: FALLBACK_DRONE_FTP_HOST, port: DEFAULT_FTP_PORT })

    for (const t of targetsToTry) {
      const maxAttempts = 8
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const client = createFtpClient()
        try {
          attachBasicFtpVerboseLogging(client, null, '[GET]')
          forcePasvForDownloads(client)
          writeFtpLog({ msg: `FTP GET attempt ${attempt}/${maxAttempts} mode=pasv4 host=${t.host}:${t.port} remote=${remotePath}` })

          await accessDroneFtpMinimal(client, { host: t.host, port: t.port })
          enableFtpTcpKeepAlive(client)

          const baseName = path.basename(remotePath)
          const safeName = baseName.replace(/[\\/:*?"<>|]/g, '_')
          const localPath = path.join(downloadsDir, safeName)

          const candidates = getFtpDownloadCandidates(remotePath)
          if (candidates.length === 0) throw new Error('Invalid remotePath')

          let lastAbsErr = null
          for (const cand of candidates) {
            const parts = splitFtpPath(cand)
            let expectedSize = null

            try { await client.send('TYPE I') } catch {}
            try { expectedSize = await client.size(cand) } catch { expectedSize = null }

            // 150/125 should arrive quickly; cap so we can fall back fast.
            const preliminaryTimeoutMs = getPreliminaryTimeoutMsForFile({ size: expectedSize }, attempt)

            try {
              await downloadFileResumable(client, localPath, cand, { preliminaryTimeoutMs, expectedSize, skipPrime: true })
              lastAbsErr = null
              break
            } catch (absErr) {
              lastAbsErr = absErr
              // Keep trying this candidate with CWD+basename, then next candidate.
            }

            // If absolute-path RETR is flaky, fall back to CWD + basename for this candidate.
            if (parts?.dir && parts?.name && !cand.startsWith('/blackbox/')) {
              try {
                try { await client.cd(parts.dir) } catch {}
                try { await client.send('TYPE I') } catch {}
                let expected2 = expectedSize
                try { expected2 = await client.size(parts.name) } catch {}
                const preliminary2 = getPreliminaryTimeoutMsForFile({ size: expected2 }, attempt)
                await downloadFileResumable(client, localPath, parts.name, { preliminaryTimeoutMs: preliminary2, expectedSize: expected2, skipPrime: true })
                lastAbsErr = null
                break
              } catch (cwdErr) {
                lastAbsErr = cwdErr
                continue
              }
            }
          }

          if (lastAbsErr) throw lastAbsErr

          writeFtpLog({ msg: `FTP GET ok host=${t.host}:${t.port} remote=${remotePath}` })
          client.close()
          return { host: t.host, port: t.port, downloadsDir, remotePath, localPath }
        } catch (e) {
          lastError = e
          writeFtpLog({ level: 'error', msg: `FTP GET error attempt ${attempt}/${maxAttempts} host=${t.host}:${t.port} remote=${remotePath} code=${getFtpReplyCode(e) || ''} ${String(e?.message || e)}` })
          client.close()

          const transient = isTransientFtpError(e)
          if (!transient || attempt >= maxAttempts) {
            break
          }
          const code = getFtpReplyCode(e)
          const msg = String(e?.message || e).toLowerCase()
          const delayMs = code === 421 ? 2000 : (msg.includes('fin packet unexpectedly') || msg.includes('server sent fin') ? 2000 : 800)
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
    }

    throw lastError || new Error('Failed to download')
  })

  // Diagnostic: check PASV endpoints (reads captures/processed/pasv_endpoints.json if present)
  ipcMain.handle('diag:pasvCheck', async () => {
    try {
      const p = path.join(app.getAppPath(), '..', 'captures', 'processed', 'pasv_endpoints.json')
      let data = null
      try {
        data = JSON.parse(await fs.readFile(p, 'utf8'))
      } catch (e) {
        // try workspace-relative
        const alt = path.join(process.cwd(), 'captures', 'processed', 'pasv_endpoints.json')
        data = JSON.parse(await fs.readFile(alt, 'utf8'))
      }
      const netLib = require('net')
      const results = []
      for (const ep of data) {
        // eslint-disable-next-line no-await-in-loop
        const r = await new Promise((resolve) => {
          const s = netLib.createConnection({ host: ep.ip, port: ep.port })
          let done = false
          const t = setTimeout(() => {
            if (done) return
            done = true
            s.destroy()
            resolve({ ip: ep.ip, port: ep.port, reachable: false, error: 'timeout' })
          }, 3000)
          s.on('connect', () => {
            if (done) return
            done = true
            clearTimeout(t)
            const rtt = Date.now()
            s.destroy()
            resolve({ ip: ep.ip, port: ep.port, reachable: true, rtt: 0 })
          })
          s.on('error', (err) => {
            if (done) return
            done = true
            clearTimeout(t)
            resolve({ ip: ep.ip, port: ep.port, reachable: false, error: String(err.message) })
          })
        })
        results.push({ ...ep, ...r })
      }
      return results
    } catch (e) {
      throw new Error('PASV check failed: ' + (e?.message || String(e)))
    }
  })

  // Diagnostic: attempt FTP control connect and LIST for hosts found in pasv_endpoints.json
  ipcMain.handle('diag:ftpProbe', async () => {
    try {
      const p = path.join(process.cwd(), 'captures', 'processed', 'pasv_endpoints.json')
      const data = JSON.parse(await fs.readFile(p, 'utf8'))
      const hosts = [...new Set((data || []).map((x) => x.ip).filter(Boolean))]
      const results = []
      for (const host of hosts) {
        const client = new FtpClient(5000)
        const out = { host }
        try {
          await client.connect(host, 21)
          await client.login('', '')
          try { await client.send('TYPE A') } catch {}
          out.controlConnected = true
          try {
            const list = await client.list('/')
            out.listCount = Array.isArray(list) ? list.length : 0
            out.listSample = (list || []).slice(0, 5).map((x) => ({ name: x.name, type: x.type, size: x.size }))
          } catch (le) {
            out.listError = String(le.message || le)
          }
        } catch (err) {
          out.controlConnected = false
          out.error = String(err.message || err)
        } finally {
          client.close()
        }
        results.push(out)
      }
      return results
    } catch (e) {
      throw new Error('FTP probe failed: ' + (e?.message || String(e)))
    }
  })

  // Improved download with progress events
  ipcMain.handle('ftp:download', async (event, payload) => {
    const remotePathRaw = payload?.remotePath
    if (typeof remotePathRaw !== 'string' || remotePathRaw.length === 0) throw new Error('Invalid remotePath')
    const remotePath = normalizeFtpRemotePath(remotePathRaw)
    if (!remotePath) throw new Error('Invalid remotePath')
    if (remotePath.toLowerCase().endsWith('.tmp')) {
      throw new Error('This file is a temporary recording (.tmp). Please wait until recording finishes.')
    }

    const target = await resolveFtpTarget(payload)
    const targetsToTry = [target]
    if (target.host !== FALLBACK_DRONE_FTP_HOST) targetsToTry.push({ host: FALLBACK_DRONE_FTP_HOST, port: DEFAULT_FTP_PORT })

    const downloadsDir = (payload && typeof payload.downloadsDir === 'string' && payload.downloadsDir.length > 0)
      ? payload.downloadsDir
      : path.join(app.getPath('downloads'), 'Drone_Data_Downloads')
    await fs.mkdir(downloadsDir, { recursive: true })

    let lastError = null

    for (const t of targetsToTry) {
      const maxAttempts = 8
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const client = createFtpClient()
        try {
          const startedAt = Date.now()
          attachBasicFtpVerboseLogging(client, null, '[DL]')
          // Force PASV-only for download flow.
          forcePasvForDownloads(client)
          writeFtpLog({ msg: `FTP DOWNLOAD attempt ${attempt}/${maxAttempts} mode=pasv4 host=${t.host}:${t.port} remote=${remotePath}` })
          client.trackProgress((info) => {
            try {
              event.sender.send('ftp:progress', { host: t.host, port: t.port, downloadsDir, remotePath, info })
            } catch {}
          })

          await accessDroneFtpMinimal(client, { host: t.host, port: t.port })
          enableFtpTcpKeepAlive(client)
          const baseName = path.basename(remotePath)
          const safeName = baseName.replace(/[\\/:*?"<>|]/g, '_')
          const localPath = path.join(downloadsDir, safeName)
          const partLocalPath = `${localPath}.part`

          const candidates = getFtpDownloadCandidates(remotePath)
          if (candidates.length === 0) throw new Error('Invalid remotePath')

          let lastErr = null
          for (const cand of candidates) {
            const parts = splitFtpPath(cand)
            let expectedSize = null

            try { await client.send('TYPE I') } catch {}
            try { expectedSize = await client.size(cand) } catch { expectedSize = null }
            const preliminaryTimeoutMs = getPreliminaryTimeoutMsForFile({ size: expectedSize }, attempt)

            try {
              await downloadFileResumable(client, localPath, cand, { preliminaryTimeoutMs, expectedSize, skipPrime: true })
              lastErr = null
              break
            } catch (absErr) {
              lastErr = absErr
            }

            // Fallback for servers that dislike absolute paths: CWD into dir and RETR basename.
            if (parts?.dir && parts?.name && !cand.startsWith('/blackbox/')) {
              try {
                try { await client.cd(parts.dir) } catch {}
                try { await client.send('TYPE I') } catch {}
                let expected2 = expectedSize
                try { expected2 = await client.size(parts.name) } catch {}
                const preliminary2 = getPreliminaryTimeoutMsForFile({ size: expected2 }, attempt)
                await downloadFileResumable(client, localPath, parts.name, { preliminaryTimeoutMs: preliminary2, expectedSize: expected2, skipPrime: true })
                lastErr = null
                break
              } catch (cwdErr) {
                lastErr = cwdErr
                continue
              }
            }
          }

          if (lastErr) throw lastErr

          // Cleanup: if transfer completed, ensure no stale .part remains.
          try {
            const doneFinal = await getFileSizeOrNull(localPath)
            if (doneFinal != null && doneFinal > 0) {
              const partSize = await getFileSizeOrNull(partLocalPath)
              if (partSize != null) await fs.unlink(partLocalPath)
            }
          } catch {}

          writeFtpLog({ msg: `FTP DOWNLOAD ok host=${t.host}:${t.port} remote=${remotePath} ms=${Date.now() - startedAt}` })

          try {
            event.sender.send('ftp:done', { host: t.host, port: t.port, downloadsDir, remotePath, localPath })
          } catch {}

          try { client.trackProgress(null) } catch {}
          client.close()
          return { host: t.host, port: t.port, downloadsDir, remotePath, localPath }
        } catch (e) {
          lastError = e
          writeFtpLog({ level: 'error', msg: `FTP DOWNLOAD error attempt ${attempt}/${maxAttempts} host=${t.host}:${t.port} remote=${remotePath} code=${getFtpReplyCode(e) || ''} ${String(e?.message || e)}` })
          try {
            event.sender.send('ftp:error', { host: t.host, port: t.port, downloadsDir, remotePath, message: String(e?.message || e) })
          } catch {}

          const transient = isTransientFtpError(e)
          try { client.trackProgress(null) } catch {}
          client.close()

          if (!transient || attempt >= maxAttempts) {
            break
          }
          const code = getFtpReplyCode(e)
          const msg = String(e?.message || e).toLowerCase()
          const delayMs = code === 421 ? 2000 : (msg.includes('fin packet unexpectedly') || msg.includes('server sent fin') ? 2000 : 800)
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
    }

    throw lastError || new Error('Failed to download')
  })

  // Download all files under a directory (recursive). Emits progress events.
  ipcMain.handle('ftp:downloadAll', async (event, payload) => {
    const dir = (payload && typeof payload.dir === 'string') ? payload.dir : '/'
    const target = await resolveFtpTarget(payload)
    const host = target.host
    const port = target.port
    const downloadsDir = (payload && typeof payload.downloadsDir === 'string' && payload.downloadsDir.length > 0)
      ? payload.downloadsDir
      : path.join(app.getPath('downloads'), 'Drone_Data_Downloads')
    await fs.mkdir(downloadsDir, { recursive: true })

    const listClient = createFtpClient()
    const manifest = []
    try {
      writeFtpLog({ msg: `FTP DLALL connect ${host}:${port} walk dir=${dir}` })
      attachBasicFtpVerboseLogging(listClient, null, '[WALK]')
      await accessDroneFtpMinimal(listClient, { host, port })
      enableFtpTcpKeepAlive(listClient)
      try { await listClient.send('TYPE A') } catch {}

      // recursive list
      async function walk(remoteDir) {
        let items = []
        try {
          items = await listClient.list(remoteDir)
        } catch (e) {
          return
        }
        for (const it of items) {
          if (!it?.name || it.name === '.' || it.name === '..') continue
          const rpath = remoteDir.endsWith('/') ? remoteDir + it.name : remoteDir + '/' + it.name
          // basic-ftp uses numeric FileType enum (0 Unknown, 1 File, 2 Directory, 3 Symlink)
          // but some legacy parsing paths may yield string markers. Prefer getters when available.
          const isDir = it?.isDirectory === true || it?.type === 2 || it?.type === 'd'
          const isSymlink = it?.isSymbolicLink === true || it?.type === 3 || it?.type === 'l'

          let isFile = it?.isFile === true || it?.type === 1 || it?.type === '-'
          // Only fall back to SIZE when type is unknown.
          if (!isFile && !isDir && !isSymlink && (it?.type === 0 || it?.type == null)) {
            try {
              // eslint-disable-next-line no-await-in-loop
              const sz = await listClient.size(rpath)
              isFile = typeof sz === 'number'
            } catch {
              isFile = false
            }
          }

          if (isFile) {
            manifest.push({ path: rpath, name: it.name, size: typeof it.size === 'number' ? it.size : null })
          } else if (isDir) {
            // eslint-disable-next-line no-await-in-loop
            await walk(rpath)
          }
        }
      }

      await walk(dir)

      writeFtpLog({ msg: `FTP DLALL manifest ready files=${manifest.length}` })

      // Start with smaller files first to confirm transfer works quickly.
      manifest.sort((a, b) => {
        const as = typeof a?.size === 'number' ? a.size : Number.POSITIVE_INFINITY
        const bs = typeof b?.size === 'number' ? b.size : Number.POSITIVE_INFINITY
        return as - bs
      })


      // send manifest to renderer before downloading
      try { event.sender.send('ftp:downloadAll:manifest', { host, port, downloadsDir, dir, files: manifest }) } catch (e) {}

      // Close the WALK client before downloading to avoid multiple concurrent FTP sessions.
      // Some embedded FTP servers time out aggressively when more than one session is open.
      try { listClient.close() } catch {}

      // signal downloads are starting
      try { event.sender.send('ftp:downloadAll:start', { host, port, downloadsDir, dir, count: manifest.length }) } catch (e) {}

      let currentRemotePath = null

      for (const file of manifest) {
        const remotePath = normalizeFtpRemotePath(file.path)
        if (!remotePath) {
          try { event.sender.send('ftp:downloadAll:fileError', { remotePath: String(file?.path || ''), downloadsDir, message: 'Invalid remote path' }) } catch {}
          continue
        }
        currentRemotePath = remotePath
        const relPath = remotePath.startsWith('/') ? remotePath.slice(1) : remotePath
        const localFull = path.join(downloadsDir, relPath)
        const localDir = path.dirname(localFull)
        await fs.mkdir(localDir, { recursive: true })

        try { event.sender.send('ftp:downloadAll:fileStarted', { remotePath, downloadsDir }) } catch {}

        const maxAttempts = 6
        let succeeded = false
        let lastFileError = null

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const dlClient = createFtpClient()
          let currentRemoteDir = null
          const startedAt = Date.now()
          writeFtpLog({ msg: `FTP DLALL file attempt ${attempt}/${maxAttempts} remote=${remotePath}` })
          try {
            attachBasicFtpVerboseLogging(dlClient, null, '[DLALL]')
            try { forcePasvForDownloads(dlClient) } catch {}
            await accessDroneFtpMinimal(dlClient, { host, port })
            enableFtpTcpKeepAlive(dlClient)
            dlClient.trackProgress((info) => {
              if (!currentRemotePath) return
              try {
                event.sender.send('ftp:downloadAll:fileProgress', {
                  remotePath: currentRemotePath,
                  downloadsDir,
                  bytes: info.bytes,
                  bytesOverall: info.bytesOverall
                })
              } catch {}
            })

            if (String(remotePath).toLowerCase().endsWith('.tmp')) {
              throw new Error('Skipping temporary recording (.tmp)')
            }

            // Match manufacturer flow closely: TYPE I -> SIZE -> PASV -> RETR.
            // Try absolute path first, then fall back to CWD+basename if needed.
            const candidates = getFtpDownloadCandidates(remotePath)
            if (candidates.length === 0) throw new Error('Invalid remotePath')

            let expectedSizeHint = (typeof file?.size === 'number' ? file.size : null)
            let lastErr = null
            for (const cand of candidates) {
              const parts = splitFtpPath(cand)
              let expectedSize = expectedSizeHint

              try { await dlClient.send('TYPE I') } catch {}
              try { expectedSize = await dlClient.size(cand) } catch {}
              const preliminaryTimeoutMs = getPreliminaryTimeoutMsForFile({ size: expectedSize }, attempt)

              try {
                await downloadFileResumable(dlClient, localFull, cand, { preliminaryTimeoutMs, expectedSize, skipPrime: true })
                lastErr = null
                break
              } catch (absErr) {
                lastErr = absErr
              }

              if (parts?.dir && parts?.name && !cand.startsWith('/blackbox/')) {
                try {
                  if (currentRemoteDir !== parts.dir) {
                    await dlClient.cd(parts.dir)
                    currentRemoteDir = parts.dir
                  }
                  try { await dlClient.send('TYPE I') } catch {}
                  let expected2 = expectedSize
                  try { expected2 = await dlClient.size(parts.name) } catch {}
                  const preliminary2 = getPreliminaryTimeoutMsForFile({ size: expected2 }, attempt)
                  await downloadFileResumable(dlClient, localFull, parts.name, { preliminaryTimeoutMs: preliminary2, expectedSize: expected2, skipPrime: true })
                  lastErr = null
                  break
                } catch (cwdErr) {
                  lastErr = cwdErr
                  continue
                }
              }
            }

            if (lastErr) throw lastErr
            writeFtpLog({ msg: `FTP DLALL file ok remote=${remotePath} ms=${Date.now() - startedAt}` })
            try { event.sender.send('ftp:downloadAll:fileDone', { remotePath, downloadsDir, localPath: localFull }) } catch {}
            succeeded = true
            break
          } catch (e) {
            lastFileError = e
            const code = getFtpReplyCode(e)
            writeFtpLog({ level: 'error', msg: `FTP DLALL file error attempt ${attempt}/${maxAttempts} remote=${remotePath} code=${code || ''} ${String(e?.message || e)}` })
            try { event.sender.send('ftp:downloadAll:fileError', { remotePath, downloadsDir, message: String(e?.message || e) }) } catch {}

            const transient = isTransientFtpError(e)
            if (!transient || attempt >= maxAttempts) break

            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, code === 421 ? 4000 : 1200))
          } finally {
            try { dlClient.trackProgress(null) } catch {}
            try { dlClient.close() } catch {}
          }
        }

        if (!succeeded) {
          const msg = lastFileError ? String(lastFileError?.message || lastFileError) : 'Failed after retries'
          try { event.sender.send('ftp:downloadAll:fileError', { remotePath, downloadsDir, message: msg }) } catch {}
        }

        // pace the server a bit between files
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 150))
      }

      try { event.sender.send('ftp:downloadAll:done', { host, port, downloadsDir, dir, count: manifest.length }) } catch (e) {}
      writeFtpLog({ msg: `FTP DLALL done count=${manifest.length}` })
      return { host, port, downloadsDir, dir, count: manifest.length }
    } catch (e) {
      writeFtpLog({ level: 'error', msg: `FTP DLALL error code=${getFtpReplyCode(e) || ''} ${String(e?.message || e)}` })
      try { event.sender.send('ftp:downloadAll:error', { host, port, downloadsDir, dir, message: String(e?.message || e) }) } catch (er) {}
      try { listClient.close() } catch {}
      throw e
    }
  })

  ipcMain.handle('ftp:logPath', async () => {
    try {
      ensureFtpLogStream()
      return ftpLogFilePath
    } catch {
      return null
    }
  })

  /**
   * Serial Service IPC Handlers
   */
  const serialService = new SerialService()

  ipcMain.handle('serial:listPorts', async () => {
    try {
      return await serialService.listPorts()
    } catch (error) {
      throw new Error(`Failed to list ports: ${error.message}`)
    }
  })

  ipcMain.handle('serial:connect', async (_event, payload) => {
    try {
      const { portPath, options } = payload || {}
      if (!portPath || typeof portPath !== 'string') {
        throw new Error('Port path is required')
      }
      await serialService.connect(portPath, options)
      return { success: true, port: portPath, timestamp: Date.now() }
    } catch (error) {
      throw new Error(`Connection failed: ${error.message}`)
    }
  })

  ipcMain.handle('serial:disconnect', async () => {
    try {
      await serialService.disconnect()
      return { success: true, timestamp: Date.now() }
    } catch (error) {
      throw new Error(`Disconnect failed: ${error.message}`)
    }
  })

  ipcMain.handle('serial:send', async (_event, payload) => {
    try {
      const { data } = payload || {}
      return await serialService.send(data)
    } catch (error) {
      throw new Error(`Send failed: ${error.message}`)
    }
  })

  ipcMain.handle('serial:sendUrbBulk', async (_event, payload) => {
    try {
      const { hexData, busNumber, deviceNumber, endpoint } = payload || {}
      return await serialService.sendUrbBulk(hexData, busNumber, deviceNumber, endpoint)
    } catch (error) {
      throw new Error(`URB_BULK send failed: ${error.message}`)
    }
  })

  ipcMain.handle('serial:sendMultiple', async (_event, payload) => {
    try {
      const { packets, delayMs } = payload || {}
      return await serialService.sendMultiple(packets, delayMs)
    } catch (error) {
      throw new Error(`Multiple send failed: ${error.message}`)
    }
  })

  ipcMain.handle('serial:getStatus', async () => {
    try {
      return serialService.getStatus()
    } catch (error) {
      throw new Error(`Get status failed: ${error.message}`)
    }
  })

  ipcMain.handle('serial:startAutoLoop', async (_event, payload) => {
    try {
      const { heartbeatPackets, versionPackets, intervalMs } = payload || {}
      return serialService.startAutoLoop(heartbeatPackets, versionPackets, intervalMs)
    } catch (error) {
      throw new Error(`Start auto loop failed: ${error.message}`)
    }
  })

  ipcMain.handle('serial:stopAutoLoop', async () => {
    try {
      return serialService.stopAutoLoop()
    } catch (error) {
      throw new Error(`Stop auto loop failed: ${error.message}`)
    }
  })

  ipcMain.handle('serial:getAutoLoopStatus', async () => {
    try {
      return serialService.getAutoLoopStatus()
    } catch (error) {
      throw new Error(`Get auto loop status failed: ${error.message}`)
    }
  })

  // Setup event forwarding from serial service to renderer
  serialService.on('data', (data) => {
    BrowserWindow.getAllWindows().forEach(window => {
      try {
        window.webContents.send('serial:data', data)
      } catch {}
    })
  })

  serialService.on('connected', (data) => {
    BrowserWindow.getAllWindows().forEach(window => {
      try {
        window.webContents.send('serial:connected', data)
      } catch {}
    })
  })

  serialService.on('disconnected', (data) => {
    BrowserWindow.getAllWindows().forEach(window => {
      try {
        window.webContents.send('serial:disconnected', data)
      } catch {}
    })
  })

  serialService.on('error', (data) => {
    BrowserWindow.getAllWindows().forEach(window => {
      try {
        window.webContents.send('serial:error', data)
      } catch {}
    })
  })

  serialService.on('urb-bulk-sent', (data) => {
    BrowserWindow.getAllWindows().forEach(window => {
      try {
        window.webContents.send('serial:urbBulkSent', data)
      } catch {}
    })
  })

  serialService.on('urb-bulk-error', (data) => {
    BrowserWindow.getAllWindows().forEach(window => {
      try {
        window.webContents.send('serial:urbBulkError', data)
      } catch {}
    })
  })

  serialService.on('auto-loop-state', (data) => {
    BrowserWindow.getAllWindows().forEach(window => {
      try {
        window.webContents.send('serial:autoLoopState', data)
      } catch {}
    })
  })

  serialService.on('auto-loop-tick', (data) => {
    BrowserWindow.getAllWindows().forEach(window => {
      try {
        window.webContents.send('serial:autoLoopTick', data)
      } catch {}
    })
  })

  serialService.on('auto-loop-error', (data) => {
    BrowserWindow.getAllWindows().forEach(window => {
      try {
        window.webContents.send('serial:autoLoopError', data)
      } catch {}
    })
  })

  await cleanupChromiumCaches()
  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
