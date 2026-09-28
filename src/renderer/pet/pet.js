/* global PIXI */
// 화면을 뛰어다니는 펫. 창은 화면 전체를 덮는 투명 오버레이이고,
// 마우스가 펫 위에 있을 때만 클릭을 받도록 main 프로세스에 알려 줍니다.
(async () => {
  const api = window.codepup;
  const boot = await api.init();
  const ORIGIN = boot.origin;
  let settings = boot.settings;
  let petState = boot.pet;
  let stats = boot.stats;

  let skin = boot.skin;
  let sessions = boot.sessions.list;
  const IMAGE_SLOTS = Object.fromEntries(boot.imageSlots.map((s) => [s.key, s]));
  // 스킨에 없을 수도 있는 표정 → 대신 쓸 표정
  const FALLBACK = {
    eat2: 'eat',
    alert: 'surprised',
    worry: 'sad',
    surprised: 'happy',
    drool: 'happy',
    cry: 'carry',
    sneeze: 'happy',
    sad: 'hungry',
    hungry: 'default',
    zoom: 'run',
    tired: 'sleep',
  };
  const EXTRA_KEYS = ['eat2', 'drool', 'surprised', 'cry', 'zoom', 'sneeze', 'sad'];
  let RANDOM_EXPRESSIONS = ['happy'];

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const now = () => performance.now();

  // ---------------- 에셋 (스킨) ----------------

  const mediaUrl = (name) => `${ORIGIN}/user-media/${encodeURIComponent(name)}`;
  const skinUrl = (file) => `${ORIGIN}/${skin.base}${file.split('/').map(encodeURIComponent).join('/')}`;

  function imageUrl(key) {
    const custom = settings.customImages[key];
    if (custom) return mediaUrl(custom);
    // 기본 이미지를 직접 올렸다면 나머지 표정도 그 이미지로 통일 (다른 캐릭터와 섞이지 않게)
    if (settings.customImages.default && key !== 'food') return mediaUrl(settings.customImages.default);
    let k = key;
    for (let i = 0; i < 4 && !skin.images[k]; i++) k = FALLBACK[k] || 'default';
    return skinUrl(skin.images[k] || skin.images.default);
  }

  function soundUrls(key) {
    const custom = settings.customSounds[key];
    if (custom) return [mediaUrl(custom)];
    const files = skin.sounds[key];
    return files && files.length ? files.map(skinUrl) : [];
  }

  // 워커 대신 메인 스레드에서 이미지를 읽어 들임 (커스텀 이미지 형식 호환성)
  PIXI.Assets.setPreferences({ preferWorkers: false });

  const textures = {};
  async function loadTextures() {
    RANDOM_EXPRESSIONS = skin.expressions && skin.expressions.length ? skin.expressions : ['happy', 'surprised'];
    const keys = [...new Set([...Object.keys(IMAGE_SLOTS), ...EXTRA_KEYS, ...RANDOM_EXPRESSIONS])];
    await Promise.all(
      keys.map(async (key) => {
        try {
          textures[key] = await PIXI.Assets.load(imageUrl(key));
        } catch (err) {
          console.error('texture load failed', key, err);
          textures[key] = null;
        }
      })
    );
  }
  const tex = (key) => textures[key] || textures.default || PIXI.Texture.WHITE;

  // ---------------- 소리 ----------------
  // 스킨에 소리 파일이 있으면 파일로, 없으면 옹알이 목소리(WebAudio)로 재생

  let voice = null;
  let lastVoiceAt = 0;
  const babble = () => !skin.voice || skin.voice.type !== 'files';
  // 스킨별 말버릇 (예: 치와와 '멍멍')
  const cp = () => skin.catchphrase || '헤헤';
  function play(key, { ambient = false, interrupt = true, text = '' } = {}) {
    if (!settings.soundEnabled) return null;
    if (ambient && !settings.ambientSounds) return null;
    if (!interrupt && (now() - lastVoiceAt < 1500 || (voice && !voice.paused && !voice.ended))) return null;
    const urls = soundUrls(key);
    if (urls.length) {
      if (voice) voice.pause();
      const a = new Audio(pick(urls));
      a.volume = settings.volume;
      a.play().catch(() => {});
      voice = a;
      lastVoiceAt = now();
      return a;
    }
    if (babble()) {
      PupVoice.setVolume(settings.volume);
      if (text && (key === 'chatter' || key === 'greet')) PupVoice.speak(text, (skin.voice && skin.voice.pitch) || 1);
      else PupVoice.cue(key, (skin.voice && skin.voice.pitch) || 1);
      lastVoiceAt = now();
    }
    return null;
  }
  function stopVoice() {
    if (voice) voice.pause();
  }

  // ---------------- PIXI ----------------

  const app = new PIXI.Application({
    resizeTo: window,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.body.prepend(app.view);
  app.ticker.maxFPS = 60;

  await loadTextures();

  const foodLayer = new PIXI.Container();
  const shadow = new PIXI.Graphics();
  shadow.beginFill(0x000000, 0.16).drawEllipse(0, 0, 50, 10).endFill();
  const mesh = new PIXI.SimplePlane(tex('default'), 10, 10);
  app.stage.addChild(shadow, foodLayer, mesh);

  let buffer = null;
  let verts = null;
  let baseVerts = null;
  let vertVel = null;
  function syncVertexArrays() {
    buffer = mesh.geometry.getBuffer('aVertexPosition');
    verts = buffer.data;
    baseVerts = Float32Array.from(verts);
    vertVel = new Float32Array(verts.length);
  }
  syncVertexArrays();

  let texKey = 'default';
  function setTex(key) {
    const t = tex(key);
    texKey = key;
    if (mesh.texture === t) return;
    // 크기가 다른 텍스처면 PIXI가 정점 배열을 새로 만들고, render()에서 다시 동기화함
    mesh.texture = t;
  }

  // ---------------- 화면 · 펫 상태 ----------------

  const W = () => window.innerWidth;
  const H = () => window.innerHeight;
  const size = () => settings.size;
  const aspect = () => {
    const t = mesh.texture;
    return t && t.height ? t.width / t.height : 1;
  };
  const petW = () => size() * aspect();
  const ground = () => settings.moveMode === 'ground';
  const floorY = () => H() - 4;

  const bounds = () => ({
    minX: petW() / 2 + 4,
    maxX: W() - petW() / 2 - 4,
    minY: ground() ? floorY() : size() + 30,
    maxY: floorY(),
  });

  const P = {
    x: rand(W() * 0.25, W() * 0.75),
    y: -20,
    vx: 0,
    vy: 0,
    facing: 1,
    state: 'intro',
    t: 0, // 현재 상태에 머문 시간(초)
    dur: 0,
    target: null,
    hopPhase: 0,
    hop: 0,
    squash: 0,
    squashV: 0,
    data: {},
  };
  let landY = ground() ? floorY() : rand(H() * 0.45, H() * 0.8);

  // 이 상태들 중에는 다른 행동으로 넘어가도 괜찮음
  const INTERRUPTIBLE = new Set(['wander', 'idle', 'expr', 'chatter', 'hover', 'sing', 'sneezePrep', 'sneeze', 'landed']);
  const PHYSICS = new Set(['carry', 'flung', 'fall', 'intro']);

  function setState(state, opts = {}) {
    P.state = state;
    P.t = 0;
    P.dur = opts.dur || 0;
    P.data = opts.data || {};
    if (opts.tex) setTex(opts.tex);
    app.ticker.maxFPS = state === 'sleep' ? 15 : 60;
  }

  function moodTex() {
    if (petState.hunger < 25) return 'hungry';
    if (petState.energy < 25) return 'tired';
    if (petState.happiness < 25) return 'sad';
    return 'default';
  }

  function cpuLoad() {
    return settings.cpuReactive ? stats.cpu || 0 : 0;
  }

  function walkSpeed() {
    const lvl = Math.min(1.6, 1 + (petState.level - 1) * 0.03);
    const cpuF = 1 + (cpuLoad() / 100) * 2.5;
    let mood = 1;
    if (petState.hunger < 25) mood *= 0.65;
    if (petState.energy < 25) mood *= 0.6;
    return size() * 1.1 * settings.speed * lvl * cpuF * mood;
  }

  let distAcc = 0;
  function moveToward(tx, ty, speed, dt) {
    const dx = tx - P.x;
    const dy = ty - P.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return true;
    const step = Math.min(d, speed * dt);
    P.x += (dx / d) * step;
    P.y += (dy / d) * step;
    if (Math.abs(dx) > 2) P.facing = dx > 0 ? 1 : -1;
    P.hopPhase += (step / (size() * 0.42)) * Math.PI;
    distAcc += step;
    return d - step < 1;
  }

  function randomTarget(far = false) {
    const b = bounds();
    for (let i = 0; i < 8; i++) {
      const t = { x: rand(b.minX, b.maxX), y: ground() ? floorY() : rand(b.minY, b.maxY) };
      const d = Math.hypot(t.x - P.x, t.y - P.y);
      if (d > size() * (far ? 5 : 1.5)) return t;
    }
    return { x: rand(b.minX, b.maxX), y: ground() ? floorY() : rand(b.minY, b.maxY) };
  }

  function clampToBounds() {
    const b = bounds();
    P.x = clamp(P.x, b.minX, b.maxX);
    P.y = clamp(P.y, b.minY, b.maxY);
  }

  // ---------------- 말풍선 · 이펙트 ----------------

  const bubbleEl = document.getElementById('bubble');
  const tagEl = document.getElementById('tag');
  const fxEl = document.getElementById('fx');
  let bubbleUntil = 0;
  let lastBubbleAt = 0;

  const badgeEl = document.getElementById('badge');
  let bubbleNotice = null; // 버튼이 달린 알림 말풍선 { sessionId, kind }
  let importantUntil = 0; // 한도 알림처럼 중요한 말풍선은 잡담이 덮어쓰지 못하게

  // actions 가 있으면 버튼이 달린 알림 말풍선 (Claude 세션 알림)
  function say(text, ms = 2200, force = false, opts = {}) {
    const actions = opts.actions || null;
    if (!settings.bubbles && !force && !actions) return;
    // 알림 말풍선 · 중요한 말풍선이 떠 있는 동안에는 잡담으로 덮어쓰지 않음
    if (bubbleNotice && !actions && now() < bubbleUntil) return;
    if (!force && !actions && now() < importantUntil) return;
    if (opts.important) importantUntil = now() + ms;
    const body = document.createElement('div');
    body.className = 'text';
    body.textContent = text;
    const parts = [body];
    if (actions) {
      const row = document.createElement('div');
      row.className = 'actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.textContent = a.label;
        if (a.cls) b.className = a.cls;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          a.fn();
          if (a.close !== false) clearNotice();
        });
        row.appendChild(b);
      }
      parts.push(row);
    }
    bubbleEl.replaceChildren(...parts);
    bubbleEl.classList.toggle('interactive', !!actions);
    bubbleEl.classList.remove('hidden');
    bubbleNotice = actions ? { sessionId: opts.sessionId, kind: opts.kind } : null;
    bubbleUntil = now() + ms;
    lastBubbleAt = now();
  }

  function clearNotice(sessionId) {
    if (!bubbleNotice || (sessionId && bubbleNotice.sessionId !== sessionId)) return false;
    bubbleNotice = null;
    bubbleUntil = 0;
    return true;
  }

  function particle(text, x, y, { dx = rand(-20, 20), dy = rand(-60, -35), dur = 1100, fontSize = 16, rotate = 0 } = {}) {
    const el = document.createElement('div');
    el.className = 'particle';
    el.textContent = text;
    el.style.fontSize = `${fontSize}px`;
    fxEl.appendChild(el);
    const anim = el.animate(
      [
        { transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(0.6) rotate(0deg)`, opacity: 0 },
        { transform: `translate(${x + dx * 0.3}px, ${y + dy * 0.3}px) translate(-50%, -50%) scale(1) rotate(${rotate * 0.3}deg)`, opacity: 1, offset: 0.2 },
        { transform: `translate(${x + dx}px, ${y + dy}px) translate(-50%, -50%) scale(0.9) rotate(${rotate}deg)`, opacity: 0 },
      ],
      { duration: dur, easing: 'cubic-bezier(.2,.7,.3,1)' }
    );
    anim.onfinish = () => el.remove();
  }

  const headY = () => P.y - P.hop - size() * 0.95;
  function burst(chars, n, opts = {}) {
    for (let i = 0; i < n; i++) {
      particle(pick(chars), P.x + rand(-petW() * 0.4, petW() * 0.4), headY() + rand(0, size() * 0.3), {
        dx: rand(-50, 50),
        dy: rand(-80, -30),
        fontSize: rand(12, 20),
        ...opts,
      });
    }
  }

  function bump(amount = 3) {
    P.squashV += amount;
  }

  // ---------------- 행동 ----------------

  function goWander() {
    // 버튼 달린 알림이 떠 있으면 누르기 쉽게 제자리에서 기다림
    if (bubbleNotice) {
      setState('idle', { dur: 2, tex: moodTex() });
      return;
    }
    P.target = randomTarget();
    setState('wander', { tex: moodTex() });
  }

  function goIdle(dur = rand(1.2, 3.5)) {
    setState('idle', { dur, tex: moodTex() });
  }

  function petted() {
    setState('petted', { dur: 1.3, tex: 'happy' });
    burst(['💕', '💗', '♥'], 4);
    bump(2.5);
    if (now() - lastVoiceAt > 1200) play('happy');
    say(pick([`${cp()}♥`, `헤헤, ${cp()}`, `쓰담쓰담 ${cp()}`]), 1600);
    api.action('pet');
  }

  const clickTimes = [];
  function onPetClick() {
    const t = now();
    clickTimes.push(t);
    while (clickTimes.length && t - clickTimes[0] > 2500) clickTimes.shift();
    if (clickTimes.length >= 6) {
      clickTimes.length = 0;
      setState('annoyed', { dur: 2.4, tex: 'annoyed' });
      play('annoyed');
      say('폭력은 안 돼요!!', 2200);
      burst(['💢'], 3);
      bump(4);
      api.action('annoy');
      return;
    }
    if (P.state === 'sleep') {
      api.action('poke');
      return;
    }
    if (P.state === 'eat') {
      burst(['💕'], 2);
      return;
    }
    petted();
  }

  function startSing() {
    setState('sing', { dur: 4, tex: 'sing' });
    const a = play('sing', { ambient: true });
    if (a) {
      a.addEventListener('loadedmetadata', () => {
        if (P.state === 'sing' && Number.isFinite(a.duration)) P.dur = Math.min(8, a.duration + 0.3);
      });
    }
    P.data.nextNote = 0;
  }

  function doRandomBehavior() {
    const r = Math.random();
    const t = now();
    // 컴퓨터 상태 알림 (너무 자주는 말하지 않음)
    const bat = stats.battery;
    if (bat && !bat.charging && bat.percent <= 20 && t - (notice.bat || -1e9) > 180000) {
      notice.bat = t;
      setState('expr', { dur: 2.5, tex: 'cry' });
      say(`배터리가 배고파요… 🔌 (${bat.percent}%)`, 3500, true);
      play('hungry', { ambient: true });
      return;
    }
    if (stats.mem && stats.mem.percent >= 90 && t - (notice.mem || -1e9) > 300000) {
      notice.mem = t;
      setState('expr', { dur: 2.5, tex: 'dizzy' });
      say(`머리가 꽉 찼어요… 🧠 (메모리 ${stats.mem.percent}%)`, 3500, true);
      return;
    }
    if (stats.disk && stats.disk.percent >= 92 && t - (notice.disk || -1e9) > 600000) {
      notice.disk = t;
      setState('expr', { dur: 2.5, tex: 'sad' });
      say(`방이 너무 좁아요… 💾 (${stats.disk.percent}%)`, 3500, true);
      return;
    }
    if (petState.hunger < 25 && r < 0.45) {
      setState('expr', { dur: 2.2, tex: 'hungry' });
      say(pick(['배고파요…', '밥… 밥 주세요…', '꼬르륵…']), 2400);
      if (Math.random() < 0.4) play('hungry', { ambient: true });
      return;
    }
    if (petState.energy < 25 && r < 0.35) {
      setState('expr', { dur: 2.2, tex: 'tired' });
      say(pick(['졸려요…', '하암…']), 2200);
      return;
    }
    if (r < 0.07) {
      setState('sneezePrep', { dur: 0.9, tex: 'sleep' });
    } else if (r < 0.17) {
      startSing();
    } else if (r < 0.42) {
      setState('expr', { dur: rand(1.4, 2.6), tex: pick(RANDOM_EXPRESSIONS) });
    } else if (r < 0.6 && now() - lastBubbleAt > 15000 && settings.phrases.length) {
      setState('chatter', { dur: 1.8, tex: 'happy' });
      say(pick(settings.phrases), 2200);
      if (Math.random() < 0.35) play('chatter', { ambient: true, interrupt: false });
    } else {
      goWander();
    }
  }
  const notice = {};

  // ---------------- 밥 ----------------

  const foods = [];
  function spawnFood() {
    const s = size();
    const b = bounds();
    const side = Math.random() < 0.5 ? -1 : 1;
    let x = P.x + side * rand(s * 1.3, s * 3.5);
    if (x < b.minX || x > b.maxX) x = P.x - side * rand(s * 1.3, s * 3.5);
    x = clamp(x, b.minX, b.maxX);
    const gy = ground() ? floorY() : clamp(P.y + rand(-s * 0.6, s * 0.6), b.minY, b.maxY);
    const sprite = new PIXI.Sprite(tex('food'));
    sprite.anchor.set(0.5, 1);
    const fs = (s * 0.45) / Math.max(1, sprite.texture.height);
    sprite.scale.set(fs);
    sprite.alpha = 0;
    sprite.position.set(x, gy - s * 2.2);
    foodLayer.addChild(sprite);
    foods.push({ sprite, x, gy, vy: 0, landed: false, baseScale: fs, fade: 0 });
    if (INTERRUPTIBLE.has(P.state)) {
      setState('lookFood', { dur: 0.5, tex: 'drool' });
      say(pick(['밥이다!', '앗, 밥!', `${cp()}!`]), 1200);
    }
  }

  function removeFood(f) {
    foodLayer.removeChild(f.sprite);
    f.sprite.destroy();
    foods.splice(foods.indexOf(f), 1);
  }

  function updateFoods(dt) {
    for (const f of [...foods]) {
      f.sprite.alpha = Math.min(1, f.sprite.alpha + dt * 4);
      if (!f.landed) {
        f.vy += 2200 * dt;
        f.sprite.y += f.vy * dt;
        if (f.sprite.y >= f.gy) {
          f.sprite.y = f.gy;
          if (f.vy > 300) f.vy = -f.vy * 0.35;
          else {
            f.vy = 0;
            f.landed = true;
          }
        }
      }
      if (f.fade > 0) {
        f.fade -= dt;
        f.sprite.alpha = Math.max(0, f.fade / 0.6);
        if (f.fade <= 0) removeFood(f);
      }
    }
  }

  const nextFood = () => foods.find((f) => f.landed && !f.fade);

  // ---------------- 수면 ----------------

  let wakeReason = null;
  let sleepReason = null;

  function enterSleep() {
    stopVoice();
    const reason = sleepReason;
    sleepReason = null;
    if (reason === 'idle') say('심심해서 낮잠… 💤', 2000);
    else if (reason === 'exhausted') say('졸려요… 이제 잘래요 💤', 2000);
    else say('안녕히 주무세요… 💤', 1600);
    setState('sleep', { tex: 'sleep' });
    P.data.nextZ = 0.8;
  }

  function exitSleep() {
    const reason = wakeReason;
    wakeReason = null;
    if (reason === 'poked') {
      setState('annoyed', { dur: 1.8, tex: 'annoyed' });
      say('으응… 깨우지 마세요…', 2000);
      play('wake');
    } else if (reason === 'user-back') {
      setState('greet', { dur: 1.6, tex: 'happy' });
      say(`어서 오세요! ${settings.name}!`, 2200);
      play('greet');
      burst(['✨', '💕'], 4);
    } else if (reason === 'carried') {
      // 들어 올려서 깬 경우는 carry 상태가 알아서 처리
    } else {
      setState('greet', { dur: 1.6, tex: 'surprised' });
      say(reason === 'rested' ? `잘 잤다~ ${cp()}!` : '일어났어요!', 2000);
      play('wake');
    }
    if (!PHYSICS.has(P.state) && P.state !== 'annoyed' && P.state !== 'greet') goIdle(1);
  }

  // ---------------- 입력 ----------------

  const mouse = { x: -9999, y: -9999 };
  let ignoring = true;
  let drag = null;
  let hoverT = 0;

  function setIgnore(v) {
    if (v === ignoring) return;
    ignoring = v;
    api.setIgnoreMouse(v);
  }

  function hitPet(x, y) {
    const w = petW() * 0.42;
    const top = P.y - P.hop - size() * 0.95;
    const bottom = P.y - P.hop + 2;
    return x >= P.x - w && x <= P.x + w && y >= top && y <= bottom;
  }

  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });
  document.addEventListener('mouseleave', () => {
    if (!drag) {
      mouse.x = -9999;
      mouse.y = -9999;
    }
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (hitPet(e.clientX, e.clientY)) api.showContextMenu();
  });

  function toLocal(gx, gy) {
    return {
      x: (gx - mesh.x) / mesh.scale.x + mesh.pivot.x,
      y: (gy - mesh.y) / mesh.scale.y + mesh.pivot.y,
    };
  }

  // 버튼 달린 말풍선 · 배지 위에 있을 때도 클릭을 받아야 함
  function inRect(el, x, y) {
    if (el.classList.contains('hidden')) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4;
  }
  function overUI(x, y) {
    return (bubbleNotice && inRect(bubbleEl, x, y)) || inRect(badgeEl, x, y);
  }
  badgeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    api.menuAction('open-panel');
  });

  window.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('#bubble, #badge')) return;
    if (e.button !== 0 || e.ctrlKey || !hitPet(e.clientX, e.clientY)) return;
    app.view.setPointerCapture(e.pointerId);
    drag = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: e.clientX - P.x,
      oy: e.clientY - P.y,
      local: toLocal(e.clientX, e.clientY),
      t0: now(),
      moved: false,
      longPress: false,
      nextPet: 0,
      history: [{ x: e.clientX, y: e.clientY, t: now() }],
    };
  });

  window.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (!drag || e.pointerId !== drag.id) return;
    drag.history.push({ x: e.clientX, y: e.clientY, t: now() });
    if (drag.history.length > 8) drag.history.shift();
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) {
      drag.moved = true;
      startCarry();
    }
  });

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      if (d.longPress) goIdle(0.8);
      else onPetClick();
      return;
    }
    // 최근 움직임으로 던지는 속도 계산
    const h = d.history;
    const last = h[h.length - 1];
    let first = h[0];
    for (const p of h) if (last.t - p.t <= 90) { first = p; break; }
    const dtv = Math.max(16, last.t - first.t) / 1000;
    const vx = (last.x - first.x) / dtv;
    const vy = (last.y - first.y) / dtv;
    const speed = Math.hypot(vx, vy);
    if (now() - last.t > 120 || speed < 700) {
      P.vx = 0;
      P.vy = 0;
      if (ground() && P.y < floorY() - 2) setState('fall', { tex: 'carry' });
      else {
        clampToBounds();
        setState('landed', { dur: 0.7, tex: 'cry' });
        bump(3);
      }
    } else {
      const k = Math.min(1, 2600 / speed);
      P.vx = vx * k;
      P.vy = vy * k;
      setState('flung', { tex: 'carry' });
      play('flung');
      say(pick(['으아아앙~!', '꺄아~!']), 1400);
    }
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  function startCarry() {
    if (petState.sleeping) {
      wakeReason = 'carried';
      api.action('carried');
    }
    setState('carry', { tex: 'carry' });
    play('carry');
    burst(['💦'], 2);
  }

  // ---------------- 명령 · 동기화 ----------------

  api.onCommand((cmd) => {
    switch (cmd.name) {
      case 'feed':
        spawnFood();
        break;
      case 'pet':
        if (!PHYSICS.has(P.state)) petted();
        break;
      case 'sing':
        if (!PHYSICS.has(P.state) && P.state !== 'sleep') startSing();
        break;
      case 'say':
        say(cmd.text, 4500, true, { important: true });
        if (cmd.tex && INTERRUPTIBLE.has(P.state)) setState('greet', { dur: 1.6, tex: cmd.tex });
        play('happy', { interrupt: false });
        break;
      case 'greet':
        setState('greet', { dur: 1.6, tex: 'happy' });
        say(`안녕하세요! ${settings.name}예요!`, 2400, true);
        play('greet');
        break;
      default:
        break;
    }
  });

  api.onPetEvent((ev) => {
    if (ev.type === 'levelup') {
      burst(['✨', '⭐', '🎉'], 8, { dy: rand(-110, -60) });
      say(`Lv.${ev.level} 달성! ${cp()}!`, 3000, true);
      play('levelup');
      if (INTERRUPTIBLE.has(P.state)) setState('levelup', { dur: 2.2, tex: 'levelup' });
      bump(4);
    } else if (ev.type === 'slept') {
      sleepReason = ev.reason;
    } else if (ev.type === 'woke') {
      wakeReason = ev.reason;
    }
  });

  api.onPetState((s) => {
    petState = s;
  });

  // ---------------- Claude Code 세션 알림 ----------------

  const clipText = (t, n) => {
    const x = String(t || '').replace(/\s+/g, ' ').trim();
    return x.length > n ? x.slice(0, n - 1) + '…' : x;
  };

  function noticeAnim(texKey, marks) {
    if (P.state === 'sleep' || PHYSICS.has(P.state)) return;
    setState('notice', { dur: 2.6, tex: texKey });
    bump(5);
    burst(marks, 2, { dy: -70 });
  }

  function showPermission(sess) {
    const p = sess.pending;
    noticeAnim('worry', ['❓', '🔔']);
    play('permission');
    say(`🔔 ${sess.name}\n${p.title}${p.detail ? ': ' + clipText(p.detail, 80) : ''} 해도 돼요?`, 10 * 60 * 1000, true, {
      sessionId: sess.id,
      kind: 'permission',
      actions: [
        { label: '허락', cls: 'ok', fn: () => api.decide(sess.id, 'allow') },
        { label: '거절', fn: () => api.decide(sess.id, 'deny') },
        { label: '보드', cls: 'ghost', fn: () => api.menuAction('open-panel', { sessionId: sess.id }) },
      ],
    });
  }

  function showNextPending() {
    const next = sessions.find((x) => x.pending && x.pending.kind === 'permission');
    if (next) showPermission(next);
  }

  function updateBadge() {
    const waiting = sessions.filter((x) => x.pending).length;
    badgeEl.textContent = waiting > 9 ? '9+' : String(waiting);
    badgeEl.classList.toggle('hidden', waiting === 0);
  }

  api.onSessions(({ event, session, list }) => {
    sessions = list;
    updateBadge();
    if (!event || !session) return;
    const id = session.id;
    switch (event.type) {
      case 'permission':
        showPermission(session);
        break;
      case 'settled':
        if (clearNotice(id)) showNextPending();
        break;
      case 'done': {
        noticeAnim('alert', ['❗', '✨']);
        play('done');
        const msg = event.message ? `\n${window.CodePupMd.summary(event.message, 70)}` : '';
        const actions = [
          { label: '터미널', cls: 'ok', fn: () => api.focusSession(id) },
          { label: '보드', fn: () => api.menuAction('open-panel', { sessionId: id }) },
        ];
        say(`✅ ${session.name} 작업 끝!${msg}`, 15000, true, {
          sessionId: id,
          kind: 'done',
          actions,
        });
        break;
      }
      case 'idle':
        if (!bubbleNotice) {
          say(`⏳ ${session.name}: 다음 지시를 기다려요`, 12000, true, {
            sessionId: id,
            kind: 'idle',
            actions: [{ label: '터미널', cls: 'ok', fn: () => api.focusSession(id) }],
          });
        }
        break;
      case 'working':
        if (bubbleNotice && bubbleNotice.sessionId === id && bubbleNotice.kind !== 'permission') clearNotice(id);
        break;
      case 'started':
        if (!bubbleNotice) say(`🐾 ${session.name} 세션을 지켜볼게요!`, 1800);
        break;
      case 'discovered':
        if (!bubbleNotice) say(`👀 ${session.name} 세션을 찾았어요!`, 1800);
        break;
      default:
        break;
    }
  });

  api.onSkins(async (p) => {
    skin = p.active;
    if (p.name) settings = { ...settings, name: p.name }; // 설정 변경 알림보다 먼저 올 수 있어서 새 이름을 함께 받음
    await loadTextures();
    setTex(texKey);
    for (const f of foods) f.sprite.texture = tex('food');
    makeTrayFrames();
    setState('greet', { dur: 1.4, tex: 'happy' });
    say(`짠! ${settings.name}예요!`, 1800, true);
    play('greet');
  });

  api.onStats((s) => {
    const wasCharging = stats.battery && stats.battery.charging;
    stats = s;
    if (s.battery && s.battery.charging && wasCharging === false && P.state !== 'sleep') {
      say(`충전 ${cp()} ⚡`, 2000);
      burst(['⚡'], 3);
    }
  });

  let customSig = JSON.stringify([settings.customImages, settings.customSounds]);
  api.onSettings(async (s) => {
    settings = s;
    const sig = JSON.stringify([s.customImages, s.customSounds]);
    if (sig !== customSig) {
      customSig = sig;
      await loadTextures();
      setTex(texKey);
      for (const f of foods) f.sprite.texture = tex('food');
      makeTrayFrames();
      setState('greet', { dur: 1.4, tex: 'happy' });
      say(`새 모습 ${cp()}!`, 1800, true);
    }
    if (PHYSICS.has(P.state)) return;
    // 바닥 모드로 바꾸면 순간이동 대신 뚝 떨어지기
    if (ground() && P.y < floorY() - 2) {
      P.vy = 0;
      setState('fall', { tex: 'surprised' });
    } else {
      clampToBounds();
      if (P.target) P.target = randomTarget();
    }
  });

  // ---------------- 메뉴 막대 아이콘 프레임 ----------------

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function drawIconFrame(img, scale, phase, zzz) {
    const Wc = 22 * scale;
    const Hc = 18 * scale;
    const c = document.createElement('canvas');
    c.width = Wc;
    c.height = Hc;
    const g = c.getContext('2d');
    const ih = 15 * scale;
    const iw = ih * (img.width / img.height);
    const hop = Math.abs(Math.sin(phase)) * 2.5 * scale;
    const sq = 1 - Math.cos(phase * 2) * 0.05;
    g.translate(Wc / 2, Hc);
    g.rotate(Math.sin(phase) * 0.1);
    g.scale(1 / sq, sq);
    g.drawImage(img, -iw / 2, -ih - hop, iw, ih);
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (zzz) {
      g.fillStyle = '#7a6cff';
      g.font = `bold ${7 * scale}px sans-serif`;
      g.fillText('z', Wc - 6 * scale, 6 * scale);
    }
    return c.toDataURL('image/png');
  }

  async function makeTrayFrames() {
    try {
      const [runImg, sleepImg] = await Promise.all([loadImage(imageUrl('default')), loadImage(imageUrl('sleep'))]);
      const N = 8;
      const run = [];
      for (let i = 0; i < N; i++) {
        const phase = (i / N) * Math.PI * 2;
        run.push({ x1: drawIconFrame(runImg, 1, phase), x2: drawIconFrame(runImg, 2, phase) });
      }
      const sleep = { x1: drawIconFrame(sleepImg, 1, 0, true), x2: drawIconFrame(sleepImg, 2, 0, true) };
      api.setTrayFrames({ run, sleep });
    } catch (err) {
      console.error('tray frames failed', err);
    }
  }
  makeTrayFrames();

  // ---------------- 메인 루프 ----------------

  const startedAt = now();
  let zoomed = false;
  let sprintNoticeAt = -1e9;
  let lastRanReport = now();

  function update(dt) {
    P.t += dt;
    const s = size();
    const b = bounds();
    const cpu = cpuLoad();
    const sprinting = cpu >= settings.sprintThreshold;

    // 서버(main) 상태와 수면 동기화
    if (petState.sleeping && P.state !== 'sleep' && !PHYSICS.has(P.state) && P.state !== 'eat') enterSleep();
    else if (!petState.sleeping && P.state === 'sleep') exitSleep();

    // 4분 44초 이스터에그
    if (!zoomed && (now() - startedAt) / 1000 >= 284 && INTERRUPTIBLE.has(P.state)) {
      zoomed = true;
      P.target = randomTarget(true);
      setState('zoom', { dur: 4, tex: 'zoom' });
    }

    // 밥이 있으면 먹으러 감
    if (INTERRUPTIBLE.has(P.state) || P.state === 'sprint') {
      if (nextFood()) setState('goFood', { tex: 'drool' });
    }

    // CPU 과부하 → 전력 질주
    if (sprinting && INTERRUPTIBLE.has(P.state) && P.state !== 'hover') {
      P.target = randomTarget(true);
      setState('sprint', { tex: 'run' });
      if (now() - sprintNoticeAt > 30000) {
        sprintNoticeAt = now();
        say(`${cp()}!!! (CPU ${Math.round(stats.cpu)}%)`, 1800);
      }
    }

    switch (P.state) {
      case 'intro': {
        P.vy += 1800 * dt;
        P.y += P.vy * dt;
        if (P.y >= landY) {
          P.y = landY;
          P.vy = 0;
          bump(5);
          setState('greet', { dur: 1.6, tex: 'happy' });
          say(`${settings.name}!`, 1600);
          play('greet');
          burst(['✨', '💕'], 4);
        }
        break;
      }
      case 'wander': {
        if (moveToward(P.target.x, P.target.y, walkSpeed(), dt)) {
          if (Math.random() < 0.55) goIdle();
          else doRandomBehavior();
        }
        break;
      }
      case 'sprint': {
        if (moveToward(P.target.x, P.target.y, walkSpeed() * 1.8, dt)) P.target = randomTarget(true);
        P.data.dust = (P.data.dust || 0) - dt;
        if (P.data.dust <= 0) {
          P.data.dust = 0.12;
          particle('💨', P.x - P.facing * petW() * 0.45, P.y - s * 0.15, { dx: -P.facing * rand(20, 40), dy: rand(-15, 0), dur: 600, fontSize: rand(10, 15) });
        }
        if (cpu < settings.sprintThreshold - 10) {
          goIdle(1.5);
          setTex('tired');
          say(`헉헉… ${cp()}`, 1600);
        }
        break;
      }
      case 'zoom': {
        if (moveToward(P.target.x, P.target.y, walkSpeed() * 3, dt)) P.target = randomTarget(true);
        if (P.t >= P.dur) goWander();
        break;
      }
      case 'goFood': {
        const f = nextFood();
        if (!f) {
          goWander();
          break;
        }
        const standX = f.x - (f.x > P.x ? 1 : -1) * petW() * 0.45;
        const arrived = moveToward(standX, f.gy, Math.max(walkSpeed() * 1.3, s * 1.6), dt);
        if (arrived) {
          P.facing = f.x > P.x ? 1 : -1;
          if (petState.hunger >= 95) {
            f.fade = 0.6;
            setState('refuse', { dur: 2.2, tex: 'happy' });
            say('배불러요~', 2200);
            play('full');
          } else {
            setState('eat', { dur: 2.4, tex: 'eat', data: { food: f, chew: 0 } });
            play('eat');
          }
        }
        break;
      }
      case 'eat': {
        const f = P.data.food;
        P.data.chew += dt;
        if (P.data.chew >= 0.2) {
          P.data.chew = 0;
          setTex(texKey === 'eat' ? 'eat2' : 'eat');
          bump(1.2);
          if (Math.random() < 0.4) particle(pick(['냠', '냠냠', '✨']), P.x + P.facing * petW() * 0.35, headY() + s * 0.35, { fontSize: 12, dur: 700 });
        }
        if (f && foods.includes(f)) f.sprite.scale.set(f.baseScale * Math.max(0.15, 1 - P.t / P.dur));
        if (P.t >= P.dur) {
          if (f && foods.includes(f)) removeFood(f);
          setState('petted', { dur: 1.4, tex: 'happy' });
          api.action('ate').then((res) => {
            if (res.result === 'full') {
              say('배불러요~', 2000);
              play('full');
            } else {
              say(pick([`${cp()}!`, `맛있어요! ${cp()}`, `냠냠 ${cp()}`]), 1800);
              play('happy');
              burst(['💕', '✨'], 4);
            }
          });
        }
        break;
      }
      case 'sleep': {
        P.data.nextZ -= dt;
        if (P.data.nextZ <= 0) {
          P.data.nextZ = 1.6;
          particle(pick(['z', 'Z', '💤']), P.x + P.facing * petW() * 0.3, headY() + s * 0.15, { dx: P.facing * 25, dy: -45, dur: 1800, fontSize: rand(11, 16) });
        }
        break;
      }
      case 'carry': {
        if (!drag) break;
        const tx = mouse.x - drag.ox;
        const ty = mouse.y - drag.oy;
        const k = Math.min(1, dt * 14);
        const px = P.x;
        P.x += (tx - P.x) * k;
        P.y += (ty - P.y) * k;
        if (Math.abs(P.x - px) > 0.5) P.facing = P.x > px ? 1 : -1;
        P.x = clamp(P.x, 0, W());
        P.y = clamp(P.y, s * 0.5, H() + s * 0.3);
        break;
      }
      case 'flung': {
        const decay = Math.exp(-(ground() ? 0.6 : 2.4) * dt);
        P.vx *= decay;
        if (ground()) P.vy += 2600 * dt;
        else P.vy *= decay;
        P.x += P.vx * dt;
        P.y += P.vy * dt;
        if (P.x < b.minX || P.x > b.maxX) {
          P.x = clamp(P.x, b.minX, b.maxX);
          P.vx = -P.vx * 0.7;
          P.facing = P.vx > 0 ? 1 : -1;
          bump(4);
        }
        if (P.y < b.minY || P.y > b.maxY) {
          const hitFloor = P.y > b.maxY;
          P.y = clamp(P.y, b.minY, b.maxY);
          P.vy = -P.vy * (ground() ? 0.45 : 0.7);
          if (hitFloor && ground()) P.vx *= 0.8;
          bump(4);
        }
        P.hopPhase += dt * 20;
        const settled = ground() ? P.y >= b.maxY - 1 && Math.abs(P.vy) < 90 && Math.abs(P.vx) < 60 : Math.hypot(P.vx, P.vy) < 60;
        if (settled) {
          P.vx = 0;
          P.vy = 0;
          if (ground()) P.y = floorY();
          setState('dizzy', { dur: 2, tex: 'dizzy' });
          say('어지러워요… @_@', 1800);
        }
        break;
      }
      case 'fall': {
        P.vy += 2600 * dt;
        P.y += P.vy * dt;
        if (P.y >= floorY()) {
          P.y = floorY();
          if (P.vy > 400) {
            P.vy = -P.vy * 0.3;
            bump(4);
          } else {
            P.vy = 0;
            setState('landed', { dur: 0.7, tex: 'cry' });
            bump(3);
          }
        }
        break;
      }
      case 'dizzy': {
        P.data.swirl = (P.data.swirl || 0) - dt;
        if (P.data.swirl <= 0) {
          P.data.swirl = 0.5;
          particle('💫', P.x + rand(-10, 10), headY() - 4, { dx: rand(-20, 20), dy: -20, dur: 900, fontSize: 13 });
        }
        if (P.t >= P.dur) goWander();
        break;
      }
      case 'hover': {
        P.facing = mouse.x > P.x ? 1 : -1;
        if (!hitPet(mouse.x, mouse.y)) {
          hoverT = 0;
          goIdle(0.6);
        }
        break;
      }
      case 'sing': {
        P.hopPhase += dt * 6;
        P.data.nextNote -= dt;
        if (P.data.nextNote <= 0) {
          P.data.nextNote = 0.45;
          particle(pick(['♪', '♫', '🎵']), P.x + rand(-petW() * 0.4, petW() * 0.4), headY(), { fontSize: rand(13, 19), dur: 1300 });
        }
        if (P.t >= P.dur) goWander();
        break;
      }
      case 'petting':
        break; // 손을 뗄 때까지 유지 (endDrag 에서 정리)
      case 'sneezePrep': {
        if (P.t >= P.dur) {
          setState('sneeze', { dur: 0.6, tex: 'sneeze' });
          say('에취!', 900);
          bump(5);
          burst(['💦'], 3);
        }
        break;
      }
      case 'lookFood':
      case 'idle':
      case 'expr':
      case 'chatter':
      case 'petted':
      case 'annoyed':
      case 'greet':
      case 'levelup':
      case 'landed':
      case 'refuse':
      case 'notice':
      case 'sneeze': {
        if (P.state === 'petted' || P.state === 'levelup' || P.state === 'greet' || P.state === 'notice') P.hopPhase += dt * 8;
        if (P.dur && P.t >= P.dur) {
          if (P.state === 'idle') doRandomBehavior();
          else goWander();
        }
        break;
      }
      default:
        goWander();
    }

    // 길게 누르고 있으면 계속 쓰다듬기
    if (drag && !drag.moved && now() - drag.t0 > 650 && P.state !== 'sleep') {
      if (!drag.longPress) {
        drag.longPress = true;
        setState('petting', { tex: 'happy' });
        say(`쓰담쓰담… ${cp()}`, 1800);
        play('happy');
      }
      drag.nextPet -= dt;
      if (drag.nextPet <= 0) {
        drag.nextPet = 0.6;
        burst(['💕', '♥'], 1);
        api.action('pet');
      }
      P.hopPhase += dt * 5;
    }

    // 마우스를 올리면 멈춰서 쳐다보기
    const over = hitPet(mouse.x, mouse.y);
    if (over && !drag && (P.state === 'wander' || P.state === 'idle')) {
      hoverT += dt;
      if (hoverT > 0.35) setState('hover', { tex: 'happy' });
    } else if (!over) {
      hoverT = 0;
    }

    // 클릭 통과 제어: 펫 위에 있을 때만 마우스를 받음
    setIgnore(!(over || drag || overUI(mouse.x, mouse.y)));

    // 달린 거리 → 경험치
    if (now() - lastRanReport > 10000) {
      lastRanReport = now();
      const bodies = distAcc / s;
      distAcc = 0;
      if (bodies > 0.5) api.action('ran', { bodies });
    }
  }

  // ---------------- 그리기 ----------------

  function render(dt, time) {
    const s = size();
    const t = mesh.texture;
    const moving = ['wander', 'sprint', 'zoom', 'goFood', 'sing', 'petted', 'levelup', 'greet', 'petting', 'notice'].includes(P.state);
    const hopAmp = P.state === 'sprint' || P.state === 'zoom' ? 0.16 : 0.1;
    const targetHop = moving ? Math.abs(Math.sin(P.hopPhase)) * s * hopAmp : 0;
    P.hop += (targetHop - P.hop) * Math.min(1, dt * (moving ? 30 : 10));
    if (P.state === 'intro' || P.state === 'fall' || P.state === 'flung' || P.state === 'carry') P.hop = 0;

    // 몸 전체 말랑 스프링
    P.squashV += (-P.squash * 180 - P.squashV * 12) * dt;
    P.squash += P.squashV * dt * 0.06;
    P.squash = clamp(P.squash, -0.35, 0.35);

    let breathe = 0;
    if (P.state === 'sleep') breathe = Math.sin(time * 2.2) * 0.035;
    else if (!moving) breathe = Math.sin(time * 3) * 0.015;

    const base = s / Math.max(1, t.height);
    const sy = base * (1 - P.squash + breathe);
    const sx = base * (1 + P.squash * 0.6 - breathe * 0.5);
    mesh.pivot.set(t.width / 2, t.height);
    mesh.scale.set(sx * P.facing, sy);
    mesh.position.set(P.x, P.y - P.hop);
    mesh.rotation = P.state === 'flung' ? Math.sin(P.hopPhase) * 0.35 : P.state === 'sprint' ? P.facing * 0.06 : 0;

    const onGround = !['carry', 'flung', 'fall', 'intro'].includes(P.state);
    const shadowY = onGround ? P.y : ground() ? floorY() : P.y;
    shadow.visible = settings.moveMode === 'ground' || onGround;
    shadow.position.set(P.x, shadowY - 2);
    shadow.scale.set((petW() / 100) * (1 - P.hop / (s * 0.5)) * 0.9, (s / 75) * 0.9);

    // 잡아당긴 곳이 쭈욱 늘어나는 메쉬 변형
    const radius = (s * 0.75) / Math.abs(mesh.scale.y);
    let dLx = 0;
    let dLy = 0;
    if (drag && P.state === 'carry') {
      const gx = P.x + (drag.local.x - mesh.pivot.x) * mesh.scale.x;
      const gy = P.y + (drag.local.y - mesh.pivot.y) * mesh.scale.y;
      let dx = mouse.x - gx;
      let dy = mouse.y - gy;
      const len = Math.hypot(dx, dy);
      const maxLen = s * 0.9;
      if (len > maxLen) {
        dx *= maxLen / len;
        dy *= maxLen / len;
      }
      dLx = dx / mesh.scale.x;
      dLy = dy / mesh.scale.y;
    }
    if (buffer.data !== verts) syncVertexArrays();
    for (let i = 0; i < verts.length; i += 2) {
      let tx = baseVerts[i];
      let ty = baseVerts[i + 1];
      if (dLx || dLy) {
        const d = Math.hypot(tx - drag.local.x, ty - drag.local.y);
        if (d < radius) {
          const f = Math.pow(1 - d / radius, 1.6);
          tx += dLx * f;
          ty += dLy * f;
        }
      }
      vertVel[i] = (vertVel[i] + (tx - verts[i]) * 0.2) * 0.78;
      vertVel[i + 1] = (vertVel[i + 1] + (ty - verts[i + 1]) * 0.2) * 0.78;
      verts[i] += vertVel[i];
      verts[i + 1] += vertVel[i + 1];
    }
    buffer.update();

    // 말풍선 · 이름표
    const top = P.y - P.hop - s * (1 - P.squash) - 10;
    if (!bubbleEl.classList.contains('hidden')) {
      if (now() > bubbleUntil) {
        bubbleEl.classList.add('hidden');
        bubbleNotice = null;
      }
      const bw = bubbleEl.offsetWidth;
      const bx = clamp(P.x - bw / 2, 6, W() - bw - 6);
      const by = Math.max(6, top - bubbleEl.offsetHeight - 6);
      bubbleEl.style.transform = `translate(${bx}px, ${by}px)`;
      bubbleEl.style.setProperty('--tail', `${clamp(P.x - bx, 14, bw - 14)}px`);
    }
    if (!badgeEl.classList.contains('hidden')) {
      const bx = clamp(P.x + petW() * 0.3, 4, W() - 30);
      const by = Math.max(4, top - 4);
      badgeEl.style.transform = `translate(${bx}px, ${by}px)`;
    }
    const showTag = hitPet(mouse.x, mouse.y) || (drag && drag.longPress);
    tagEl.classList.toggle('hidden', !showTag);
    if (showTag) {
      tagEl.textContent = `${settings.name} Lv.${petState.level}  🍚${petState.hunger} 💖${petState.happiness} ⚡${petState.energy}`;
      const tw = tagEl.offsetWidth;
      const tx = clamp(P.x - tw / 2, 6, W() - tw - 6);
      const ty = Math.min(H() - tagEl.offsetHeight - 4, P.y + 6);
      tagEl.style.transform = `translate(${tx}px, ${ty}px)`;
    }
  }

  let clock = 0;
  app.ticker.add(() => {
    const dt = Math.min(0.1, app.ticker.deltaMS / 1000);
    clock += dt;
    update(dt);
    updateFoods(dt);
    render(dt, clock);
  });

  window.addEventListener('resize', () => {
    landY = Math.min(landY, floorY());
    if (!PHYSICS.has(P.state)) clampToBounds();
  });

  // 디버그/테스트용 훅
  window.__codepup = { P, get state() { return P.state; }, spawnFood, onPetClick, clearNotice: () => clearNotice() };
})();
