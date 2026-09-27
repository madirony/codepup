// 대화 기록 파일(~/.claude/projects/*/<세션>.jsonl)로 지금 열려 있는 세션을 찾습니다.
// 훅 · 상태 표시줄 설정을 실시간으로 다시 읽지 않는 옛 버전에서도 이미 열린 세션이 보드에 뜨게 하려는 용도예요.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_BYTES = 64 * 1024;

function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// 파일 끝에서부터 sessionId 와 cwd 가 들어 있는 줄을 찾음
function parseTail(text) {
  const lines = text.split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 잘려서 시작한 첫 줄 등
    }
    const id = obj.sessionId || obj.session_id;
    if (id && obj.cwd) return { session_id: id, cwd: obj.cwd };
  }
  return null;
}

/**
 * 최근 withinMs 안에 기록이 갱신된 세션 목록
 * @returns {{session_id:string, cwd:string, transcript_path:string, mtime:number}[]}
 */
function scanActive({ home = os.homedir(), withinMs = 3 * 60 * 1000, now = Date.now() } = {}) {
  const root = path.join(home, '.claude', 'projects');
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const dir of projects) {
    const full = path.join(root, dir.name);
    let files = [];
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(full, f);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (now - mtimeMs > withinMs) continue;
        const info = parseTail(readTail(file));
        if (info) out.push({ ...info, transcript_path: file, mtime: Math.round(mtimeMs) });
      } catch {
        // 읽는 도중 지워진 파일 등은 건너뜀
      }
    }
  }
  return out;
}

module.exports = { scanActive, parseTail };
