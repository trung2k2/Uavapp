import fs from 'fs'

const buf = fs.readFileSync('DATFile/FLY008.DAT')
const scales = [1e5, 1e6, 1e7, 1e8]
const wanted = { minLat: 10, maxLat: 25, minLon: 100, maxLon: 115 }

function inRange(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

function scoreSeries(points) {
  if (points.length < 40) return null
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  let jump = 0
  let step = 0
  let nearWanted = 0
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
    if (p.lat >= wanted.minLat && p.lat <= wanted.maxLat && p.lon >= wanted.minLon && p.lon <= wanted.maxLon) nearWanted += 1
    if (i > 0) {
      const d = Math.hypot(p.lat - points[i - 1].lat, p.lon - points[i - 1].lon)
      step += d
      if (d > 0.005) jump += 1
    }
  }
  return {
    n: points.length,
    centerLat: (minLat + maxLat) / 2,
    centerLon: (minLon + maxLon) / 2,
    spanLat: maxLat - minLat,
    spanLon: maxLon - minLon,
    jumpRatio: jump / Math.max(1, points.length - 1),
    meanStep: step / Math.max(1, points.length - 1),
    nearWantedRatio: nearWanted / points.length
  }
}

const candidates = []

for (const scale of scales) {
  let pos = 256
  let rec = 0
  const map = new Map()

  const add = (key, recType, off, lat, lon) => {
    if (!inRange(lat, lon)) return
    let arr = map.get(key)
    if (!arr) {
      arr = []
      map.set(key, arr)
    }
    arr.push({ lat, lon })
  }

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

    if (rec % 10 === 0) {
      const recType = buf[pos + 3]
      const ps = pos + 4
      const pl = len - 5
      for (let off = 0; off + 8 <= pl; off += 4) {
        try {
          const a = buf.readInt32LE(ps + off) / scale
          const b = buf.readInt32LE(ps + off + 4) / scale
          add(`${recType}|off${off}|s${scale}|ab`, recType, off, a, b)
          add(`${recType}|off${off}|s${scale}|ba`, recType, off, b, a)
        } catch {}
      }
    }

    rec += 1
    pos += len
  }

  for (const [key, points] of map) {
    const met = scoreSeries(points)
    if (!met) continue
    const score = met.nearWantedRatio * 500 + met.n * 0.2 - met.jumpRatio * 120 - met.meanStep * 200 - Math.max(0, (met.spanLat + met.spanLon) - 2) * 20
    candidates.push({ key, scale, ...met, score })
  }
}

candidates.sort((a, b) => b.score - a.score)
console.log('Top int-scale candidates:')
for (const c of candidates.slice(0, 40)) {
  console.log(`${c.key} n=${c.n} score=${c.score.toFixed(2)} near=${(c.nearWantedRatio * 100).toFixed(2)}% center=(${c.centerLat.toFixed(6)},${c.centerLon.toFixed(6)}) span=(${c.spanLat.toFixed(6)},${c.spanLon.toFixed(6)}) jump=${c.jumpRatio.toFixed(3)} step=${c.meanStep.toFixed(6)}`)
}

console.log('\nCandidates with >10% points in VN-ish range:')
for (const c of candidates.filter((x) => x.nearWantedRatio > 0.1).slice(0, 20)) {
  console.log(`${c.key} n=${c.n} score=${c.score.toFixed(2)} near=${(c.nearWantedRatio * 100).toFixed(2)}% center=(${c.centerLat.toFixed(6)},${c.centerLon.toFixed(6)}) span=(${c.spanLat.toFixed(6)},${c.spanLon.toFixed(6)})`)
}
