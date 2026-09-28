import cairosvg
from PIL import Image
SQ = 'M512 40 C 840 40 984 184 984 512 C 984 840 840 984 512 984 C 184 984 40 840 40 512 C 40 184 184 40 512 40 Z'
def dog(v):
    # 달리는 치와와: 큰 박쥐 귀 · 사과 머리 · 짧은 주둥이 · 가는 다리 · 위로 말린 꼬리
    legs = {
      1: '<path d="M430 610 L360 700" /><path d="M470 615 L500 720" /><path d="M620 610 L700 690" /><path d="M590 615 L560 725" />',
      2: '<path d="M440 610 L380 715" /><path d="M470 615 L470 725" /><path d="M620 610 L690 700" /><path d="M600 615 L610 728" />',
    }[v]
    return f'''
<g stroke="#fff" stroke-width="44" stroke-linecap="round" fill="none">{legs}</g>
<g fill="#fff">
  <!-- body -->
  <ellipse cx="520" cy="560" rx="165" ry="95"/>
  <!-- tail curled up -->
  <path d="M370 540 Q300 470 330 400 Q350 360 385 380 Q400 395 385 415 Q365 450 405 505 Z"/>
  <!-- neck -->
  <path d="M600 500 L690 440 L720 560 L620 600 Z"/>
  <!-- head (apple) -->
  <circle cx="710" cy="440" r="110"/>
  <!-- snout -->
  <ellipse cx="808" cy="478" rx="58" ry="44"/>
  <!-- ears: big, flared -->
  <path d="M628 392 L520 232 Q512 205 540 210 L712 328 Z"/>
  <path d="M728 338 L836 188 Q856 170 862 196 L812 372 Z"/>
</g>
<g fill="#3a2fb0">
  <ellipse cx="740" cy="430" rx="20" ry="24"/>
  <circle cx="860" cy="466" r="15"/>
</g>
<circle cx="748" cy="421" r="7" fill="#fff"/>
<g fill="#3a2fb0" opacity=".3"><path d="M556 240 L672 330 L650 345 Z"/><path d="M836 222 L800 340 L784 330 Z"/></g>
'''
def icon(v):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6a5cff"/><stop offset="1" stop-color="#3a2fb0"/></linearGradient></defs>
<path d="{SQ}" fill="url(#bg)"/>
<g stroke="#fff" stroke-width="28" stroke-linecap="round" opacity=".5"><line x1="110" y1="470" x2="250" y2="470"/><line x1="150" y1="550" x2="260" y2="550"/><line x1="130" y1="630" x2="220" y2="630"/></g>
{dog(v)}
<circle cx="820" cy="760" r="0"/>
<circle cx="230" cy="250" r="72" fill="#ff5a6e" stroke="#fff" stroke-width="20"/>
</svg>'''
imgs=[]
for v in (1,2):
    cairosvg.svg2png(bytestring=icon(v).encode(), write_to=f'b{v}.png', output_width=1024, output_height=1024)
    imgs.append(Image.open(f'b{v}.png').convert('RGBA'))
sheet = Image.new('RGBA', (760, 380), (236,232,235,255))
for i, im in enumerate(imgs):
    x=i*380
    sheet.alpha_composite(im.resize((256,256), Image.LANCZOS), (x+62, 16))
    for j,sz in enumerate([64,32,16]):
        sheet.alpha_composite(im.resize((sz,sz), Image.LANCZOS), (x+80+j*90+(64-sz)//2, 295+(64-sz)//2))
sheet.save('b-sheet.png'); print('ok')
