"""Search for text log encoding in DJI DAT file."""
import mmap, sys

path = sys.argv[1] if len(sys.argv) > 1 else r"samplefile\FLY002.DAT"
needle = b'INFO:'

with open(path, 'rb') as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)

    idx = mm.find(needle)
    if idx != -1:
        print(f'plain text: offset={idx}')

    found = []
    for key in range(256):
        enc = bytes(b ^ key for b in needle)
        idx = mm.find(enc)
        if idx != -1:
            mm.seek(max(0, idx - 30))
            ctx = mm.read(80)
            xd = bytes(b ^ key for b in ctx)
            printable = sum(1 for b in xd if 32 <= b < 127)
            if printable / len(xd) > 0.55:
                found.append((key, idx, xd))

    mm.close()

if found:
    for key, idx, xd in found[:5]:
        print(f'XOR 0x{key:02X}: offset={idx}')
        print(f'  decoded: {xd[:60]}')
else:
    print('Not found with any single-byte XOR key')
    print('-> Text may use rolling XOR or different encoding')
