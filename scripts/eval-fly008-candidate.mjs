import fs from 'fs'

const b = fs.readFileSync('DATFile/FLY008.DAT')
const candidate = { recordType: 207, encoding: 'float64', offset: 40 }

function readPoint(ps, pl) {
  if (candidate.offset + 16 > pl) return null
  const lat = b.readDoubleLE(ps + candidate.offset)
  const lon = b.readDoubleLE(ps + candidate.offset + 8)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

const pts = []
let pos = 256
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
  const rt = b[pos + 3]
  if (rt === candidate.recordType) {
    const ps = pos + 4
    const pl = totalLen - 5
    const p = readPoint(ps, pl)
    if (p) pts.push(p)
  }
  pos += totalLen
}

function stats(arr, mapFn = (x) => x) {
  if (!arr.length) return null
  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity
  for (const p0 of arr) {
    const p = mapFn(p0)
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
  }
  return { count: arr.length, minLat, maxLat, minLon, maxLon }
}

const rad = stats(pts)
const deg = stats(pts, (p) => ({ lat: p.lat * 180 / Math.PI, lon: p.lon * 180 / Math.PI }))

console.log('candidate', candidate)
console.log('rad', rad)
console.log('deg', deg)
console.log('first10 rad', pts.slice(0, 10))
console.log('first10 deg', pts.slice(0, 10).map((p) => ({ lat: p.lat * 180 / Math.PI, lon: p.lon * 180 / Math.PI })))
