// Claude Code 세션 허브: 훅 이벤트를 받아 세션 상태를 관리하고,
// 권한 요청·다음 지시처럼 사용자의 응답이 필요한 요청을 펫 UI와 이어 줍니다.
// Electron에 의존하지 않으므로 node --test 로 검증합니다.
const path = require('path');
const { EventEmitter } = require('events');

const HISTORY_MAX = 40;
// 사용자가 직접 끝낸 세션 (/exit · Ctrl+D · /clear · /resume 로 다른 세션 전환 · 로그아웃)
// → "닫힌 세션 다시 열기"에 넣지 않아요. 터미널이 꺼지거나 맥이 재시동돼서 사라진 세션만 복구 대상.
const USER_ENDED = new Set(['prompt_input_exit', 'clear', 'resume', 'logout']);
const SUMMARY_MAX = 1200;

function projectName(cwd) {
  if (!cwd) return '알 수 없는 폴더';
  return path.basename(cwd.replace(/[\\/]+$/, '')) || cwd;
}

function clip(text, n) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
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
   * @param {() => object} opts.getSettings  { awayMode, permissionWaitSec, replyWaitMin }
   * @param {object[]} [opts.history]        복구용 세션 기록
   * @param {() => number} [opts.now]
   */
  constructor({ getSettings, history = [], now = Date.now } = {}) {
    super();
    this.getSettings = getSettings || (() => ({}));
    this.now = now;
    this.sessions = new Map();
    this.history = Array.isArray(history) ? history.slice(0, HISTORY_MAX) : [];
    this.shares = new Map(); // targetId -> [{ fromName, text }]
    this.seq = 0;
    this.limits = null; // 최근 상태 표시줄의 요금제 한도 { five_hour, seven_day, at }
    this.alerted = {}; // 한도 · 컨텍스트 알림을 한 번씩만 보내기 위한 기록
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
      context: s.context || null, // { pct, size }
      model: s.model || '',
      costUsd: s.costUsd || 0,
      live: !!s.statusAt, // 상태 표시줄로 살아 있음을 확인한 세션
      pending: s.pending ? { ...s.pending, resolve: undefined, timer: undefined } : null,
      sharedQueued: (this.shares.get(s.id) || []).length,
    };
  }

  counts() {
    let permission = 0;
    let reply = 0;
    let working = 0;
    for (const s of this.sessions.values()) {
      if (s.pending && s.pending.kind === 'permission') permission++;
      else if (s.pending && s.pending.kind === 'reply') reply++;
      if (s.status === 'working') working++;
    }
    return { total: this.sessions.size, permission, reply, working };
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
        const queued = this.shares.get(s.id);
        if (queued && queued.length) {
          this.shares.delete(s.id);
          return {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: this.shareText(queued),
            },
          };
        }
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
    const waitSec = cfg.awayMode ? (cfg.replyWaitMin || 30) * 60 : cfg.permissionWaitSec || 60;
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

  async onStop(s, payload, signal) {
    const cfg = this.getSettings();
    s.status = 'done';
    s.lastMessage = clip(payload.last_assistant_message, SUMMARY_MAX);
    s.activity = '작업 끝!';
    if (!cfg.awayMode) {
      this.changed(s, { type: 'done', message: clip(s.lastMessage, 140) });
      return null;
    }
    // 자리 비움 모드: 펫에서 다음 지시를 보낼 때까지 기다림
    const pending = { kind: 'reply' };
    const wait = this.waitFor(s, pending, (cfg.replyWaitMin || 30) * 60 * 1000, signal);
    this.changed(s, { type: 'done', message: clip(s.lastMessage, 140), awaitingReply: true });
    const answer = await wait;
    this.changed(s, { type: 'settled' });
    if (!answer || !answer.text) return null;
    s.status = 'working';
    s.lastPrompt = clip(answer.text, 200);
    s.activity = '다음 지시 전달됨';
    this.changed(s, { type: 'working' });
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: `사용자가 데스크톱 펫(CodePup)으로 다음 지시를 보냈어요. 이 지시를 이어서 수행해 주세요:\n\n${answer.text}`,
      },
    };
  }

  // ---------- 상태 표시줄 (이미 열린 세션 발견 · 한도 · 컨텍스트) ----------

  /**
   * Claude Code 상태 표시줄이 몇 초마다 보내 주는 JSON 을 반영합니다.
   * 훅 이벤트가 없어도 열려 있는 세션을 찾고, 요금제 한도와 컨텍스트 사용률을 추적해요.
   */
  status(payload) {
    if (!payload || typeof payload.session_id !== 'string' || !payload.session_id) return;
    const isNew = !this.sessions.has(payload.session_id);
    const cwd = payload.cwd || (payload.workspace && payload.workspace.current_dir) || '';
    const s = this.upsert({ session_id: payload.session_id, cwd, transcript_path: payload.transcript_path }, {}, { touch: isNew });
    s.statusAt = this.now();
    let changed = isNew;
    const cw = payload.context_window || {};
    if (Number.isFinite(cw.used_percentage)) {
      const pct = Math.round(cw.used_percentage);
      if (!s.context || s.context.pct !== pct) changed = true;
      s.context = { pct, size: cw.context_window_size || 0 };
      this.contextAlert(s);
    }
    const model = payload.model && (payload.model.display_name || payload.model.id);
    if (model && model !== s.model) {
      s.model = model;
      changed = true;
    }
    if (payload.cost && Number.isFinite(payload.cost.total_cost_usd)) s.costUsd = payload.cost.total_cost_usd;
    if (isNew) s.activity = '열려 있는 세션';
    if (changed) this.changed(s, { type: isNew ? 'discovered' : 'status' });
    if (payload.rate_limits && typeof payload.rate_limits === 'object') this.updateLimits(payload.rate_limits);
  }

  updateLimits(rl) {
    const pick = (w) => (w && Number.isFinite(w.used_percentage) ? { pct: Math.round(w.used_percentage * 10) / 10, resetsAt: Number(w.resets_at) || 0 } : null);
    const next = { five_hour: pick(rl.five_hour), seven_day: pick(rl.seven_day), at: this.now() };
    const prev = this.limits;
    this.limits = next;
    const same = prev && JSON.stringify([prev.five_hour, prev.seven_day]) === JSON.stringify([next.five_hour, next.seven_day]);
    if (!same) this.emit('limits', { limits: next, alert: this.limitAlert(next) });
  }

  // 한도가 50 · 80 · 95% 를 처음 넘을 때 한 번씩 알림 (초기화되면 다시)
  limitAlert(l) {
    const w = l.five_hour;
    if (!w) return null;
    const key = `5h:${w.resetsAt}`;
    const level = [95, 80, 50].find((t) => w.pct >= t);
    if (!level) return null;
    if ((this.alerted[key] || 0) >= level) return null;
    this.alerted[key] = level;
    return { window: 'five_hour', level, pct: w.pct, resetsAt: w.resetsAt };
  }

  contextAlert(s) {
    const pct = s.context.pct;
    const key = `ctx:${s.id}`;
    if (pct < 60) {
      delete this.alerted[key]; // 압축(compact)되면 다시 알릴 수 있게
      return;
    }
    if (pct >= 85 && !this.alerted[key]) {
      this.alerted[key] = true;
      this.changed(s, { type: 'context', pct });
    }
  }

  // 대화 기록 파일로 찾은 세션 (설정을 실시간으로 다시 읽지 않는 옛 버전용)
  observe({ session_id, cwd, transcript_path, mtime }) {
    if (!session_id || !cwd) return;
    const isNew = !this.sessions.has(session_id);
    if (!isNew) return;
    if (this.history.some((h) => h.id === session_id && h.ended)) return; // 이미 끝난 세션
    const s = this.upsert({ session_id, cwd, transcript_path });
    s.observedAt = mtime || this.now();
    s.updatedAt = mtime || this.now();
    s.activity = '열려 있는 세션';
    this.changed(s, { type: 'discovered' });
  }

  // 신호가 끊긴 세션 정리 (터미널을 그냥 닫으면 SessionEnd 가 안 올 수 있음)
  sweep({ statusTimeoutMs = 90000, idleTimeoutMs = 30 * 60000 } = {}) {
    const t = this.now();
    for (const s of [...this.sessions.values()]) {
      if (s.pending || s.status === 'working' || s.status === 'permission') continue;
      const lastSignal = Math.max(s.statusAt || 0, s.updatedAt || 0);
      const gone = s.statusAt ? t - s.statusAt > statusTimeoutMs : t - lastSignal > idleTimeoutMs;
      if (gone) {
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

  reply(sessionId, text) {
    const s = this.sessions.get(sessionId);
    const t = String(text || '').trim();
    if (!s || !t || !s.pending || s.pending.kind !== 'reply') return false;
    return this.settle(s, { text: t.slice(0, 4000) });
  }

  // 자리 비움 대기를 풀고 터미널에서 직접 이어서 하기
  release(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.pending) return false;
    return this.settle(s, null);
  }

  shareText(items) {
    return items
      .map((it) => `다른 Claude Code 세션(${it.fromName})의 최근 결과를 공유받았어요. 참고해 주세요.\n---\n${it.text}\n---`)
      .join('\n\n');
  }

  // from 세션의 마지막 결과를 to 세션의 다음 프롬프트(또는 대기 중인 답장)에 붙입니다.
  share(fromId, toId) {
    const from = this.sessions.get(fromId) || this.history.find((h) => h.id === fromId);
    const to = this.sessions.get(toId);
    if (!from || !to || fromId === toId) return { ok: false, error: '세션을 찾을 수 없어요' };
    const text = (this.sessions.get(fromId) || {}).lastMessage || '';
    if (!text) return { ok: false, error: '공유할 결과가 아직 없어요' };
    const item = { fromName: from.name, text };
    if (to.pending && to.pending.kind === 'reply') {
      this.settle(to, { text: this.shareText([item]) });
      return { ok: true, delivered: 'now' };
    }
    const q = this.shares.get(toId) || [];
    q.push(item);
    this.shares.set(toId, q);
    this.changed(to, { type: 'shared', fromName: from.name });
    return { ok: true, delivered: 'next-prompt' };
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
