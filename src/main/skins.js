// 스킨 = 표정 이미지 + 소리 + 목소리 설정을 묶은 폴더 (skin.json).
// 앱에 들어 있는 스킨(assets/skins)과 사용자가 불러온 스킨(userData/skins)을 함께 다룹니다.
const fs = require('fs');
const path = require('path');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const SOUND_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);
const MAX_FILE = 15 * 1024 * 1024;
const MAX_FILES = 80;

function slug(name) {
  const s = String(name || 'skin').toLowerCase().replace(/[^a-z0-9가-힣_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 40) || 'skin';
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

// skin.json 이 없는 폴더도 파일 이름(default.png, happy.png, greet.mp3 …)으로 스킨을 만들어 줌
function inferManifest(dir, name) {
  const images = {};
  const sounds = {};
  for (const f of fs.readdirSync(dir)) {
    const ext = path.extname(f).toLowerCase();
    const key = path.basename(f, ext);
    if (IMAGE_EXT.has(ext)) images[key] = f;
    else if (SOUND_EXT.has(ext)) sounds[key] = [f];
  }
  if (!images.default) return null;
  return { name, voice: { type: Object.keys(sounds).length ? 'files' : 'babble' }, images, sounds };
}

function safeRel(p) {
  const n = path.normalize(String(p)).replace(/^([/\\])+/, '');
  return n.startsWith('..') ? null : n;
}

function cleanManifest(m, id, source) {
  const images = {};
  for (const [k, v] of Object.entries(m.images || {})) {
    const r = safeRel(v);
    if (r) images[k] = r;
  }
  const sounds = {};
  for (const [k, v] of Object.entries(m.sounds || {})) {
    const arr = (Array.isArray(v) ? v : [v]).map(safeRel).filter(Boolean);
    if (arr.length) sounds[k] = arr;
  }
  return {
    id,
    source,
    name: String(m.name || id).slice(0, 40),
    description: String(m.description || '').slice(0, 120),
    voice: m.voice && typeof m.voice === 'object' ? { type: m.voice.type === 'files' ? 'files' : 'babble', pitch: Number(m.voice.pitch) || 1 } : { type: 'babble', pitch: 1 },
    images,
    sounds,
    expressions: Array.isArray(m.expressions) ? m.expressions.filter((e) => images[e]) : [],
    defaultName: m.defaultName ? String(m.defaultName).slice(0, 20) : '',
    catchphrase: m.catchphrase ? String(m.catchphrase).slice(0, 20) : '',
    phrases: Array.isArray(m.phrases) ? m.phrases.map((x) => String(x).slice(0, 40)).slice(0, 50) : [],
    // 렌더러에서 쓰는 URL 앞부분
    base: source === 'bundled' ? `skins/${id}/` : `user-skins/${id}/`,
  };
}

class Skins {
  constructor({ bundledDir, userDir }) {
    this.bundledDir = bundledDir;
    this.userDir = userDir;
    fs.mkdirSync(userDir, { recursive: true });
  }

  list() {
    const out = [];
    const scan = (root, source) => {
      let names = [];
      try {
        names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return;
      }
      for (const id of names.sort()) {
        const m = readManifest(path.join(root, id));
        if (m && m.images && m.images.default) out.push(cleanManifest(m, id, source));
      }
    };
    scan(this.bundledDir, 'bundled');
    scan(this.userDir, 'user');
    return out;
  }

  get(id) {
    const all = this.list();
    return all.find((s) => s.id === id) || all.find((s) => s.id === 'chihuahua') || all[0] || null;
  }

  // 폴더를 통째로 복사해서 스킨으로 등록
  import(srcDir) {
    const name = path.basename(srcDir);
    const manifest = readManifest(srcDir) || inferManifest(srcDir, name);
    if (!manifest || !manifest.images || !manifest.images.default) {
      return { ok: false, error: 'skin.json 이나 default.png 가 있는 폴더를 골라 주세요' };
    }
    let id = slug(manifest.name || name);
    if (fs.existsSync(path.join(this.bundledDir, id))) id = `${id}-custom`;
    const dest = path.join(this.userDir, id);
    fs.rmSync(dest, { recursive: true, force: true });
    let count = 0;
    const copy = (rel) => {
      const from = path.join(srcDir, rel);
      const ext = path.extname(rel).toLowerCase();
      if (!IMAGE_EXT.has(ext) && !SOUND_EXT.has(ext)) return;
      const st = fs.statSync(from);
      if (!st.isFile() || st.size > MAX_FILE || ++count > MAX_FILES) return;
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.copyFileSync(from, path.join(dest, rel));
    };
    const clean = cleanManifest(manifest, id, 'user');
    for (const f of Object.values(clean.images)) {
      try {
        copy(f);
      } catch {
        // 빠진 파일은 건너뜀
      }
    }
    for (const arr of Object.values(clean.sounds)) {
      for (const f of arr) {
        try {
          copy(f);
        } catch {
          // 빠진 파일은 건너뜀
        }
      }
    }
    fs.writeFileSync(path.join(dest, 'skin.json'), JSON.stringify({ ...manifest, name: clean.name }, null, 2));
    return { ok: true, id };
  }

  remove(id) {
    const dir = path.join(this.userDir, path.basename(id));
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

module.exports = { Skins, slug, cleanManifest, inferManifest };
