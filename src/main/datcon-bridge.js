import path from 'path'
import fs from 'fs/promises'
import * as fsSync from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

function getJavaBinName(tool) {
  return process.platform === 'win32' ? `${tool}.exe` : tool
}

function getJavaHomeCandidates() {
  const candidates = []
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME)

  if (process.platform === 'win32') {
    const roots = [
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Microsoft'
    ]

    for (const root of roots) {
      if (!fsSync.existsSync(root)) continue
      for (const entry of fsSync.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const name = entry.name.toLowerCase()
        if (name.startsWith('jdk') || name.includes('jdk')) {
          candidates.push(path.join(root, entry.name))
        }
      }
    }
  }

  const seen = new Set()
  const unique = []
  for (const c of candidates) {
    const norm = path.normalize(c)
    if (seen.has(norm)) continue
    seen.add(norm)
    unique.push(norm)
  }
  return unique
}

function resolveJavaTool(tool) {
  const toolName = getJavaBinName(tool)
  const explicit = process.env[`DATCON_${String(tool).toUpperCase()}_PATH`]
  if (explicit && fsSync.existsSync(explicit)) return explicit

  for (const javaHome of getJavaHomeCandidates()) {
    const full = path.join(javaHome, 'bin', toolName)
    if (fsSync.existsSync(full)) return full
  }

  return tool
}

function getDatConPaths() {
  const rootCandidates = [
    path.resolve(__dirname, '..', '..', 'DatCon', 'DatCon'),
    path.resolve(process.cwd(), 'DatCon', 'DatCon')
  ]

  for (const javaRoot of rootCandidates) {
    const bridgeJava = path.join(javaRoot, 'src', 'apps', 'DatConCliBridge.java')
    if (fsSync.existsSync(bridgeJava)) {
      const classesDir = path.join(javaRoot, 'bin-bridge')
      const bridgeClass = path.join(classesDir, 'src', 'apps', 'DatConCliBridge.class')
      const iaMathJar = path.join(javaRoot, 'lib', 'ia_math.jar')
      return { javaRoot, bridgeJava, bridgeClass, classesDir, iaMathJar }
    }
  }

  throw new Error('Khong tim thay DatCon bridge source (DatCon/DatCon/src/apps/DatConCliBridge.java)')
}

function getLatestJavaSourceMtimeMs(dir) {
  if (!fsSync.existsSync(dir)) return 0
  let latest = 0
  const stack = [dir]

  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fsSync.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.name.endsWith('.java')) continue
      const mtime = fsSync.statSync(fullPath).mtimeMs
      if (mtime > latest) latest = mtime
    }
  }

  return latest
}

async function ensureJavaBridgeCompiled() {
  const { javaRoot, bridgeJava, bridgeClass, classesDir, iaMathJar } = getDatConPaths()
  const javaSrcRoot = path.join(javaRoot, 'src')
  const latestSourceMtimeMs = getLatestJavaSourceMtimeMs(javaSrcRoot)
  const compiledMtimeMs = fsSync.existsSync(bridgeClass) ? fsSync.statSync(bridgeClass).mtimeMs : 0
  const shouldCompile = !fsSync.existsSync(bridgeClass) || latestSourceMtimeMs > compiledMtimeMs

  if (!shouldCompile) return

  if (fsSync.existsSync(classesDir)) fsSync.rmSync(classesDir, { recursive: true, force: true })
  fsSync.mkdirSync(classesDir, { recursive: true })

  try {
    await execFileAsync(
      resolveJavaTool('javac'),
      ['-cp', iaMathJar, '-d', classesDir, '-sourcepath', javaRoot, bridgeJava],
      { cwd: javaRoot, windowsHide: true }
    )
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Khong tim thay javac. Vui long cai JDK hoac dat JAVA_HOME dung.')
    }
    const details = [error?.stdout, error?.stderr].filter(Boolean).join('\n')
    throw new Error(`Khong the build DatCon Java bridge: ${details || error?.message || 'unknown error'}`)
  }
}

function parseBridgeJson(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line.startsWith('{') && line.endsWith('}')) {
      return JSON.parse(line)
    }
  }
  throw new Error(output || 'DatCon bridge returned no JSON output')
}

async function runDatConBridge(command, args) {
  await ensureJavaBridgeCompiled()
  const { javaRoot, classesDir, iaMathJar } = getDatConPaths()
  const classPath = [classesDir, iaMathJar].join(path.delimiter)

  try {
    const { stdout, stderr } = await execFileAsync(
      resolveJavaTool('java'),
      ['-cp', classPath, 'src.apps.DatConCliBridge', command, ...args],
      { cwd: javaRoot, windowsHide: true }
    )
    return parseBridgeJson([stdout, stderr].filter(Boolean).join('\n'))
  } catch (error) {
    const merged = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n')
    try {
      return parseBridgeJson(merged)
    } catch {
      throw new Error(merged || 'DatCon bridge execution failed')
    }
  }
}

async function safeStat(filePath) {
  try {
    return await fs.stat(filePath)
  } catch {
    return null
  }
}

function parseKmlAltitudeStats(kmlText) {
  const text = String(kmlText || '')
  const match = text.match(/<coordinates>([\s\S]*?)<\/coordinates>/i)
  if (!match) return null

  const rawCoords = match[1]
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean)

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let count = 0

  for (const token of rawCoords) {
    const parts = token.split(',')
    if (parts.length < 3) continue
    const alt = Number(parts[2])
    if (!Number.isFinite(alt)) continue
    if (alt < min) min = alt
    if (alt > max) max = alt
    count += 1
  }

  if (count === 0 || !Number.isFinite(min) || !Number.isFinite(max)) return null
  return {
    pointCount: count,
    minAltitudeM: min,
    maxAltitudeM: max,
    rangeAltitudeM: max - min
  }
}

async function getKmlAltitudeStats(kmlPath) {
  try {
    const text = await fs.readFile(kmlPath, 'utf8')
    return parseKmlAltitudeStats(text)
  } catch {
    return null
  }
}

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      const next = line[i + 1]
      if (inQuotes && next === '"') {
        cur += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((v) => String(v || '').trim())
}

async function getRelativeHeightStatsFromCsv(csvPath) {
  try {
    const text = await fs.readFile(csvPath, 'utf8')
    const lines = String(text || '').split(/\r?\n/).filter(Boolean)
    if (lines.length < 2) return null

    const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase())
    const idx = headers.findIndex((h) => /relative\s*height|height\s*relative|relativeheight/.test(h))
    if (idx < 0) return null

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let count = 0
    for (let i = 1; i < lines.length; i += 1) {
      const cols = parseCsvLine(lines[i])
      const raw = cols[idx]
      const v = Number(raw)
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
      count += 1
    }

    if (count === 0 || !Number.isFinite(min) || !Number.isFinite(max)) return null
    return {
      count,
      minRelativeHeightM: min,
      maxRelativeHeightM: max,
      relativeHeightRangeM: max - min
    }
  } catch {
    return null
  }
}

function decideProfileByRelativeHeight(relativeHeightStats) {
  const range = relativeHeightStats?.relativeHeightRangeM
  if (Number.isFinite(range) && range < 4) {
    return {
      kmlMode: 'groundtrack',
      profileMeters: null,
      reason: 'relativeHeightRange<4m'
    }
  }
  return {
    kmlMode: 'profile',
    profileMeters: 4,
    reason: Number.isFinite(range) ? 'relativeHeightRange>=4m' : 'relativeHeightMissing'
  }
}

function getManualKmlMode(options) {
  const mode = String(options?.kmlMode || '').toLowerCase().trim()
  if (mode === 'ground' || mode === 'groundtrack') return 'groundtrack'
  if (mode === 'profile') return 'profile'
  return null
}

function getManualProfileMeters(options, fallback = 4) {
  const v = Number(options?.profileMeters)
  if (Number.isFinite(v) && v > 0) return v
  return fallback
}

async function createTombstoneFromAnalyze(filePath, outDir, stem) {
  const analyze = await runDatConBridge('analyze', [filePath])
  if (!analyze?.success || !analyze?.data) return null

  const analyzedAt = new Date().toISOString()
  const outPath = path.join(outDir, `${stem}-tombstone.txt`)
  const text = [
    '###############################################################################',
    `   UAV/UAS/Drone Data Generated By DatCon Bridge at ${analyzedAt}`,
    '###############################################################################',
    '',
    `Aircraft Type:\t\t${analyze.data.acType || 'Unknown'}`,
    `Analyzed at:\t\t${analyzedAt}`,
    `Input file:\t\t${filePath}`,
    `Clock rate:\t\t${analyze.data.clockRate ?? ''}`,
    `GPS locked:\t\t${analyze.data.gpsLocked ? 'true' : 'false'}`,
    `First motor tick:\t${analyze.data.firstMotorTick ?? ''}`,
    `Last motor tick:\t${analyze.data.lastMotorTick ?? ''}`,
    `Lowest tick:\t\t${analyze.data.lowestTick ?? ''}`,
    `Highest tick:\t\t${analyze.data.highestTick ?? ''}`,
    '',
    'Analysis message:',
    String(analyze.data.analysisMessage || ''),
    ''
  ].join('\n')

  await fs.writeFile(outPath, text, 'utf8')
  return outPath
}

export async function decryptWithDatConBridge(filePath, outputDir, options = null) {
  const outDir = outputDir && String(outputDir).trim().length > 0
    ? outputDir
    : path.dirname(filePath)
  const base = path.basename(filePath)
  const stem = base.replace(/\.dat$/i, '')

  await fs.mkdir(outDir, { recursive: true })

  const csvResult = await runDatConBridge('export-csv', [filePath, outDir])
  if (!csvResult?.success || !csvResult?.path) {
    throw new Error(csvResult?.error || `DatCon export-csv failed for ${base}`)
  }

  const relativeHeight = await getRelativeHeightStatsFromCsv(csvResult.path)
  const manualMode = getManualKmlMode(options)
  let profileDecision = manualMode
    ? {
        kmlMode: manualMode,
        profileMeters: manualMode === 'profile' ? getManualProfileMeters(options, 4) : null,
        reason: manualMode === 'profile' ? 'manualProfile' : 'manualGround'
      }
    : decideProfileByRelativeHeight(relativeHeight)

  const buildKmlArgs = (decision) => {
    const args = [filePath, outDir, decision.kmlMode]
    if (decision.kmlMode === 'profile' && Number.isFinite(decision.profileMeters)) {
      args.push(String(decision.profileMeters))
    }
    return args
  }

  let kmlResult = await runDatConBridge('export-kml', buildKmlArgs(profileDecision))
  if (!kmlResult?.success || !kmlResult?.path) {
    throw new Error(kmlResult?.error || `DatCon export-kml failed for ${base}`)
  }

  // In auto mode, if CSV has no relativeHeight, decide again from KML altitude range.
  // This guarantees "range < 4m => groundtrack" still applies.
  let altitude = await getKmlAltitudeStats(kmlResult.path)
  const hasCsvRelativeRange = Number.isFinite(relativeHeight?.relativeHeightRangeM)
  if (!manualMode && !hasCsvRelativeRange) {
    const fallbackStats = Number.isFinite(altitude?.rangeAltitudeM)
      ? { relativeHeightRangeM: altitude.rangeAltitudeM }
      : null
    const fallbackDecision = decideProfileByRelativeHeight(fallbackStats)
    if (fallbackDecision.kmlMode !== profileDecision.kmlMode) {
      profileDecision = fallbackDecision
      kmlResult = await runDatConBridge('export-kml', buildKmlArgs(profileDecision))
      if (!kmlResult?.success || !kmlResult?.path) {
        throw new Error(kmlResult?.error || `DatCon export-kml failed for ${base}`)
      }
      altitude = await getKmlAltitudeStats(kmlResult.path)
    } else {
      profileDecision = fallbackDecision
    }
  }

  let tombPath = null
  try {
    tombPath = await createTombstoneFromAnalyze(filePath, outDir, stem)
  } catch {
    tombPath = null
  }

  const outputPaths = [
    ['CSV', csvResult.path],
    ['KML', kmlResult.path],
    ['TXT', tombPath]
  ]

  const outputs = []
  for (const [type, fp] of outputPaths) {
    if (!fp) continue
    const stat = await safeStat(fp)
    if (stat) outputs.push({ type, name: path.basename(fp), path: fp, size: stat.size })
  }

  const resolvedMinRelativeHeight = Number.isFinite(relativeHeight?.minRelativeHeightM)
    ? relativeHeight.minRelativeHeightM
    : (Number.isFinite(altitude?.minAltitudeM) ? altitude.minAltitudeM : null)
  const resolvedMaxRelativeHeight = Number.isFinite(relativeHeight?.maxRelativeHeightM)
    ? relativeHeight.maxRelativeHeightM
    : (Number.isFinite(altitude?.maxAltitudeM) ? altitude.maxAltitudeM : null)
  const resolvedRangeRelativeHeight = Number.isFinite(relativeHeight?.relativeHeightRangeM)
    ? relativeHeight.relativeHeightRangeM
    : (Number.isFinite(altitude?.rangeAltitudeM) ? altitude.rangeAltitudeM : null)
  const relativeHeightSource = Number.isFinite(relativeHeight?.relativeHeightRangeM)
    ? 'csv.relativeHeight'
    : (Number.isFinite(altitude?.rangeAltitudeM) ? 'kml.altitudeFallback' : 'none')

  const inputStat = await safeStat(filePath)
  return {
    outputs,
    inputSize: inputStat?.size ?? null,
    engine: 'datcon_java_bridge',
    altitude,
    profile: {
      ...profileDecision,
      relativeHeightRangeM: resolvedRangeRelativeHeight,
      minRelativeHeightM: resolvedMinRelativeHeight,
      maxRelativeHeightM: resolvedMaxRelativeHeight,
      relativeHeightSource
    }
  }
}
