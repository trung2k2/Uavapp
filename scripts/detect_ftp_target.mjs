import os from 'os'
import net from 'net'

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

  if (prefixes.size === 0) preferredPrefixes.forEach((p) => prefixes.add(p))
  return [...prefixes]
}

function probeFtpBanner(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let done = false

    const finish = (ok, detail) => {
      if (done) return
      done = true
      try { socket.destroy() } catch {}
      resolve({ ok, detail })
    }

    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)

    socket.on('error', (err) => {
      clearTimeout(timer)
      finish(false, err?.message || String(err))
    })

    socket.on('data', (buf) => {
      const text = String(buf || '')
      if (text.includes('220')) {
        clearTimeout(timer)
        finish(true, text.trim())
      }
    })
  })
}

async function main() {
  const prefixes = getLikelyUsbTetherPrefixes()
  const portsToTry = [21, 2121, 8021]

  const hostCandidates = []
  for (const p of prefixes) {
    hostCandidates.push(p + '2')
    hostCandidates.push(p + '1')
  }

  const seen = new Set()
  const orderedHosts = hostCandidates.filter((h) => {
    if (seen.has(h)) return false
    seen.add(h)
    return true
  })

  console.log('Detected prefixes:', prefixes)
  console.log('Host candidates:', orderedHosts)
  console.log('Port candidates:', portsToTry)

  for (const host of orderedHosts) {
    for (const port of portsToTry) {
      // eslint-disable-next-line no-await-in-loop
      const res = await probeFtpBanner(host, port)
      if (res.ok) {
        console.log(`FOUND FTP: ${host}:${port}`)
        console.log('Banner:', res.detail)
        process.exit(0)
      } else {
        console.log(`no: ${host}:${port} (${res.detail})`)
      }
    }
  }

  console.log('NOT FOUND (no FTP banner detected).')
  process.exit(2)
}

main().catch((e) => {
  console.error('ERROR:', e)
  process.exit(1)
})
