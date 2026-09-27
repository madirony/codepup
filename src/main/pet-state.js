// 다마고치 상태 (포만감 · 기분 · 에너지 · 레벨) 순수 로직.
// Electron에 의존하지 않으므로 node --test 로 바로 검증할 수 있습니다.

const RATES = {
  hungerPerHour: 22, // 포만감 감소
  happinessPerHour: 10, // 기분 감소
  energyPerHourAwake: 10, // 깨어 있을 때 에너지 감소 (CPU 부하가 높을수록 최대 2배)
  energyPerHourAsleep: 240, // 자는 동안 회복 (0 → 100 약 25분)
};

const AUTO_SLEEP_ENERGY = 8;
const PET_EXP_COOLDOWN_MS = 2500;
const OFFLINE_RATE = 0.5; // 앱이 꺼져 있던 시간은 절반 속도로만 반영
const OFFLINE_MAX_SEC = 24 * 3600;
const OFFLINE_FLOOR = 15; // 오래 꺼 두어도 이 아래로는 떨어뜨리지 않음

const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

function expToNext(level) {
  return Math.round(40 * Math.pow(level, 1.35));
}

function createPet(now = Date.now()) {
  return {
    hunger: 80, // 포만감 (높을수록 배부름)
    happiness: 80,
    energy: 90,
    sleeping: false,
    level: 1,
    exp: 0,
    totalFed: 0,
    totalPets: 0,
    bornAt: now,
    lastTick: now,
    lastPetExpAt: 0,
    awakeSecAcc: 0,
  };
}

function normalize(raw, now = Date.now()) {
  const base = createPet(now);
  const pet = { ...base, ...(raw || {}) };
  for (const key of ['hunger', 'happiness', 'energy']) {
    pet[key] = Number.isFinite(pet[key]) ? clamp(pet[key]) : base[key];
  }
  pet.level = Number.isInteger(pet.level) && pet.level >= 1 ? pet.level : 1;
  pet.exp = Number.isFinite(pet.exp) && pet.exp >= 0 ? pet.exp : 0;
  pet.sleeping = !!pet.sleeping;
  return pet;
}

// exp를 더하고 레벨 업 횟수만큼 events 배열에 'levelup'을 추가합니다.
function addExp(pet, amount, events) {
  if (!(amount > 0)) return;
  pet.exp += amount;
  while (pet.exp >= expToNext(pet.level)) {
    pet.exp -= expToNext(pet.level);
    pet.level += 1;
    pet.happiness = clamp(pet.happiness + 10);
    events.push({ type: 'levelup', level: pet.level });
  }
}

// dtSec 만큼 시간을 흘려보냅니다. ctx.cpu 는 0~100.
function tick(pet, dtSec, ctx = {}) {
  const events = [];
  if (!(dtSec > 0)) return events;
  const h = dtSec / 3600;
  const cpu = clamp(ctx.cpu || 0);

  pet.hunger = clamp(pet.hunger - RATES.hungerPerHour * h * (pet.sleeping ? 0.5 : 1));

  let moodDecay = RATES.happinessPerHour;
  if (pet.hunger < 20) moodDecay *= 2;
  if (pet.energy < 20) moodDecay *= 1.5;
  if (pet.sleeping) moodDecay *= 0.3;
  pet.happiness = clamp(pet.happiness - moodDecay * h);

  if (pet.sleeping) {
    pet.energy = clamp(pet.energy + RATES.energyPerHourAsleep * h);
    if (pet.energy >= 100) {
      pet.sleeping = false;
      addExp(pet, 10, events);
      events.push({ type: 'woke', reason: 'rested' });
    }
  } else {
    pet.energy = clamp(pet.energy - RATES.energyPerHourAwake * (1 + cpu / 100) * h);
    // 깨어 있는 동안 기분이 좋으면 2분마다 경험치 +1
    pet.awakeSecAcc += dtSec;
    while (pet.awakeSecAcc >= 120) {
      pet.awakeSecAcc -= 120;
      if (pet.happiness >= 40) addExp(pet, 1, events);
    }
    if (pet.energy <= AUTO_SLEEP_ENERGY) {
      pet.sleeping = true;
      events.push({ type: 'slept', reason: 'exhausted' });
    }
  }
  return events;
}

// 앱이 꺼져 있던 동안의 변화를 완만하게 반영합니다.
function catchUp(pet, now = Date.now()) {
  const elapsed = Math.min(OFFLINE_MAX_SEC, Math.max(0, (now - (pet.lastTick || now)) / 1000));
  const before = { hunger: pet.hunger, happiness: pet.happiness };
  if (elapsed > 0) {
    // 꺼져 있는 동안 레벨 업·자동 수면 이벤트는 무시하고 수치만 반영
    tick(pet, elapsed * OFFLINE_RATE, { cpu: 0 });
    pet.hunger = Math.max(pet.hunger, Math.min(before.hunger, OFFLINE_FLOOR));
    pet.happiness = Math.max(pet.happiness, Math.min(before.happiness, OFFLINE_FLOOR));
  }
  pet.sleeping = false; // 켜질 때는 항상 깨어서 인사
  pet.lastTick = now;
  return elapsed;
}

function feed(pet) {
  const events = [];
  if (pet.hunger >= 95) {
    pet.happiness = clamp(pet.happiness - 2);
    return { result: 'full', events };
  }
  pet.hunger = clamp(pet.hunger + 35);
  pet.happiness = clamp(pet.happiness + 6);
  pet.totalFed += 1;
  addExp(pet, 8, events);
  return { result: 'ate', events };
}

function petPet(pet, now = Date.now()) {
  const events = [];
  if (pet.sleeping) {
    pet.sleeping = false;
    pet.happiness = clamp(pet.happiness - 5);
    events.push({ type: 'woke', reason: 'poked' });
    return { result: 'woken', events };
  }
  pet.happiness = clamp(pet.happiness + 4);
  pet.totalPets += 1;
  if (now - pet.lastPetExpAt >= PET_EXP_COOLDOWN_MS) {
    pet.lastPetExpAt = now;
    addExp(pet, 2, events);
  }
  return { result: 'petted', events };
}

function annoy(pet) {
  pet.happiness = clamp(pet.happiness - 6);
  return { result: 'annoyed', events: [] };
}

function sleep(pet) {
  if (pet.sleeping) return { result: 'already', events: [] };
  pet.sleeping = true;
  return { result: 'slept', events: [{ type: 'slept', reason: 'command' }] };
}

function wake(pet, reason = 'command') {
  if (!pet.sleeping) return { result: 'already', events: [] };
  pet.sleeping = false;
  const events = [{ type: 'woke', reason }];
  if (reason === 'poked' || reason === 'carried') pet.happiness = clamp(pet.happiness - 5);
  return { result: 'woke', events };
}

// 달린 거리(몸 길이 단위)로 경험치를 얻습니다. CPU가 바쁠수록 펫도 훈련!
function ran(pet, bodyLengths) {
  const events = [];
  if (bodyLengths > 0 && !pet.sleeping) {
    addExp(pet, bodyLengths / 40, events);
    pet.energy = clamp(pet.energy - bodyLengths * 0.004);
  }
  return { result: 'ran', events };
}

// Claude Code 세션이 작업을 끝내면: 함께 일한 보람으로 경험치 · 기분 UP
function taskDone(pet) {
  const events = [];
  pet.happiness = clamp(pet.happiness + 3);
  pet.hunger = clamp(pet.hunger - 1);
  pet.tasksDone = (pet.tasksDone || 0) + 1;
  addExp(pet, 6, events);
  return { result: 'task-done', events };
}

// 렌더러로 보낼 요약 (내부 누적값 제외)
function snapshot(pet) {
  return {
    hunger: Math.round(pet.hunger),
    happiness: Math.round(pet.happiness),
    energy: Math.round(pet.energy),
    sleeping: pet.sleeping,
    level: pet.level,
    exp: Math.floor(pet.exp),
    expToNext: expToNext(pet.level),
    totalFed: pet.totalFed,
    totalPets: pet.totalPets,
    tasksDone: pet.tasksDone || 0,
    bornAt: pet.bornAt,
  };
}

module.exports = {
  RATES,
  expToNext,
  createPet,
  normalize,
  addExp,
  tick,
  catchUp,
  feed,
  petPet,
  annoy,
  sleep,
  wake,
  ran,
  taskDone,
  snapshot,
};
