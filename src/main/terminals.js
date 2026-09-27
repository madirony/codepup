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

function osascript(lines) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve({ ok: false, error: 'macOS 에서만 지원해요' });
    const args = [];
    for (const l of lines) args.push('-e', l);
    execFile('osascript', args, { timeout: 8000 }, (err, stdout) => {
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
  return `cd ${shQuote(session.cwd || '~')} && ${parts.join(' ')}`;
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

// 새 터미널 창에서 세션 다시 열기 (iTerm 을 쓰던 세션은 iTerm 으로)
async function openSessions(sessions, opts = {}) {
  const results = [];
  for (const s of sessions) {
    const cmd = resumeCommand(s, opts);
    const useITerm = opts.terminal === 'iTerm' || (opts.terminal !== 'Terminal' && s.term === 'iTerm.app');
    const r = useITerm
      ? await osascript([
          'tell application "iTerm"',
          '  set w to (create window with default profile)',
          `  tell current session of w to write text ${asString(cmd)}`,
          '  activate',
          'end tell',
        ])
      : await osascript([`tell application "Terminal" to do script ${asString(cmd)}`, 'tell application "Terminal" to activate']);
    results.push({ id: s.id, ...r });
  }
  return results;
}

module.exports = { focusSession, openSessions, resumeCommand, shQuote, asString, APPS };
