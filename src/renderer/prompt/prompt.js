// 펫에게 말 걸기: 새 작업을 시키거나, 세션에 다음 지시를 보냅니다.
(async () => {
  const api = window.codepup;
  const boot = await api.init();
  const ORIGIN = boot.origin;
  let settings = boot.settings;
  let skin = boot.skin;
  let ctx = { sessions: [], recent: [], folders: [], home: '' };
  let wanted = decodeURIComponent(location.hash.slice(1)) || null;
  const $ = (id) => document.getElementById(id);

  const ROUTE_HINT = {
    new: '터미널 없이 제가 이 폴더에서 Claude Code 를 실행할게요',
    reply: '기다리고 있는 세션에 바로 전달할게요',
    resume: '이 대화를 이어서 제가 실행할게요',
    fork: '터미널 세션은 그대로 두고, 대화를 이어받아 제가 실행할게요',
    busy: '지금 일하는 중이에요. 끝나면 말 걸어 주세요',
  };

  const shortPath = (p) => String(p || '').replace(/^\/(Users|home)\/[^/]+/, '~');

  function avatarUrl() {
    const c = settings.customImages && settings.customImages.happy;
    if (c) return `${ORIGIN}/user-media/${encodeURIComponent(c)}`;
    return `${ORIGIN}/${skin.base}${skin.images.happy || skin.images.default}`;
  }

  function fillTargets() {
    const sel = $('target');
    const opts = [new Option('✨ 새 작업 시키기', 'new')];
    for (const s of ctx.sessions) {
      const tag = { reply: '💬 기다리는 중', resume: '🐶 이어서', fork: '↪︎ 이어받기', busy: '⚙️ 작업 중' }[s.route] || '';
      opts.push(new Option(`${s.name} · ${tag}`, s.id));
    }
    for (const h of ctx.recent) opts.push(new Option(`🔁 ${h.name} · 닫힌 세션 이어서`, h.id));
    sel.replaceChildren(...opts);
    const pick = wanted && opts.some((o) => o.value === wanted) ? wanted : ctx.sessions.find((s) => s.route === 'reply') ? ctx.sessions.find((s) => s.route === 'reply').id : 'new';
    sel.value = pick;
    wanted = null;
  }

  function fillFolders(selected) {
    const sel = $('folder');
    const list = [...ctx.folders];
    if (selected && !list.includes(selected)) list.unshift(selected);
    if (!list.length && ctx.home) list.push(ctx.home);
    sel.replaceChildren(...list.map((f) => new Option(shortPath(f), f)));
    if (selected) sel.value = selected;
  }

  function routeOf(target) {
    if (target === 'new') return 'new';
    const s = ctx.sessions.find((x) => x.id === target);
    return s ? s.route : 'resume';
  }

  function update() {
    const target = $('target').value;
    const route = routeOf(target);
    $('folder-row').classList.toggle('hidden', target !== 'new');
    $('hint').textContent = ROUTE_HINT[route] || '';
    $('send').disabled = route === 'busy';
    $('title').textContent = `${settings.name}에게 부탁하기`;
    $('avatar').src = avatarUrl();
  }

  async function load() {
    ctx = await api.promptContext();
    fillTargets();
    fillFolders();
    update();
    $('error').classList.add('hidden');
    $('text').focus();
  }

  async function send() {
    const text = $('text').value.trim();
    if (!text) return;
    $('send').disabled = true;
    const target = $('target').value;
    const r = await api.sendPrompt({ target, text, cwd: target === 'new' ? $('folder').value : undefined });
    $('send').disabled = false;
    if (r.ok) {
      $('text').value = '';
      $('error').classList.add('hidden');
    } else {
      $('error').textContent = r.error || '보내지 못했어요';
      $('error').classList.remove('hidden');
    }
  }

  $('target').addEventListener('change', update);
  $('pick').addEventListener('click', async () => {
    const dir = await api.pickFolder();
    if (dir) fillFolders(dir);
  });
  $('send').addEventListener('click', send);
  $('close').addEventListener('click', () => api.closePrompt());
  $('text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.closePrompt();
  });
  window.addEventListener('focus', () => $('text').focus());

  api.onPromptTarget((id) => {
    wanted = id;
    load();
  });
  api.onSessions(() => {
    if (!document.hasFocus()) load();
  });
  api.onSettings((s) => {
    settings = s;
    update();
  });
  api.onSkins((p) => {
    skin = p.active;
    update();
  });

  load();
})();
