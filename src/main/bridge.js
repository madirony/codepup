// Claude Code 훅 ↔ 펫 앱 사이의 로컬 브리지.
// - 127.0.0.1 에만 열리고, 실행할 때마다 새로 만드는 토큰으로 잠급니다.
// - 훅 스크립트(~/.codepup/codepup-hook.sh)는 앱이 꺼져 있으면 아무것도 하지 않고 조용히 끝나요.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BODY_LIMIT = 2 * 1024 * 1024;
const MARKER = 'codepup-hook.sh';
// 이전 이름(Speaki 데스크톱 펫)으로 설치된 훅도 함께 정리
const LEGACY_MARKERS = ['speaki-hook.sh'];

// 우리가 설치하는 훅. 응답을 기다려야 하는 이벤트만 동기, 나머지는 async 로 세션을 느리게 하지 않음.
const HOOK_EVENTS = [
  { event: 'SessionStart', async: true },
  { event: 'UserPromptSubmit', timeout: 10 },
  { event: 'PostToolUse', async: true },
  { event: 'Notification', async: true },
  { event: 'PermissionRequest', timeout: 3600 },
  { event: 'Stop', timeout: 3600 },
  { event: 'SessionEnd', async: true },
];

const HOOK_SCRIPT = `#!/bin/sh
# CodePup 데스크톱 펫 ↔ Claude Code 연결 스크립트 (CodePup 이 설치함 · 지워도 안전)
# 앱이 꺼져 있으면 아무것도 하지 않고 끝나요.
EVENT="$1"
CONF="$HOME/.codepup/bridge.env"
[ -r "$CONF" ] || exit 0
. "$CONF"
[ -n "$CODEPUP_PORT" ] || exit 0

# 이 세션이 돌아가는 터미널(tty) 찾기 → "터미널로 이동"에 사용
TTY=""
P=$PPID
i=0
while [ $i -lt 5 ] && [ -n "$P" ] && [ "$P" != "1" ]; do
  T=$(ps -o tty= -p "$P" 2>/dev/null | tr -d ' ')
  case "$T" in ""|"?"|"??") ;; *) TTY="$T"; break ;; esac
  P=$(ps -o ppid= -p "$P" 2>/dev/null | tr -d ' ')
  i=$((i + 1))
done

MAXT=5
case "$EVENT" in PermissionRequest|Stop) MAXT=3590 ;; UserPromptSubmit) MAXT=8 ;; esac

OUT=$(curl -s --max-time "$MAXT" -X POST \\
  -H "Authorization: Bearer $CODEPUP_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "X-CodePup-TTY: $TTY" \\
  -H "X-CodePup-Term: \${TERM_PROGRAM:-}" \\
  --data-binary @- "http://127.0.0.1:$CODEPUP_PORT/hook/$EVENT" 2>/dev/null)
[ -n "$OUT" ] && printf '%s' "$OUT"
exit 0
`;

// 상태 표시줄: 받은 JSON 을 CodePup 에 넘기고, 원래 쓰던 상태 표시줄 명령이 있으면 그대로 실행해서 보여 줘요.
const STATUSLINE_MARKER = 'codepup-statusline.sh';
const STATUSLINE_SCRIPT = `#!/bin/sh
# CodePup 상태 표시줄 연결 (CodePup 이 설치함 · 연결을 해제하면 원래 설정으로 돌아가요)
# 로컬(127.0.0.1)로만 보내요. Anthropic API 는 부르지 않아요.
IN=$(cat)
CONF="$HOME/.codepup/bridge.env"
if [ -r "$CONF" ]; then
  . "$CONF"
  if [ -n "$CODEPUP_PORT" ]; then
    TTY=""
    P=$PPID
    i=0
    while [ $i -lt 5 ] && [ -n "$P" ] && [ "$P" != "1" ]; do
      T=$(ps -o tty= -p "$P" 2>/dev/null | tr -d ' ')
      case "$T" in ""|"?"|"??") ;; *) TTY="$T"; break ;; esac
      P=$(ps -o ppid= -p "$P" 2>/dev/null | tr -d ' ')
      i=$((i + 1))
    done
    printf '%s' "$IN" | curl -s --max-time 2 -X POST \\
      -H "Authorization: Bearer $CODEPUP_TOKEN" -H "Content-Type: application/json" \\
      -H "X-CodePup-TTY: $TTY" \\
      --data-binary @- "http://127.0.0.1:$CODEPUP_PORT/status" >/dev/null 2>&1 &
  fi
fi
PREV="$HOME/.codepup/statusline-prev.sh"
if [ -r "$PREV" ]; then
  printf '%s' "$IN" | sh "$PREV"
else
  printf '🐶 CodePup'
fi
`;

class Bridge {
  constructor({ hub, homeDir = os.homedir(), onError = () => {} }) {
    this.hub = hub;
    this.dir = path.join(homeDir, '.codepup');
    this.envFile = path.join(this.dir, 'bridge.env');
    this.scriptFile = path.join(this.dir, 'codepup-hook.sh');
    this.statusScript = path.join(this.dir, STATUSLINE_MARKER);
    this.prevStatusJson = path.join(this.dir, 'statusline-prev.json');
    this.prevStatusScript = path.join(this.dir, 'statusline-prev.sh');
    this.claudeSettings = path.join(homeDir, '.claude', 'settings.json');
    this.token = crypto.randomBytes(24).toString('hex');
    this.server = null;
    this.port = 0;
    this.onError = onError;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.route(req, res));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.writeEnv();
        resolve(this.port);
      });
    });
  }

  stop() {
    try {
      fs.unlinkSync(this.envFile); // 앱이 꺼지면 훅이 바로 건너뛰도록
    } catch {
      // 없으면 그만
    }
    if (this.server) this.server.close();
  }

  writeEnv() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.envFile, `CODEPUP_PORT=${this.port}\nCODEPUP_TOKEN=${this.token}\n`, { mode: 0o600 });
    fs.chmodSync(this.envFile, 0o600);
  }

  route(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(body === null || body === undefined ? '' : JSON.stringify(body));
    };
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${this.token}`;
    if (auth.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      return send(401, { error: 'unauthorized' });
    }
    const isStatus = req.url === '/status';
    const m = /^\/hook\/([A-Za-z]+)$/.exec(req.url || '');
    if (req.method !== 'POST' || (!m && !isStatus)) return send(404, { error: 'not found' });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) req.destroy();
      else chunks.push(c);
    });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return send(400, { error: 'bad json' });
      }
      if (isStatus) {
        try {
          this.hub.status(payload, { tty: String(req.headers['x-codepup-tty'] || '').slice(0, 40) });
        } catch (err) {
          this.onError(err);
        }
        return send(200, null);
      }
      // 훅이 취소되면(터미널에서 먼저 답했거나 타임아웃) 대기도 함께 정리
      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      try {
        const out = await this.hub.handle(m[1], payload, {
          tty: String(req.headers['x-codepup-tty'] || '').slice(0, 40),
          term: String(req.headers['x-codepup-term'] || '').slice(0, 40),
          signal: ac.signal,
        });
        if (!res.writableEnded && !res.destroyed) send(200, out);
      } catch (err) {
        this.onError(err);
        if (!res.writableEnded && !res.destroyed) send(200, null);
      }
    });
  }

  // ---------- ~/.claude/settings.json 훅 설치 ----------

  readClaudeSettings() {
    try {
      return JSON.parse(fs.readFileSync(this.claudeSettings, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw new Error('~/.claude/settings.json 을 읽을 수 없어요 (JSON 형식 오류?)');
    }
  }

  isInstalled() {
    try {
      const s = this.readClaudeSettings();
      return HOOK_EVENTS.every(({ event }) => JSON.stringify((s.hooks || {})[event] || []).includes(MARKER)) && this.isOurStatusLine(s.statusLine);
    } catch {
      return false;
    }
  }

  hookCommand(event) {
    return `sh "${this.scriptFile}" ${event}`;
  }

  // 기존 설정은 그대로 두고 우리 훅만 추가/교체합니다. 설치 전 백업을 남겨요.
  install() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.scriptFile, HOOK_SCRIPT, { mode: 0o755 });
    const settings = this.stripOurs(this.readClaudeSettings());
    this.installStatusLine(settings);
    settings.hooks = settings.hooks || {};
    for (const h of HOOK_EVENTS) {
      const hook = { type: 'command', command: this.hookCommand(h.event) };
      if (h.async) hook.async = true;
      if (h.timeout) hook.timeout = h.timeout;
      settings.hooks[h.event] = [...(settings.hooks[h.event] || []), { hooks: [hook] }];
    }
    this.writeClaudeSettings(settings);
    return true;
  }

  // 앱이 켜질 때: 이미 연결돼 있으면 스크립트와 설정을 이 버전으로 갱신 (예전 5초 새로고침 제거 등)
  refresh() {
    if (!this.isInstalled()) return false;
    return this.install();
  }

  uninstall() {
    const settings = this.stripOurs(this.readClaudeSettings());
    this.restoreStatusLine(settings);
    this.writeClaudeSettings(settings);
    return true;
  }

  isOurStatusLine(sl) {
    return !!(sl && String(sl.command || '').includes(STATUSLINE_MARKER));
  }

  // 원래 상태 표시줄(예: claude-hud)은 기억해 두고, 우리 스크립트가 그 명령을 이어서 실행
  installStatusLine(settings) {
    fs.writeFileSync(this.statusScript, STATUSLINE_SCRIPT, { mode: 0o755 });
    const prev = settings.statusLine;
    if (prev && !this.isOurStatusLine(prev)) {
      fs.writeFileSync(this.prevStatusJson, JSON.stringify(prev, null, 2));
      if (prev.type === 'command' && prev.command) {
        fs.writeFileSync(this.prevStatusScript, `#!/bin/sh\n# 원래 쓰던 상태 표시줄 명령\n${prev.command}\n`, { mode: 0o755 });
      }
    }
    const saved = this.readPrevStatusLine();
    // 새로고침 주기는 강제하지 않아요 (원래 설정을 그대로). 주기를 짧게 두면 이어서 실행되는
    // claude-hud 같은 명령이 세션마다 사용량을 자꾸 조회해서 429 (rate limited) 가 날 수 있어요.
    const ours = { type: 'command', command: `sh "${this.statusScript}"` };
    if (saved && Number.isFinite(saved.padding)) ours.padding = saved.padding;
    if (saved && Number.isFinite(saved.refreshInterval)) ours.refreshInterval = saved.refreshInterval;
    settings.statusLine = ours;
  }

  readPrevStatusLine() {
    try {
      return JSON.parse(fs.readFileSync(this.prevStatusJson, 'utf8'));
    } catch {
      return null;
    }
  }

  restoreStatusLine(settings) {
    if (settings.statusLine && !this.isOurStatusLine(settings.statusLine)) return; // 사용자가 이미 바꿨으면 그대로
    const saved = this.readPrevStatusLine();
    if (saved) settings.statusLine = saved;
    else delete settings.statusLine;
    for (const f of [this.prevStatusJson, this.prevStatusScript]) {
      try {
        fs.unlinkSync(f);
      } catch {
        // 없으면 그만
      }
    }
  }

  stripOurs(settings) {
    const s = { ...settings };
    if (!s.hooks) return s;
    const hooks = {};
    for (const [event, groups] of Object.entries(s.hooks)) {
      if (!Array.isArray(groups)) {
        hooks[event] = groups;
        continue;
      }
      const kept = groups
        .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => ![MARKER, ...LEGACY_MARKERS].some((m) => String(h.command || '').includes(m))) }))
        .filter((g) => g.hooks.length > 0);
      if (kept.length) hooks[event] = kept;
    }
    s.hooks = hooks;
    if (Object.keys(hooks).length === 0) delete s.hooks;
    return s;
  }

  writeClaudeSettings(settings) {
    fs.mkdirSync(path.dirname(this.claudeSettings), { recursive: true });
    if (fs.existsSync(this.claudeSettings)) {
      fs.copyFileSync(this.claudeSettings, this.claudeSettings + '.codepup-backup');
    }
    const tmp = this.claudeSettings + '.codepup-tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, this.claudeSettings);
  }
}

module.exports = { Bridge, HOOK_EVENTS, HOOK_SCRIPT, MARKER, STATUSLINE_SCRIPT, STATUSLINE_MARKER };
