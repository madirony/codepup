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

// 원래 돌던 권한 모드 → claude 실행 옵션 (plan 은 이어 가지 않고 기본으로)
const MODE_FLAGS = {
  bypassPermissions: ['--dangerously-skip-permissions'],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  auto: ['--permission-mode', 'auto'],
  dontAsk: ['--permission-mode', 'dontAsk'],
};

// 세션을 다시 여는 셸 명령
// skipPermissions: 항상 --dangerously-skip-permissions · 아니면 세션이 원래 쓰던 모드 그대로
function resumeCommand(session, { remoteControl = true, skipPermissions = false, extraArgs = '' } = {}) {
  const parts = ['claude', '--resume', shQuote(session.id)];
  if (remoteControl) parts.push('--rc');
  if (skipPermissions) parts.push('--dangerously-skip-permissions');
  else if (MODE_FLAGS[session.permissionMode]) parts.push(...MODE_FLAGS[session.permissionMode]);
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

// 대화형 claude 명령인지 (claude -p / --print 같은 한 번짜리 실행은 제외)
const CLAUDE_RE = /(^|[\s/])claude(\s|$)/;
function isInteractiveClaude(command) {
  return CLAUDE_RE.test(command) && !/(^|\s)(-p|--print)(\s|$)/.test(command);
}

// 명령줄에 세션 ID 가 있으면 (--resume <id> · -r <id> · --session-id <id>)
function sessionIdFromArgs(command) {
  const m = /(?:--resume|-r|--session-id)[\s=]+['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(command);
  return m ? m[1] : '';
}

// 지금 터미널에서 돌고 있는 claude 목록 [{ pid, tty, command }] (알 수 없으면 null)
function runningClaudes() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,tty=,command='], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = [];
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m || m[2] === '?' || m[2] === '??') continue;
        if (isInteractiveClaude(m[3])) out.push({ pid: Number(m[1]), tty: m[2].replace(/^\/dev\//, ''), command: m[3] });
      }
      resolve(out);
    });
  });
}

// 프로세스의 작업 폴더 (macOS lsof)
function cwdOf(pid) {
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve('');
      const line = String(stdout).split('\n').find((l) => l.startsWith('n'));
      resolve(line ? line.slice(1) : '');
    });
  });
}

// claude 가 돌고 있는 터미널(tty) 목록 → 창을 닫아 사라진 세션 정리에 사용 (알 수 없으면 null)
async function aliveClaudeTtys(procs) {
  const list = procs || (await runningClaudes());
  return list ? new Set(list.map((p) => p.tty)) : null;
}

module.exports = { focusSession, openSessions, resumeCommand, aliveClaudeTtys, runningClaudes, cwdOf, isInteractiveClaude, sessionIdFromArgs, cleanEnv, shQuote, asString, APPS };
