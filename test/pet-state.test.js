const test = require('node:test');
const assert = require('node:assert/strict');
const Pet = require('../src/main/pet-state');
const { pickDisk } = require('../src/main/system-stats');
const { mergeSettings } = require('../src/main/store');

test('시간이 흐르면 포만감·기분·에너지가 줄어든다', () => {
  const pet = Pet.createPet(0);
  Pet.tick(pet, 3600, { cpu: 0 });
  assert.equal(Math.round(pet.hunger), 80 - Pet.RATES.hungerPerHour);
  assert.equal(Math.round(pet.happiness), 80 - Pet.RATES.happinessPerHour);
  assert.equal(Math.round(pet.energy), 90 - Pet.RATES.energyPerHourAwake);
});

test('CPU 부하가 높으면 에너지가 더 빨리 준다', () => {
  const idle = Pet.createPet(0);
  const busy = Pet.createPet(0);
  Pet.tick(idle, 1800, { cpu: 0 });
  Pet.tick(busy, 1800, { cpu: 100 });
  assert.ok(busy.energy < idle.energy);
});

test('밥을 먹으면 포만감이 오르고, 배부르면 거절한다', () => {
  const pet = Pet.createPet(0);
  pet.hunger = 40;
  const r1 = Pet.feed(pet);
  assert.equal(r1.result, 'ate');
  assert.equal(pet.hunger, 75);
  pet.hunger = 97;
  const r2 = Pet.feed(pet);
  assert.equal(r2.result, 'full');
  assert.equal(pet.hunger, 97);
});

test('경험치가 차면 레벨 업 이벤트가 나온다', () => {
  const pet = Pet.createPet(0);
  const events = [];
  Pet.addExp(pet, Pet.expToNext(1) + Pet.expToNext(2), events);
  assert.equal(pet.level, 3);
  assert.deepEqual(events.map((e) => e.level), [2, 3]);
  assert.equal(pet.exp, 0);
});

test('에너지가 바닥나면 스스로 잠들고, 다 차면 일어난다', () => {
  const pet = Pet.createPet(0);
  pet.energy = 9;
  const e1 = Pet.tick(pet, 600, { cpu: 50 });
  assert.equal(pet.sleeping, true);
  assert.ok(e1.some((e) => e.type === 'slept'));
  const e2 = Pet.tick(pet, 3600, { cpu: 0 });
  assert.equal(pet.sleeping, false);
  assert.ok(e2.some((e) => e.type === 'woke' && e.reason === 'rested'));
});

test('자는 중에 쓰다듬으면 깨고 기분이 조금 나빠진다', () => {
  const pet = Pet.createPet(0);
  Pet.sleep(pet);
  const before = pet.happiness;
  const r = Pet.petPet(pet, 10_000);
  assert.equal(r.result, 'woken');
  assert.equal(pet.sleeping, false);
  assert.ok(pet.happiness < before);
});

test('쓰다듬기 경험치는 쿨타임이 있다', () => {
  const pet = Pet.createPet(0);
  Pet.petPet(pet, 10_000);
  Pet.petPet(pet, 10_500);
  assert.equal(pet.exp, 2);
  Pet.petPet(pet, 13_000);
  assert.equal(pet.exp, 4);
});

test('앱이 꺼져 있던 시간은 완만하게 반영되고 바닥까지 떨어지지 않는다', () => {
  const pet = Pet.createPet(0);
  pet.lastTick = 0;
  Pet.catchUp(pet, 72 * 3600 * 1000);
  assert.ok(pet.hunger >= 15);
  assert.ok(pet.happiness >= 15);
  assert.equal(pet.sleeping, false);
});

test('손상된 저장 데이터도 정상 값으로 복구한다', () => {
  const pet = Pet.normalize({ hunger: 'x', happiness: 500, level: -3, exp: NaN });
  assert.equal(pet.hunger, 80);
  assert.equal(pet.happiness, 100);
  assert.equal(pet.level, 1);
  assert.equal(pet.exp, 0);
});

test('macOS에서는 실제 데이터 볼륨을 저장공간으로 고른다', () => {
  const d = pickDisk([
    { mount: '/', size: 500, used: 10 },
    { mount: '/System/Volumes/Data', size: 500, used: 300 },
  ]);
  assert.equal(d.mount, '/System/Volumes/Data');
  assert.equal(pickDisk([]), null);
});

test('저장된 설정이 일부만 있어도 기본값과 합쳐진다', () => {
  const s = mergeSettings({ size: 50, tray: { cpu: false } });
  assert.equal(s.size, 50);
  assert.equal(s.tray.cpu, false);
  assert.equal(s.tray.mem, true);
  assert.deepEqual(s.customImages, {});
});
