// 세션 보드: 여러 Claude Code 세션의 상태를 보고, 허락·답장·공유·터미널 이동을 합니다.
(async () => {
  const api = window.codepup;
  const boot = await api.init();
  const ORIGIN = boot.origin;
  let settings = boot.settings;
  let skin = boot.skin;
  let sessions = boot.sessions.list;
  let restorable = boot.sessions.restorable;
  let claude = boot.claude;
  let limits = boot.limits;
  const drafts = new Map(); // 세션별 작성 중인 답장
  let focusId = decodeURIComponent(location.hash.slice(1)) || null;
  const $ = (id) => document.getElementById(id);

  const STATUS = {
    permission: ['permission', '🔔 허락 대기'],
    reply: ['reply', '💬 답장 대기'],
    working: ['working', '⚙️ 작업 중'],
    done: ['done', '✅ 완료'],
    waiting: ['waiting', '⏳ 입력 대기'],
    idle: ['idle', '💤 대기'],
  };

  function statusOf(s) {
    if (s.pending && s.pending.kind === 'permission') return STATUS.permission;
    if (s.pending && s.pending.kind === 'reply') return STATUS.reply;
    return STATUS[s.status] || STATUS.idle;
  }

  function ago(t) {
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return '방금';
    if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
    return `${Math.floor(sec / 86400)}일 전`;
  }

  function shortPath(p) {
    return String(p || '').replace(/^\/Users\/[^/]+/, '~');
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), 2000);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(text, cls, onClick) {
    const b = el('button', cls, text);
    b.addEventListener('click', onClick);
    return b;
  }

  function avatarUrl() {
    const custom = settings.customImages && settings.customImages.happy;
    if (custom) return `${ORIGIN}/user-media/${encodeURIComponent(custom)}`;
    return skin ? `${ORIGIN}/${skin.base}${skin.images.happy || skin.images.default}` : '';
  }

  // ---------- 카드 ----------

  function card(s) {
    const [cls, label] = statusOf(s);
    const c = el('div', 'card' + (s.pending ? ' attn' : '') + (s.id === focusId ? ' focus' : ''));
    c.dataset.id = s.id;

    const top = el('div', 'row');
    top.append(el('span', `chip ${cls}`, label), el('span', 'name', s.name), el('span', 'ago', ago(s.updatedAt)));
    c.append(top, el('div', 'cwd', shortPath(s.cwd)));
    if (s.activity && !s.pending) c.append(el('div', 'activity', s.activity));
    if (s.context) {
      const ctx = el('div', 'ctx', `컨텍스트 ${s.context.pct}%${s.model ? ` · ${s.model}` : ''}${s.costUsd ? ` · $${s.costUsd.toFixed(2)}` : ''}`);
      ctx.append(meter(s.context.pct));
      c.append(ctx);
    }

    if (s.pending && s.pending.kind === 'permission') {
      const box = el('div', 'ask');
      box.append(el('b', '', `${s.pending.title} 해도 될까요?`));
      if (s.pending.detail) box.append(el('pre', '', s.pending.detail));
      const btns = el('div', 'btns');
      btns.append(button('허락', 'ok', () => decide(s.id, 'allow')));
      if (s.pending.canAlways) btns.append(button('항상 허락', '', () => decide(s.id, 'always')));
      btns.append(button('거절', '', () => decide(s.id, 'deny')));
      btns.append(el('span', 'spacer'));
      const cd = el('span', 'countdown');
      cd.dataset.expires = s.pending.expiresAt;
      btns.append(cd);
      box.append(btns);
      c.append(box);
    } else if (s.pending && s.pending.kind === 'reply') {
      if (s.lastMessage) c.append(el('div', 'message', s.lastMessage));
      const ta = el('textarea');
      ta.placeholder = '다음 지시를 입력하세요 (Enter 보내기 · Shift+Enter 줄바꿈)';
      ta.value = drafts.get(s.id) || '';
      ta.addEventListener('input', () => drafts.set(s.id, ta.value));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          send(s.id, ta.value);
        }
      });
      const btns = el('div', 'btns');
      btns.append(button('보내기', 'primary', () => send(s.id, ta.value)));
      btns.append(button('터미널에서 할게요', 'ghost', () => release(s.id)));
      btns.append(el('span', 'spacer'));
      const cd = el('span', 'countdown');
      cd.dataset.expires = s.pending.expiresAt;
      btns.append(cd);
      c.append(ta, btns);
    } else if (s.status === 'done' && s.lastMessage) {
      c.append(el('div', 'message', s.lastMessage));
      if (!settings.awayMode) c.append(el('div', 'hint', '💡 자리 비움을 켜 두면 작업이 끝났을 때 여기서 바로 다음 지시를 보낼 수 있어요.'));
    }

    // 하단: 터미널 이동 · 결과 공유
    const foot = el('div', 'btns footer');
    foot.append(button('터미널로 이동', 'ghost', () => focus(s.id)));
    const others = sessions.filter((o) => o.id !== s.id);
    if (s.lastMessage && others.length) {
      const sel = el('select');
      sel.append(new Option('결과 공유 → 세션 선택', ''));
      for (const o of others) sel.append(new Option(`→ ${o.name}`, o.id));
      sel.addEventListener('change', async () => {
        if (!sel.value) return;
        const r = await api.share(s.id, sel.value);
        toast(r.ok ? (r.delivered === 'now' ? '바로 전달했어요!' : '다음 대화에 붙여서 전달할게요') : r.error);
        sel.value = '';
      });
      foot.append(sel);
    }
    if (s.sharedQueued) foot.append(el('span', 'countdown', `📎 공유 ${s.sharedQueued}건 대기`));
    c.append(foot);
    return c;
  }

  function meter(pct) {
    const m = el('div', 'meter' + (pct >= 85 ? ' danger' : pct >= 60 ? ' warn' : ''));
    const fill = el('div');
    fill.style.width = `${Math.min(100, pct)}%`;
    m.append(fill);
    return m;
  }

  function left(at) {
    const sec = Math.max(0, Math.round(at - Date.now() / 1000));
    const h = Math.floor(sec / 3600);
    return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간` : `${h}시간 ${Math.floor((sec % 3600) / 60)}분`;
  }

  function renderLimits() {
    const box = $('limits');
    const items = [];
    for (const [key, label] of [['five_hour', '5시간'], ['seven_day', '주간']]) {
      const w = limits && limits[key];
      if (!w) continue;
      const d = el('div', 'limit', `${label} ${Math.round(w.pct)}% · ${left(w.resetsAt)} 뒤`);
      d.title = `${label} 한도 ${w.pct}% 사용 · ${left(w.resetsAt)} 뒤 초기화`;
      d.append(meter(w.pct));
      items.push(d);
    }
    box.replaceChildren(...items);
    box.classList.toggle('hidden', !items.length);
  }

  // ---------- 동작 ----------

  async function decide(id, decision) {
    const ok = await api.decide(id, decision);
    toast(ok ? { allow: '허락했어요!', always: '앞으로도 허락할게요', deny: '거절했어요' }[decision] : '이미 처리된 요청이에요');
  }

  async function send(id, text) {
    if (!String(text).trim()) return;
    const ok = await api.reply(id, text);
    if (ok) {
      drafts.delete(id);
      toast('전달했어요! 다시 일하러 가요 🐾');
    } else toast('이 세션은 지금 답장을 기다리지 않아요');
  }

  async function release(id) {
    await api.release(id);
    toast('터미널로 돌려보냈어요');
  }

  async function focus(id) {
    const r = await api.focusSession(id);
    if (!r.ok) toast(r.error || '터미널을 찾지 못했어요');
  }

  // ---------- 그리기 ----------

  function render() {
    const active = document.activeElement;
    const activeId = active && active.closest && active.closest('.card') ? active.closest('.card').dataset.id : null;
    const selStart = active && active.selectionStart;

    $('avatar').src = avatarUrl();
    const waiting = sessions.filter((s) => s.pending).length;
    const working = sessions.filter((s) => s.status === 'working').length;
    $('summary').textContent = sessions.length
      ? `세션 ${sessions.length}개 · ${waiting ? `🔔 ${waiting}개가 기다려요` : working ? `⚙️ ${working}개 작업 중` : '모두 한가해요'}`
      : 'Claude Code 세션을 시작하면 여기에 나타나요';
    renderLimits();
    $('away').checked = !!settings.awayMode;
    $('away').closest('.away').classList.toggle('on', !!settings.awayMode);
    $('connect').classList.toggle('hidden', !!(claude && claude.installed));

    const list = $('list');
    // 기다리는 세션을 위로
    const sorted = [...sessions].sort((a, b) => (b.pending ? 1 : 0) - (a.pending ? 1 : 0) || b.updatedAt - a.updatedAt);
    if (!sorted.length) {
      const empty = el('div', 'empty');
      const img = el('img');
      img.src = avatarUrl();
      empty.append(img, el('p', '', '아직 열린 세션이 없어요.'), el('p', '', '터미널에서 claude 를 실행하면 제가 지켜볼게요!'));
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(...sorted.map(card));
    }

    // 닫힌 세션 (rcup)
    $('restore-box').classList.toggle('hidden', !restorable.length);
    $('restore-hint').textContent = settings.restoreRemoteControl
      ? '원격 제어(--rc)를 켠 채로 새 터미널 창에서 이어서 열어요.'
      : '새 터미널 창에서 claude --resume 으로 이어서 열어요.';
    $('restore-list').replaceChildren(
      ...restorable.slice(0, 12).map((h) => {
        const row = el('div', 'restore-item');
        row.append(el('span', 'name', h.name), el('span', 'ago', ago(h.lastSeen)));
        row.append(button('열기', '', async () => report(await api.restoreSessions([h.id]))));
        row.append(button('✕', 'icon', async () => {
          await api.forgetSession(h.id);
          refresh();
        }));
        return row;
      })
    );

    // 입력 중이던 곳으로 포커스 복원
    if (activeId) {
      const ta = list.querySelector(`.card[data-id="${CSS.escape(activeId)}"] textarea`);
      if (ta) {
        ta.focus();
        if (Number.isFinite(selStart)) ta.setSelectionRange(selStart, selStart);
      }
    }
    if (focusId) {
      const target = list.querySelector(`.card[data-id="${CSS.escape(focusId)}"]`);
      if (target) {
        target.scrollIntoView({ block: 'nearest' });
        const ta = target.querySelector('textarea');
        if (ta && !activeId) ta.focus();
      }
      focusId = null;
    }
    tickCountdowns();
  }

  function report(r) {
    toast(r.ok ? `${r.opened}개 세션을 다시 열었어요` : r.error || '열지 못했어요');
  }

  function tickCountdowns() {
    for (const cd of document.querySelectorAll('.countdown[data-expires]')) {
      const left = Math.max(0, Math.round((Number(cd.dataset.expires) - Date.now()) / 1000));
      cd.textContent = left >= 60 ? `${Math.ceil(left / 60)}분 남음` : `${left}초 남음`;
    }
  }
  setInterval(tickCountdowns, 1000);

  async function refresh() {
    const r = await api.sessions();
    sessions = r.list;
    restorable = r.restorable;
    render();
  }

  // ---------- 이벤트 ----------

  $('close').addEventListener('click', () => api.closePanel());
  $('away').addEventListener('change', (e) => api.menuAction('away-toggle', { value: e.target.checked }));
  $('connect-btn').addEventListener('click', async () => {
    const r = await api.connectClaude();
    toast(r.ok ? '연결했어요! 새로 여는 세션부터 적용돼요' : r.error || '연결하지 못했어요');
  });
  $('restore-all').addEventListener('click', async () => report(await api.restoreSessions(null)));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.closePanel();
  });

  api.onSessions((p) => {
    sessions = p.list;
    refresh();
  });
  api.onSettings((s) => {
    settings = s;
    render();
  });
  api.onSkins((p) => {
    skin = p.active;
    render();
  });
  api.onLimits((l) => {
    limits = l;
    renderLimits();
  });
  api.onClaudeStatus((c) => {
    claude = c;
    render();
  });
  api.onPanelFocus((id) => {
    focusId = id;
    render();
  });
  setInterval(render, 30000); // "n분 전" 갱신

  render();
})();
