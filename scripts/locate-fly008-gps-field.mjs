import fs from 'fs'

const buf = fs.readFileSync('DATFile/FLY008.DAT')

function isValid(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}

function tryAdd(map, key, recType, enc, off, lat, lon) {
  if (!isValid(lat, lon)) return
  let s = map.get(key)
  if (!s) {
    s = { recType, enc, off, points: [] }
    map.set(key, s)
  }
  s.points.push({ lat, lon })
}

const cands = new Map()
let pos = 256
let recIdx = 0
while (pos + 5 <= buf.length) {
  if (buf[pos] !== 0x55) {
    const next = buf.indexOf(0x55, pos + 1)
    if (next < 0) break
    pos = next
    continue
  }

  const len = buf.readUInt16LE(pos + 1)
  if (len < 5 || pos + len > buf.length) {
    pos += 1
    continue
  }

  const recType = buf[pos + 3]
  const ps = pos + 4
  const pl = len - 5

  if (recIdx % 10 === 0 && pl >= 8) {
    for (let off = 0; off + 8 <= pl; off += 4) {
      try {
        const lat = buf.readInt32LE(ps + off) / 1e7
        const lon = buf.readInt32LE(ps + off + 4) / 1e7
        tryAdd(cands, `${recType}|i|${off}`, recType, 'int32e7', off, lat, lon)
      } catch {}
      try {
        const lat = buf.readFloatLE(ps + off)
        const lon = buf.readFloatLE(ps + off + 4)
        tryAdd(cands, `${recType}|f|${off}`, recType, 'float32', off, lat, lon)
      } catch {}
    }
    for (let off = 0; off + 16 <= pl; off += 4) {
      try {
        const lat = buf.readDoubleLE(ps + off)
        const lon = buf.readDoubleLE(ps + off + 8)
        tryAdd(cands, `${recType}|d|${off}`, recType, 'float64', off, lat, lon)
      } catch {}
    }
  }

  recIdx += 1
  pos += len
}

function evaluateSeries(series) {
  if (series.length < 40) return null

  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity

  for (const p of series) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
  }

  let bestRun = 1
  let run = 1
  let jumpCount = 0
  let stepSum = 0
  for (let i = 1; i < series.length; i += 1) {
    const d = Math.hypot(series[i].lat - series[i - 1].lat, series[i].lon - series[i - 1].lon)
    stepSum += d
    if (d > 0.005) {
      jumpCount += 1
      run = 1
    } else {
      run += 1
      if (run > bestRun) bestRun = run
    }
  }

  return {
    n: series.length,
    spanLat: maxLat - minLat,
    spanLon: maxLon - minLon,
    centerLat: (minLat + maxLat) / 2,
    centerLon: (minLon + maxLon) / 2,
    bestRun,
    jumpRatio: jumpCount / Math.max(1, series.length - 1),
    meanStep: stepSum / Math.max(1, series.length - 1)
  }
}

const scored = []
for (const cand of cands.values()) {
  const met = evaluateSeries(cand.points)
  if (!met) continue
  const totalSpan = met.spanLat + met.spanLon
  const score = met.bestRun * 2 - met.jumpRatio * 120 - met.meanStep * 400 - Math.max(0, totalSpan - 2) * 20
  scored.push({ ...cand, ...met, totalSpan, score })
}

scored.sort((a, b) => b.score - a.score)
console.log('Top candidates:')
for (const x of scored.slice(0, 30)) {
  console.log(`${x.recType}/${x.enc}/@${x.off} n=${x.n} run=${x.bestRun} score=${x.score.toFixed(2)} center=(${x.centerLat.toFixed(6)},${x.centerLon.toFixed(6)}) span=(${x.spanLat.toFixed(6)},${x.spanLon.toFixed(6)}) jump=${x.jumpRatio.toFixed(3)} step=${x.meanStep.toFixed(6)}`)
}

console.log('\nCandidates near VN-ish center (lat 10..25, lon 100..115):')
for (const x of scored.filter((v) => v.centerLat >= 10 && v.centerLat <= 25 && v.centerLon >= 100 && v.centerLon <= 115).slice(0, 20)) {
  console.log(`${x.recType}/${x.enc}/@${x.off} n=${x.n} run=${x.bestRun} score=${x.score.toFixed(2)} center=(${x.centerLat.toFixed(6)},${x.centerLon.toFixed(6)}) span=(${x.spanLat.toFixed(6)},${x.spanLon.toFixed(6)})`)
}
