"""Generate the original pixel glass/fish app icon using Python's standard library."""
from pathlib import Path
import struct,zlib,subprocess,tempfile
root=Path(__file__).resolve().parent.parent
palette={'bg':(213,241,230,255),'ink':(33,79,96,255),'glass':(243,252,237,255),'water':(86,183,193,255),'deep':(46,132,160,255),'fish':(240,155,80,255),'white':(255,248,221,255)}
def color(x,y):
 if (x<2 or x>29 or y<2 or y>29) and ((x<5 or x>26) and (y<5 or y>26)):return (0,0,0,0)
 c=palette['bg']
 if 7<=y<=26:
  left=6+(y-7)//7;right=25-(y-7)//7
  if left<=x<=right:
   c=palette['ink'] if x in (left,right) or y in (7,26) else palette['glass']
   if left<x<right and 14<=y<=24:c=palette['water'] if y<20 else palette['deep']
   if x==left+2 and 10<=y<=14:c=palette['white']
 if 11<=x<=21 and 18<=y<=21:
  if (14<=x<=20 and 18<=y<=21) or (11<=x<=13 and y in (18,21)):
   c=palette['fish'] if x not in (16,19) else palette['white']
   if x==20 and y==19:c=palette['ink']
 return c
def png(n):
 raw=b''.join(b'\0'+b''.join(bytes(color(x*32//n,y*32//n)) for x in range(n)) for y in range(n))
 def chunk(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',n,n,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
with tempfile.TemporaryDirectory(prefix='sip-icon-') as temp:
 icons=Path(temp)/'Sip.iconset';icons.mkdir()
 for n in [16,32,128,256,512]:
  (icons/f'icon_{n}x{n}.png').write_bytes(png(n));(icons/f'icon_{n}x{n}@2x.png').write_bytes(png(n*2))
 (root/'assets/icon.png').write_bytes(png(512))
 subprocess.run(['iconutil','-c','icns',str(icons),'-o',str(root/'assets/icon.icns')],check=True)
