import fs from 'node:fs'
import path from 'node:path'

function u32le(buf, off) {
  return buf.readUInt32LE(off)
}

function hex(buf, max = 64) {
  const b = buf.subarray(0, Math.min(buf.length, max))
  return b.toString('hex').match(/.{1,2}/g)?.join(' ') ?? ''
}

function asciiSnippet(buf, max = 160) {
  const b = buf.subarray(0, Math.min(buf.length, max))
  let out = ''
  for (const ch of b) {
    out += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : '.'
  }
  return out
}

function macToString(buf, off) {
  const parts = []
  for (let i = 0; i < 6; i++) parts.push(buf[off + i].toString(16).padStart(2, '0'))
  return parts.join(':')
}

function ipv4ToString(buf, off) {
  return `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`
}

function bump(map, key, inc = 1) {
  map[key] = (map[key] || 0) + inc
}

function topN(map, n = 20) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

function findAsciiNeedle(buf, needles) {
  const s = buf.toString('latin1')
  for (const needle of needles) {
    if (s.includes(needle)) return needle
  }
  return null
}

function tryExtractRndisEthernet(payload) {
  // RNDIS Packet Message (type 1):
  // uint32 MessageType (1)
  // uint32 MessageLength
  // uint32 DataOffset (from start of DataOffset field, i.e. offset 8)
  // uint32 DataLength
  // ... (OOB/PerPacketInfo/etc)
  // Ethernet frame begins at (8 + DataOffset)
  if (!Buffer.isBuffer(payload) || payload.length < 16) return null
  const msgType = payload.readUInt32LE(0)
  if (msgType !== 1) return null
  const msgLen = payload.readUInt32LE(4)
  const dataOffset = payload.readUInt32LE(8)
  const dataLen = payload.readUInt32LE(12)
  if (msgLen <= 0 || msgLen > payload.length + 32) return null
  if (dataLen <= 0 || dataLen > payload.length) return null
  const dataStart = 8 + dataOffset
  const dataEnd = dataStart + dataLen
  if (dataStart < 0 || dataEnd > payload.length || dataStart >= dataEnd) return null
  const eth = payload.subarray(dataStart, dataEnd)
  if (eth.length < 14) return null
  return { eth, msgLen, dataStart, dataLen }
}

function transferName(t) {
  switch (t) {
    case 0:
      return 'iso'
    case 1:
      return 'int'
    case 2:
      return 'ctrl'
    case 3:
      return 'bulk'
    case 0xfe:
      return 'irp-info'
    case 0xff:
      return 'unknown'
    default:
      return `t${t}`
  }
}

function safeBigUInt64LE(buf, off) {
  try {
    return buf.readBigUInt64LE(off)
  } catch {
    return null
  }
}

function parseUsbpcap(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 27) return null
  const headerLen = packet.readUInt16LE(0)
  if (headerLen < 27 || headerLen > packet.length) return null

  const irpId = safeBigUInt64LE(packet, 2)
  const status = packet.length >= 14 ? packet.readUInt32LE(10) : null
  const func = packet.length >= 16 ? packet.readUInt16LE(14) : null
  const info = packet.length >= 17 ? packet.readUInt8(16) : null
  const bus = packet.length >= 19 ? packet.readUInt16LE(17) : null
  const device = packet.length >= 21 ? packet.readUInt16LE(19) : null
  const endpoint = packet.length >= 22 ? packet.readUInt8(21) : null
  const transfer = packet.length >= 23 ? packet.readUInt8(22) : null
  const dataLen = packet.length >= 27 ? packet.readUInt32LE(23) : 0
  const stage = transfer === 2 && headerLen >= 28 ? packet.readUInt8(27) : null

  const payloadStart = headerLen
  const payloadEnd = Math.min(packet.length, payloadStart + Math.max(0, dataLen))
  const payload = packet.subarray(payloadStart, payloadEnd)

  const dir = typeof endpoint === 'number' && (endpoint & 0x80) !== 0 ? 'IN' : 'OUT'
  const epNum = typeof endpoint === 'number' ? endpoint & 0x0f : null
  const isCompletion = typeof info === 'number' ? (info & 0x01) === 0x01 : null

  return {
    headerLen,
    irpId: typeof irpId === 'bigint' ? `0x${irpId.toString(16)}` : null,
    status,
    func,
    info,
    isCompletion,
    bus,
    device,
    endpoint,
    epNum,
    dir,
    transfer,
    transferName: typeof transfer === 'number' ? transferName(transfer) : null,
    dataLen,
    payload
  }
}

async function main() {
  const args = process.argv.slice(2)
  const fileArg = args.find((a) => !a.startsWith('--'))
  const filePath = fileArg
    ? path.resolve(fileArg)
    : path.resolve('captures', 'laydata.pcapng')

  const maxSamples = Number((args.find((a) => a.startsWith('--maxSamples=')) || '').split('=')[1] || 80)
  const minPayload = Number((args.find((a) => a.startsWith('--minPayload=')) || '').split('=')[1] || 1)
  const focusPort = Number((args.find((a) => a.startsWith('--focusPort=')) || '').split('=')[1] || 0)

  const patterns = ['DCIM', '100MEDIA', '.JPG', '.JPEG', '.MP4', '.MOV', 'DJI', 'MISC', 'THM', 'thumb', 'index']
  const netNeedles = [
    'GET ',
    'POST ',
    'HTTP/1.1',
    'RTSP/',
    'DESCRIBE ',
    'SETUP ',
    'TEARDOWN ',
    'USER ',
    'PASS ',
    'SYST',
    'PWD',
    'TYPE ',
    'CWD ',
    'LIST',
    'MLSD',
    'RETR ',
    'STOR ',
    '220 ',
    '230 ',
    '331 ',
    'dji',
    'DJI'
  ]

  const summary = {
    filePath,
    interfaces: [],
    blocks: { total: 0, idb: 0, epb: 0, other: 0 },
    packets: { total: 0, usbpcap: 0, bulk: 0, bulkIn: 0, bulkOut: 0 },
    endpoints: {},
    net: {
      ethernetFrames: 0,
      ipv4: 0,
      ipv6: 0,
      tcp: 0,
      udp: 0,
      tcpPorts: {},
      udpPorts: {},
      conversations: {},
      signatures: {},
      signatureSamples: []
    },
    samples: []
  }

  const interfaces = []
  let buffer = Buffer.alloc(0)

  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })

  for await (const chunk of stream) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

    while (buffer.length >= 12) {
      const blockType = u32le(buffer, 0)
      const blockLen = u32le(buffer, 4)
      if (blockLen < 12 || blockLen > 128 * 1024 * 1024) {
        throw new Error(`Invalid block length: ${blockLen}`)
      }
      if (buffer.length < blockLen) break

      const block = buffer.subarray(0, blockLen)
      buffer = buffer.subarray(blockLen)

      summary.blocks.total++

      // Block format: [type u32][totalLen u32][body ...][totalLen u32]
      // Body begins at offset 8.
      if (blockType === 0x00000001) {
        summary.blocks.idb++
        if (block.length >= 20) {
          const linktype = block.readUInt16LE(8)
          const snaplen = block.readUInt32LE(12)
          interfaces.push({ linktype, snaplen })
        } else {
          interfaces.push({ linktype: null, snaplen: null })
        }
      } else if (blockType === 0x00000006) {
        summary.blocks.epb++
        if (block.length < 32) continue

        const interfaceId = block.readUInt32LE(8)
        const capLen = block.readUInt32LE(20)
        if (capLen <= 0) continue

        const pktDataStart = 28
        const capLenPadded = (capLen + 3) & ~3
        const pktDataEndPadded = pktDataStart + capLenPadded
        if (pktDataEndPadded > block.length - 4) continue

        const packetData = block.subarray(pktDataStart, pktDataStart + capLen)
        summary.packets.total++

        const iface = interfaces[interfaceId] || { linktype: null }
        if (iface.linktype !== 249) continue

        const parsed = parseUsbpcap(packetData)
        if (!parsed) continue

        summary.packets.usbpcap++

        const epKey = `${parsed.transferName}:${parsed.dir}:0x${(parsed.endpoint ?? 0).toString(16).padStart(2, '0')}`
        summary.endpoints[epKey] = (summary.endpoints[epKey] || 0) + 1

        const payloadLen = parsed.payload.length
        const isBulk = parsed.transfer === 3
        if (isBulk) {
          summary.packets.bulk++
          if (parsed.dir === 'IN') summary.packets.bulkIn++
          else summary.packets.bulkOut++
        }

        // Decode embedded Ethernet/IP frames over USB (commonly via RNDIS)
        if (isBulk && (parsed.endpoint === 0x08 || parsed.endpoint === 0x81) && parsed.payload.length >= 16) {
          const rndis = tryExtractRndisEthernet(parsed.payload)
          const eth = rndis?.eth
          if (eth) {
            summary.net.ethernetFrames++
            const ethType = eth.readUInt16BE(12)

            if (ethType === 0x0800) {
              // IPv4
              if (eth.length >= 14 + 20) {
                summary.net.ipv4++
                const ihl = (eth[14] & 0x0f) * 4
                const totalLen = eth.readUInt16BE(16)
                const proto = eth[23]
                const srcIp = ipv4ToString(eth, 26)
                const dstIp = ipv4ToString(eth, 30)

                const l4Off = 14 + ihl
                const ipEnd = Math.min(eth.length, 14 + totalLen)
                if (l4Off + 4 <= ipEnd) {
                  if (proto === 6 && l4Off + 20 <= ipEnd) {
                    // TCP
                    summary.net.tcp++
                    const srcPort = eth.readUInt16BE(l4Off)
                    const dstPort = eth.readUInt16BE(l4Off + 2)
                    bump(summary.net.tcpPorts, String(srcPort))
                    bump(summary.net.tcpPorts, String(dstPort))

                    const dataOff = ((eth[l4Off + 12] >> 4) & 0x0f) * 4
                    const tcpPayloadOff = l4Off + dataOff
                    if (tcpPayloadOff < ipEnd) {
                      const tcpPayload = eth.subarray(tcpPayloadOff, ipEnd)
                      const sig = tcpPayload.length > 0 ? findAsciiNeedle(tcpPayload, netNeedles) : null
                      if (sig) bump(summary.net.signatures, sig)
                      const convKey = `${srcIp}:${srcPort} > ${dstIp}:${dstPort}`
                      bump(summary.net.conversations, convKey, tcpPayload.length)

                      const isFocused = focusPort > 0 && (srcPort === focusPort || dstPort === focusPort)
                      if ((sig || isFocused) && summary.net.signatureSamples.length < 60) {
                        summary.net.signatureSamples.push({
                          conv: convKey,
                          sig: sig || null,
                          tcpLen: tcpPayload.length,
                          payloadHeadHex: hex(tcpPayload, 96),
                          payloadAscii: asciiSnippet(tcpPayload, 220)
                        })
                      }
                    }
                  } else if (proto === 17 && l4Off + 8 <= ipEnd) {
                    // UDP
                    summary.net.udp++
                    const srcPort = eth.readUInt16BE(l4Off)
                    const dstPort = eth.readUInt16BE(l4Off + 2)
                    bump(summary.net.udpPorts, String(srcPort))
                    bump(summary.net.udpPorts, String(dstPort))
                    const udpPayloadOff = l4Off + 8
                    if (udpPayloadOff < ipEnd) {
                      const udpPayload = eth.subarray(udpPayloadOff, ipEnd)
                      const sig = udpPayload.length > 0 ? findAsciiNeedle(udpPayload, netNeedles) : null
                      if (sig) bump(summary.net.signatures, sig)
                      const convKey = `${srcIp}:${srcPort} > ${dstIp}:${dstPort}`
                      bump(summary.net.conversations, convKey, udpPayload.length)
                    }
                  }
                }
              }
            } else if (ethType === 0x86dd) {
              summary.net.ipv6++
            }
          }
        }

        if (payloadLen < minPayload) continue

        let matched = null
        const ascii = asciiSnippet(parsed.payload, 400)
        for (const p of patterns) {
          if (ascii.includes(p)) {
            matched = p
            break
          }
        }

        const looksLikeProtocol = payloadLen >= 16

        if ((matched || (isBulk && looksLikeProtocol)) && summary.samples.length < maxSamples) {
          summary.samples.push({
            interfaceId,
            transfer: parsed.transferName,
            dir: parsed.dir,
            endpoint: parsed.endpoint,
            irpId: parsed.irpId,
            bus: parsed.bus,
            device: parsed.device,
            dataLen: parsed.dataLen,
            payloadLen,
            match: matched,
            payloadHeadHex: hex(parsed.payload, 96),
            payloadAscii: asciiSnippet(parsed.payload, 200)
          })
        }
      } else {
        summary.blocks.other++
      }
    }
  }

  summary.interfaces = interfaces

  const outPath = path.resolve('captures', 'laydata.summary.json')
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8')

  console.log(`Wrote ${outPath}`)
  console.log(
    JSON.stringify(
      {
        blocks: summary.blocks,
        packets: summary.packets,
        topEndpoints: topN(summary.endpoints, 20),
        net: {
          ethernetFrames: summary.net.ethernetFrames,
          ipv4: summary.net.ipv4,
          ipv6: summary.net.ipv6,
          tcp: summary.net.tcp,
          udp: summary.net.udp,
          topTcpPorts: topN(summary.net.tcpPorts, 15),
          topUdpPorts: topN(summary.net.udpPorts, 15),
          topSignatures: topN(summary.net.signatures, 15),
          topConversationsByBytes: topN(summary.net.conversations, 12)
        }
      },
      null,
      2
    )
  )
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
