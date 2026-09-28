// macOS 터미널 제어: 세션이 돌아가는 터미널 창으로 이동하고, 닫힌 세션을 새 창으로 다시 엽니다.
const { execFile } = require('child_process');

// TERM_PROGRAM 값 → 앱 이름
const APPS = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm',
  vscode: 'Visual Studio Code',
  ghostty: 'Ghostty',
  WarpTerminal: 'Warp',
  WezTerm: 'WezTerm',
  cursor: 'Cursor',
};

const asString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Claude Code 가 자식 프로세스에 붙이는 표시. 이게 이어지면 새로 연 claude 가 자기를 '하위 세션'으로 여겨
// 대화 기록을 저장하지 않아요 (⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker).
const CHILD_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT'];

function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const k of CHILD_MARKERS) delete out[k];
  return out;
}

function osascript(lines) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve({ ok: false, error: 'macOS 에서만 지원해요' });
    const args = [];
    for (const l of lines) args.push('-e', l);
    execFile('osascript', args, { timeout: 8000, env: cleanEnv() }, (err, stdout) => {
      if (err) resolve({ ok: false, error: String(err.message || err).slice(0, 200) });
      else resolve({ ok: true, out: String(stdout).trim() });
    });
  });
}

// 세션을 다시 여는 셸 명령
function resumeCommand(session, { remoteControl = true, skipPermissions = false, extraArgs = '' } = {}) {
  const parts = ['claude', '--resume', shQuote(session.id)];
  if (remoteControl) parts.push('--rc');
  if (skipPermissions) parts.push('--dangerously-skip-permissions');
  if (extraArgs && /^[\w\s=.:/@,+-]*$/.test(extraArgs)) parts.push(extraArgs.trim());
  return `cd ${shQuote(session.cwd || '~')} && env -u ${CHILD_MARKERS.join(' -u ')} ${parts.join(' ')}`;
}

async function focusSession(session) {
  const tty = session.tty ? (session.tty.startsWith('/dev/') ? session.tty : `/dev/${session.tty}`) : '';
  const app = APPS[session.term] || null;
  if (tty && (!app || app === 'Terminal')) {
    const r = await osascript([
      'tell application "Terminal"',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      `      if tty of t is ${asString(tty)} then`,
      '        set selected of t to true',
      '        set index of w to 1',
      '        activate',
      '        return "found"',
      '      end if',
      '    end repeat',
      '  end repeat',
      'end tell',
      'return "missing"',
    ]);
    if (r.ok && r.out === 'found') return r;
  }
  if (tty && app === 'iTerm') {
    const r = await osascript([
      'tell application "iTerm"',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      '      repeat with s in sessions of t',
      `        if tty of s is ${asString(tty)} then`,
      '          select w',
      '          select t',
      '          select s',
      '          activate',
      '          return "found"',
      '        end if',
      '      end repeat',
      '    end repeat',
      '  end repeat',
      'end tell',
      'return "missing"',
    ]);
    if (r.ok && r.out === 'found') return r;
  }
  if (app) return osascript([`tell application ${asString(app)} to activate`]);
  return { ok: false, error: '터미널을 찾지 못했어요' };
}

// 닫힌 세션 다시 열기: 쓰고 있던 터미널 창에 탭으로 추가 (창이 없으면 새 창)
// macOS 터미널은 탭을 만드는 AppleScript 명령이 없어서 ⌘T 를 보내요 → 손쉬운 사용 권한이 없으면 새 창으로 열어요.
function iTermScript(cmd, tabs) {
  return [
    'tell application "iTerm"',
    '  activate',
    ...(tabs
      ? ['  if (count of windows) > 0 then', '    tell current window to create tab with default profile', '  else', '    create window with default profile', '  end if']
      : ['  create window with default profile']),
    `  tell current session of current window to write text ${asString(cmd)}`,
    'end tell',
  ];
}

function terminalTabScript(cmd) {
  return [
    'tell application "Terminal"',
    '  if (count of windows) = 0 then',
    `    do script ${asString(cmd)}`,
    '    activate',
    '    return "window"',
    '  end if',
    '  activate',
    'end tell',
    'tell application "System Events" to keystroke "t" using command down',
    'delay 0.4',
    'tell application "Terminal"',
    `  do script ${asString(cmd)} in selected tab of front window`,
    'end tell',
    'return "tab"',
  ];
}

async function openSessions(sessions, opts = {}) {
  const results = [];
  const tabs = opts.tabs !== false;
  for (const s of sessions) {
    const cmd = resumeCommand(s, opts);
    const useITerm = opts.terminal === 'iTerm' || (opts.terminal !== 'Terminal' && s.term === 'iTerm.app');
    let r;
    if (useITerm) r = await osascript(iTermScript(cmd, tabs));
    else if (tabs) {
      r = await osascript(terminalTabScript(cmd));
      if (!r.ok) {
        // 손쉬운 사용 권한이 없으면 ⌘T 를 못 보내요 → 새 창으로
        r = await osascript([`tell application "Terminal" to do script ${asString(cmd)}`, 'tell application "Terminal" to activate']);
        if (r.ok) r.note = '탭으로 열려면 시스템 설정 › 개인정보 보호 › 손쉬운 사용에서 CodePup 을 허용해 주세요';
      }
    } else r = await osascript([`tell application "Terminal" to do script ${asString(cmd)}`, 'tell application "Terminal" to activate']);
    results.push({ id: s.id, ...r });
  }
  return results;
}

// claude 가 돌고 있는 터미널(tty) 목록 → 창을 닫아 사라진 세션 정리에 사용 (알 수 없으면 null)
function aliveClaudeTtys() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'tty=,command='], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const set = new Set();
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\S+)\s+(.*)$/.exec(line);
        if (!m || m[1] === '?' || m[1] === '??') continue;
        if (/(^|[\s/])claude(\s|$)/.test(m[2])) set.add(m[1].replace(/^\/dev\//, ''));
      }
      resolve(set);
    });
  });
}

module.exports = { focusSession, openSessions, resumeCommand, aliveClaudeTtys, cleanEnv, shQuote, asString, APPS };
