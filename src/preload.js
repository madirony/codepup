const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('codepup', {
  init: () => ipcRenderer.invoke('app:init'),

  onPetState: listen('pet:state'),
  onPetEvent: listen('pet:event'),
  onCommand: listen('pet:command'),
  onSettings: listen('settings:changed'),
  onStats: listen('stats:update'),
  onSettingsTab: listen('settings:tab'),
  onSkins: listen('skins:changed'),
  onSessions: listen('sessions:changed'),
  onClaudeStatus: listen('claude:status'),
  onPanelFocus: listen('panel:focus'),
  onPromptTarget: listen('prompt:target'),
  onTaskStarted: listen('task:started'),
  onTaskFinished: listen('task:finished'),
  onLimits: listen('limits:changed'),

  // 펫 창
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', ignore),
  showContextMenu: () => ipcRenderer.send('pet:context-menu'),
  setTrayFrames: (frames) => ipcRenderer.send('pet:tray-frames', frames),
  action: (name, payload) => ipcRenderer.invoke('pet:action', name, payload),

  // 설정 창
  menuAction: (name, payload) => ipcRenderer.invoke('menu:action', name, payload),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  pickMedia: (kind, slot) => ipcRenderer.invoke('media:pick', kind, slot),
  resetMedia: (kind, slot) => ipcRenderer.invoke('media:reset', kind, slot),
  importSkin: () => ipcRenderer.invoke('skins:import'),
  removeSkin: (id) => ipcRenderer.invoke('skins:remove', id),
  resetPet: () => ipcRenderer.invoke('pet:reset'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),

  // Claude Code 세션
  sessions: () => ipcRenderer.invoke('sessions:get'),
  decide: (id, decision) => ipcRenderer.invoke('sessions:decide', id, decision),
  reply: (id, text) => ipcRenderer.invoke('sessions:reply', id, text),
  release: (id) => ipcRenderer.invoke('sessions:release', id),
  share: (from, to) => ipcRenderer.invoke('sessions:share', from, to),
  focusSession: (id) => ipcRenderer.invoke('sessions:focus', id),
  restoreSessions: (ids) => ipcRenderer.invoke('sessions:restore', ids),
  forgetSession: (id) => ipcRenderer.invoke('sessions:forget', id),
  closePanel: () => ipcRenderer.send('panel:close'),
  // 펫에게 말 걸기
  openPrompt: (opts) => ipcRenderer.send('prompt:open', opts),
  closePrompt: () => ipcRenderer.send('prompt:close'),
  promptContext: () => ipcRenderer.invoke('prompt:context'),
  pickFolder: () => ipcRenderer.invoke('prompt:pick-folder'),
  sendPrompt: (req) => ipcRenderer.invoke('prompt:send', req),
  cancelTask: (taskId) => ipcRenderer.invoke('tasks:cancel', taskId),
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  connectClaude: () => ipcRenderer.invoke('claude:connect'),
  disconnectClaude: () => ipcRenderer.invoke('claude:disconnect'),
});
