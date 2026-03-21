"""Find text records in DJI DAT binary."""
import struct, sys

path = sys.argv[1] if len(sys.argv) > 1 else r"samplefile\FLY002.DAT"
with open(path, 'rb') as f:
    data = f.read()

needle = b'lib_route_init ok'

# Plain text
idx = data.find(needle)
print(f'Plain text "{needle.decode()}": offset={idx}')

# XOR 0x55
xored = bytes(b ^ 0x55 for b in data[:2_000_000])
idx2 = xored.find(needle)
print(f'XOR 0x55:  offset={idx2}')

# Try XOR with other keys
for key in [0x11, 0x22, 0x33, 0x44, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]:
    xored = bytes(b ^ key for b in data[:2_000_000])
    idx3 = xored.find(needle)
    if idx3 != -1:
        print(f'XOR 0x{key:02X}: offset={idx3}')

# Show what's at offset 256 (first record)
print()
print('Bytes at offset 256:', data[256:280].hex(' '))
sync = data[256]
length = struct.unpack_from('<H', data, 257)[0]
unk = data[259]
rtype = data[260]
print(f'sync=0x{sync:02X} length={length} unk=0x{unk:02X} type=0x{rtype:02X}')
payload = data[261: 256+length-1]
print(f'payload ({len(payload)} bytes):', payload[:32].hex(' '))
print(f'payload printable:', payload[:40])
