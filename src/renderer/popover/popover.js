// 메뉴 막대 팝오버: 허락 기다리는 세션 · 세션 목록 · 시스템 상태 · 잠자기 방지를 한 화면에
(async () => {
  const api = window.codepup;
  const md = window.CodePupMd;
  const boot = await api.init();
  const ORIGIN = boot.origin;
  let settings = boot.settings;
  let skin = boot.skin;
  let sessions = boot.sessions.list;
  let restorable = boot.sessions.restorable || [];
  let awake = boot.awake || {};
  let claude = boot.claude;
  const cpuHist = [];
  let picking = false; // 닫힌 세션 고르는 중
  const picked = new Set();
  const $ = (id) => document.getElementById(id);

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const button = (text, cls, fn) => {
    const b = el('button', cls, text);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return '방금';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    return `${Math.floor(s / 86400)}일 전`;
  };
  const avatarUrl = () => {
    const custom = settings.customImages && settings.customImages.happy;
    if (custom) return `${ORIGIN}/user-media/${encodeURIComponent(custom)}`;
    return skin ? `${ORIGIN}/${skin.base}${skin.images.happy || skin.images.default}` : '';
  };

  // ---------- 시스템 ----------
  function setBar(id, pct, warnAt = 80) {
    const bar = $(id);
    bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    bar.style.background = pct >= 90 ? 'var(--pink)' : pct >= warnAt ? 'var(--warn)' : '';
  }
  function renderStats(st) {
    if (!st) return;
    $('cpu').textContent = `${st.cpu}%`;
    cpuHist.push(st.cpu);
    while (cpuHist.length > 30) cpuHist.shift();
    const n = Math.max(2, cpuHist.length);
    $('spark').setAttribute('points', cpuHist.map((v, i) => `${(i / (n - 1)) * 60},${13 - (v / 100) * 12}`).join(' '));
    $('mem').textContent = `${st.mem.percent}%`;
    setBar('mem-bar', st.mem.percent);
    if (st.disk) {
      $('disk').textContent = `${st.disk.percent}%`;
      setBar('disk-bar', st.disk.percent, 85);
    }
    if (st.battery) {
      $('bat').textContent = `${st.battery.percent}%`;
      $('bat-k').textContent = st.battery.charging ? '⚡ 충전 중' : '🔋 배터리';
      const b = $('bat-bar');
      b.style.width = `${st.battery.percent}%`;
      b.style.background = st.battery.percent <= 20 ? 'var(--pink)' : 'var(--ok)';
    } else {
      $('bat').textContent = '–';
      $('bat-k').textContent = '🔌 전원';
    }
  }

  // ---------- 세션 ----------
  const RANK = { permission: 0, working: 1, done: 2 };
  const rank = (s) => (s.pending ? 0 : RANK[s.status] ?? 3);

  function askCard(s) {
    const c = el('div', 'ask');
    const t = el('div', 't');
    const left = el('span', 'left');
    left.dataset.expires = s.pending.expiresAt;
    t.append('🔔 ', el('b', '', s.name), left);
    c.append(t, el('code', '', `${s.pending.title}${s.pending.detail ? `: ${s.pending.detail}` : ''}`));
    const btns = el('div', 'btns');
    btns.append(button('허락', 'btn ok', () => api.decide(s.id, 'allow')));
    if (s.pending.canAlways) btns.append(button('항상 허락', 'btn', () => api.decide(s.id, 'always')));
    btns.append(button('거절', 'btn', () => api.decide(s.id, 'deny')));
    btns.append(button('터미널', 'btn push', () => api.focusSession(s.id)));
    c.append(btns);
    return c;
  }

  function row(s) {
    const r = el('div', 'row');
    const cls = s.needsReopen ? 'muted' : s.status === 'working' ? 'working' : s.status === 'done' ? 'done' : '';
    const sub = s.needsReopen
      ? '🔕 알림 꺼짐 · 위에서 켜기'
      : s.status === 'done' && s.lastMessage
        ? md.summary(s.lastMessage, 50)
        : s.activity || '대기';
    r.append(el('span', `dot ${cls}`), el('b', '', s.name), el('span', 's', sub), el('span', 'a', ago(s.updatedAt)));
    r.title = `${s.cwd || ''}\n눌러서 세션 보드에서 보기`;
    r.addEventListener('click', () => {
      api.menuAction('open-panel', { sessionId: s.id });
      api.closePopover();
    });
    return r;
  }

  function render() {
    $('avatar').src = avatarUrl();
    $('name').textContent = settings.name;
    $('board-key').textContent = window.CodePupKeys.label(settings.panelShortcut);
    const asks = sessions.filter((s) => s.pending && s.pending.kind === 'permission');
    const working = sessions.filter((s) => s.status === 'working').length;
    $('summary').textContent = !sessions.length
      ? 'Claude Code 세션을 기다리는 중이에요'
      : `세션 ${sessions.length}개 · ${asks.length ? `🔔 ${asks.length}개가 허락을 기다려요` : working ? `⚙️ ${working}개 일하는 중` : '모두 쉬는 중'}`;
    $('connect').classList.toggle('hidden', !!(claude && claude.installed));

    $('asks-box').classList.toggle('hidden', !asks.length);
    $('asks-count').textContent = asks.length || '';
    $('asks').replaceChildren(...asks.map(askCard));

    const muted = sessions.filter((s) => s.needsReopen);
    $('muted').classList.toggle('hidden', !muted.length);
    $('muted-text').textContent = `🔕 알림이 꺼진 세션 ${muted.length}개 (연결 전에 연 세션)`;

    const rest = sessions.filter((s) => !(s.pending && s.pending.kind === 'permission')).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    // 많아도 5개까지만 (일하는 중 · 끝남 순), 나머지는 보드에서
    const MAX = 5;
    const rows = rest.slice(0, MAX).map(row);
    if (rest.length > MAX) {
      const more = el('div', 'row more', `… 외 ${rest.length - MAX}개 · 크게 보기`);
      more.addEventListener('click', () => {
        api.menuAction('open-panel', {});
        api.closePopover();
      });
      rows.push(more);
    }
    $('list').replaceChildren(...(rows.length ? rows : [el('div', 'empty', sessions.length ? '다른 세션은 없어요' : '터미널에서 claude 를 실행하면 여기에 떠요')]));

    // 닫힌 세션 고르기 (일부만 열 수 있게)
    if (picking && !restorable.length) picking = false;
    for (const id of [...picked]) if (!restorable.some((h) => h.id === id)) picked.delete(id);
    $('pick-box').classList.toggle('hidden', !picking);
    $('restore').classList.toggle('active', picking);
    if (picking) {
      $('pick').replaceChildren(
        ...restorable.map((h) => {
          const r = el('label', 'pick-row');
          const cb = el('input');
          cb.type = 'checkbox';
          cb.checked = picked.has(h.id);
          cb.addEventListener('change', () => {
            if (cb.checked) picked.add(h.id);
            else picked.delete(h.id);
            render();
          });
          const why = h.endReason === 'vanished' ? '갑자기 꺼짐' : '창을 닫음';
          r.append(cb, el('b', '', h.name), el('span', 's', `${why} · ${ago(h.lastSeen)}`));
          return r;
        })
      );
      $('pick-open').disabled = !picked.size;
      $('pick-open').textContent = picked.size ? `선택한 ${picked.size}개 열기` : '열 세션을 골라요';
      $('pick-all').textContent = picked.size === restorable.length ? '모두 해제' : '모두 선택';
    }

    // 아래 버튼
    $('restore').disabled = !restorable.length;
    $('restore-sub').textContent = restorable.length ? `${restorable.length}개 · 골라서 열기` : '없음';
    const autoOn = settings.keepAwake !== false;
    const on = autoOn || settings.keepAwakeManual;
    $('awake-box').classList.toggle('on', !!awake.active);
    $('awake-sub').textContent = settings.keepAwakeManual
      ? '계속 깨어 있기 · 켜짐'
      : !autoOn
        ? '꺼짐'
        : awake.active
          ? awake.reason && awake.reason.count
            ? `세션 ${awake.reason.count}개 · 켜짐`
            : '켜짐'
          : settings.keepAwakeMode === 'working'
            ? '일할 때만 · 대기'
            : '세션 열리면 · 대기';
    $('awake').title = on ? '눌러서 끄기' : '눌러서 켜기';
    $('lid').classList.toggle('on', !!awake.lid);
    $('lid-sub').textContent = `잠들지 않기 · ${awake.lid ? '켜짐' : '꺼짐'}`;
    tick();
    requestAnimationFrame(() => api.resizePopover(document.getElementById('pop').offsetHeight));
  }

  function tick() {
    for (const e of document.querySelectorAll('[data-expires]')) {
      const left = Math.max(0, Math.round((Number(e.dataset.expires) - Date.now()) / 1000));
      e.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 남음`;
    }
  }
  setInterval(tick, 1000);

  async function refresh() {
    const r = await api.sessions();
    sessions = r.list;
    restorable = r.restorable || [];
    render();
  }

  // ---------- 동작 ----------
  $('settings').addEventListener('click', () => {
    api.menuAction('open-settings', {});
    api.closePopover();
  });
  $('board').addEventListener('click', () => {
    api.menuAction('open-panel', {});
    api.closePopover();
  });
  $('connect-btn').addEventListener('click', () => api.connectClaude());
  $('muted-btn').addEventListener('click', () => api.reopenForHooks(null));
  $('restore').addEventListener('click', () => {
    if (!restorable.length) return;
    picking = !picking;
    render();
  });
  $('pick-all').addEventListener('click', () => {
    if (picked.size === restorable.length) picked.clear();
    else restorable.forEach((h) => picked.add(h.id));
    render();
  });
  $('pick-cancel').addEventListener('click', () => {
    picking = false;
    render();
  });
  $('pick-open').addEventListener('click', async () => {
    if (!picked.size) return;
    const ids = [...picked];
    picked.clear();
    picking = false;
    render();
    await api.restoreSessions(ids);
    api.closePopover();
  });
  $('awake').addEventListener('click', () => api.menuAction('awake-toggle', {}));
  $('awake-more').addEventListener('click', () => api.menuAction('awake-menu', {}));
  $('lid').addEventListener('click', () => api.menuAction('awake-lid', { value: !awake.lid }));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.closePopover();
  });

  api.onSessions((p) => {
    sessions = p.list;
    refresh();
  });
  api.onStats(renderStats);
  api.onAwake((a) => {
    awake = a;
    render();
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
  api.onPopoverShown(refresh);
  setInterval(render, 30000);

  renderStats(boot.stats);
  render();
  window.__popover = { render };
})();
