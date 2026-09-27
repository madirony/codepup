(async () => {
  const api = window.codepup;
  const boot = await api.init();
  const ORIGIN = boot.origin;
  let settings = boot.settings;
  let pet = boot.pet;
  let stats = boot.stats;
  let skins = boot.skins;
  let skin = boot.skin;
  let claude = boot.claude;
  const $ = (id) => document.getElementById(id);

  const mediaUrl = (name) => `${ORIGIN}/user-media/${encodeURIComponent(name)}`;
  const GB = 1024 ** 3;
  const fmtGB = (b) => (b / GB >= 100 ? Math.round(b / GB) : (b / GB).toFixed(1)) + 'GB';

  function toast(text) {
    let el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.style.opacity = '0'), 1800);
  }

  // ---------- 탭 ----------
  function showTab(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  if (location.hash) showTab(location.hash.slice(1));
  api.onSettingsTab(showTab);

  // ---------- 상태 ----------
  const skinFile = (sk, key) => {
    const f = sk.images[key] || sk.images.default;
    return `${ORIGIN}/${sk.base}${f.split('/').map(encodeURIComponent).join('/')}`;
  };
  function heroImage() {
    const c = settings.customImages.default;
    return c ? mediaUrl(c) : skinFile(skin, 'default');
  }

  function renderPet() {
    $('hero-img').src = heroImage();
    $('hero-name').textContent = settings.name;
    $('hero-sub').textContent = `Lv.${pet.level}${pet.sleeping ? ' · 💤 자는 중' : ''}`;
    const set = (key, value, max, label) => {
      $(`m-${key}`).style.width = `${Math.round((value / max) * 100)}%`;
      $(`v-${key}`).textContent = label;
    };
    set('exp', pet.exp, pet.expToNext, `${pet.exp} / ${pet.expToNext}`);
    set('hunger', pet.hunger, 100, `${pet.hunger}%`);
    set('happiness', pet.happiness, 100, `${pet.happiness}%`);
    set('energy', pet.energy, 100, `${pet.energy}%`);
    const btn = $('btn-sleep');
    btn.dataset.action = pet.sleeping ? 'wake' : 'sleep';
    btn.textContent = pet.sleeping ? '☀️ 깨우기' : '💤 재우기';
    let line = '';
    if (pet.sleeping) line = '쿨쿨 자는 중이에요. 에너지가 다 차면 알아서 일어나요.';
    else if (pet.hunger < 25) line = '배고파해요! 밥을 주세요 🍚';
    else if (pet.energy < 25) line = '졸려해요… 재워 주세요 💤';
    else if (pet.happiness < 30) line = '심심해해요. 쓰다듬어 주세요 🤚';
    else line = '기분 좋게 뛰어놀고 있어요. 쪼아요~';
    $('status-line').textContent = `${line}  (지금까지 밥 ${pet.totalFed}번 · 쓰다듬기 ${pet.totalPets}번)`;
    $('born').textContent = `함께한 지 ${Math.max(1, Math.ceil((Date.now() - pet.bornAt) / 86400000))}일째`;
  }

  document.querySelectorAll('[data-action]').forEach((b) =>
    b.addEventListener('click', () => api.menuAction(b.dataset.action))
  );

  // ---------- 일반 설정 ----------
  const fields = {
    name: { type: 'text' },
    size: { type: 'range', num: true, fmt: (v) => `${v}px` },
    speed: { type: 'range', num: true, fmt: (v) => `×${Number(v).toFixed(1)}` },
    moveMode: { type: 'select' },
    cpuReactive: { type: 'check' },
    sprintThreshold: { type: 'range', num: true, fmt: (v) => `${v}%` },
    idleSleep: { type: 'check' },
    idleSleepMinutes: { type: 'number', num: true },
    soundEnabled: { type: 'check' },
    volume: { type: 'range', num: true, fmt: (v) => `${Math.round(v * 100)}%` },
    ambientSounds: { type: 'check' },
    bubbles: { type: 'check' },
    showOnFullscreen: { type: 'check' },
    launchAtLogin: { type: 'check' },
    hidden: { type: 'check' },
    awayMode: { type: 'check' },
    permissionWaitSec: { type: 'number', num: true },
    replyWaitMin: { type: 'number', num: true },
    restoreRemoteControl: { type: 'check' },
    restoreSkipPermissions: { type: 'check' },
    restoreTerminal: { type: 'select' },
    restoreExtraArgs: { type: 'text' },
    keepAwake: { type: 'check' },
    keepAwakeMode: { type: 'select' },
    keepAwakeManual: { type: 'check' },
  };

  function fillForm() {
    for (const [key, f] of Object.entries(fields)) {
      const el = $(`s-${key}`);
      if (document.activeElement === el) continue;
      if (f.type === 'check') el.checked = !!settings[key];
      else el.value = settings[key];
      const out = $(`o-${key}`);
      if (out && f.fmt) out.textContent = f.fmt(settings[key]);
    }
    if (document.activeElement !== $('s-phrases')) $('s-phrases').value = settings.phrases.join('\n');
    document.querySelectorAll('[data-tray]').forEach((el) => (el.checked = !!settings.tray[el.dataset.tray]));
  }

  for (const [key, f] of Object.entries(fields)) {
    const el = $(`s-${key}`);
    const read = () => (f.type === 'check' ? el.checked : f.num ? Number(el.value) : el.value);
    const evt = f.type === 'range' ? 'input' : 'change';
    el.addEventListener(evt, () => {
      const v = read();
      const out = $(`o-${key}`);
      if (out && f.fmt) out.textContent = f.fmt(v);
      api.updateSettings({ [key]: v });
    });
  }
  $('s-phrases').addEventListener('change', (e) => {
    api.updateSettings({ phrases: e.target.value.split('\n') });
    toast('대사를 저장했어요');
  });
  document.querySelectorAll('[data-tray]').forEach((el) =>
    el.addEventListener('change', () => api.updateSettings({ tray: { [el.dataset.tray]: el.checked } }))
  );

  // ---------- 메뉴 막대 실시간 값 ----------
  function renderStats() {
    const rows = [['🖥 CPU', stats.cpu, `${stats.cpu}%`]];
    rows.push(['🧠 메모리', stats.mem.percent, `${stats.mem.percent}% · ${fmtGB(stats.mem.used)} / ${fmtGB(stats.mem.total)}`]);
    if (stats.disk) rows.push(['💾 저장공간', stats.disk.percent, `${stats.disk.percent}% · ${fmtGB(stats.disk.used)} / ${fmtGB(stats.disk.total)}`]);
    if (stats.battery) rows.push(['🔋 배터리', stats.battery.percent, `${stats.battery.percent}%${stats.battery.charging ? ' · 충전 중' : ''}`]);
    const box = $('live-stats');
    box.replaceChildren(
      ...rows.map(([label, v, text]) => {
        const row = document.createElement('div');
        row.className = 'meter';
        const l = document.createElement('span');
        l.textContent = label;
        const track = document.createElement('div');
        track.className = 'track';
        const fill = document.createElement('div');
        fill.className = 'fill sys';
        fill.style.width = `${v}%`;
        track.appendChild(fill);
        const b = document.createElement('b');
        b.textContent = text;
        row.append(l, track, b);
        return row;
      })
    );
  }

  // ---------- 커스텀 ----------
  let previewAudio = null;
  function previewSound(slot) {
    if (previewAudio) previewAudio.pause();
    const custom = settings.customSounds[slot.key];
    const files = skin.sounds[slot.key] || [];
    if (!custom && !files.length) {
      // 스킨에 파일이 없으면 옹알이 목소리
      PupVoice.setVolume(settings.volume);
      if (slot.key === 'chatter' || slot.key === 'greet') PupVoice.speak(`안녕하세요 ${settings.name}예요`, skin.voice.pitch || 1);
      else PupVoice.cue(slot.key, skin.voice.pitch || 1);
      return;
    }
    const url = custom ? mediaUrl(custom) : `${ORIGIN}/${skin.base}${files[Math.floor(Math.random() * files.length)]}`;
    previewAudio = new Audio(url);
    previewAudio.volume = settings.volume;
    previewAudio.play().catch(() => {});
  }

  async function pick(kind, slot) {
    const res = await api.pickMedia(kind, slot);
    if (res.ok) toast(`바꿨어요! ${settings.name}를 확인해 보세요`);
    else if (res.error) toast(res.error);
  }

  function button(text, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderSkins() {
    $('skin-list').replaceChildren(
      ...skins.map((sk) => {
        const el = document.createElement('div');
        el.className = 'slot skin' + (sk.id === skin.id ? ' custom' : '');
        const img = document.createElement('img');
        img.src = skinFile(sk, 'default');
        const label = document.createElement('div');
        label.textContent = sk.name;
        const desc = document.createElement('div');
        desc.className = 'muted';
        desc.textContent = sk.description || (sk.voice.type === 'babble' ? '옹알이 목소리' : '녹음 목소리');
        const btns = document.createElement('div');
        btns.className = 'btns';
        if (sk.id === skin.id) btns.appendChild(button('사용 중', () => {}));
        else btns.appendChild(button('사용하기', () => api.updateSettings({ skin: sk.id })));
        if (sk.source === 'user') btns.appendChild(button('삭제', () => api.removeSkin(sk.id)));
        el.append(img, label, desc, btns);
        return el;
      })
    );
  }

  $('import-skin').addEventListener('click', async () => {
    const r = await api.importSkin();
    if (r.ok) toast('스킨을 불러왔어요!');
    else if (r.error) toast(r.error);
  });

  function renderCustom() {
    renderSkins();
    const imgBox = $('image-slots');
    imgBox.replaceChildren(
      ...boot.imageSlots.map((slot) => {
        const custom = settings.customImages[slot.key];
        const el = document.createElement('div');
        el.className = 'slot' + (custom ? ' custom' : '');
        const img = document.createElement('img');
        img.src = custom ? mediaUrl(custom) : settings.customImages.default ? mediaUrl(settings.customImages.default) : skinFile(skin, slot.key);
        const label = document.createElement('div');
        label.textContent = slot.label;
        const btns = document.createElement('div');
        btns.className = 'btns';
        btns.appendChild(button('업로드', () => pick('image', slot.key)));
        if (custom) btns.appendChild(button('기본', () => api.resetMedia('image', slot.key)));
        el.append(img, label, btns);
        return el;
      })
    );

    const soundBox = $('sound-slots');
    soundBox.replaceChildren(
      ...boot.soundSlots.map((slot) => {
        const custom = settings.customSounds[slot.key];
        const el = document.createElement('div');
        el.className = 'slot' + (custom ? ' custom' : '');
        const label = document.createElement('div');
        label.textContent = slot.label;
        const tag = document.createElement('span');
        tag.className = 'badge' + (custom ? '' : ' soft');
        tag.textContent = custom ? '커스텀' : (skin.sounds[slot.key] || []).length ? '스킨' : skin.voice.type === 'babble' ? '옹알이' : '없음';
        label.appendChild(tag);
        const btns = document.createElement('div');
        btns.className = 'btns';
        btns.appendChild(button('▶ 듣기', () => previewSound(slot)));
        btns.appendChild(button('업로드', () => pick('sound', slot.key)));
        if (custom) btns.appendChild(button('기본', () => api.resetMedia('sound', slot.key)));
        el.append(label, btns);
        return el;
      })
    );
  }

  $('reset-images').addEventListener('click', () => api.resetMedia('image', '*'));
  $('reset-sounds').addEventListener('click', () => api.resetMedia('sound', '*'));
  $('reset-pet').addEventListener('click', async () => {
    if (await api.resetPet()) toast(`새로운 ${settings.name}가 태어났어요!`);
  });
  $('open-data').addEventListener('click', () => api.openDataFolder());
  $('version').textContent = `v${boot.version}`;

  // ---------- Claude Code ----------
  function renderClaude() {
    const on = claude && claude.installed;
    $('cc-status').textContent = on ? '✅ 연결됨' : '⚪ 연결 안 됨';
    $('cc-status').className = 'status ' + (on ? 'on' : 'off');
    $('cc-connect').classList.toggle('hidden', !!on);
    $('cc-disconnect').classList.toggle('hidden', !on);
    $('cc-path').textContent = claude ? claude.settingsPath.replace(/^\/(Users|home)\/[^/]+/, '~') : '';
  }
  $('cc-connect').addEventListener('click', async () => {
    const r = await api.connectClaude();
    toast(r.ok ? '연결했어요! 새로 여는 세션부터 적용돼요' : r.error || '연결하지 못했어요');
    claude = await api.claudeStatus();
    renderClaude();
  });
  $('cc-disconnect').addEventListener('click', async () => {
    const r = await api.disconnectClaude();
    toast(r.ok ? '연결을 해제했어요' : r.error);
    claude = await api.claudeStatus();
    renderClaude();
  });
  $('cc-panel').addEventListener('click', () => api.menuAction('open-panel'));
  $('shortcut').textContent = (boot.shortcut || '').replace('CommandOrControl', boot.platform === 'darwin' ? '⌘' : 'Ctrl').replace('Shift', '⇧').replace(/\+/g, ' ');

  // ---------- 구독 ----------
  api.onPetState((p) => {
    pet = p;
    renderPet();
  });
  api.onSettings((s) => {
    const customChanged = JSON.stringify([s.customImages, s.customSounds]) !== JSON.stringify([settings.customImages, settings.customSounds]);
    settings = s;
    fillForm();
    renderPet();
    if (customChanged) renderCustom();
  });
  api.onStats((s) => {
    stats = s;
    renderStats();
  });
  api.onSkins((p) => {
    skins = p.skins;
    skin = p.active;
    renderPet();
    renderCustom();
  });
  api.onClaudeStatus((c) => {
    claude = c;
    renderClaude();
  });

  renderClaude();
  fillForm();
  renderPet();
  renderStats();
  renderCustom();
})();
