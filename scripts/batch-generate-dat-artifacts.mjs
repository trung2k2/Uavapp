import fs from 'fs/promises'
import path from 'path'

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

function isPlausibleLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return false
  return true
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
  let pos = dataLen >= 256 ? 256 : 0
  let recordIndex = 0
  let sampledRecords = 0
  const sampleStride = 25
  const maxSampledRecords = 120000
  const tracks = new Map()

  const getTrack = (key, recordType, encoding, offset) => {
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

  while (pos + 5 <= dataLen && sampledRecords < maxSampledRecords) {
    if (buffer[pos] !== 0x55) {
      const next = buffer.indexOf(0x55, pos + 1)
      if (next < 0) break
      pos = next
      continue
    }

    const totalLen = buffer.readUInt16LE(pos + 1)
    if (totalLen < 5 || pos + totalLen > dataLen) {
      pos += 1
      continue
    }

    const recordType = buffer[pos + 3]
    const payloadStart = pos + 4
    const payloadLen = totalLen - 5

    if (recordIndex % sampleStride === 0 && payloadLen >= 8) {
      sampledRecords += 1
      const maxIntFloatOffset = Math.min(payloadLen - 8, 56)
      const maxDoubleOffset = Math.min(payloadLen - 16, 48)

      for (let off = 0; off <= maxIntFloatOffset; off += 4) {
        try {
          const latI = buffer.readInt32LE(payloadStart + off) / 1e7
          const lonI = buffer.readInt32LE(payloadStart + off + 4) / 1e7
          updateCoordinateTrack(getTrack(`${recordType}|int32e7|${off}`, recordType, 'int32e7', off), latI, lonI)
        } catch {}

        try {
          const latF = buffer.readFloatLE(payloadStart + off)
          const lonF = buffer.readFloatLE(payloadStart + off + 4)
          updateCoordinateTrack(getTrack(`${recordType}|float32|${off}`, recordType, 'float32', off), latF, lonF)
        } catch {}
      }

      for (let off = 0; off <= maxDoubleOffset; off += 4) {
        try {
          const latD = buffer.readDoubleLE(payloadStart + off)
          const lonD = buffer.readDoubleLE(payloadStart + off + 8)
          updateCoordinateTrack(getTrack(`${recordType}|float64|${off}`, recordType, 'float64', off), latD, lonD)
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
    if (jumpRatio > 0.5 || span < 0.00005 || span > 8) continue

    const score = t.n * 1.2 - jumpRatio * 180 - meanStep * 600 - Math.abs(stillRatio - 0.15) * 40 - Math.max(0, span - 1.5) * 8
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
  if (!candidate || recordType !== candidate.recordType || candidate.offset < 0) return null
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

async function generateForDat(filePath, outDir) {
  const base = path.basename(filePath)
  const stem = base.replace(/\.dat$/i, '')
  const inputStat = await fs.stat(filePath)

  const csvPath = path.join(outDir, `${base}.csv`)
  const kmlPath = path.join(outDir, `${base}.kml`)
  const tombPath = path.join(outDir, `${stem}-tombstone.txt`)

  const buffer = await fs.readFile(filePath)

  const csvRows = ['Sample Number,DateTime GMT,Latitude,Longitude,Altitude_mASL,NumSats,GPSLevel,RC Connected,Fix,OffsetSeconds,DateTime UTC']
  const textLines = []
  const gpsPoints = []
  const candidate = detectBestDatCoordinateCandidate(buffer)
  const trustedCandidate = candidate?.isTrusted ? candidate : null
  const maxCsvRows = 30000
  const rowStride = 250
  const maxGpsPoints = 25000

  let pos = buffer.length >= 256 ? 256 : 0
  let totalEntries = 0
  let processedEntries = 0

  while (pos + 5 <= buffer.length) {
    if (buffer[pos] !== 0x55) {
      const next = buffer.indexOf(0x55, pos + 1)
      if (next < 0) break
      pos = next
      continue
    }

    const totalLen = buffer.readUInt16LE(pos + 1)
    if (totalLen < 5 || pos + totalLen > buffer.length) {
      pos += 1
      continue
    }

    totalEntries += 1
    const recordType = buffer[pos + 3]
    const payloadStart = pos + 4
    const payloadEnd = pos + totalLen - 1
    const payloadLen = Math.max(0, payloadEnd - payloadStart)
    const sampleNumber = payloadLen >= 4 ? buffer.readUInt32LE(payloadStart) : pos
    const offsetSeconds = sampleNumber > 0 ? Math.floor(sampleNumber / 5_000_000) : 0

    const point = trustedCandidate
      ? readCandidateCoordinatePoint(buffer, payloadStart, payloadLen, recordType, trustedCandidate)
      : null
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
      if (gpsPoints.length < maxGpsPoints && (!prev || Math.hypot(prev.lat - point.lat, prev.lon - point.lon) > 1e-7)) gpsPoints.push(point)
    }

    const keepRow = point || processedEntries % rowStride === 0
    if (keepRow && csvRows.length < maxCsvRows) {
      csvRows.push(`${sampleNumber},<nil>,${latitudeField},${longitudeField},${altitudeField},<nil>,${gpsLevelField},<nil>,${fixField},${offsetSeconds},<nil>`)
    }
    processedEntries += 1

    if (payloadLen >= 12 && textLines.length < 8000) {
      const payload = buffer.subarray(payloadStart, payloadEnd)
      let printable = 0
      for (const b of payload) if ((b >= 32 && b <= 126) || b === 9) printable += 1
      if (printable / payload.length >= 0.7) {
        const normalized = normalizeDatTextLine(payload.toString('latin1'))
        if (normalized.length >= 8) textLines.push(normalized)
      }
    }

    pos += totalLen
  }

  const startPoint = gpsPoints[0] || null
  const endPoint = gpsPoints.length > 0 ? gpsPoints[gpsPoints.length - 1] : null
  const startCoordinateText = startPoint ? `${startPoint.lon.toFixed(7)},${startPoint.lat.toFixed(7)},${(startPoint.altitude ?? 0).toFixed(2)}` : ''
  const endCoordinateText = endPoint ? `${endPoint.lon.toFixed(7)},${endPoint.lat.toFixed(7)},${(endPoint.altitude ?? 0).toFixed(2)}` : ''
  const pathCoordinatesText = gpsPoints.map((p) => `${p.lon.toFixed(7)},${p.lat.toFixed(7)},${(p.altitude ?? 0).toFixed(2)}`).join(' ')
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
    `      <coordinates>${startCoordinateText}</coordinates>`,
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
    `      <coordinates>${endCoordinateText}</coordinates>`,
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
    'Aircraft Type:\t\tUnknown',
    `Analyzed at:\t\t${analyzedAt}`,
    `Input file:\t\t${filePath}`,
    'Flight GPS Start UTC:\t0001-01-01T00:00:00Z',
    `Total entries:\t\t${totalEntries.toLocaleString()}`,
    `Processed entries:\t${processedEntries.toLocaleString()}`,
    `Takeoff Altitude:\t${startPoint?.altitude != null ? startPoint.altitude.toFixed(2) : 0}`,
    `KML Fixed Points:\t${gpsPoints.length > 0 ? 2 : 0}`,
    `KML Path Points:\t${gpsPoints.length}`,
    `Flight Start Point:\t${startPoint ? `${startPoint.lat.toFixed(7)},${startPoint.lon.toFixed(7)}` : ''}`,
    `Flight End Point:\t${endPoint ? `${endPoint.lat.toFixed(7)},${endPoint.lon.toFixed(7)}` : ''}`,
    `GPS Candidate:\t${candidate ? `${candidate.recordType}/${candidate.encoding}/@${candidate.offset}` : 'none'}`,
    `GPS Candidate Trusted:\t${trustedCandidate ? 'true' : 'false'}`,
    '',
    '####################Raw Text From FlyLog:Value Records ########################',
    ...textLines,
    ''
  ].join('\n')

  await fs.writeFile(csvPath, csvRows.join('\n') + '\n', 'utf8')
  await fs.writeFile(kmlPath, kmlText, 'utf8')
  await fs.writeFile(tombPath, tombText, 'utf8')

  return {
    dat: filePath,
    outputs: [csvPath, kmlPath, tombPath],
    gpsPoints: gpsPoints.length,
    candidate: candidate ? `${candidate.recordType}/${candidate.encoding}/@${candidate.offset}` : 'none',
    candidateTrusted: Boolean(trustedCandidate),
    inputSize: inputStat.size
  }
}

async function main() {
  const root = process.cwd()
  const datDir = path.join(root, 'DATFile')
  const outDir = path.join(root, 'outputfile')
  await fs.mkdir(outDir, { recursive: true })

  const entries = await fs.readdir(datDir)
  const datFiles = entries.filter((name) => /\.dat$/i.test(name)).sort()
  if (!datFiles.length) throw new Error('No DAT files found in DATFile')

  const onlyArg = process.argv[2] ? String(process.argv[2]).trim() : null
  const selectedFiles = onlyArg
    ? datFiles.filter((name) => name.toLowerCase() === onlyArg.toLowerCase())
    : datFiles
  if (!selectedFiles.length) throw new Error(`DAT file not found: ${onlyArg}`)

  const results = []
  for (const name of selectedFiles) {
    const full = path.join(datDir, name)
    const r = await generateForDat(full, outDir)
    results.push(r)
    console.log(`Generated ${name}: gpsPoints=${r.gpsPoints}, candidate=${r.candidate}`)
  }

  const reportPath = path.join(outDir, 'generation_report.json')
  await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8')
  console.log(`Report: ${reportPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
