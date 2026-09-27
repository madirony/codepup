"""기본 스킨 '블랙탄 치와와' 이미지를 SVG로 그려 PNG로 내보냅니다.

사용법:  pip install cairosvg pillow && python3 tools/draw_chihuahua.py
출력:    assets/skins/chihuahua/*.png, build/icon.png
"""
import os
import cairosvg
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'skins', 'chihuahua')
RIM = '#6b5d73'
INK = '#1d1418'

DEFS = '''<defs>
<radialGradient id="fur" cx="0.38" cy="0.3" r="0.85"><stop offset="0" stop-color="#4d4455"/><stop offset="0.55" stop-color="#2a2430"/><stop offset="1" stop-color="#151118"/></radialGradient>
<radialGradient id="furBody" cx="0.5" cy="0.25" r="0.9"><stop offset="0" stop-color="#433a4a"/><stop offset="1" stop-color="#141016"/></radialGradient>
<radialGradient id="furFar" cx="0.5" cy="0.3" r="0.9"><stop offset="0" stop-color="#2c2631"/><stop offset="1" stop-color="#0f0c11"/></radialGradient>
<radialGradient id="tan" cx="0.45" cy="0.35" r="0.75"><stop offset="0" stop-color="#f7d3a2"/><stop offset="1" stop-color="#d8925a"/></radialGradient>
<radialGradient id="earIn" cx="0.5" cy="0.75" r="0.75"><stop offset="0" stop-color="#ffb9c4"/><stop offset="1" stop-color="#e8889b"/></radialGradient>
<radialGradient id="pupil" cx="0.45" cy="0.6" r="0.65"><stop offset="0" stop-color="#5a3526"/><stop offset="0.5" stop-color="#1c0f0d"/><stop offset="1" stop-color="#050304"/></radialGradient>
<radialGradient id="nose" cx="0.4" cy="0.3" r="0.8"><stop offset="0" stop-color="#4a4048"/><stop offset="1" stop-color="#0d0a0d"/></radialGradient>
<linearGradient id="scarf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffa07c"/><stop offset="1" stop-color="#ee6653"/></linearGradient>
<linearGradient id="bone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff7ea"/><stop offset="1" stop-color="#ecd3b0"/></linearGradient>
</defs>'''

EYES = [dict(cx=236, cy=178, rx=31, ry=38, near=True), dict(cx=316, cy=172, rx=22, ry=31, near=False)]


def star(x, y, s, color='#ffd54a'):
    return (f'<path transform="translate({x} {y}) scale({s})" d="M0 -14 L4 -4 L14 0 L4 4 L0 14 L-4 4 L-14 0 L-4 -4Z" '
            f'fill="{color}" stroke="{INK}" stroke-width="2.5" stroke-linejoin="round"/>')


def eye(e, look):
    cx, cy, rx, ry = e['cx'], e['cy'], e['rx'], e['ry']
    k = 1 if e['near'] else 0.72
    if look == 'closed_happy':
        return f'<path d="M{cx - rx * 0.8} {cy + 6} Q{cx} {cy - ry * 0.8} {cx + rx * 0.8} {cy + 6}" fill="none" stroke="{INK}" stroke-width="{9 * k}" stroke-linecap="round"/>'
    if look == 'closed_sleep':
        return f'<path d="M{cx - rx * 0.8} {cy + 2} Q{cx} {cy + ry * 0.5} {cx + rx * 0.8} {cy + 2}" fill="none" stroke="{INK}" stroke-width="{8 * k}" stroke-linecap="round"/>'
    if look == 'squint':  # > <
        d = rx * 0.6
        if e['near']:
            p = f'M{cx - d} {cy - d} L{cx + d * 0.7} {cy} L{cx - d} {cy + d}'
        else:
            p = f'M{cx + d} {cy - d} L{cx - d * 0.7} {cy} L{cx + d} {cy + d}'
        return f'<path d="{p}" fill="none" stroke="{INK}" stroke-width="{8 * k}" stroke-linecap="round" stroke-linejoin="round"/>'
    if look == 'dizzy':
        r = rx * 0.7
        return (f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="#fff" stroke="{INK}" stroke-width="4"/>'
                f'<path d="M{cx} {cy} m-{r * 0.2} 0 a{r * 0.2} {r * 0.2} 0 1 1 {r * 0.4} 0 a{r * 0.45} {r * 0.45} 0 1 1 -{r * 0.9} 0 '
                f'a{r * 0.7} {r * 0.7} 0 1 1 {r * 1.4} 0" fill="none" stroke="{INK}" stroke-width="{4 * k}" stroke-linecap="round"/>')
    scale = {'alert': 0.72, 'worry': 0.62, 'angry': 0.55, 'half': 0.72, 'sparkle': 0.82}.get(look, 0.78)
    px, py = cx + rx * 0.18, cy + ry * (0.05 if look == 'alert' else 0.12)
    prx, pry = rx * scale, ry * scale * 0.95
    s = f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="#fff" stroke="{INK}" stroke-width="4"/>'
    s += f'<ellipse cx="{px}" cy="{py}" rx="{prx}" ry="{pry}" fill="url(#pupil)"/>'
    if look == 'sparkle':
        s += star(px - prx * 0.3, py - pry * 0.35, 0.85 * k, '#fff')
        s += f'<circle cx="{px + prx * 0.42}" cy="{py + pry * 0.4}" r="{prx * 0.17}" fill="#fff"/>'
    else:
        s += f'<ellipse cx="{px - prx * 0.35}" cy="{py - pry * 0.42}" rx="{prx * 0.42}" ry="{pry * 0.36}" fill="#fff"/>'
        s += f'<circle cx="{px + prx * 0.42}" cy="{py + pry * 0.38}" r="{prx * 0.17}" fill="#fff"/>'
    if look == 'half':  # 졸린 눈꺼풀
        s += (f'<path d="M{cx - rx - 3} {cy - 2} Q{cx} {cy - ry - 6} {cx + rx + 3} {cy - 2} L{cx + rx + 3} {cy - ry - 8} '
              f'L{cx - rx - 3} {cy - ry - 8} Z" fill="#2a2430"/>'
              f'<path d="M{cx - rx} {cy - 2} Q{cx} {cy - 8} {cx + rx} {cy - 2}" fill="none" stroke="{INK}" stroke-width="{5 * k}" stroke-linecap="round"/>')
    return s


def brows(mood):
    s = ''
    for e, rot in zip(EYES, (-14, 10)):
        r = rot
        if mood in ('worry', 'sad'):
            r = -rot * 1.5
        elif mood == 'angry':
            r = rot * -2.2 if e['near'] else rot * -2.2
            r = 24 if e['near'] else -24
        dy = -8 if mood == 'alert' else (6 if mood == 'angry' else 0)
        w = 14 if e['near'] else 10
        x, y = e['cx'] - 2, e['cy'] - e['ry'] - 14 + dy
        s += f'<ellipse cx="{x}" cy="{y}" rx="{w}" ry="{w * 0.6}" fill="url(#tan)" transform="rotate({r} {x} {y})"/>'
    return s


def mouth(kind):
    if kind == 'open':
        return f'<path d="M280 238 Q296 270 312 236 Z" fill="#b8404f" stroke="{INK}" stroke-width="3" stroke-linejoin="round"/>'
    if kind == 'tongue':
        return (f'<path d="M280 238 Q296 270 312 236 Z" fill="#b8404f" stroke="{INK}" stroke-width="3" stroke-linejoin="round"/>'
                f'<path d="M288 252 Q297 276 306 252 Z" fill="#ff8fa0" stroke="#7a2f3a" stroke-width="2"/>')
    if kind == 'wide':
        return f'<path d="M276 236 Q296 284 318 234 Z" fill="#b8404f" stroke="{INK}" stroke-width="3" stroke-linejoin="round"/><path d="M286 258 Q297 274 308 258 Z" fill="#ff8fa0"/>'
    if kind == 'o':
        return f'<ellipse cx="296" cy="246" rx="8" ry="10" fill="#b8404f" stroke="{INK}" stroke-width="3"/>'
    if kind == 'wavy':
        return f'<path d="M280 246 Q288 238 296 246 Q304 238 312 246" fill="none" stroke="{INK}" stroke-width="3.5" stroke-linecap="round"/>'
    if kind == 'chew':
        return f'<path d="M282 240 Q296 250 310 240" fill="none" stroke="{INK}" stroke-width="3.5" stroke-linecap="round"/><ellipse cx="318" cy="236" rx="5" ry="4" fill="#f0c89a" stroke="{INK}" stroke-width="1.5"/>'
    if kind == 'grr':
        return (f'<path d="M280 244 L312 244" stroke="{INK}" stroke-width="3.5" stroke-linecap="round"/>'
                f'<path d="M286 244 l3 -6 l3 6 M300 244 l3 -6 l3 6" fill="#fff" stroke="{INK}" stroke-width="2"/>')
    if kind == 'sleep':
        return f'<path d="M284 238 Q296 246 308 238" fill="none" stroke="{INK}" stroke-width="3.5" stroke-linecap="round"/>'
    return (f'<path d="M276 234 Q286 246 296 236 Q306 246 316 234" fill="none" stroke="{INK}" stroke-width="3.5" stroke-linecap="round"/>'
            f'<path d="M290 242 Q296 256 302 242 Z" fill="#ff8fa0" stroke="{INK}" stroke-width="2"/>')


def tear(x, y, big=False):
    s = 1.6 if big else 1
    return f'<path transform="translate({x} {y}) scale({s})" d="M0 0 q-7 15 0 24 q7 -9 0 -24z" fill="#9fd8ff" stroke="{INK}" stroke-width="2"/>'


EXTRAS = {
    'alert': f'<g transform="translate(408 96) rotate(14)"><rect x="-10" y="-36" width="20" height="44" rx="10" fill="#ffd23f" stroke="{INK}" stroke-width="4"/><circle cx="0" cy="22" r="9" fill="#ffd23f" stroke="{INK}" stroke-width="4"/></g>',
    'question': f'<text x="392" y="128" font-family="Arial" font-weight="900" font-size="62" fill="#8ec5ff" stroke="{INK}" stroke-width="4">?</text>',
    'zzz': f'<text x="394" y="126" font-family="Arial" font-weight="900" font-size="38" fill="#b3a6ff" stroke="{INK}" stroke-width="3">z</text><text x="420" y="92" font-family="Arial" font-weight="900" font-size="26" fill="#b3a6ff" stroke="{INK}" stroke-width="3">z</text>',
    'stars': star(404, 118, 1.5) + star(432, 160, 0.9),
    'note': f'<text x="392" y="130" font-family="Arial" font-weight="900" font-size="52" fill="#ff8fb1" stroke="{INK}" stroke-width="3">♪</text>',
    'anger': f'<g transform="translate(398 104)" stroke="#e8455a" stroke-width="6" stroke-linecap="round" fill="none"><path d="M-14 -4 q10 0 10 -10"/><path d="M4 -14 q0 10 10 10"/><path d="M14 4 q-10 0 -10 10"/><path d="M-4 14 q0 -10 -10 -10"/></g>',
    'sweat': '<path d="M392 150 q9 15 0 24 q-9 -9 0 -24z" fill="#aee0ff" stroke="#1d1418" stroke-width="2.5"/>',
    'crumbs': '<circle cx="330" cy="262" r="4" fill="#f0c89a"/><circle cx="342" cy="252" r="3" fill="#f0c89a"/>',
    'spit': '<circle cx="360" cy="238" r="5" fill="#bfe6ff"/><circle cx="376" cy="226" r="4" fill="#bfe6ff"/><circle cx="372" cy="250" r="3" fill="#bfe6ff"/>',
}

# 표정 정의: (눈, 눈썹, 입, 추가 효과들, 눈물)
EXPRESSIONS = {
    'default': ('open', 'normal', 'smile', [], None),
    'happy': ('closed_happy', 'normal', 'open', ['stars'], None),
    # 글자 모양 표시(!, ?, z, ♪)는 좌우 반전되면 어색해서 이미지에 넣지 않고 펫 이펙트로 띄워요
    'alert': ('alert', 'alert', 'o', [], None),
    'worry': ('worry', 'worry', 'wavy', ['sweat'], None),
    'sleep': ('closed_sleep', 'normal', 'sleep', [], None),
    'run': ('closed_happy', 'normal', 'tongue', [], None),
    'carry': ('worry', 'worry', 'wavy', [], 'small'),
    'dizzy': ('dizzy', 'worry', 'wavy', [], None),
    'eat': ('closed_happy', 'normal', 'wide', ['crumbs'], None),
    'eat2': ('closed_happy', 'normal', 'chew', ['crumbs'], None),
    'hungry': ('worry', 'sad', 'wavy', ['sweat'], None),
    'tired': ('closed_sleep', 'sad', 'wavy', ['sweat'], None),
    'sing': ('closed_happy', 'normal', 'open', [], None),
    'annoyed': ('angry', 'angry', 'grr', ['anger'], None),
    'levelup': ('sparkle', 'alert', 'tongue', ['stars'], None),
    'surprised': ('alert', 'alert', 'o', [], None),
    'drool': ('sparkle', 'normal', 'tongue', [], None),
    'cry': ('closed_sleep', 'sad', 'open', [], 'big'),
    'sneeze': ('squint', 'normal', 'wide', ['spit'], None),
    'sad': ('worry', 'sad', 'wavy', [], None),
}


def chihuahua(name):
    look, mood, m, extras, tears = EXPRESSIONS[name]
    eyes = ''.join(eye(e, look) for e in EYES)
    tear_svg = ''
    if tears:
        tear_svg = tear(214, 214, tears == 'big') + (tear(304, 204, True) if tears == 'big' else '')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 380" width="920" height="760">{DEFS}
<path d="M160 296 Q156 346 168 352 Q182 352 184 298 Z" fill="url(#furFar)" stroke="{RIM}" stroke-width="2.5"/>
<path d="M246 300 Q244 348 256 352 Q270 350 270 300 Z" fill="url(#furFar)" stroke="{RIM}" stroke-width="2.5"/>
<ellipse cx="170" cy="348" rx="11" ry="6" fill="#c98a55"/><ellipse cx="258" cy="349" rx="11" ry="6" fill="#c98a55"/>
<path d="M136 298 Q130 352 146 358 Q162 358 164 300 Z" fill="url(#furBody)" stroke="{RIM}" stroke-width="3"/>
<path d="M222 302 Q218 354 234 360 Q252 358 250 302 Z" fill="url(#furBody)" stroke="{RIM}" stroke-width="3"/>
<path d="M133 332 Q131 356 146 358 Q161 358 162 332 Z" fill="url(#tan)"/><path d="M220 336 Q219 358 234 360 Q250 358 249 336 Z" fill="url(#tan)"/>
<ellipse cx="148" cy="357" rx="15" ry="6" fill="url(#tan)" stroke="{RIM}" stroke-width="2"/><ellipse cx="236" cy="359" rx="15" ry="6" fill="url(#tan)" stroke="{RIM}" stroke-width="2"/>
<path d="M120 276 Q118 226 180 222 Q250 220 272 262 Q282 306 248 322 Q196 336 150 326 Q116 314 120 276 Z" fill="url(#furBody)" stroke="{RIM}" stroke-width="3"/>
<path d="M226 258 Q258 252 266 284 Q264 312 238 320 Q224 292 226 258 Z" fill="url(#tan)" opacity="0.95"/>
<path d="M138 256 Q92 236 98 190 Q104 160 134 166 Q154 174 146 192 Q136 188 128 196 Q122 226 156 240 Z" fill="url(#furBody)" stroke="{RIM}" stroke-width="3" stroke-linejoin="round"/>
<path d="M200 240 Q252 268 316 250 L314 272 Q250 292 202 264 Z" fill="url(#scarf)" stroke="#9a3b33" stroke-width="2.5"/>
<path d="M234 270 L246 304 L260 274 Z" fill="url(#scarf)" stroke="#9a3b33" stroke-width="2.5"/>
<path d="M300 94 Q352 46 394 30 Q404 34 398 48 Q384 106 342 134 Z" fill="url(#furFar)" stroke="{RIM}" stroke-width="3" stroke-linejoin="round"/>
<path d="M310 100 Q354 62 386 48 Q374 98 338 122 Z" fill="url(#earIn)" opacity="0.8"/>
<path d="M180 132 Q118 104 90 38 Q92 26 106 26 Q178 42 236 96 Z" fill="url(#fur)" stroke="{RIM}" stroke-width="3" stroke-linejoin="round"/>
<path d="M186 120 Q134 94 110 44 Q170 60 220 100 Z" fill="url(#earIn)"/>
<path d="M258 74 Q356 74 366 172 Q372 264 262 270 Q158 272 150 182 Q146 76 258 74 Z" fill="url(#fur)" stroke="{RIM}" stroke-width="3"/>
<ellipse cx="236" cy="100" rx="46" ry="14" fill="#fff" opacity="0.10" transform="rotate(-10 236 100)"/>
<path d="M262 226 Q298 204 340 216 Q348 254 302 262 Q262 260 262 226 Z" fill="url(#tan)"/>
<ellipse cx="200" cy="228" rx="21" ry="11" fill="#ff8fa0" opacity="{0.75 if name in ('happy', 'levelup', 'eat', 'eat2') else 0.5}"/>
{brows(mood)}
{eyes}
<path d="M286 214 Q298 206 310 212 Q312 224 298 228 Q284 224 286 214 Z" fill="url(#nose)"/>
<ellipse cx="295" cy="212" rx="4.5" ry="2.8" fill="#fff" opacity="0.6"/>
{mouth(m)}
{tear_svg}
{''.join(EXTRAS[x] for x in extras)}
</svg>'''


def bone():
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 110" width="400" height="220">{DEFS}
<g transform="rotate(-12 100 55)">
<path d="M52 42 Q34 18 22 34 Q10 48 28 56 Q10 64 22 78 Q34 94 52 70 L148 70 Q166 94 178 78 Q190 64 172 56 Q190 48 178 34 Q166 18 148 42 Z"
 fill="url(#bone)" stroke="#8a6a4a" stroke-width="4" stroke-linejoin="round"/>
<path d="M58 50 L142 50" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity="0.7"/>
</g></svg>'''


def render(svg, path, height):
    tmp = path + '.tmp.png'
    cairosvg.svg2png(bytestring=svg.encode(), write_to=tmp, output_height=height * 2)
    im = Image.open(tmp).convert('RGBA')
    os.remove(tmp)
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    # 모든 표정을 같은 캔버스 기준으로 잘라야 표정이 바뀔 때 몸이 튀지 않음 → 공통 bbox 사용
    ims = {n: render(chihuahua(n), os.path.join(OUT, n), 380) for n in EXPRESSIONS}
    body_box = None
    for n, im in ims.items():
        box = im.getbbox()
        body_box = box if body_box is None else (min(body_box[0], box[0]), min(body_box[1], box[1]), max(body_box[2], box[2]), max(body_box[3], box[3]))
    for n, im in ims.items():
        c = im.crop(body_box)
        h = 320
        c = c.resize((round(c.width * h / c.height), h), Image.LANCZOS)
        c.save(os.path.join(OUT, f'{n}.png'), optimize=True)
    b = render(bone(), os.path.join(OUT, 'food'), 110)
    b = b.crop(b.getbbox())
    b.thumbnail((256, 256), Image.LANCZOS)
    b.save(os.path.join(OUT, 'food.png'), optimize=True)

    # 앱 아이콘 1024
    S = 1024
    icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((100, 100, 924, 924), radius=185, fill=255)
    bg = Image.new('RGBA', (S, S))
    d = ImageDraw.Draw(bg)
    for y in range(S):
        t = y / S
        d.line((0, y, S, y), fill=(int(255 - t * 12), int(222 - t * 40), int(196 - t * 40), 255))
    icon.paste(bg, (0, 0), mask)
    face = Image.open(os.path.join(OUT, 'happy.png')).convert('RGBA')
    face.thumbnail((760, 760), Image.LANCZOS)
    icon.alpha_composite(face, ((S - face.width) // 2 - 10, 900 - face.height))
    icon.save(os.path.join(ROOT, 'build', 'icon.png'))
    icon.save(os.path.join(ROOT, 'build', 'icon.icns'))
    print('ok', len(ims), 'expressions →', OUT)


if __name__ == '__main__':
    main()
