// Claude Code 세션 허브: 훅 이벤트를 받아 세션 상태를 관리하고,
// 권한 요청·다음 지시처럼 사용자의 응답이 필요한 요청을 펫 UI와 이어 줍니다.
// Electron에 의존하지 않으므로 node --test 로 검증합니다.
const path = require('path');
const { EventEmitter } = require('events');

const HISTORY_MAX = 40;
// 사용자가 직접 끝낸 세션 (/exit · Ctrl+D · /clear · /resume 로 다른 세션 전환 · 로그아웃)
// → "닫힌 세션 다시 열기"에 넣지 않아요. 터미널이 꺼지거나 맥이 재시동돼서 사라진 세션만 복구 대상.
const USER_ENDED = new Set(['prompt_input_exit', 'clear', 'resume', 'logout']);
const SUMMARY_MAX = 4000;

function projectName(cwd) {
  if (!cwd) return '알 수 없는 폴더';
  return path.basename(cwd.replace(/[\\/]+$/, '')) || cwd;
}

function clip(text, n) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// 줄바꿈은 살려서 자르기 (마크다운 답변용)
function clipKeepLines(text, n) {
  if (!text) return '';
  const s = String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// 권한 요청을 사람이 읽기 좋은 한 줄로
function describeTool(toolName, input = {}) {
  switch (toolName) {
    case 'Bash':
      return { title: '명령 실행', detail: input.command || '' };
    case 'Edit':
    case 'MultiEdit':
      return { title: '파일 수정', detail: input.file_path || '' };
    case 'Write':
      return { title: '파일 만들기', detail: input.file_path || '' };
    case 'Read':
      return { title: '파일 읽기', detail: input.file_path || '' };
    case 'WebFetch':
      return { title: '웹 페이지 가져오기', detail: input.url || '' };
    case 'WebSearch':
      return { title: '웹 검색', detail: input.query || '' };
    default:
      if (toolName && toolName.startsWith('mcp__')) {
        return { title: `도구 사용 (${toolName.split('__')[1] || 'MCP'})`, detail: clip(JSON.stringify(input), 200) };
      }
      return { title: toolName || '도구 사용', detail: clip(JSON.stringify(input), 200) };
  }
}

class SessionHub extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => object} opts.getSettings  { permissionWaitSec }
   * @param {object[]} [opts.history]        복구용 세션 기록
   * @param {() => number} [opts.now]
   */
  constructor({ getSettings, history = [], now = Date.now } = {}) {
    super();
    this.getSettings = getSettings || (() => ({}));
    this.now = now;
    this.sessions = new Map();
    this.history = Array.isArray(history) ? history.slice(0, HISTORY_MAX) : [];
    this.seq = 0;
  }

  // ---------- 조회 ----------

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => this.view(s));
  }

  view(s) {
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      activity: s.activity,
      lastMessage: s.lastMessage,
      lastPrompt: s.lastPrompt,
      updatedAt: s.updatedAt,
      term: s.term,
      tty: s.tty,
      needsReopen: !!s.needsReopen,
      pending: s.pending ? { ...s.pending, resolve: undefined, timer: undefined } : null,
    };
  }

  counts() {
    let permission = 0;
    let working = 0;
    for (const s of this.sessions.values()) {
      if (s.pending && s.pending.kind === 'permission') permission++;
      if (s.status === 'working') working++;
    }
    return { total: this.sessions.size, permission, working };
  }

  // ---------- 훅 처리 ----------

  upsert(payload, meta = {}, { touch = true } = {}) {
    const id = payload.session_id;
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        cwd: payload.cwd || '',
        name: projectName(payload.cwd),
        status: 'idle',
        activity: '',
        lastMessage: '',
        lastPrompt: '',
        pending: null,
        transcriptPath: payload.transcript_path || '',
        term: meta.term || '',
        tty: meta.tty || '',
        startedAt: this.now(),
        updatedAt: this.now(),
      };
      this.sessions.set(id, s);
    }
    if (payload.cwd) {
      s.cwd = payload.cwd;
      s.name = projectName(payload.cwd);
    }
    if (payload.transcript_path) s.transcriptPath = payload.transcript_path;
    // 이 세션이 돌던 권한 모드 (default · acceptEdits · auto · bypassPermissions …) → 다시 열 때 그대로
    if (typeof payload.permission_mode === 'string' && payload.permission_mode) s.permissionMode = payload.permission_mode;
    if (meta.term) s.term = meta.term;
    if (meta.tty) s.tty = meta.tty;
    if (touch) s.updatedAt = this.now();
    this.remember(s);
    return s;
  }

  remember(s) {
    const entry = {
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      term: s.term,
      permissionMode: s.permissionMode || '',
      lastSeen: this.now(),
      ended: s.status === 'ended',
      endReason: s.endReason || '', // 'exit' = 사용자가 끝냄 · 'closed' = 터미널이 닫힘 · 'vanished' = 신호가 끊김
    };
    this.history = [entry, ...this.history.filter((h) => h.id !== s.id)].slice(0, HISTORY_MAX);
  }

  changed(s, event) {
    this.emit('changed', { session: this.view(s), event, counts: this.counts() });
  }

  /**
   * 훅 이벤트 하나를 처리하고, Claude Code 에 돌려줄 JSON(없으면 null)을 resolve 합니다.
   * @param {string} event
   * @param {object} payload 훅 stdin JSON
   * @param {object} meta    { tty, term, signal(AbortSignal) }
   */
  async handle(event, payload, meta = {}) {
    if (!payload || typeof payload.session_id !== 'string' || !payload.session_id) return null;
    const s = this.upsert(payload, meta);
    s.needsReopen = false; // 훅이 오면 알림이 켜진 세션

    switch (event) {
      case 'SessionStart':
        s.status = 'idle';
        s.activity = payload.source === 'resume' ? '이어서 시작' : '새 세션';
        this.changed(s, { type: 'started' });
        return null;

      case 'UserPromptSubmit': {
        this.settle(s, null);
        s.status = 'working';
        s.lastPrompt = clip(payload.prompt, 200);
        s.activity = '생각 중…';
        this.changed(s, { type: 'working' });
        return null;
      }

      case 'PostToolUse': {
        if (s.pending && s.pending.kind === 'permission') this.settle(s, null); // 터미널에서 이미 답함
        s.status = 'working';
        const d = describeTool(payload.tool_name, payload.tool_input);
        s.activity = clip(`${d.title} ${d.detail}`, 80);
        this.changed(s, { type: 'activity' });
        return null;
      }

      case 'Notification': {
        const type = payload.notification_type;
        if (type === 'idle_prompt' && !s.pending) {
          s.status = 'waiting';
          this.changed(s, { type: 'idle', message: clip(payload.message, 120) });
        }
        return null;
      }

      case 'PermissionRequest':
        return this.askPermission(s, payload, meta.signal);

      case 'Stop':
        return this.onStop(s, payload, meta.signal);

      case 'SessionEnd':
        this.settle(s, null);
        s.status = 'ended';
        s.endReason = USER_ENDED.has(payload.reason) ? 'exit' : 'closed';
        s.activity = '종료됨';
        this.remember(s);
        this.changed(s, { type: 'ended' });
        this.sessions.delete(s.id);
        return null;

      default:
        return null;
    }
  }

  waitFor(s, pending, ms, signal) {
    return new Promise((resolve) => {
      this.settle(s, null); // 이전 대기가 있으면 정리
      pending.id = `p${++this.seq}`;
      pending.createdAt = this.now();
      pending.expiresAt = this.now() + ms;
      pending.resolve = resolve;
      pending.timer = setTimeout(() => this.settle(s, null, pending.id), ms);
      s.pending = pending;
      if (signal) {
        if (signal.aborted) return this.settle(s, null, pending.id);
        signal.addEventListener('abort', () => this.settle(s, null, pending.id), { once: true });
      }
    });
  }

  // 대기 중인 요청을 answer 로 끝냅니다. pendingId 가 주어지면 그 요청일 때만.
  settle(s, answer, pendingId) {
    const p = s.pending;
    if (!p || (pendingId && p.id !== pendingId)) return false;
    clearTimeout(p.timer);
    s.pending = null;
    p.resolve(answer);
    return true;
  }

  async askPermission(s, payload, signal) {
    const cfg = this.getSettings();
    const d = describeTool(payload.tool_name, payload.tool_input);
    s.status = 'permission';
    s.activity = clip(`${d.title} 허락 대기`, 80);
    const waitSec = cfg.permissionWaitSec || 60;
    const suggestion = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions[0] : null;
    const pending = {
      kind: 'permission',
      tool: payload.tool_name,
      title: d.title,
      detail: clip(d.detail, 400),
      canAlways: !!suggestion,
    };
    const wait = this.waitFor(s, pending, waitSec * 1000, signal);
    this.changed(s, { type: 'permission', title: d.title, detail: pending.detail });
    const answer = await wait;
    if (s.status === 'permission') s.status = 'working';
    this.changed(s, { type: 'settled' });
    if (!answer) return null; // 응답 없음 → 터미널의 원래 권한 창으로
    if (answer.decision === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: answer.message || '사용자가 데스크톱 펫에서 거절했어요.' },
        },
      };
    }
    const decision = { behavior: 'allow' };
    if (answer.decision === 'always' && suggestion) decision.updatedPermissions = [suggestion];
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }

  onStop(s, payload) {
    s.status = 'done';
    s.lastMessage = clipKeepLines(payload.last_assistant_message, SUMMARY_MAX);
    s.activity = '작업 끝!';
    this.changed(s, { type: 'done', message: s.lastMessage.slice(0, 400) });
    return null;
  }

  // 대화 기록 파일로 찾은 세션 (CodePup 을 켜기 전부터 열려 있던 세션 등)
  observe({ session_id, cwd, transcript_path, mtime }) {
    if (!session_id || !cwd) return;
    const isNew = !this.sessions.has(session_id);
    if (!isNew) {
      // 대화 기록이 계속 갱신되면 살아 있는 것 (터미널 정보가 없는 세션의 생존 신호)
      const cur = this.sessions.get(session_id);
      if (mtime && mtime > (cur.updatedAt || 0)) cur.updatedAt = mtime;
      return;
    }
    if (this.history.some((h) => h.id === session_id && h.ended)) return; // 이미 끝난 세션
    const s = this.upsert({ session_id, cwd, transcript_path });
    s.observedAt = mtime || this.now();
    s.updatedAt = mtime || this.now();
    s.activity = '열려 있는 세션';
    this.changed(s, { type: 'discovered' });
  }

  // 터미널에서 돌고 있는 claude 를 직접 찾아 붙이기 (CodePup 을 켜기 전부터 열려 있던 세션도 바로 보이게)
  // 터미널(tty)을 알아서, 창을 닫으면 바로 정리돼요
  // needsReopen: CodePup 을 연결하기 전에 시작된 claude → 훅을 모르니 알림이 안 와요 (다시 열면 해결)
  attach({ session_id, cwd, tty, transcript_path, pid, command, needsReopen = false }) {
    if (!session_id || !cwd || !tty) return;
    const known = [...this.sessions.values()].find((x) => x.tty === tty);
    if (known) {
      if (pid) known.pid = pid;
      if (command) known.command = command;
      return; // 이 터미널의 세션은 이미 알고 있음
    }
    const cur = this.sessions.get(session_id);
    if (cur) {
      if (!cur.tty) cur.tty = tty;
      return;
    }
    const s = this.upsert({ session_id, cwd, transcript_path }, { tty });
    s.activity = needsReopen ? '알림 꺼짐 · 다시 열면 켜져요' : '열려 있는 세션';
    s.pid = pid || 0;
    s.command = command || '';
    s.needsReopen = needsReopen;
    this.changed(s, { type: 'discovered' });
  }

  // 알림이 꺼진 (CodePup 연결 전에 연) 세션들
  needingReopen() {
    return [...this.sessions.values()].filter((s) => s.needsReopen && s.pid && s.tty);
  }

  // 신호가 끊긴 세션 정리 (터미널을 그냥 닫으면 SessionEnd 가 안 올 수 있음)
  // aliveTtys: claude 가 돌고 있는 터미널(tty) 목록. 모르면(null) 오래 조용한 세션만 정리해요.
  // - claude 가 하나도 안 돌고 있으면(aliveTtys 가 비어 있음) 모든 세션을 정리
  // - 터미널을 모르는 세션(대화 기록으로만 찾은 세션)은 기록이 멈춘 지 20분이면 정리
  sweep({ aliveTtys = null, graceMs = 60000, idleTimeoutMs = 3 * 60 * 60000, noTtyTimeoutMs = 20 * 60000 } = {}) {
    const t = this.now();
    for (const s of [...this.sessions.values()]) {
      const lastSignal = s.updatedAt || 0;
      const quiet = t - lastSignal;
      const tty = String(s.tty || '').replace(/^\/dev\//, '');
      // 터미널이 사라진 게 확실하면 일하던 중 · 허락 대기 중이어도 정리 (iTerm 을 통째로 닫은 경우)
      const termGone = aliveTtys && (aliveTtys.size === 0 || (tty && !aliveTtys.has(tty)));
      if (!termGone && (s.pending || s.status === 'working' || s.status === 'permission')) continue;
      let gone;
      if (termGone) gone = quiet > graceMs;
      else if (!tty) gone = quiet > noTtyTimeoutMs;
      else gone = quiet > idleTimeoutMs;
      if (gone) {
        if (s.pending) this.settle(s, null);
        s.status = 'ended';
        s.endReason = 'vanished';
        this.remember(s);
        this.sessions.delete(s.id);
        this.changed(s, { type: 'ended' });
      }
    }
  }

  // ---------- UI 동작 ----------

  decide(sessionId, decision, message) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.pending || s.pending.kind !== 'permission') return false;
    return this.settle(s, { decision, message });
  }

  // 복구 후보: 지금 열려 있지 않은 최근 세션 중, 사용자가 직접 끝낸 건 빼고
  restorable(limit = 20) {
    return this.history.filter((h) => !this.sessions.has(h.id) && h.cwd && h.endReason !== 'exit').slice(0, limit);
  }

  // 앱 종료 시 대기 중인 훅을 모두 풀어 줌
  releaseAll() {
    for (const s of this.sessions.values()) this.settle(s, null);
  }
}

module.exports = { SessionHub, describeTool, projectName, clip };
