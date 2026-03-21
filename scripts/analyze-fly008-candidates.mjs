import fs from 'fs'

const b = fs.readFileSync('DATFile/FLY008.DAT')
const tracks = new Map()

const isPlausible = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4)

function getTrack(key, recordType, encoding, offset) {
  let t = tracks.get(key)
  if (!t) {
    t = {
      recordType,
      encoding,
      offset,
      n: 0,
      step: 0,
      jump: 0,
      still: 0,
      minLat: Number.POSITIVE_INFINITY,
      maxLat: Number.NEGATIVE_INFINITY,
      minLon: Number.POSITIVE_INFINITY,
      maxLon: Number.NEGATIVE_INFINITY,
      prev: null
    }
    tracks.set(key, t)
  }
  return t
}

function addPoint(track, lat, lon) {
  if (!isPlausible(lat, lon)) return
  track.n += 1
  if (lat < track.minLat) track.minLat = lat
  if (lat > track.maxLat) track.maxLat = lat
  if (lon < track.minLon) track.minLon = lon
  if (lon > track.maxLon) track.maxLon = lon
  if (track.prev) {
    const d = Math.hypot(lat - track.prev[0], lon - track.prev[1])
    track.step += d
    if (d > 0.25) track.jump += 1
    if (d < 1e-7) track.still += 1
  }
  track.prev = [lat, lon]
}

let pos = 256
let recordIndex = 0
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

  const recordType = b[pos + 3]
  const payloadStart = pos + 4
  const payloadLen = totalLen - 5

  if (recordIndex % 25 === 0 && payloadLen >= 8) {
    for (let off = 0; off <= Math.min(payloadLen - 8, 56); off += 4) {
      try {
        addPoint(getTrack(`${recordType}|i|${off}`, recordType, 'int32e7', off), b.readInt32LE(payloadStart + off) / 1e7, b.readInt32LE(payloadStart + off + 4) / 1e7)
      } catch {}
      try {
        addPoint(getTrack(`${recordType}|f|${off}`, recordType, 'float32', off), b.readFloatLE(payloadStart + off), b.readFloatLE(payloadStart + off + 4))
      } catch {}
    }

    for (let off = 0; off <= Math.min(payloadLen - 16, 48); off += 4) {
      try {
        addPoint(getTrack(`${recordType}|d|${off}`, recordType, 'float64', off), b.readDoubleLE(payloadStart + off), b.readDoubleLE(payloadStart + off + 8))
      } catch {}
    }
  }

  recordIndex += 1
  pos += totalLen
}

const ranked = []
for (const t of tracks.values()) {
  if (t.n < 30) continue
  const denom = Math.max(1, t.n - 1)
  const jumpRatio = t.jump / denom
  const stillRatio = t.still / denom
  const meanStep = t.step / denom
  const spanLat = t.maxLat - t.minLat
  const spanLon = t.maxLon - t.minLon
  const span = spanLat + spanLon
  const score = t.n * 1.2 - jumpRatio * 180 - meanStep * 600 - Math.abs(stillRatio - 0.15) * 40 - Math.max(0, span - 1.5) * 8
  ranked.push({
    ...t,
    jumpRatio,
    stillRatio,
    meanStep,
    spanLat,
    spanLon,
    span,
    centerLat: (t.minLat + t.maxLat) / 2,
    centerLon: (t.minLon + t.maxLon) / 2,
    score
  })
}

ranked.sort((a, b) => b.score - a.score)
for (const r of ranked.slice(0, 30)) {
  console.log(`${r.recordType}/${r.encoding}/@${r.offset} n=${r.n} score=${r.score.toFixed(1)} spanLat=${r.spanLat.toFixed(4)} spanLon=${r.spanLon.toFixed(4)} center=(${r.centerLat.toFixed(4)},${r.centerLon.toFixed(4)}) jump=${r.jumpRatio.toFixed(3)} step=${r.meanStep.toFixed(4)}`)
}
