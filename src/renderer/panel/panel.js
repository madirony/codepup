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
  const expanded = new Set(); // 펼쳐 둔 세션
  let filter = '';
  let focusId = decodeURIComponent(location.hash.slice(1)) || null;
  const $ = (id) => document.getElementById(id);

  const STATUS = {
    permission: ['permission', '🔔 허락 대기'],
    working: ['working', '⚙️ 작업 중'],
    done: ['done', '✅ 완료'],
    waiting: ['waiting', '⏳ 입력 대기'],
    idle: ['idle', '💤 대기'],
  };

  function statusOf(s) {
    if (s.pending && s.pending.kind === 'permission') return STATUS.permission;
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

  const md = window.CodePupMd;
  const RANK = { permission: 0, working: 1, done: 2, waiting: 3, idle: 4 };
  const rank = (s) => (s.pending ? 0 : RANK[s.status] ?? 5);

  function mdBox(text) {
    const box = el('div', 'md');
    box.innerHTML = md.toHtml(text); // md.js 가 모든 글자를 이스케이프한 뒤 태그만 붙임
    return box;
  }

  // 허락 대기: 크게
  function card(s) {
    const [cls, label] = statusOf(s);
    const c = el('div', 'card attn' + (s.id === focusId ? ' focus' : ''));
    c.dataset.id = s.id;
    const top = el('div', 'row');
    top.append(el('span', `chip ${cls}`, label), el('span', 'name', s.name), el('span', 'ago', ago(s.updatedAt)));
    c.append(top, el('div', 'cwd', shortPath(s.cwd)));
    const box = el('div', 'ask');
    box.append(el('b', '', `${s.pending.title} 해도 될까요?`));
    if (s.pending.detail) box.append(el('pre', '', s.pending.detail));
    const btns = el('div', 'btns');
    btns.append(button('허락', 'ok', () => decide(s.id, 'allow')));
    if (s.pending.canAlways) btns.append(button('항상 허락', '', () => decide(s.id, 'always')));
    btns.append(button('거절', '', () => decide(s.id, 'deny')));
    btns.append(button('터미널', 'ghost', () => focus(s.id)));
    btns.append(el('span', 'spacer'));
    const cd = el('span', 'countdown');
    cd.dataset.expires = s.pending.expiresAt;
    btns.append(cd);
    box.append(btns);
    c.append(box);
    return c;
  }

  // 나머지: 한 줄 (누르면 마지막 답변 · 공유 · 터미널)
  function line(s) {
    const [cls, label] = statusOf(s);
    const open = expanded.has(s.id);
    const item = el('div', 'line' + (open ? ' open' : '') + (s.id === focusId ? ' focus' : ''));
    item.dataset.id = s.id;
    const head = el('div', 'line-head');
    head.title = shortPath(s.cwd);
    const dot = el('span', `dot ${cls}`);
    dot.title = label;
    const sub = s.status === 'done' && s.lastMessage ? md.summary(s.lastMessage, 60) : s.activity || label;
    head.append(dot, el('span', 'name', s.name), el('span', 'sub', sub), el('span', 'ago', ago(s.updatedAt)));
    head.addEventListener('click', () => {
      if (open) expanded.delete(s.id);
      else expanded.add(s.id);
      render();
    });
    item.append(head);
    if (!open) return item;

    const body = el('div', 'line-body');
    body.append(el('div', 'cwd', shortPath(s.cwd)));
    if (s.lastPrompt) body.append(el('div', 'prompt', `🙋 ${s.lastPrompt}`));
    if (s.lastMessage) body.append(mdBox(s.lastMessage));
    const foot = el('div', 'btns');
    foot.append(button('터미널로 이동', 'ghost', () => focus(s.id)));
    const others = sessions.filter((o) => o.id !== s.id);
    if (s.lastMessage && others.length) {
      const sel = el('select');
      sel.append(new Option('결과 공유 → 세션 선택', ''));
      for (const o of others) sel.append(new Option(`→ ${o.name}`, o.id));
      sel.addEventListener('change', async () => {
        if (!sel.value) return;
        const r = await api.share(s.id, sel.value);
        toast(r.ok ? '다음 대화에 붙여서 전달할게요' : r.error);
        sel.value = '';
      });
      foot.append(sel);
    }
    if (s.sharedQueued) foot.append(el('span', 'countdown', `📎 공유 ${s.sharedQueued}건 대기`));
    body.append(foot);
    item.append(body);
    return item;
  }

  // ---------- 동작 ----------

  async function decide(id, decision) {
    const ok = await api.decide(id, decision);
    toast(ok ? { allow: '허락했어요!', always: '앞으로도 허락할게요', deny: '거절했어요' }[decision] : '이미 처리된 요청이에요');
  }

  async function focus(id) {
    const r = await api.focusSession(id);
    if (!r.ok) toast(r.error || '터미널을 찾지 못했어요');
  }

  // ---------- 그리기 ----------

  function render() {
    $('avatar').src = avatarUrl();
    const waiting = sessions.filter((s) => s.pending).length;
    const working = sessions.filter((s) => s.status === 'working').length;
    $('summary').textContent = sessions.length
      ? `세션 ${sessions.length}개 · ${waiting ? `🔔 ${waiting}개가 허락을 기다려요` : working ? `⚙️ ${working}개 작업 중` : '모두 한가해요'}`
      : 'Claude Code 세션을 시작하면 여기에 나타나요';
    $('connect').classList.toggle('hidden', !!(claude && claude.installed));
    $('filter').classList.toggle('hidden', sessions.length < 6 && !filter);

    const list = $('list');
    const q = filter.trim().toLowerCase();
    const shown = sessions
      .filter((s) => !q || `${s.name} ${s.cwd} ${s.activity}`.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    if (focusId) expanded.add(focusId);
    const asks = shown.filter((s) => s.pending && s.pending.kind === 'permission');
    const rest = shown.filter((s) => !(s.pending && s.pending.kind === 'permission'));
    if (!sessions.length) {
      const empty = el('div', 'empty');
      const img = el('img');
      img.src = avatarUrl();
      empty.append(img, el('p', '', '아직 열린 세션이 없어요.'), el('p', '', '터미널에서 claude 를 실행하면 제가 지켜볼게요!'));
      list.replaceChildren(empty);
    } else {
      const parts = [...asks.map(card)];
      if (rest.length) {
        const box = el('div', 'lines');
        box.append(...rest.map(line));
        parts.push(box);
      }
      if (!shown.length) parts.push(el('p', 'muted pad', '검색 결과가 없어요'));
      list.replaceChildren(...parts);
    }

    // 닫힌 세션 (rcup)
    $('restore-box').classList.toggle('hidden', !restorable.length);
    $('restore-hint').textContent = settings.restoreRemoteControl
      ? '원격 제어(--rc)를 켠 채로 터미널 탭에서 이어서 열어요.'
      : '터미널 탭에서 claude --resume 으로 이어서 열어요.';
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

    if (focusId) {
      const target = list.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
      if (target) target.scrollIntoView({ block: 'nearest' });
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
  $('filter').addEventListener('input', (e) => {
    filter = e.target.value;
    render();
    e.target.focus();
  });
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
