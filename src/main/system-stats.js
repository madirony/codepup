// CPU · 메모리 · 저장공간 · 배터리 사용량을 주기적으로 수집합니다.
const os = require('os');
const { EventEmitter } = require('events');
const si = require('systeminformation');

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const v of Object.values(cpu.times)) total += v;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// macOS APFS에서는 '/'가 읽기 전용 시스템 볼륨이라 실제 사용자 데이터 볼륨을 우선 사용
function pickDisk(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const prefer = ['/System/Volumes/Data', '/', 'C:'];
  for (const mount of prefer) {
    const hit = list.find((d) => d.mount === mount);
    if (hit && hit.size > 0) return hit;
  }
  return list.filter((d) => d.size > 0).sort((a, b) => b.size - a.size)[0] || null;
}

class SystemStats extends EventEmitter {
  constructor() {
    super();
    this.stats = {
      cpu: 0,
      mem: { percent: 0, used: 0, total: os.totalmem() },
      disk: null, // { percent, used, total }
      battery: null, // { percent, charging } — 배터리가 없는 기기는 null
    };
    this.prev = cpuTimes();
    this.timers = [];
    this.smoothCpu = 0;
  }

  start() {
    this.pollCpu();
    this.pollMem();
    this.pollDisk();
    this.pollBattery();
    this.timers.push(setInterval(() => this.pollCpu(), 2000));
    this.timers.push(setInterval(() => this.pollMem(), 5000));
    this.timers.push(setInterval(() => this.pollDisk(), 60000));
    this.timers.push(setInterval(() => this.pollBattery(), 30000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  pollCpu() {
    const cur = cpuTimes();
    const dTotal = cur.total - this.prev.total;
    const dIdle = cur.idle - this.prev.idle;
    this.prev = cur;
    if (dTotal <= 0) return;
    const raw = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
    // 순간적인 튐을 조금 부드럽게
    this.smoothCpu = this.smoothCpu * 0.3 + raw * 0.7;
    this.stats.cpu = Math.round(this.smoothCpu);
    this.emit('update', this.stats);
  }

  async pollMem() {
    try {
      const m = await si.mem();
      // active = 캐시/버퍼를 뺀 실사용량 (macOS 활성 상태 보기와 비슷)
      const used = m.active || m.used;
      this.stats.mem = { percent: Math.round((used / m.total) * 100), used, total: m.total };
    } catch {
      const total = os.totalmem();
      const used = total - os.freemem();
      this.stats.mem = { percent: Math.round((used / total) * 100), used, total };
    }
    this.emit('update', this.stats);
  }

  async pollDisk() {
    try {
      const d = pickDisk(await si.fsSize());
      if (d) {
        this.stats.disk = { percent: Math.round((d.used / d.size) * 100), used: d.used, total: d.size };
        this.emit('update', this.stats);
      }
    } catch {
      // 조회 실패 시 이전 값 유지
    }
  }

  async pollBattery() {
    try {
      const b = await si.battery();
      this.stats.battery = b && b.hasBattery ? { percent: Math.round(b.percent), charging: !!(b.isCharging || b.acConnected) } : null;
      this.emit('update', this.stats);
    } catch {
      this.stats.battery = null;
    }
  }
}

module.exports = { SystemStats, pickDisk };
