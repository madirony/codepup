// userData 폴더의 JSON 파일에 설정과 펫 상태를 저장합니다.
const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS } = require('./defaults');

function mergeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.tray = { ...DEFAULT_SETTINGS.tray, ...((raw && raw.tray) || {}) };
  s.customImages = { ...((raw && raw.customImages) || {}) };
  s.customSounds = { ...((raw && raw.customSounds) || {}) };
  if (!Array.isArray(s.phrases)) s.phrases = DEFAULT_SETTINGS.phrases;
  return s;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'codepup-data.json');
    this.mediaDir = path.join(dir, 'user-media');
    this.timer = null;
    fs.mkdirSync(this.mediaDir, { recursive: true });
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // 첫 실행이거나 손상된 파일이면 기본값으로 시작
    }
    this.settings = mergeSettings(raw.settings);
    this.pet = raw.pet || null;
    this.sessionsHistory = Array.isArray(raw.sessionsHistory) ? raw.sessionsHistory : [];
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 1500);
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    const data = JSON.stringify(
      { version: 2, settings: this.settings, pet: this.pet, sessionsHistory: this.sessionsHistory },
      null,
      2
    );
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] save failed', err);
    }
  }
}

module.exports = { Store, mergeSettings };
