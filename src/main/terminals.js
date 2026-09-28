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

function hasITerm() {
  const fs = require('fs');
  const os = require('os');
  return ['/Applications/iTerm.app', `${os.homedir()}/Applications/iTerm.app`].some((p) => fs.existsSync(p));
}

async function openSessions(sessions, opts = {}) {
  const results = [];
  const tabs = opts.tabs !== false;
  for (const s of sessions) {
    const cmd = resumeCommand(s, opts);
    // 어떤 터미널이었는지 모르면(연결 전에 연 세션 등) iTerm 이 깔려 있으면 iTerm 으로
    const useITerm =
      opts.terminal === 'iTerm' ||
      (opts.terminal !== 'Terminal' && (s.term === 'iTerm.app' || (s.term !== 'Apple_Terminal' && hasITerm())));
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
// 실행 파일 자체가 claude 일 때만 (vim claude · less claude 같은 건 아님)
function isInteractiveClaude(command) {
  const t = String(command || '').trim().split(/\s+/);
  const base = (x) => String(x || '').split('/').pop();
  const exe = base(t[0]);
  const isClaude = exe === 'claude' || (/^(node|bun)$/.test(exe) && /(^|\/)(claude|cli\.m?js)$/.test(t[1] || '') && /claude/.test(t[1] || ''));
  return isClaude && !/(^|\s)(-p|--print)(\s|$)/.test(command);
}

// 명령줄에 세션 ID 가 있으면 (--resume <id> · -r <id> · --session-id <id>)
function sessionIdFromArgs(command) {
  const m = /(?:--resume|-r|--session-id)[\s=]+['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(command);
  return m ? m[1] : '';
}

// 지금 터미널에서 돌고 있는 claude 목록 [{ pid, tty, command, startedAt }] (알 수 없으면 null)
const LSTART = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(\S+)\s+(.*)$/;
function parsePs(stdout) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const m = LSTART.exec(line);
    if (!m || m[3] === '?' || m[3] === '??') continue;
    if (!isInteractiveClaude(m[4])) continue;
    const started = Date.parse(m[2]);
    out.push({ pid: Number(m[1]), tty: m[3].replace(/^\/dev\//, ''), command: m[4], startedAt: Number.isFinite(started) ? started : 0 });
  }
  return out;
}

function runningClaudes() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,lstart=,tty=,command='], { timeout: 4000, maxBuffer: 8 * 1024 * 1024, env: { ...cleanEnv(), LC_ALL: 'C' } }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(parsePs(stdout));
    });
  });
}

// 원래 claude 명령의 옵션은 그대로 두고 세션만 --resume <id> 로 (예: --dangerously-skip-permissions --remote-control 이름)
// ps 출력엔 따옴표가 없어서 띄어쓰기가 있는 값은 복원할 수 없어요 → 아는 옵션만 남기고 나머지(첫 프롬프트 등)는 버려요
const FLAG_ONLY = new Set(['--dangerously-skip-permissions', '--rc', '--verbose', '--ide', '--chrome', '--no-chrome']);
const FLAG_VALUE = new Set(['--permission-mode', '--model', '--fallback-model', '--add-dir', '--settings', '--agent', '--mcp-config']);
function reopenCommand(session, command) {
  const tokens = String(command || '').trim().split(/\s+/);
  const at = tokens.findIndex((t) => /(^|\/)(claude|cli\.m?js)$/.test(t));
  const args = at >= 0 ? tokens.slice(at + 1) : [];
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (FLAG_ONLY.has(a)) kept.push(a);
    else if (FLAG_VALUE.has(a) && next && !next.startsWith('-')) {
      kept.push(a, next);
      i++;
    } else if (a === '--remote-control') {
      // 이름은 선택: 바로 뒤가 옵션이 아닌 한 단어면 이름으로
      kept.push(a);
      if (next && !next.startsWith('-') && !/["']/.test(next)) {
        kept.push(next);
        i++;
      }
    } else if (/^--(permission-mode|model|settings|agent)=/.test(a)) kept.push(a);
  }
  kept.push('--resume', session.id);
  return `cd ${shQuote(session.cwd || '~')} && env -u ${CHILD_MARKERS.join(' -u ')} claude ${kept.map(shQuote).join(' ')}`;
}

// 같은 터미널 탭(tty)에 명령 입력 (iTerm → Terminal 순서로 찾아봄)
async function typeInTty(tty, cmd) {
  const dev = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  const iterm = await osascript([
    'if application "iTerm" is running then',
    '  tell application "iTerm"',
    '    repeat with w in windows',
    '      repeat with t in tabs of w',
    '        repeat with s in sessions of t',
    `          if tty of s is ${asString(dev)} then`,
    `            tell s to write text ${asString(cmd)}`,
    '            return "ok"',
    '          end if',
    '        end repeat',
    '      end repeat',
    '    end repeat',
    '  end tell',
    'end if',
    'return "missing"',
  ]);
  if (iterm.ok && iterm.out === 'ok') return iterm;
  const term = await osascript([
    'if application "Terminal" is running then',
    '  tell application "Terminal"',
    '    repeat with w in windows',
    '      repeat with t in tabs of w',
    `        if tty of t is ${asString(dev)} then`,
    `          do script ${asString(cmd)} in t`,
    '          return "ok"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end tell',
    'end if',
    'return "missing"',
  ]);
  if (term.ok && term.out === 'ok') return term;
  return { ok: false, error: '그 터미널 탭을 찾지 못했어요 (iTerm · macOS 터미널만 지원)' };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 같은 탭에서 claude 를 끝내고 곧바로 이어서 다시 열기 → 새로 연 세션은 CodePup 훅을 읽어서 알림이 와요
async function reopenInPlace(session, proc) {
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS 에서만 지원해요' };
  const cmd = reopenCommand(session, proc.command);
  // 끄기 직전에 그 PID 가 아직 같은 터미널의 claude 인지 다시 확인 (PID 가 재사용됐을 수 있어요)
  const now = await new Promise((resolve) => {
    execFile('ps', ['-p', String(proc.pid), '-o', 'tty=,command='], { timeout: 4000, env: cleanEnv() }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
  const m = /^(\S+)\s+(.*)$/.exec(now);
  if (!m || m[1].replace(/^\/dev\//, '') !== proc.tty || !isInteractiveClaude(m[2])) {
    return { ok: false, error: '그 세션이 이미 바뀌었어요. 잠시 뒤 다시 해 주세요' };
  }
  try {
    process.kill(proc.pid, 'SIGTERM'); // claude 는 대화 기록을 저장하고 끝나요
  } catch (err) {
    return { ok: false, error: `끝내지 못했어요: ${err.message}` };
  }
  for (let i = 0; i < 25 && alive(proc.pid); i++) await new Promise((r) => setTimeout(r, 200));
  if (alive(proc.pid)) return { ok: false, error: '아직 끝나지 않았어요. 잠시 뒤 다시 해 주세요' };
  await new Promise((r) => setTimeout(r, 400)); // 셸 프롬프트가 돌아올 때까지
  return typeInTty(proc.tty, cmd);
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

module.exports = { focusSession, openSessions, resumeCommand, reopenCommand, reopenInPlace, aliveClaudeTtys, runningClaudes, parsePs, cwdOf, isInteractiveClaude, sessionIdFromArgs, cleanEnv, shQuote, asString, APPS };
