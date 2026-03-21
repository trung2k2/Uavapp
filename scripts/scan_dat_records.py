"""Scan DJI WM220 DAT file to identify record types and find text/GPS records."""
import struct, sys, os

def scan(path, max_records=2000):
    with open(path, 'rb') as f:
        data = f.read()

    print(f"File size: {len(data):,}")
    
    # Find DJI_LOG_V3 marker
    log_v3_pos = data.find(b'DJI_LOG_V3')
    print(f"DJI_LOG_V3 at offset: {log_v3_pos} (0x{log_v3_pos:X})")
    
    # Records start after the two 128-byte header blocks = offset 256
    pos = 256
    type_counts = {}
    text_samples = {}
    
    n = 0
    while pos < len(data) - 4 and n < max_records:
        if data[pos] != 0x55:
            # Try to resync
            next55 = data.find(b'\x55', pos+1)
            if next55 == -1:
                break
            pos = next55
            continue
        
        total_len = struct.unpack_from('<H', data, pos+1)[0]
        if total_len < 5 or pos + total_len > len(data):
            pos += 1
            continue
        
        rec_type = data[pos+3]
        payload = data[pos+4 : pos+total_len-1]
        crc_byte = data[pos+total_len-1]
        
        type_counts[rec_type] = type_counts.get(rec_type, 0) + 1
        
        # Check if payload contains readable ASCII text (for text record discovery)
        if rec_type not in text_samples:
            printable = sum(1 for b in payload if 32 <= b < 127)
            if printable > len(payload) * 0.6 and len(payload) > 10:
                try:
                    text = payload.decode('ascii', errors='replace')
                    text_samples[rec_type] = f"len={total_len} text={text[:80]!r}"
                except:
                    pass
        
        # For GPS-like records: look for doubles that could be lat/lon
        if total_len >= 20 and rec_type not in text_samples:
            for off in range(0, min(len(payload)-7, 32), 8):
                try:
                    val = struct.unpack_from('<d', payload, off)[0]
                    if 20 < abs(val) < 180:  # plausible lat/lon range
                        if rec_type not in text_samples:
                            text_samples[rec_type] = f"len={total_len} possible_coord@{off}: {val:.6f}"
                        break
                except:
                    pass
        
        pos += total_len
        n += 1
    
    print(f"\nScanned {n} records. Record type counts:")
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1])[:30]:
        note = text_samples.get(t, "")
        print(f"  type=0x{t:02X} ({t:3d})  count={c:6d}  {note}")

if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else r"samplefile\FLY002.DAT"
    scan(path)
