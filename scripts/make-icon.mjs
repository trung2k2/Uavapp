import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const workspaceRoot = process.cwd()
const buildPng = path.join(workspaceRoot, 'build', 'icon.png')
const resourcesPng = path.join(workspaceRoot, 'resources', 'icon.png')
const outIco = path.join(workspaceRoot, 'build', 'icon.ico')

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  const src = (await exists(buildPng)) ? buildPng : resourcesPng
  if (!(await exists(src))) {
    throw new Error(`Missing icon source PNG. Expected ${buildPng} or ${resourcesPng}`)
  }

  const sizes = [16, 24, 32, 48, 64, 128, 256]

  // Create PNG buffers for multiple sizes; electron-builder requires at least 256x256.
  const buffers = await Promise.all(
    sizes.map(async (s) => {
      return sharp(src)
        .resize(s, s, { fit: 'cover' })
        .png()
        .toBuffer()
    })
  )

  const icoBuf = await pngToIco(buffers)
  await fs.mkdir(path.dirname(outIco), { recursive: true })
  await fs.writeFile(outIco, icoBuf)

  // eslint-disable-next-line no-console
  console.log(`Generated ${path.relative(workspaceRoot, outIco)} from ${path.relative(workspaceRoot, src)}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || err?.message || String(err))
  process.exit(1)
})
