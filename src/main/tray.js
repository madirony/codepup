// RunCat처럼 CPU 사용률에 맞춰 달리는 메뉴 막대 아이콘 + 시스템 상태 텍스트.
const { Tray, Menu, nativeImage } = require('electron');
// 세션 보드 · 세션 복구 메뉴도 여기서 만듭니다.

const GB = 1024 ** 3;
const fmtGB = (bytes) => (bytes / GB >= 100 ? Math.round(bytes / GB) : (bytes / GB).toFixed(1)) + 'GB';

function bar(value, max = 100, width = 10) {
  const filled = Math.round((Math.max(0, Math.min(max, value)) / max) * width);
  return '■'.repeat(filled) + '□'.repeat(width - filled);
}

function imageFromFrame(frame) {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, dataURL: frame.x1 });
  img.addRepresentation({ scaleFactor: 2, dataURL: frame.x2 });
  return img;
}

class PetTray {
  constructor({ fallbackIconPath, onAction }) {
    this.onAction = onAction;
    const fallback = nativeImage.createFromPath(fallbackIconPath).resize({ height: 18 });
    this.tray = new Tray(fallback);
    this.tray.setToolTip('CodePup');
    this.runFrames = [fallback];
    this.sleepFrame = fallback;
    this.frameIndex = 0;
    this.animTimer = null;
    this.state = { stats: null, pet: null, settings: null, sessions: null, awake: null };
    // 왼쪽 클릭 → 세션 팝오버 · 오른쪽 클릭(또는 ⌃클릭) → 메뉴
    this.menu = null;
    this.tray.on('click', (e, bounds) => {
      if (e && e.ctrlKey) return this.popMenu();
      this.onAction('toggle-popover', { bounds: bounds || this.tray.getBounds() });
    });
    this.tray.on('right-click', () => this.popMenu());
    this.scheduleFrame();
  }

  setFrames({ run, sleep }) {
    try {
      if (Array.isArray(run) && run.length) this.runFrames = run.map(imageFromFrame);
      if (sleep) this.sleepFrame = imageFromFrame(sleep);
      this.frameIndex = 0;
    } catch (err) {
      console.error('[tray] invalid frames', err);
    }
  }

  update(partial) {
    Object.assign(this.state, partial);
    this.render();
  }

  // CPU 0% → 한 프레임에 0.3초, 100% → 0.04초
  frameDelay() {
    const cpu = (this.state.stats && this.state.stats.cpu) || 0;
    return Math.round(300 - (cpu / 100) * 260);
  }

  scheduleFrame() {
    clearTimeout(this.animTimer);
    this.animTimer = setTimeout(() => {
      const { pet, settings } = this.state;
      const animate = !settings || settings.tray.animate;
      if (pet && pet.sleeping) {
        this.tray.setImage(this.sleepFrame);
      } else if (animate && this.runFrames.length > 1) {
        this.frameIndex = (this.frameIndex + 1) % this.runFrames.length;
        this.tray.setImage(this.runFrames[this.frameIndex]);
      } else {
        this.tray.setImage(this.runFrames[0]);
      }
      this.scheduleFrame();
    }, this.frameDelay());
  }

  titleText() {
    const { stats, settings } = this.state;
    if (!stats || !settings) return '';
    const t = settings.tray;
    const parts = [];
    const c = this.state.sessions && this.state.sessions.counts;
    // 평소엔 아이콘만 (달리는 속도가 CPU). 허락을 기다리는 세션이 있을 때만 숫자가 붙어요.
    if (c && t.sessions !== false && c.permission) parts.push(`🔔${c.permission}`);
    if (t.awake && this.state.awake && this.state.awake.active) parts.push('☕');
    if (t.cpu) parts.push(`${stats.cpu}%`);
    if (t.mem) parts.push(`M${stats.mem.percent}%`);
    if (t.disk && stats.disk) parts.push(`D${stats.disk.percent}%`);
    if (t.battery && stats.battery) parts.push(`${stats.battery.charging ? '⚡' : ''}${stats.battery.percent}%`);
    return parts.join(' ');
  }

  statLines() {
    const { stats } = this.state;
    if (!stats) return [];
    const lines = [`🖥  CPU  ${bar(stats.cpu)}  ${stats.cpu}%`];
    lines.push(`🧠  메모리  ${bar(stats.mem.percent)}  ${stats.mem.percent}%  (${fmtGB(stats.mem.used)} / ${fmtGB(stats.mem.total)})`);
    if (stats.disk) {
      lines.push(`💾  저장공간  ${bar(stats.disk.percent)}  ${stats.disk.percent}%  (${fmtGB(stats.disk.used)} / ${fmtGB(stats.disk.total)})`);
    }
    if (stats.battery) {
      lines.push(`🔋  배터리  ${bar(stats.battery.percent)}  ${stats.battery.percent}%${stats.battery.charging ? '  (충전 중)' : ''}`);
    }
    return lines;
  }

  render() {
    const { pet, settings } = this.state;
    if (!settings) return;
    const title = this.titleText();
    if (process.platform === 'darwin') this.tray.setTitle(title ? ' ' + title : '', { fontType: 'monospacedDigit' });
    const statLines = this.statLines();
    this.tray.setToolTip([`${settings.name}${pet ? ` Lv.${pet.level}` : ''}`, ...statLines].join('\n'));

    const act = (name) => () => this.onAction(name);
    const info = (label) => ({ label, enabled: false });
    const toggleTray = (key) => (item) => this.onAction('tray-toggle', { key, value: item.checked });
    const template = [];

    if (pet) {
      template.push(
        info(`🐣  ${settings.name}  ·  Lv.${pet.level}${pet.sleeping ? '  ·  💤 자는 중' : ''}`),
        info(`⭐  경험치  ${bar(pet.exp, pet.expToNext)}  ${pet.exp} / ${pet.expToNext}`),
        info(`🍚  포만감  ${bar(pet.hunger)}  ${pet.hunger}%`),
        info(`💖  기분     ${bar(pet.happiness)}  ${pet.happiness}%`),
        info(`⚡  에너지  ${bar(pet.energy)}  ${pet.energy}%`),
        { type: 'separator' }
      );
    }
    template.push(...this.sessionItems());
    statLines.forEach((l) => template.push(info(l)));
    template.push(
      { type: 'separator' },
      { label: '🍖  밥 주기', click: act('feed'), enabled: !settings.hidden },
      { label: '🤚  쓰다듬기', click: act('pet'), enabled: !settings.hidden },
      pet && pet.sleeping ? { label: '☀️  깨우기', click: act('wake') } : { label: '💤  재우기', click: act('sleep') },
      { label: '🎵  노래 불러줘', click: act('sing'), enabled: !settings.hidden && !(pet && pet.sleeping) },
      { type: 'separator' },
      { label: settings.hidden ? '👀  펫 보이기' : '🙈  펫 숨기기', click: act('toggle-hidden') },
      {
        label: '메뉴 막대에 표시',
        submenu: [
          { label: 'CPU', type: 'checkbox', checked: settings.tray.cpu, click: toggleTray('cpu') },
          { label: '메모리', type: 'checkbox', checked: settings.tray.mem, click: toggleTray('mem') },
          { label: '저장공간', type: 'checkbox', checked: settings.tray.disk, click: toggleTray('disk') },
          { label: '배터리', type: 'checkbox', checked: settings.tray.battery, click: toggleTray('battery') },
          { label: '허락 기다리는 세션 수 (🔔)', type: 'checkbox', checked: settings.tray.sessions !== false, click: toggleTray('sessions') },
          { label: '잠자기 방지 중 (☕)', type: 'checkbox', checked: !!settings.tray.awake, click: toggleTray('awake') },
          { type: 'separator' },
          { label: '아이콘 달리기 애니메이션', type: 'checkbox', checked: settings.tray.animate, click: toggleTray('animate') },
        ],
      },
      { label: '소리 켜기', type: 'checkbox', checked: settings.soundEnabled, click: (i) => this.onAction('sound-toggle', { value: i.checked }) },
      { label: '설정 · 커스텀…', click: act('open-settings'), accelerator: 'CommandOrControl+,' },
      { type: 'separator' },
      { label: 'CodePup 종료', click: act('quit'), accelerator: 'CommandOrControl+Q' }
    );
    this.menu = Menu.buildFromTemplate(template);
  }

  popMenu() {
    if (this.menu) this.tray.popUpContextMenu(this.menu);
  }

  bounds() {
    return this.tray.getBounds();
  }

  sessionItems() {
    const { sessions, settings } = this.state;
    const act = (name, payload) => () => this.onAction(name, payload);
    const items = [];
    const list = (sessions && sessions.list) || [];
    const restorable = (sessions && sessions.restorable) || [];
    const icon = (s) =>
      s.pending && s.pending.kind === 'permission' ? '🔔' : s.status === 'working' ? '⚙️' : s.status === 'done' ? '✅' : '💤';
    items.push({ label: `🗂  세션 보드 열기${list.length ? `  (${list.length})` : ''}`, click: act('open-panel'), accelerator: 'CommandOrControl+Shift+J' });
    // 세션이 많아도 메뉴가 길어지지 않게: 허락 대기 → 작업 중 → 끝남 순으로 5개까지만, 나머지는 보드에서
    const MENU_MAX = 5;
    const rank = (s) => (s.pending ? 0 : s.status === 'working' ? 1 : s.status === 'done' ? 2 : 3);
    const shown = [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt).slice(0, MENU_MAX);
    for (const s of shown) {
      items.push({ label: `     ${icon(s)}  ${s.name}  ·  ${s.activity || s.status}`.slice(0, 60), click: act('open-panel', { sessionId: s.id }) });
    }
    if (list.length > MENU_MAX) items.push({ label: `     … 외 ${list.length - MENU_MAX}개 (보드에서 보기)`, click: act('open-panel') });
    const muted = list.filter((s) => s.needsReopen).length;
    if (muted) items.push({ label: `🔕  알림 꺼진 세션 ${muted}개 → 다시 열어서 알림 켜기`, click: act('reopen-hooks', {}) });
    const aw = this.state.awake || {};
    let awakeText = '☕  잠자기 방지 꺼짐';
    if (aw.active && aw.manual) awakeText = '☕  계속 깨어 있는 중 (직접 켬)';
    else if (aw.active && aw.reason && aw.reason.kind === 'open') awakeText = `☕  세션 ${aw.reason.count}개가 열려 있어서 잠들지 않아요`;
    else if (aw.active && aw.reason) awakeText = `☕  Claude 작업 중이라 잠들지 않아요`;
    else if (aw.active) awakeText = '☕  곧 잠자기 방지를 풀어요';
    else if (aw.external) awakeText = '☕  다른 앱이 잠자기를 막는 중 (caffeinate 등)';
    if (aw.lid) awakeText += ' · 🧳 덮개를 닫아도 켜짐';
    // 잠자기 방지는 한 줄 + 하위 메뉴 하나로
    items.push({
      label: awakeText,
      submenu: [
        { label: 'Claude 세션이 열려 있으면 (원격 작업용)', type: 'radio', checked: settings.keepAwake !== false && settings.keepAwakeMode !== 'working', click: () => { this.onAction('awake-auto', { value: true }); this.onAction('awake-mode', { value: 'open' }); } },
        { label: 'Claude 가 일할 때만', type: 'radio', checked: settings.keepAwake !== false && settings.keepAwakeMode === 'working', click: () => { this.onAction('awake-auto', { value: true }); this.onAction('awake-mode', { value: 'working' }); } },
        { label: '자동으로 막지 않기', type: 'radio', checked: settings.keepAwake === false, click: () => this.onAction('awake-auto', { value: false }) },
        { type: 'separator' },
        { label: '지금부터 계속 깨어 있기', type: 'checkbox', checked: !!settings.keepAwakeManual, click: (i) => this.onAction('awake-manual', { value: i.checked }) },
        { label: '🧳 덮개를 닫아도 잠들지 않기 (외출용)', type: 'checkbox', checked: !!aw.lid, click: (i) => this.onAction('awake-lid', { value: i.checked }) },
      ],
    });
    if (restorable.length) {
      items.push({
        label: `🔁  닫힌 세션 다시 열기 (${restorable.length})`,
        submenu: [
          { label: '전부 다시 열기', click: act('restore', {}) },
          { type: 'separator' },
          ...restorable.slice(0, 10).map((h) => ({ label: `${h.name}  ·  ${new Date(h.lastSeen).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, click: act('restore', { ids: [h.id] }) })),
        ],
      });
    }
    if (this.state.claude && !this.state.claude.installed) {
      items.push({ label: '🔌  Claude Code 연결하기…', click: act('connect-claude') });
    }
    items.push({ type: 'separator' });
    return items;
  }

  destroy() {
    clearTimeout(this.animTimer);
    this.tray.destroy();
  }
}

module.exports = { PetTray, bar };
