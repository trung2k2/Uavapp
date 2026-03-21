import fs from 'fs/promises'
import path from 'path'

function countNonNilGps(csvText) {
  const lines = csvText.split(/\r?\n/)
  if (lines.length <= 1) return 0
  let count = 0
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    const cols = line.split(',')
    const lat = cols[2]
    const lon = cols[3]
    if (lat && lon && lat !== '<nil>' && lon !== '<nil>') count += 1
  }
  return count
}

function extractKmlCoordinatesCount(kmlText) {
  const matches = [...kmlText.matchAll(/<coordinates>(.*?)<\/coordinates>/gms)]
  let total = 0
  for (const m of matches) {
    const raw = (m[1] || '').trim()
    if (!raw) continue
    total += raw.split(/\s+/).filter(Boolean).length
  }
  return total
}

async function safeStat(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

async function main() {
  const root = process.cwd()
  const outDir = path.join(root, 'outputfile')
  const sampleDir = path.join(root, 'samplefile')

  const targetBase = 'FLY002'
  const generatedCsv = path.join(outDir, `${targetBase}.DAT.csv`)
  const generatedKml = path.join(outDir, `${targetBase}.DAT.kml`)
  const generatedTxt = path.join(outDir, `${targetBase}-tombstone.txt`)

  const sampleCsv = path.join(sampleDir, `${targetBase}.DAT.csv`)
  const sampleKml = path.join(sampleDir, `${targetBase}.DAT.kml`)
  const sampleTxt = path.join(sampleDir, `${targetBase}-tombstone.txt`)

  const [gCsvStat, gKmlStat, gTxtStat, sCsvStat, sKmlStat, sTxtStat] = await Promise.all([
    safeStat(generatedCsv),
    safeStat(generatedKml),
    safeStat(generatedTxt),
    safeStat(sampleCsv),
    safeStat(sampleKml),
    safeStat(sampleTxt)
  ])

  if (!gCsvStat || !gKmlStat || !gTxtStat) throw new Error('Generated FLY002 outputs not found in outputfile')
  if (!sCsvStat || !sKmlStat || !sTxtStat) throw new Error('Sample FLY002 outputs not found in samplefile')

  const [gCsv, gKml, gTxt, sCsv, sKml, sTxt] = await Promise.all([
    fs.readFile(generatedCsv, 'utf8'),
    fs.readFile(generatedKml, 'utf8'),
    fs.readFile(generatedTxt, 'utf8'),
    fs.readFile(sampleCsv, 'utf8'),
    fs.readFile(sampleKml, 'utf8'),
    fs.readFile(sampleTxt, 'utf8')
  ])

  const report = {
    comparedAt: new Date().toISOString(),
    file: targetBase,
    sizeBytes: {
      generated: {
        csv: gCsvStat.size,
        kml: gKmlStat.size,
        tombstone: gTxtStat.size
      },
      sample: {
        csv: sCsvStat.size,
        kml: sKmlStat.size,
        tombstone: sTxtStat.size
      }
    },
    csv: {
      generatedRows: gCsv.split(/\r?\n/).filter(Boolean).length,
      sampleRows: sCsv.split(/\r?\n/).filter(Boolean).length,
      generatedGpsRows: countNonNilGps(gCsv),
      sampleGpsRows: countNonNilGps(sCsv)
    },
    kml: {
      generatedCoordinateTokens: extractKmlCoordinatesCount(gKml),
      sampleCoordinateTokens: extractKmlCoordinatesCount(sKml)
    },
    tombstone: {
      generatedHasRawTextSection: gTxt.includes('Raw Text From FlyLog:Value Records'),
      sampleHasRawTextSection: sTxt.includes('Raw Text From FlyLog:Value Records'),
      generatedHasGpsCandidate: gTxt.includes('GPS Candidate:'),
      sampleHasGpsCandidate: sTxt.includes('GPS Candidate:')
    }
  }

  const reportPath = path.join(outDir, 'compare_with_sample_report.json')
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
  console.log(`Report: ${reportPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
