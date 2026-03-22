/**
 * DJI packet helpers using the CRC and sequence rules provided by user.
 */

function hexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '').toLowerCase()
  const out = []
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16))
  }
  return out
}

function bytesToHex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// CRC from user formula:
// crc = 0x3692, poly = 0x8408, process packet bytes before CRC.
function crc16Custom(data) {
  let crc = 0x3692
  const poly = 0x8408

  for (const b of data) {
    crc ^= b
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ poly
      } else {
        crc >>= 1
      }
      crc &= 0xffff
    }
  }

  return crc
}

function appendPacketCrc(packetWithoutCrc) {
  const crc = crc16Custom(packetWithoutCrc)
  return [...packetWithoutCrc, crc & 0xff, (crc >> 8) & 0xff]
}

// Sequence in current captures is byte 7-8 (0-index: 6 and 7), little-endian.
function extractSeqFromPacket(packetHex) {
  const bytes = hexToBytes(packetHex)
  if (bytes.length < 8) return null
  return bytes[6] | (bytes[7] << 8)
}

function getLastSequence(packetList) {
  for (let i = packetList.length - 1; i >= 0; i--) {
    const seq = extractSeqFromPacket(packetList[i])
    if (seq != null) return seq
  }
  return 0
}

function buildPacketFromTemplate(templatePrefix, seq, templateTail) {
  const seqLow = seq & 0xff
  const seqHigh = (seq >> 8) & 0xff
  const raw = [...templatePrefix, seqLow, seqHigh, ...templateTail]
  return bytesToHex(appendPacketCrc(raw))
}

function generateSequentialPackets(templatePrefix, templateTail, count, startSeq) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push(buildPacketFromTemplate(templatePrefix, (startSeq + i) & 0xffff, templateTail))
  }
  return out
}

const packets = {
  'get-device-info': [
    '550e04662a1f437d40000100de05', // Ví dụ packet 1
    '550d04332a0310274000018639', // Ví dụ packet 2
    '5514046d2a28112740004aea0702061211178df7', // Ví dụ packet 3
    '550d04330a03122740000c6897',  // Ví dụ packet 4
    '550e04662a2813274000510159af',
    '550d04332a03142740000e61ec',
    '551104920a0315274003df01000000b7a8',
    '550d04332a0316274000011e02',
    '550f04a22a0317274003e5000073a2',
    '550f04a22a0318274003e9ffff9cee',
    '550d04332a0319274000ff1376',
    '550f04a22a031a274003e50100e495'
  ]
}

const lastGetDeviceInfoSeq = getLastSequence(packets['get-device-info'])
const startSeq = (lastGetDeviceInfoSeq + 1) & 0xffff

// Matches user example format: 55 0d 04 33 2a 03 [seqL] [seqH] 40 00 [cmd] [crcL] [crcH]
const periodicPrefix = [0x55, 0x0d, 0x04, 0x33, 0x2a, 0x03]

packets['heartbeat-log-message'] = generateSequentialPackets(
  periodicPrefix,
  [0x40, 0x00, 0x0e],
  8,
  startSeq
)

packets['version-inquiry'] = generateSequentialPackets(
  periodicPrefix,
  [0x40, 0x00, 0x01],
  4,
  (startSeq + 8) & 0xffff
)

// change-mode uses cmd 0x18 and payload 0x01.
packets['change-mode'] = generateSequentialPackets(
  [0x55, 0x0e, 0x04, 0x66, 0x2a, 0xf1],
  [0x40, 0x0a, 0x18, 0x01],
  4,
  (startSeq + 12) & 0xffff
)

export { crc16Custom, extractSeqFromPacket, generateSequentialPackets, getLastSequence }
export default packets;