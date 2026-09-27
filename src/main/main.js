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
} = require('electron');

const { Store } = require('./store');
const { SystemStats } = require('./system-stats');
const { PetTray } = require('./tray');
const Pet = require('./pet-state');
const { SessionHub } = require('./sessions');
const { Bridge } = require('./bridge');
const { Skins } = require('./skins');
const { Runner, isLongContextError } = require('./runner');
const transcripts = require('./transcripts');
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
const PANEL_SHORTCUT = 'CommandOrControl+Shift+J';
const PROMPT_SHORTCUT = 'CommandOrControl+Shift+K';
const FALLBACK_MODEL = 'sonnet'; // 모든 요금제에서 추가 사용량 없이 쓸 수 있는 모델

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
let runner;
let promptWin = null;
let petWin = null;
let settingsWin = null;
let panelWin = null;
let lastTickAt = Date.now();
let lastSavedAt = 0;
let idleNap = false;
let quitting = false;

// ---------- 공용 ----------

function windows() {
  return [petWin, settingsWin, panelWin, promptWin].filter((w) => w && !w.isDestroyed());
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
  sendToAll('skins:changed', { skins: skins.list(), active: skins.get(store.settings.skin) });
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

// 펫에게 말 걸기: 펫 머리 위에 뜨는 작은 입력창
function openPrompt({ x, y, sessionId } = {}) {
  const pb = petWin && !petWin.isDestroyed() ? petWin.getBounds() : overlayBounds();
  const wa = overlayBounds();
  const w = 380;
  const h = 250;
  const sx = Math.round(Math.min(wa.x + wa.width - w - 8, Math.max(wa.x + 8, pb.x + (Number.isFinite(x) ? x : wa.width / 2) - w / 2)));
  let sy = Math.round(pb.y + (Number.isFinite(y) ? y : wa.height / 2) - h - 90);
  if (sy < wa.y + 8) sy = Math.round(pb.y + (Number.isFinite(y) ? y : 0) + 20);
  sy = Math.min(sy, wa.y + wa.height - h - 8);
  const hash = sessionId ? '#' + encodeURIComponent(sessionId) : '';
  if (promptWin && !promptWin.isDestroyed()) {
    promptWin.setBounds({ x: sx, y: sy, width: w, height: h });
    promptWin.webContents.send('prompt:target', sessionId || null);
    promptWin.show();
    promptWin.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
    return;
  }
  promptWin = new BrowserWindow({
    x: sx,
    y: sy,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  promptWin.setAlwaysOnTop(true, 'floating');
  promptWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  promptWin.loadURL(`${ORIGIN}/src/renderer/prompt/index.html${hash}`);
  promptWin.once('ready-to-show', () => {
    promptWin.show();
    promptWin.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  });
  promptWin.on('blur', () => {
    if (promptWin && !promptWin.isDestroyed() && !promptWin.webContents.isDevToolsOpened()) promptWin.hide();
  });
  promptWin.on('closed', () => {
    promptWin = null;
  });
}

function recentFolders() {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    if (p && !seen.has(p) && fs.existsSync(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  add(store.settings.lastTaskCwd);
  for (const s of hub.list()) add(s.cwd);
  for (const h of hub.history) add(h.cwd);
  return out.slice(0, 12);
}

function promptContext() {
  return {
    sessions: hub.list().map((s) => ({ ...s, route: hub.route(s.id).kind })),
    recent: hub.restorable(8).map((h) => ({ ...h, route: 'resume' })),
    folders: recentFolders(),
    home: app.getPath('home'),
  };
}

async function sendPrompt({ target, text, cwd }) {
  const prompt = String(text || '').trim();
  if (!prompt) return { ok: false, error: '할 일을 적어 주세요' };
  if (!target || target === 'new') {
    if (!cwd) return { ok: false, error: '작업할 폴더를 골라 주세요' };
    store.settings.lastTaskCwd = cwd;
    store.saveSoon();
    return runner.start({ cwd, prompt, model: store.settings.taskModel });
  }
  const r = hub.route(target);
  switch (r.kind) {
    case 'reply':
      return hub.reply(target, prompt) ? { ok: true, delivered: 'reply' } : { ok: false, error: '전달하지 못했어요' };
    case 'busy':
      return { ok: false, error: `${r.session.name} 는 지금 일하는 중이에요. 끝나면 다시 말 걸어 주세요!` };
    case 'resume':
      return runner.start({ cwd: r.session.cwd, prompt, resume: target, model: store.settings.taskModel });
    case 'fork':
      return runner.start({ cwd: r.session.cwd, prompt, resume: target, fork: true, model: store.settings.taskModel });
    default:
      return { ok: false, error: '세션을 찾을 수 없어요' };
  }
}

async function pickFolder() {
  const res = await dialog.showOpenDialog(promptWin || undefined, {
    title: '작업할 폴더 선택',
    defaultPath: store.settings.lastTaskCwd || app.getPath('home'),
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
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
  if (Number.isFinite(s.replyWaitMin)) out.replyWaitMin = Math.round(Math.min(58, Math.max(1, s.replyWaitMin)));
  if (['auto', 'Terminal', 'iTerm'].includes(s.restoreTerminal)) out.restoreTerminal = s.restoreTerminal;
  if (typeof s.restoreExtraArgs === 'string') out.restoreExtraArgs = s.restoreExtraArgs.slice(0, 120);
  if (['', 'sonnet', 'opus', 'haiku', 'fable'].includes(s.taskModel)) out.taskModel = s.taskModel;
  for (const key of [
    'soundEnabled',
    'ambientSounds',
    'bubbles',
    'cpuReactive',
    'idleSleep',
    'showOnFullscreen',
    'launchAtLogin',
    'hidden',
    'awayMode',
    'restoreRemoteControl',
  ]) {
    if (typeof s[key] === 'boolean') out[key] = s[key];
  }
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
        '연결하면 세션이 끝나거나 허락이 필요할 때 펫이 알려 주고, 펫에서 바로 허락·거절할 수 있어요. 상태 표시줄로 5시간·주간 한도와 컨텍스트 사용률도 보여 줘요. 쓰시던 상태 표시줄(claude-hud 등)은 그대로 이어서 나와요.',
    });
    if (res.response !== 1) return { ok: false, canceled: true };
  }
  try {
    bridge.install();
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
  return { remoteControl: s.restoreRemoteControl, extraArgs: s.restoreExtraArgs, terminal: s.restoreTerminal };
}

async function restoreSessions(ids) {
  const list = hub.restorable(40).filter((h) => !ids || ids.includes(h.id));
  if (!list.length) return { ok: false, error: '다시 열 세션이 없어요' };
  const results = await terminals.openSessions(list, restoreOptions());
  const failed = results.filter((r) => !r.ok);
  return failed.length ? { ok: false, error: failed[0].error, opened: results.length - failed.length } : { ok: true, opened: results.length };
}

function fmtLeft(resetsAt) {
  const sec = Math.max(0, Math.round(resetsAt - Date.now() / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}일 ${h % 24}시간`;
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

function onLimits({ limits, alert }) {
  sendToAll('limits:changed', limits);
  if (tray) tray.update({ limits });
  if (alert) {
    const msg =
      alert.level >= 95
        ? `5시간 한도 ${Math.round(alert.pct)}%! 거의 다 썼어요… ${fmtLeft(alert.resetsAt)} 뒤 초기화`
        : `5시간 한도 ${Math.round(alert.pct)}% 썼어요. ${fmtLeft(alert.resetsAt)} 뒤 초기화돼요`;
    sendCommand('say', { text: `⏳ ${msg}`, tex: alert.level >= 80 ? 'worry' : 'surprised' });
  }
}

function scanOpenSessions() {
  try {
    for (const t of transcripts.scanActive()) hub.observe(t);
  } catch (err) {
    console.error('[transcripts]', err);
  }
  hub.sweep();
}

function onHubChanged({ session, event, counts }) {
  sendToAll('sessions:changed', { session, event, counts, list: hub.list() });
  if (tray) tray.update({ sessions: { counts, list: hub.list(), restorable: hub.restorable(10) } });
  if (event.type === 'done') applyAction(() => Pet.taskDone(pet));
  if (event.type === 'started' || event.type === 'ended') persistPet();
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
    case 'away-toggle':
      updateSettings({ awayMode: payload.value });
      sendCommand('say', { text: payload.value ? '자리 비움 모드! 제가 대신 받아 둘게요' : '다녀오셨어요? 자리 비움 끝!', tex: 'happy' });
      break;
    case 'open-settings':
      openSettings(payload.tab);
      break;
    case 'open-panel':
      openPanel({ focusSession: payload.sessionId });
      break;
    case 'open-prompt':
      // 펫 위치를 알아야 해서 펫 창에게 부탁
      sendCommand('open-prompt', { sessionId: payload.sessionId || null });
      break;
    case 'connect-claude':
      connectClaude();
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
    { label: '💬  말 걸기 (일 시키기)…', click: act('open-prompt'), accelerator: PROMPT_SHORTCUT },
    { label: `🗂  세션 보드${c.total ? ` (${c.total})` : ''}`, click: act('open-panel') },
    { label: '🏠  자리 비움 모드', type: 'checkbox', checked: store.settings.awayMode, click: (i) => handleMenuAction('away-toggle', { value: i.checked }) },
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
    limits: hub.limits,
    claude: claudeStatus(),
    origin: ORIGIN,
    version: app.getVersion(),
    platform: process.platform,
    shortcut: PANEL_SHORTCUT,
    promptShortcut: PROMPT_SHORTCUT,
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
  ipcMain.handle('sessions:reply', (_e, id, text) => hub.reply(id, text));
  ipcMain.handle('sessions:release', (_e, id) => hub.release(id));
  ipcMain.handle('sessions:share', (_e, from, to) => hub.share(from, to));
  ipcMain.handle('sessions:focus', (_e, id) => {
    const s = hub.list().find((x) => x.id === id);
    return s ? terminals.focusSession(s) : { ok: false, error: '세션이 없어요' };
  });
  ipcMain.handle('sessions:restore', (_e, ids) => restoreSessions(ids));
  ipcMain.handle('sessions:forget', (_e, id) => {
    hub.history = hub.history.filter((h) => h.id !== id);
    persistPet();
    return true;
  });
  ipcMain.on('panel:close', () => panelWin && panelWin.hide());

  // 펫에게 말 걸기
  ipcMain.on('prompt:open', (_e, opts) => openPrompt(opts || {}));
  ipcMain.on('prompt:close', () => promptWin && promptWin.hide());
  ipcMain.handle('prompt:context', () => promptContext());
  ipcMain.handle('prompt:pick-folder', () => pickFolder());
  ipcMain.handle('prompt:send', async (_e, req) => {
    const r = await sendPrompt(req || {});
    if (r.ok && promptWin && !promptWin.isDestroyed()) promptWin.hide();
    return r;
  });
  ipcMain.handle('tasks:cancel', (_e, taskId) => runner.cancel(taskId));

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
      'Claude Code 를 쓰고 계신가요? 연결하면 세션이 작업을 끝내거나 허락이 필요할 때 제가 달려가서 알려 드리고, 여기서 바로 허락하거나 다음 지시를 보낼 수 있어요.\n\n(~/.claude/settings.json 에 훅을 추가해요. 나중에 설정에서 언제든 해제할 수 있어요.)',
  });
  if (res.response === 1) connectClaude(false);
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  store = new Store(app.getPath('userData'));
  skins = new Skins({ bundledDir: path.join(APP_ROOT, 'assets', 'skins'), userDir: path.join(app.getPath('userData'), 'skins') });
  if (!skins.list().some((k) => k.id === store.settings.skin)) store.settings.skin = 'chihuahua';
  pet = Pet.normalize(store.pet);
  Pet.catchUp(pet);
  lastTickAt = Date.now();

  hub = new SessionHub({ getSettings: () => store.settings, history: store.sessionsHistory });
  hub.on('changed', onHubChanged);
  hub.on('limits', onLimits);
  bridge = new Bridge({ hub, onError: (err) => console.error('[bridge]', err) });
  runner = new Runner();
  runner.on('started', (t) => sendToAll('task:started', t));
  runner.on('finished', (r) => {
    // 1M 컨텍스트 모델 권한이 없으면 일반 모델로 한 번 더
    const req = r.request || {};
    if (!r.ok && isLongContextError(r.error) && !req.retried && req.model !== FALLBACK_MODEL) {
      sendCommand('say', { text: '1M 컨텍스트 모델은 추가 사용량이 필요해서, 일반 모델로 다시 해 볼게요!', tex: 'worry' });
      runner.start({ ...req, model: FALLBACK_MODEL, retried: true }).then((res) => {
        if (!res.ok) hub.taskFinished({ ...r, error: res.error });
      });
      return;
    }
    if (!r.ok && isLongContextError(r.error)) {
      r = { ...r, error: '이 모델은 추가 사용량(usage credits)이 필요해요. 설정 → Claude Code 에서 펫이 쓸 모델을 바꿔 주세요.' };
    }
    sendToAll('task:finished', r);
    hub.taskFinished(r);
  });
  try {
    await bridge.start();
  } catch (err) {
    console.error('[bridge] failed to start', err);
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

  globalShortcut.register(PANEL_SHORTCUT, () => openPanel({ toggle: true }));
  globalShortcut.register(PROMPT_SHORTCUT, () => handleMenuAction('open-prompt'));

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
  if (runner) runner.stopAll();
  if (bridge) bridge.stop();
  if (store && pet) {
    pet.lastTick = Date.now();
    persistPet(true);
  }
  if (stats) stats.stop();
});
