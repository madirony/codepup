// ☕ Claude 가 일하는 동안 맥이 잠들지 않게 (caffeinate 처럼)
// - 세션이 작업 중이거나 허락을 기다리면 자동으로 잠자기 방지를 켜고, 모두 쉬면 잠시 뒤 끕니다.
// - 사용자가 메뉴에서 "계속 깨어 있기"를 켜면 수동으로도 유지해요.
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

const GRACE_MS = 2 * 60 * 1000; // 작업이 끝난 뒤에도 잠깐 더 (다음 지시를 바로 줄 수 있게)
const STALE_MS = 20 * 60 * 1000; // 이 시간 동안 소식이 없으면 '작업 중'이어도 멈춘 걸로 봄

// 지금 깨어 있어야 하는 이유 (없으면 null)
// mode 'open'  = 원격 작업 모드: 세션이 열려 있기만 해도 (휴대폰에서 다음 지시를 보낼 수 있게)
// mode 'working' = 세션이 일하거나 허락을 기다릴 때만
function awakeReason({ sessions = [], tasks = 0, now = Date.now(), mode = 'open' }) {
  if (tasks > 0) return { kind: 'task', count: tasks };
  const busy = sessions.filter(
    (s) => (s.pending || s.status === 'working' || s.status === 'permission') && now - (s.updatedAt || 0) < STALE_MS
  );
  if (busy.length) return { kind: 'sessions', count: busy.length, names: busy.map((s) => s.name) };
  if (mode === 'open') {
    const open = sessions.filter((s) => s.status !== 'ended');
    if (open.length) return { kind: 'open', count: open.length, names: open.map((s) => s.name) };
  }
  return null;
}

// 덮개를 닫아도 잠들지 않게 (macOS: pmset disablesleep · 관리자 암호 필요)
function lidSleepDisabled() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(false);
    execFile('pmset', ['-g'], { timeout: 4000 }, (err, stdout) => {
      resolve(!err && /SleepDisabled\s+1/.test(String(stdout)));
    });
  });
}

function setLidSleepDisabled(disable) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve({ ok: false, error: 'macOS 에서만 지원해요' });
    const cmd = `do shell script "pmset -a disablesleep ${disable ? 1 : 0}" with administrator privileges`;
    execFile('osascript', ['-e', cmd], { timeout: 120000 }, (err) => {
      if (err) resolve({ ok: false, error: /cancel/i.test(String(err.message)) ? '취소했어요' : String(err.message).slice(0, 160) });
      else resolve({ ok: true });
    });
  });
}

class KeepAwake extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{start: Function, stop: Function, isStarted: Function}} opts.blocker  Electron powerSaveBlocker
   * @param {() => number} [opts.now]
   */
  constructor({ blocker, now = Date.now, detectExternal = true } = {}) {
    super();
    this.blocker = blocker;
    this.now = now;
    this.detectExternal = detectExternal;
    this.id = null;
    this.auto = true; // 설정: Claude 작업 중엔 자동으로
    this.mode = 'open'; // 'open' | 'working'
    this.manual = false; // 메뉴: 계속 깨어 있기
    this.reason = null;
    this.lastBusyAt = 0;
    this.external = false; // 다른 앱의 caffeinate 등
  }

  get active() {
    return this.id !== null;
  }

  state() {
    return {
      active: this.active,
      manual: this.manual,
      auto: this.auto,
      reason: this.reason,
      mode: this.mode,
      external: this.external,
      lid: this.lid || false,
      until: !this.manual && this.active && !this.reason ? this.lastBusyAt + GRACE_MS : null,
    };
  }

  configure({ auto, manual, mode }) {
    if (typeof auto === 'boolean') this.auto = auto;
    if (typeof manual === 'boolean') this.manual = manual;
    if (mode === 'open' || mode === 'working') this.mode = mode;
  }

  async refreshLid() {
    const v = await lidSleepDisabled();
    if (v !== this.lid) {
      this.lid = v;
      this.emit('changed', this.state());
    }
    return v;
  }

  async setLid(disable) {
    const r = await setLidSleepDisabled(disable);
    await this.refreshLid();
    return r;
  }

  // 세션 상태가 바뀔 때마다 호출
  evaluate({ sessions, tasks }) {
    const t = this.now();
    const reason = this.auto ? awakeReason({ sessions, tasks, now: t, mode: this.mode }) : null;
    if (reason) this.lastBusyAt = t;
    this.reason = reason;
    const want = this.manual || !!reason || (this.auto && this.lastBusyAt && t - this.lastBusyAt < GRACE_MS);
    const was = this.active;
    if (want && !this.active) {
      this.id = this.blocker.start('prevent-app-suspension');
    } else if (!want && this.active) {
      this.blocker.stop(this.id);
      this.id = null;
    }
    if (was !== this.active) this.emit('changed', { ...this.state(), turnedOn: this.active });
    return this.state();
  }

  // 다른 앱이 이미 잠자기를 막고 있는지 (pmset 의 PreventUserIdleSystemSleep 기록)
  checkExternal() {
    if (!this.detectExternal || process.platform !== 'darwin') return Promise.resolve(false);
    return new Promise((resolve) => {
      execFile('pmset', ['-g', 'assertions'], { timeout: 4000 }, (err, stdout) => {
        if (err) return resolve(false);
        const lines = String(stdout).split('\n').filter((l) => /PreventUserIdle(System|Display)Sleep/.test(l) && /pid \d+/.test(l));
        const others = lines.filter((l) => !/Electron|CodePup/i.test(l));
        const ext = others.length > 0;
        if (ext !== this.external) {
          this.external = ext;
          this.emit('changed', this.state());
        }
        resolve(ext);
      });
    });
  }

  stop() {
    if (this.active) this.blocker.stop(this.id);
    this.id = null;
  }
}

module.exports = { KeepAwake, awakeReason, GRACE_MS, lidSleepDisabled, setLidSleepDisabled };
