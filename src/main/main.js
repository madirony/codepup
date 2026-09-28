const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  protocol,
  net,
  Menu,
  dialog,
  powerMonitor,
  shell,
  globalShortcut,
  powerSaveBlocker,
} = require('electron');

const { Store } = require('./store');
const { SystemStats } = require('./system-stats');
const { PetTray } = require('./tray');
const Pet = require('./pet-state');
const { SessionHub } = require('./sessions');
const { Bridge } = require('./bridge');
const { Skins } = require('./skins');
const transcripts = require('./transcripts');
const { KeepAwake } = require('./keep-awake');
const terminals = require('./terminals');
const { IMAGE_SLOTS, SOUND_SLOTS, DEFAULT_SETTINGS } = require('./defaults');

const APP_ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'preload.js');
const SCHEME = 'codepup';
const ORIGIN = `${SCHEME}://app`;
const TICK_MS = 5000;
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const SOUND_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg'];
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
let activeShortcut = ''; // 지금 등록된 세션 보드 단축키

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// 같은 origin(codepup://app)에서 앱 파일 · 스킨 · 사용자 업로드 파일을 모두 제공해야
// WebGL 텍스처(CORS)와 fetch 가 문제없이 동작합니다.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let store;
let pet;
let stats;
let tray;
let hub;
let bridge;
let skins;
let awake;
let petWin = null;
let settingsWin = null;
let panelWin = null;
let popWin = null; // 메뉴 막대 아이콘을 누르면 뜨는 팝오버
let lastTickAt = Date.now();
let lastSavedAt = 0;
let idleNap = false;
let quitting = false;

// ---------- 공용 ----------

function windows() {
  return [petWin, settingsWin, panelWin, popWin].filter((w) => w && !w.isDestroyed());
}

function sendToAll(channel, payload) {
  for (const win of windows()) win.webContents.send(channel, payload);
}

function broadcastPet() {
  const snap = Pet.snapshot(pet);
  sendToAll('pet:state', snap);
  if (tray) tray.update({ pet: snap });
}

function broadcastSettings() {
  sendToAll('settings:changed', store.settings);
  if (tray) tray.update({ settings: store.settings });
}

function broadcastSkins() {
  sendToAll('skins:changed', { skins: skins.list(), active: skins.get(store.settings.skin), name: store.settings.name });
}

function handleEvents(events) {
  for (const ev of events) sendToAll('pet:event', ev);
}

function persistPet(force = false) {
  store.pet = pet;
  store.sessionsHistory = hub ? hub.history : store.sessionsHistory;
  if (force) store.saveNow();
  else store.saveSoon();
  lastSavedAt = Date.now();
}

function applyAction(fn) {
  const { result, events } = fn();
  handleEvents(events);
  broadcastPet();
  persistPet();
  return { result, pet: Pet.snapshot(pet) };
}

function sendCommand(name, payload = {}) {
  if (!petWin || petWin.isDestroyed()) return;
  petWin.webContents.send('pet:command', { name, ...payload });
}

// ---------- 창 ----------

function overlayBounds() {
  return screen.getPrimaryDisplay().workArea;
}

function createPetWindow() {
  const b = overlayBounds();
  petWin = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // 클릭해도 작업 중인 앱의 포커스를 뺏지 않도록
    acceptFirstMouse: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  petWin.setAlwaysOnTop(true, 'floating');
  petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: store.settings.showOnFullscreen });
  petWin.loadURL(`${ORIGIN}/src/renderer/pet/index.html`);
  petWin.once('ready-to-show', () => {
    if (!store.settings.hidden) petWin.showInactive();
  });
  petWin.on('closed', () => {
    petWin = null;
    if (!quitting) createPetWindow();
  });
}

function fitPetWindow() {
  if (!petWin || petWin.isDestroyed()) return;
  petWin.setBounds(overlayBounds());
}

function openSettings(tab) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (tab) settingsWin.webContents.send('settings:tab', tab);
    if (process.platform === 'darwin') app.focus({ steal: true });
    return;
  }
  settingsWin = new BrowserWindow({
    width: 640,
    height: 800,
    minWidth: 480,
    minHeight: 560,
    title: '설정',
    backgroundColor: '#fff5f7',
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadURL(`${ORIGIN}/src/renderer/settings/index.html${tab ? '#' + tab : ''}`);
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// 세션 보드: 여러 Claude Code 세션을 한눈에 보고 답하는 작은 창
function openPanel({ focusSession, toggle } = {}) {
  if (panelWin && !panelWin.isDestroyed()) {
    if (toggle && panelWin.isVisible()) {
      panelWin.hide();
      return;
    }
    panelWin.show();
    panelWin.focus();
    if (focusSession) panelWin.webContents.send('panel:focus', focusSession);
    if (process.platform === 'darwin') app.focus({ steal: true });
    return;
  }
  const wa = overlayBounds();
  const w = 400;
  const h = Math.min(640, wa.height - 40);
  panelWin = new BrowserWindow({
    width: w,
    height: h,
    x: wa.x + wa.width - w - 16,
    y: wa.y + 12,
    minWidth: 340,
    minHeight: 360,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: '세션 보드',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  panelWin.setAlwaysOnTop(true, 'floating');
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWin.loadURL(`${ORIGIN}/src/renderer/panel/index.html${focusSession ? '#' + encodeURIComponent(focusSession) : ''}`);
  panelWin.once('ready-to-show', () => {
    panelWin.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
  });
  panelWin.on('closed', () => {
    panelWin = null;
  });
}

// ---------- 세션 보드 단축키 ----------

const ACCEL_RE = /^(?:(?:CommandOrControl|Command|Control|Alt|Shift)\+){1,4}(?:[A-Z0-9]|F\d{1,2}|Space|Up|Down|Left|Right|[.,/;])$/;

// 다른 앱이 이미 쓰는 키면 등록이 안 돼요 → 이전 키로 되돌리고 알려 줌
function applyShortcut(accel) {
  if (activeShortcut) globalShortcut.unregister(activeShortcut);
  activeShortcut = '';
  if (!accel) return { ok: true };
  if (!ACCEL_RE.test(accel)) return { ok: false, error: '쓸 수 없는 조합이에요' };
  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => openPanel({ toggle: true }));
  } catch {
    ok = false;
  }
  if (ok) activeShortcut = accel;
  return ok ? { ok: true } : { ok: false, error: '다른 앱이 이미 쓰고 있는 단축키예요' };
}

function setShortcut(accel) {
  const prev = store.settings.panelShortcut;
  const next = String(accel || '');
  const r = applyShortcut(next);
  if (!r.ok) {
    applyShortcut(prev);
    return r;
  }
  updateSettings({ panelShortcut: next });
  return { ok: true };
}

// ---------- 메뉴 막대 팝오버 ----------

const POP_W = 372;
let popAnchor = null; // 마지막으로 누른 메뉴 막대 아이콘 위치
let popHiddenAt = 0;

function placePopover(bounds, height) {
  if (bounds && bounds.width) popAnchor = bounds;
  const b = popAnchor || (tray ? tray.bounds() : null);
  const disp = b ? screen.getDisplayNearestPoint({ x: b.x, y: b.y }) : screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const h = Math.min(height || popWin.getBounds().height, wa.height - 12);
  let x = b ? Math.round(b.x + b.width / 2 - POP_W / 2) : wa.x + wa.width - POP_W - 8;
  x = Math.max(wa.x + 6, Math.min(x, wa.x + wa.width - POP_W - 6));
  const y = b ? Math.round(b.y + b.height + 4) : wa.y + 4;
  popWin.setBounds({ x, y: Math.max(y, wa.y + 2), width: POP_W, height: h });
}

function togglePopover(bounds) {
  if (popWin && !popWin.isDestroyed()) {
    if (popWin.isVisible()) return popWin.hide();
    if (Date.now() - popHiddenAt < 300) return; // 아이콘을 다시 눌러 닫은 경우 (blur 로 먼저 숨겨짐)
    placePopover(bounds);
    popWin.show();
    popWin.focus();
    if (process.platform === 'darwin') app.focus({ steal: true }); // Dock 이 없는 앱이라 포커스를 가져와야 바깥 클릭으로 닫혀요
    popWin.webContents.send('popover:shown');
    return;
  }
  popWin = new BrowserWindow({
    width: POP_W,
    height: 520,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: true,
    title: 'CodePup',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  popWin.setAlwaysOnTop(true, 'pop-up-menu');
  popWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popWin.loadURL(`${ORIGIN}/src/renderer/popover/index.html`);
  popWin.on('blur', () => {
    if (popWin && !popWin.isDestroyed() && !popWin.webContents.isDevToolsOpened()) {
      popHiddenAt = Date.now();
      popWin.hide();
    }
  });
  popWin.on('closed', () => {
    popWin = null;
  });
  popWin.once('ready-to-show', () => {
    placePopover(bounds);
    popWin.show();
    popWin.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  });
}

// 잠자기 방지 ▾ 메뉴
function showAwakeMenu() {
  const s = store.settings;
  Menu.buildFromTemplate([
    { label: 'Claude 세션이 열려 있으면 (원격 작업용)', type: 'radio', checked: s.keepAwake !== false && s.keepAwakeMode !== 'working', click: () => { handleMenuAction('awake-auto', { value: true }); handleMenuAction('awake-mode', { value: 'open' }); } },
    { label: 'Claude 가 일할 때만', type: 'radio', checked: s.keepAwake !== false && s.keepAwakeMode === 'working', click: () => { handleMenuAction('awake-auto', { value: true }); handleMenuAction('awake-mode', { value: 'working' }); } },
    { label: '자동으로 막지 않기', type: 'radio', checked: s.keepAwake === false, click: () => handleMenuAction('awake-auto', { value: false }) },
    { type: 'separator' },
    { label: '지금부터 계속 깨어 있기', type: 'checkbox', checked: !!s.keepAwakeManual, click: (i) => handleMenuAction('awake-manual', { value: i.checked }) },
    { type: 'separator' },
    { label: '자세한 설정…', click: () => openSettings('claude') },
  ]).popup({ window: popWin || undefined });
}

// ---------- 설정 ----------

function applySettingsSideEffects(prev) {
  const s = store.settings;
  if (petWin && !petWin.isDestroyed()) {
    if (prev.showOnFullscreen !== s.showOnFullscreen) {
      petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: s.showOnFullscreen });
    }
    if (prev.hidden !== s.hidden) {
      if (s.hidden) petWin.hide();
      else petWin.showInactive();
    }
  }
  if (prev.launchAtLogin !== s.launchAtLogin && app.isPackaged && process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin });
  }
  if (prev.skin !== s.skin) {
    // 이름·대사를 바꾸지 않았다면 새 스킨의 기본값으로
    const before = skins.get(prev.skin);
    const after = skins.get(s.skin);
    if (after && after.defaultName && (!before || s.name === before.defaultName || s.name === DEFAULT_SETTINGS.name)) {
      s.name = after.defaultName;
    }
    if (after && after.phrases.length && (!before || JSON.stringify(s.phrases) === JSON.stringify(before.phrases))) {
      s.phrases = after.phrases;
    }
    broadcastSkins();
  }
}

function sanitizePatch(patch) {
  const out = {};
  const s = patch || {};
  if (typeof s.name === 'string') out.name = s.name.trim().slice(0, 20) || DEFAULT_SETTINGS.name;
  if (typeof s.skin === 'string' && skins.list().some((k) => k.id === s.skin)) out.skin = s.skin;
  if (Number.isFinite(s.size)) out.size = Math.round(Math.min(160, Math.max(40, s.size)));
  if (Number.isFinite(s.speed)) out.speed = Math.min(3, Math.max(0.3, s.speed));
  if (s.moveMode === 'free' || s.moveMode === 'ground') out.moveMode = s.moveMode;
  if (Number.isFinite(s.volume)) out.volume = Math.min(1, Math.max(0, s.volume));
  if (Number.isFinite(s.sprintThreshold)) out.sprintThreshold = Math.round(Math.min(100, Math.max(20, s.sprintThreshold)));
  if (Number.isFinite(s.idleSleepMinutes)) out.idleSleepMinutes = Math.round(Math.min(120, Math.max(1, s.idleSleepMinutes)));
  if (Number.isFinite(s.permissionWaitSec)) out.permissionWaitSec = Math.round(Math.min(600, Math.max(10, s.permissionWaitSec)));
  if (['auto', 'Terminal', 'iTerm'].includes(s.restoreTerminal)) out.restoreTerminal = s.restoreTerminal;
  if (typeof s.restoreExtraArgs === 'string') out.restoreExtraArgs = s.restoreExtraArgs.slice(0, 120);
  if (s.keepAwakeMode === 'open' || s.keepAwakeMode === 'working') out.keepAwakeMode = s.keepAwakeMode;
  for (const key of [
    'keepAwake',
    'keepAwakeManual',
    'soundEnabled',
    'ambientSounds',
    'bubbles',
    'cpuReactive',
    'idleSleep',
    'showOnFullscreen',
    'launchAtLogin',
    'hidden',
    'restoreRemoteControl',
    'restoreSkipPermissions',
    'restoreTabs',
  ]) {
    if (typeof s[key] === 'boolean') out[key] = s[key];
  }
  if (typeof s.panelShortcut === 'string' && (s.panelShortcut === '' || ACCEL_RE.test(s.panelShortcut))) out.panelShortcut = s.panelShortcut;
  if (Array.isArray(s.phrases)) {
    out.phrases = s.phrases.map((p) => String(p).trim().slice(0, 40)).filter(Boolean).slice(0, 50);
  }
  if (s.tray && typeof s.tray === 'object') {
    out.tray = { ...store.settings.tray };
    for (const key of Object.keys(DEFAULT_SETTINGS.tray)) {
      if (typeof s.tray[key] === 'boolean') out.tray[key] = s.tray[key];
    }
  }
  return out;
}

function updateSettings(patch) {
  const prev = { ...store.settings };
  Object.assign(store.settings, sanitizePatch(patch));
  applySettingsSideEffects(prev);
  store.saveSoon();
  broadcastSettings();
  return store.settings;
}

// ---------- 사용자 업로드 미디어 ----------

function slotExists(kind, slot) {
  const list = kind === 'image' ? IMAGE_SLOTS : SOUND_SLOTS;
  return list.some((s) => s.key === slot);
}

function removeMediaFile(name) {
  if (!name) return;
  const file = path.join(store.mediaDir, path.basename(name));
  fs.promises.unlink(file).catch(() => {});
}

async function pickMedia(kind, slot) {
  if (!slotExists(kind, slot)) return { ok: false, error: '알 수 없는 슬롯' };
  const exts = kind === 'image' ? IMAGE_EXT : SOUND_EXT;
  const res = await dialog.showOpenDialog(settingsWin || undefined, {
    title: kind === 'image' ? '이미지 선택' : '소리 파일 선택',
    properties: ['openFile'],
    filters: [{ name: kind === 'image' ? '이미지' : '오디오', extensions: exts }],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  const src = res.filePaths[0];
  const ext = path.extname(src).slice(1).toLowerCase();
  if (!exts.includes(ext)) return { ok: false, error: '지원하지 않는 파일 형식이에요' };
  const { size } = await fs.promises.stat(src);
  if (size > MAX_MEDIA_BYTES) return { ok: false, error: '15MB 이하 파일만 올릴 수 있어요' };
  const name = `${kind}-${slot}-${Date.now()}.${ext}`;
  await fs.promises.copyFile(src, path.join(store.mediaDir, name));
  const field = kind === 'image' ? 'customImages' : 'customSounds';
  removeMediaFile(store.settings[field][slot]);
  store.settings[field] = { ...store.settings[field], [slot]: name };
  store.saveSoon();
  broadcastSettings();
  return { ok: true, name };
}

function resetMedia(kind, slot) {
  const field = kind === 'image' ? 'customImages' : 'customSounds';
  const next = { ...store.settings[field] };
  if (slot === '*') {
    Object.values(next).forEach(removeMediaFile);
    store.settings[field] = {};
  } else {
    removeMediaFile(next[slot]);
    delete next[slot];
    store.settings[field] = next;
  }
  store.saveSoon();
  broadcastSettings();
  return { ok: true };
}

async function importSkin() {
  const res = await dialog.showOpenDialog(settingsWin || undefined, {
    title: '스킨 폴더 선택 (skin.json 또는 default.png 가 있는 폴더)',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  const r = skins.import(res.filePaths[0]);
  if (r.ok) {
    broadcastSkins();
    updateSettings({ skin: r.id });
  }
  return r;
}

// ---------- Claude Code ----------

function claudeStatus() {
  return {
    installed: bridge ? bridge.isInstalled() : false,
    running: !!(bridge && bridge.port),
    settingsPath: bridge ? bridge.claudeSettings : '',
    counts: hub ? hub.counts() : null,
  };
}

async function connectClaude(ask = true) {
  if (ask) {
    const res = await dialog.showMessageBox(settingsWin || undefined, {
      type: 'question',
      buttons: ['취소', '연결하기'],
      defaultId: 1,
      cancelId: 0,
      message: 'Claude Code 와 연결할까요?',
      detail:
        '~/.claude/settings.json 에 알림용 훅을 추가해요. 기존 설정은 그대로 두고, 바꾸기 전에 백업(settings.json.codepup-backup)을 남겨요.\n\n' +
        '연결하면 세션이 끝나거나 허락이 필요할 때 펫이 알려 주고, 펫에서 바로 허락·거절할 수 있어요.\n\n이미 열려 있는 세션은 연결 후 한 번 다시 열어야 알림이 와요 (세션 보드의 [알림 켜기] 버튼으로 한 번에).',
    });
    if (res.response !== 1) return { ok: false, canceled: true };
  }
  try {
    bridge.install();
    store.settings.hooksSince = Date.now(); // 이 뒤에 시작한 claude 만 훅을 읽어요
    store.saveSoon();
    sendToAll('claude:status', claudeStatus());
    if (tray) tray.update({ claude: claudeStatus() });
    sendCommand('say', { text: '이제 Claude 세션을 지켜볼게요!', tex: 'happy' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function disconnectClaude() {
  try {
    bridge.uninstall();
    sendToAll('claude:status', claudeStatus());
    if (tray) tray.update({ claude: claudeStatus() });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function restoreOptions() {
  const s = store.settings;
  return { remoteControl: s.restoreRemoteControl, skipPermissions: s.restoreSkipPermissions, extraArgs: s.restoreExtraArgs, terminal: s.restoreTerminal, tabs: s.restoreTabs };
}

// 알림이 꺼진 세션(연결 전에 연 세션)을 같은 탭에서 닫았다가 바로 다시 열기
async function reopenForHooks(ids) {
  const targets = hub.needingReopen().filter((s) => !ids || ids.includes(s.id));
  if (!targets.length) return { ok: false, error: '다시 열 세션이 없어요' };
  // 방금까지 대화 기록이 바뀐 세션은 일하는 중일 수 있어서 건너뜀
  const busy = [];
  const ready = [];
  for (const s of targets) {
    let m = 0;
    try {
      m = s.transcriptPath ? fs.statSync(s.transcriptPath).mtimeMs : 0;
    } catch {
      // 없으면 조용한 것으로
    }
    (Date.now() - m < 20000 ? busy : ready).push(s);
  }
  if (!ready.length) return { ok: false, error: '지금 일하는 중인 것 같아요. 끝나면 다시 눌러 주세요' };
  const res = await dialog.showMessageBox({
    type: 'question',
    buttons: ['취소', `${ready.length}개 다시 열기`],
    defaultId: 1,
    cancelId: 0,
    message: '알림이 꺼진 세션을 같은 탭에서 다시 열까요?',
    detail:
      `CodePup 을 연결하기 전에 연 세션은 알림을 보낼 수 없어요. 그 탭의 claude 를 끝내고 곧바로 같은 대화를 이어서 열어요 (원래 옵션 그대로).\n\n` +
      ready.map((s) => `• ${s.name}`).join('\n') +
      (busy.length ? `\n\n건너뜀 (지금 일하는 중): ${busy.map((s) => s.name).join(', ')}` : ''),
  });
  if (res.response !== 1) return { ok: false, canceled: true };
  let done = 0;
  const errors = [];
  for (const s of ready) {
    const r = await terminals.reopenInPlace({ id: s.id, cwd: s.cwd }, { pid: s.pid, tty: s.tty, command: s.command });
    if (r.ok) done++;
    else errors.push(`${s.name}: ${r.error}`);
  }
  if (done) sendCommand('say', { text: `🔔 ${done}개 세션 알림을 켰어요!`, tex: 'happy' });
  return { ok: done > 0, reopened: done, errors };
}

async function restoreSessions(ids) {
  const list = hub.restorable(40).filter((h) => !ids || ids.includes(h.id));
  if (!list.length) return { ok: false, error: '다시 열 세션이 없어요' };
  if (!ids && list.length > 1) {
    const res = await dialog.showMessageBox({
      type: 'question',
      buttons: ['취소', `${list.length}개 다시 열기`],
      defaultId: 1,
      cancelId: 0,
      message: `닫힌 세션 ${list.length}개를 다시 열까요?`,
      detail:
        list.map((h) => `• ${h.name}${h.endReason === 'vanished' ? ' (갑자기 꺼짐)' : ''}`).join('\n') +
        '\n\n/exit 로 직접 끝낸 세션은 빠져 있어요. 다시 열고 싶지 않은 세션은 세션 보드에서 ✕ 로 목록에서 지울 수 있어요.',
    });
    if (res.response !== 1) return { ok: false, canceled: true };
  }
  const results = await terminals.openSessions(list, restoreOptions());
  const failed = results.filter((r) => !r.ok);
  return failed.length ? { ok: false, error: failed[0].error, opened: results.length - failed.length } : { ok: true, opened: results.length };
}

function evaluateAwake() {
  if (!awake) return;
  awake.configure({ auto: store.settings.keepAwake, manual: store.settings.keepAwakeManual, mode: store.settings.keepAwakeMode });
  awake.evaluate({ sessions: hub.list(), tasks: 0 });
}

async function toggleLid(disable) {
  if (disable) {
    const res = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['취소', '덮개를 닫아도 잠들지 않기'],
      defaultId: 1,
      cancelId: 0,
      message: '노트북 덮개를 닫아도 맥이 잠들지 않게 할까요?',
      detail:
        '밖에서 원격으로 작업할 때 쓰는 기능이에요. macOS 설정(pmset disablesleep)을 바꾸기 때문에 관리자 암호를 한 번 물어봐요.\n\n' +
        '⚠️ 가방 속에서도 켜져 있어서 뜨거워지고 배터리가 빨리 닳을 수 있어요. 돌아오면 꼭 다시 꺼 주세요. (메뉴 막대에서 끌 수 있어요)',
    });
    if (res.response !== 1) return;
  }
  const r = await awake.setLid(disable);
  if (!r.ok && r.error !== '취소했어요') dialog.showErrorBox('설정하지 못했어요', r.error);
  if (r.ok) sendCommand('say', { text: disable ? '🧳 덮개를 닫아도 잠들지 않을게요! 다녀오세요~' : '🛏 이제 덮개를 닫으면 잘게요', tex: 'happy' });
}

function onAwakeChanged(state) {
  if (tray) tray.update({ awake: state });
  sendToAll('awake:changed', state);
  if (state.turnedOn && !state.manual && state.reason) {
    const text = state.reason.kind === 'open' ? '☕ Claude 세션이 열려 있는 동안 맥이 잠들지 않게 지킬게요!' : '☕ Claude 가 일하는 동안 맥이 잠들지 않게 지킬게요!';
    sendCommand('say', { text, tex: 'happy' });
  }
}

const procCwd = new Map(); // pid → 작업 폴더 (lsof 는 새 프로세스에만)

async function scanOpenSessions() {
  try {
    for (const t of transcripts.scanActive()) hub.observe(t);
  } catch (err) {
    console.error('[transcripts]', err);
  }
  const procs = process.platform === 'darwin' ? await terminals.runningClaudes() : null;
  if (procs) {
    try {
      await attachRunning(procs);
    } catch (err) {
      console.error('[running]', err);
    }
  }
  hub.sweep({ aliveTtys: procs ? await terminals.aliveClaudeTtys(procs) : null });
}

// 터미널에서 돌고 있는 claude → 세션 (명령줄의 --resume ID, 없으면 그 폴더의 최근 대화 기록)
async function attachRunning(procs) {
  const live = new Set(procs.map((p) => p.pid));
  for (const pid of procCwd.keys()) if (!live.has(pid)) procCwd.delete(pid);
  const taken = new Set(hub.list().map((s) => s.id));
  const knownTtys = new Set(hub.list().map((s) => s.tty).filter(Boolean));
  for (const p of procs) {
    if (knownTtys.has(p.tty)) continue;
    if (!procCwd.has(p.pid)) procCwd.set(p.pid, await terminals.cwdOf(p.pid));
    const cwd = procCwd.get(p.pid);
    if (!cwd) continue;
    let id = terminals.sessionIdFromArgs(p.command);
    let file = '';
    if (!id) {
      // 이 프로세스가 켜진 뒤에 바뀐 대화 기록만 (방금 연 새 세션이 같은 폴더의 옛 세션으로 붙지 않게)
      const since = (p.startedAt || 0) - 5000;
      const recent = transcripts.recentSessions({ cwd }).filter((r) => !taken.has(r.id) && r.mtime >= since);
      if (!recent.length) continue; // 아직 대화를 시작하지 않은 새 세션
      id = recent[0].id;
      file = recent[0].path;
    }
    taken.add(id);
    knownTtys.add(p.tty);
    const since = store.settings.hooksSince || 0;
    const needsReopen = !!(bridge && bridge.isInstalled() && since && p.startedAt && p.startedAt < since - 5000);
    hub.attach({ session_id: id, cwd, tty: p.tty, transcript_path: file, pid: p.pid, command: p.command, needsReopen });
  }
}

function onHubChanged({ session, event, counts }) {
  sendToAll('sessions:changed', { session, event, counts, list: hub.list() });
  if (tray) tray.update({ sessions: { counts, list: hub.list(), restorable: hub.restorable(10) } });
  if (event.type === 'done') applyAction(() => Pet.taskDone(pet));
  if (event.type === 'started' || event.type === 'ended') persistPet();
  evaluateAwake();
}

// ---------- 트레이 · 메뉴 동작 ----------

function handleMenuAction(name, payload = {}) {
  switch (name) {
    case 'feed':
    case 'pet':
    case 'sing':
      if (pet.sleeping && name !== 'pet') applyAction(() => Pet.wake(pet, 'command'));
      sendCommand(name);
      break;
    case 'sleep':
      idleNap = false;
      applyAction(() => Pet.sleep(pet));
      break;
    case 'wake':
      applyAction(() => Pet.wake(pet, 'command'));
      break;
    case 'toggle-hidden':
      updateSettings({ hidden: !store.settings.hidden });
      break;
    case 'tray-toggle':
      updateSettings({ tray: { [payload.key]: payload.value } });
      break;
    case 'sound-toggle':
      updateSettings({ soundEnabled: payload.value });
      break;
    case 'toggle-popover':
      togglePopover(payload && payload.bounds);
      break;
    case 'awake-toggle': {
      // 팝오버의 ☕ 버튼: 켜져 있으면(자동이든 직접이든) 끄고, 꺼져 있으면 자동으로
      const on = store.settings.keepAwake !== false || store.settings.keepAwakeManual;
      updateSettings(on ? { keepAwake: false, keepAwakeManual: false } : { keepAwake: true });
      evaluateAwake();
      break;
    }
    case 'awake-menu':
      showAwakeMenu();
      break;
    case 'open-settings':
      openSettings(payload.tab);
      break;
    case 'open-panel':
      openPanel({ focusSession: payload.sessionId });
      break;
    case 'awake-manual':
      updateSettings({ keepAwakeManual: !!payload.value }); // 앱을 다시 켜도 유지
      evaluateAwake();
      sendCommand('say', { text: payload.value ? '☕ 이제 계속 깨어 있을게요!' : '💤 이제 평소처럼 잠들어도 돼요', tex: 'happy' });
      break;
    case 'awake-auto':
      updateSettings({ keepAwake: !!payload.value });
      evaluateAwake();
      break;
    case 'awake-mode':
      updateSettings({ keepAwakeMode: payload.value });
      evaluateAwake();
      break;
    case 'awake-lid':
      toggleLid(!!payload.value);
      break;
    case 'connect-claude':
      connectClaude();
      break;
    case 'reopen-hooks':
      reopenForHooks(payload && payload.ids);
      break;
    case 'restore':
      restoreSessions(payload.ids);
      break;
    case 'focus-session': {
      const s = hub.list().find((x) => x.id === payload.sessionId);
      if (s) terminals.focusSession(s);
      break;
    }
    case 'quit':
      app.quit();
      break;
    default:
      break;
  }
}

function showPetContextMenu() {
  const act = (n, p) => () => handleMenuAction(n, p);
  const c = hub.counts();
  const menu = Menu.buildFromTemplate([
    { label: `${store.settings.name}  ·  Lv.${pet.level}`, enabled: false },
    { type: 'separator' },
    { label: `🗂  세션 보드${c.total ? ` (${c.total})` : ''}`, click: act('open-panel') },
    { type: 'separator' },
    { label: '🍖  밥 주기', click: act('feed') },
    { label: '🤚  쓰다듬기', click: act('pet') },
    pet.sleeping ? { label: '☀️  깨우기', click: act('wake') } : { label: '💤  재우기', click: act('sleep') },
    { label: '🎵  노래 불러줘', click: act('sing'), enabled: !pet.sleeping },
    { type: 'separator' },
    { label: '🎨  스킨 · 커스텀…', click: act('open-settings', { tab: 'custom' }) },
    { label: '⚙️  설정…', click: act('open-settings') },
    { label: '🙈  숨기기', click: act('toggle-hidden') },
  ]);
  menu.popup({ window: petWin || undefined });
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    settings: store.settings,
    pet: Pet.snapshot(pet),
    stats: stats.stats,
    imageSlots: IMAGE_SLOTS,
    soundSlots: SOUND_SLOTS,
    defaults: DEFAULT_SETTINGS,
    skins: skins.list(),
    skin: skins.get(store.settings.skin),
    sessions: { list: hub.list(), counts: hub.counts(), restorable: hub.restorable() },
    awake: awake ? awake.state() : null,
    claude: claudeStatus(),
    origin: ORIGIN,
    version: app.getVersion(),
    platform: process.platform,
    shortcut: store.settings.panelShortcut,
  }));

  ipcMain.on('pet:ignore-mouse', (e, ignore) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.on('pet:context-menu', () => showPetContextMenu());

  ipcMain.on('pet:tray-frames', (_e, frames) => tray && tray.setFrames(frames));

  ipcMain.handle('pet:action', (_e, name, payload = {}) => {
    switch (name) {
      case 'pet':
        return applyAction(() => Pet.petPet(pet));
      case 'ate':
        return applyAction(() => Pet.feed(pet));
      case 'annoy':
        return applyAction(() => Pet.annoy(pet));
      case 'poke':
        return applyAction(() => Pet.wake(pet, 'poked'));
      case 'carried':
        return applyAction(() => Pet.wake(pet, 'carried'));
      case 'ran':
        return applyAction(() => Pet.ran(pet, Math.min(500, Number(payload.bodies) || 0)));
      default:
        return { result: 'unknown', pet: Pet.snapshot(pet) };
    }
  });

  ipcMain.handle('menu:action', (_e, name, payload) => {
    handleMenuAction(name, payload);
    return true;
  });

  ipcMain.handle('settings:update', (_e, patch) => updateSettings(patch));
  ipcMain.handle('shortcut:set', (_e, accel) => setShortcut(accel));
  ipcMain.handle('media:pick', (_e, kind, slot) => pickMedia(kind, slot));
  ipcMain.handle('media:reset', (_e, kind, slot) => resetMedia(kind, slot));
  ipcMain.handle('skins:import', () => importSkin());
  ipcMain.handle('skins:remove', (_e, id) => {
    const ok = skins.remove(id);
    if (ok && store.settings.skin === id) updateSettings({ skin: 'chihuahua' });
    broadcastSkins();
    return ok;
  });

  // 세션
  ipcMain.handle('sessions:get', () => ({ list: hub.list(), counts: hub.counts(), restorable: hub.restorable() }));
  ipcMain.handle('sessions:decide', (_e, id, decision) => hub.decide(id, decision));
  ipcMain.handle('sessions:focus', (_e, id) => {
    const s = hub.list().find((x) => x.id === id);
    return s ? terminals.focusSession(s) : { ok: false, error: '세션이 없어요' };
  });
  ipcMain.handle('sessions:restore', (_e, ids) => restoreSessions(ids));
  ipcMain.handle('sessions:reopen-hooks', (_e, ids) => reopenForHooks(ids));
  ipcMain.handle('sessions:forget', (_e, id) => {
    hub.history = hub.history.filter((h) => h.id !== id);
    persistPet();
    return true;
  });
  ipcMain.on('panel:close', () => panelWin && panelWin.hide());
  ipcMain.on('popover:size', (_e, h) => {
    if (popWin && !popWin.isDestroyed() && Number.isFinite(h)) placePopover(null, Math.round(h));
  });
  ipcMain.on('popover:close', () => popWin && popWin.hide());


  // Claude Code 연결
  ipcMain.handle('claude:status', () => claudeStatus());
  ipcMain.handle('claude:connect', () => connectClaude(false));
  ipcMain.handle('claude:disconnect', () => disconnectClaude());

  ipcMain.handle('pet:reset', async () => {
    const res = await dialog.showMessageBox(settingsWin || undefined, {
      type: 'warning',
      buttons: ['취소', '처음부터 다시 키우기'],
      defaultId: 0,
      cancelId: 0,
      message: '레벨과 상태를 모두 초기화할까요?',
      detail: '커스텀 이미지·소리와 설정은 그대로 남아요.',
    });
    if (res.response !== 1) return false;
    pet = Pet.createPet();
    broadcastPet();
    persistPet(true);
    sendCommand('greet');
    return true;
  });

  ipcMain.handle('app:open-data-folder', () => shell.openPath(store.dir));
}

// ---------- 주기적 갱신 ----------

function petLoop() {
  const now = Date.now();
  const dt = (now - lastTickAt) / 1000;
  lastTickAt = now;
  pet.lastTick = now;

  // 컴퓨터를 한동안 안 쓰면 낮잠, 돌아오면 기상
  const idleSec = powerMonitor.getSystemIdleTime();
  const s = store.settings;
  if (s.idleSleep && !pet.sleeping && idleSec >= s.idleSleepMinutes * 60 && pet.energy < 95 && !hub.counts().permission) {
    idleNap = true;
    handleEvents([{ type: 'slept', reason: 'idle' }]);
    pet.sleeping = true;
  } else if (idleNap && pet.sleeping && idleSec < 5) {
    idleNap = false;
    pet.sleeping = false;
    handleEvents([{ type: 'woke', reason: 'user-back' }]);
  }
  if (!pet.sleeping) idleNap = false;

  handleEvents(Pet.tick(pet, dt, { cpu: stats.stats.cpu }));
  broadcastPet();
  if (now - lastSavedAt > 30000) persistPet();
}

// ---------- 시작 ----------

function registerProtocol() {
  const roots = {
    'user-media/': path.resolve(store.mediaDir),
    'user-skins/': path.resolve(app.getPath('userData'), 'skins'),
    'skins/': path.resolve(APP_ROOT, 'assets', 'skins'),
  };
  const appRoot = path.resolve(APP_ROOT);
  protocol.handle(SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    let root = appRoot;
    let sub = rel;
    for (const [prefix, dir] of Object.entries(roots)) {
      if (rel.startsWith(prefix)) {
        root = dir;
        sub = rel.slice(prefix.length);
        break;
      }
    }
    const file = path.resolve(root, sub);
    if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

async function firstRunClaude() {
  if (store.settings.claudeAsked || bridge.isInstalled()) return;
  store.settings.claudeAsked = true;
  store.saveSoon();
  const res = await dialog.showMessageBox({
    type: 'question',
    buttons: ['나중에', 'Claude Code 연결'],
    defaultId: 1,
    cancelId: 0,
    message: `안녕하세요! ${store.settings.name}예요 🐶`,
    detail:
      'Claude Code 를 쓰고 계신가요? 연결하면 세션이 작업을 끝내거나 허락이 필요할 때 제가 달려가서 알려 드리고, 말풍선에서 바로 허락 · 거절할 수 있어요.\n\n(~/.claude/settings.json 에 훅을 추가해요. 나중에 설정에서 언제든 해제할 수 있어요.)',
  });
  if (res.response === 1) connectClaude(false);
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  store = new Store(app.getPath('userData'));
  skins = new Skins({ bundledDir: path.join(APP_ROOT, 'assets', 'skins'), userDir: path.join(app.getPath('userData'), 'skins') });
  if (!skins.list().some((k) => k.id === store.settings.skin)) store.settings.skin = 'chihuahua';
  if (!store.settings.quietWander) {
    // 2.7.4: 돌아다니며 내는 소리는 기본으로 끔 → 소리가 나면 작업 끝 · 허락 요청이라는 뜻. 한 번만 바꾸고 이후엔 사용자 선택
    store.settings.quietWander = true;
    store.settings.ambientSounds = false;
    store.saveSoon();
  }
  if (!store.settings.statsBack) {
    // 2.9: 2.7 에서 꺼 버렸던 메뉴 막대 CPU · 메모리를 다시 켬 (한 번만, 이후엔 사용자 선택)
    store.settings.statsBack = true;
    store.settings.compactTray = true;
    store.settings.tray = { ...store.settings.tray, cpu: true, mem: true };
    store.saveSoon();
  }
  pet = Pet.normalize(store.pet);
  Pet.catchUp(pet);
  lastTickAt = Date.now();

  hub = new SessionHub({ getSettings: () => store.settings, history: store.sessionsHistory });
  hub.on('changed', onHubChanged);
  bridge = new Bridge({ hub, onError: (err) => console.error('[bridge]', err) });
  awake = new KeepAwake({ blocker: powerSaveBlocker });
  awake.on('changed', onAwakeChanged);
  try {
    await bridge.start();
  } catch (err) {
    console.error('[bridge] failed to start', err);
  }
  try {
    if (bridge.isInstalled() && !store.settings.hooksSince) {
      // 언제 연결했는지 모르는 예전 설치: 지금부터로 봄 (그 전에 켠 세션은 [알림 켜기] 대상)
      store.settings.hooksSince = Date.now();
      store.saveSoon();
    }
    bridge.refresh(); // 예전 버전이 넣은 5초 새로고침 등을 이 버전 설정으로 갱신
  } catch (err) {
    console.error('[bridge] refresh', err);
  }

  registerProtocol();
  registerIpc();

  stats = new SystemStats();
  tray = new PetTray({
    fallbackIconPath: path.join(APP_ROOT, 'assets', 'skins', 'chihuahua', 'default.png'),
    onAction: handleMenuAction,
  });
  tray.update({
    settings: store.settings,
    pet: Pet.snapshot(pet),
    stats: stats.stats,
    sessions: { counts: hub.counts(), list: hub.list(), restorable: hub.restorable(10) },
    claude: claudeStatus(),
  });
  stats.on('update', (st) => {
    tray.update({ stats: st });
    sendToAll('stats:update', st);
  });
  stats.start();

  createPetWindow();
  setInterval(petLoop, TICK_MS);
  // 이미 열려 있던 세션 찾기 · 신호 끊긴 세션 정리
  setTimeout(scanOpenSessions, 1500);
  setInterval(scanOpenSessions, 15000);
  // ☕ 잠자기 방지: 유예 시간이 끝났는지 · 다른 앱이 이미 막고 있는지 확인
  setInterval(evaluateAwake, 30000);
  setInterval(() => awake.checkExternal(), 60000);
  setTimeout(() => awake.checkExternal(), 3000);
  awake.refreshLid();
  setInterval(() => awake.refreshLid(), 60000);
  evaluateAwake();

  applyShortcut(store.settings.panelShortcut);

  screen.on('display-metrics-changed', fitPetWindow);
  screen.on('display-added', fitPetWindow);
  screen.on('display-removed', fitPetWindow);
  powerMonitor.on('resume', () => {
    lastTickAt = Date.now(); // 잠자기 동안의 시간은 오프라인처럼 취급하지 않음
  });

  setTimeout(firstRunClaude, 2500);
});

app.on('second-instance', () => openPanel());
app.on('window-all-closed', () => {
  // 메뉴 막대 앱이므로 창이 모두 닫혀도 종료하지 않음
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => {
  quitting = true;
  if (hub) hub.releaseAll(); // 기다리던 훅은 모두 터미널로 돌려보냄
  if (awake) awake.stop();
  if (bridge) bridge.stop();
  if (store && pet) {
    pet.lastTick = Date.now();
    persistPet(true);
  }
  if (stats) stats.stop();
});
