import fs from 'fs'

const b = fs.readFileSync('DATFile/FLY008.DAT')
const tracks = new Map()

const ok = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180

function getTrack(key, recordType, encoding, offset) {
  let t = tracks.get(key)
  if (!t) {
    t = { recordType, encoding, offset, n: 0, jump: 0, step: 0, minLat: 1e9, maxLat: -1e9, minLon: 1e9, maxLon: -1e9, prev: null }
    tracks.set(key, t)
  }
  return t
}

function add(t, lat, lon) {
  if (!ok(lat, lon)) return
  t.n += 1
  if (lat < t.minLat) t.minLat = lat
  if (lat > t.maxLat) t.maxLat = lat
  if (lon < t.minLon) t.minLon = lon
  if (lon > t.maxLon) t.maxLon = lon
  if (t.prev) {
    const d = Math.hypot(lat - t.prev[0], lon - t.prev[1])
    t.step += d
    if (d > 0.5) t.jump += 1
  }
  t.prev = [lat, lon]
}

let pos = 256
let rec = 0
while (pos + 5 <= b.length) {
  if (b[pos] !== 0x55) {
    const next = b.indexOf(0x55, pos + 1)
    if (next < 0) break
    pos = next
    continue
  }
  const totalLen = b.readUInt16LE(pos + 1)
  if (totalLen < 5 || pos + totalLen > b.length) {
    pos += 1
    continue
  }

  if (rec % 50 === 0) {
    const recordType = b[pos + 3]
    const ps = pos + 4
    const pl = totalLen - 5

    for (let off = 0; off + 8 <= pl; off += 4) {
      try {
        add(getTrack(`${recordType}|i|${off}`, recordType, 'int32e7', off), b.readInt32LE(ps + off) / 1e7, b.readInt32LE(ps + off + 4) / 1e7)
      } catch {}
      try {
        add(getTrack(`${recordType}|f|${off}`, recordType, 'float32', off), b.readFloatLE(ps + off), b.readFloatLE(ps + off + 4))
      } catch {}
    }
    for (let off = 0; off + 16 <= pl; off += 4) {
      try {
        add(getTrack(`${recordType}|d|${off}`, recordType, 'float64', off), b.readDoubleLE(ps + off), b.readDoubleLE(ps + off + 8))
      } catch {}
    }
  }

  rec += 1
  pos += totalLen
}

const list = []
for (const t of tracks.values()) {
  if (t.n < 20) continue
  const denom = Math.max(1, t.n - 1)
  const jumpRatio = t.jump / denom
  const meanStep = t.step / denom
  const centerLat = (t.minLat + t.maxLat) / 2
  const centerLon = (t.minLon + t.maxLon) / 2
  const spanLat = t.maxLat - t.minLat
  const spanLon = t.maxLon - t.minLon
  list.push({ ...t, jumpRatio, meanStep, centerLat, centerLon, spanLat, spanLon })
}

list.sort((a, b) => b.n - a.n)

console.log('--- likely non-zero lon candidates ---')
for (const x of list.filter((v) => Math.abs(v.centerLon) > 20 && Math.abs(v.centerLat) > 5 && v.jumpRatio < 0.6).slice(0, 40)) {
  console.log(`${x.recordType}/${x.encoding}/@${x.offset} n=${x.n} center=(${x.centerLat.toFixed(6)},${x.centerLon.toFixed(6)}) span=(${x.spanLat.toFixed(6)},${x.spanLon.toFixed(6)}) jump=${x.jumpRatio.toFixed(3)} step=${x.meanStep.toFixed(4)}`)
}

console.log('--- top by continuity ---')
for (const x of list.filter((v) => v.jumpRatio < 0.5).sort((a, b) => a.meanStep - b.meanStep).slice(0, 40)) {
  console.log(`${x.recordType}/${x.encoding}/@${x.offset} n=${x.n} center=(${x.centerLat.toFixed(6)},${x.centerLon.toFixed(6)}) span=(${x.spanLat.toFixed(6)},${x.spanLon.toFixed(6)}) jump=${x.jumpRatio.toFixed(3)} step=${x.meanStep.toFixed(4)}`)
}

console.log('--- radian-like center candidates ---')
for (const x of list.filter((v) => Math.abs(v.centerLat) >= 0.2 && Math.abs(v.centerLat) <= 0.6 && Math.abs(v.centerLon) >= 1.5 && Math.abs(v.centerLon) <= 2.3 && v.jumpRatio < 0.5).slice(0, 40)) {
  console.log(`${x.recordType}/${x.encoding}/@${x.offset} n=${x.n} center=(${x.centerLat.toFixed(6)},${x.centerLon.toFixed(6)}) span=(${x.spanLat.toFixed(6)},${x.spanLon.toFixed(6)}) jump=${x.jumpRatio.toFixed(3)} step=${x.meanStep.toFixed(4)}`)
}
