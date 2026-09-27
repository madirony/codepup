const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { SessionHub, describeTool } = require('../src/main/sessions');
const { Bridge, HOOK_EVENTS } = require('../src/main/bridge');
const { resumeCommand } = require('../src/main/terminals');

const base = { session_id: 's1', cwd: '/Users/me/work/my-app', transcript_path: '/tmp/t.jsonl' };
const hubWith = (settings = {}) => new SessionHub({ getSettings: () => ({ permissionWaitSec: 60, replyWaitMin: 30, ...settings }) });

test('세션이 시작되면 폴더 이름으로 보드에 나타난다', async () => {
  const hub = hubWith();
  await hub.handle('SessionStart', { ...base, source: 'startup' }, { tty: 'ttys003', term: 'Apple_Terminal' });
  const [s] = hub.list();
  assert.equal(s.name, 'my-app');
  assert.equal(s.tty, 'ttys003');
  assert.equal(hub.history[0].id, 's1');
});

test('권한 요청: 펫에서 허락하면 allow 결정을 돌려준다', async () => {
  const hub = hubWith();
  const seen = [];
  hub.on('changed', (e) => seen.push(e.event.type));
  const p = hub.handle('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'npm install' } });
  const [s] = hub.list();
  assert.equal(s.pending.kind, 'permission');
  assert.equal(s.pending.detail, 'npm install');
  assert.equal(hub.counts().permission, 1);
  assert.ok(hub.decide('s1', 'allow'));
  const out = await p;
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.ok(seen.includes('permission'));
});

test('권한 요청: 거절과 "항상 허락"', async () => {
  const hub = hubWith();
  const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' };
  let p = hub.handle('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  hub.decide('s1', 'deny');
  let out = await p;
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(out.hookSpecificOutput.decision.message, /거절/);

  p = hub.handle('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [suggestion] });
  hub.decide('s1', 'always');
  out = await p;
  assert.deepEqual(out.hookSpecificOutput.decision.updatedPermissions, [suggestion]);
});

test('권한 요청: 응답이 없거나 훅이 취소되면 아무것도 돌려주지 않는다 (터미널 창으로)', async () => {
  const hub = hubWith({ permissionWaitSec: 0.05 });
  assert.equal(await hub.handle('PermissionRequest', { ...base, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }), null);
  const hub2 = hubWith();
  const ac = new AbortController();
  const p = hub2.handle('PermissionRequest', { ...base, tool_name: 'Edit', tool_input: {} }, { signal: ac.signal });
  ac.abort();
  assert.equal(await p, null);
  assert.equal(hub2.list()[0].pending, null);
});

test('작업 완료: 평소에는 알리기만 하고 바로 끝난다', async () => {
  const hub = hubWith({ awayMode: false });
  const out = await hub.handle('Stop', { ...base, last_assistant_message: '리팩터링 끝났어요!' });
  assert.equal(out, null);
  assert.equal(hub.list()[0].status, 'done');
  assert.equal(hub.list()[0].lastMessage, '리팩터링 끝났어요!');
});

test('자리 비움 모드: 펫에서 보낸 다음 지시가 세션으로 이어진다', async () => {
  const hub = hubWith({ awayMode: true });
  const p = hub.handle('Stop', { ...base, last_assistant_message: '끝!' });
  assert.equal(hub.list()[0].pending.kind, 'reply');
  assert.ok(hub.reply('s1', '이제 테스트도 추가해 줘'));
  const out = await p;
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(out.hookSpecificOutput.additionalContext, /테스트도 추가해 줘/);
  assert.equal(hub.list()[0].status, 'working');
});

test('자리 비움 모드: "터미널에서 할게요"를 누르면 대기를 푼다', async () => {
  const hub = hubWith({ awayMode: true });
  const p = hub.handle('Stop', { ...base, last_assistant_message: '끝!' });
  assert.ok(hub.release('s1'));
  assert.equal(await p, null);
});

test('세션 간 공유: 다음 프롬프트에 다른 세션의 결과가 붙는다', async () => {
  const hub = hubWith();
  await hub.handle('Stop', { ...base, last_assistant_message: 'API 스키마는 /v2/users 로 바꿨어요' });
  await hub.handle('SessionStart', { session_id: 's2', cwd: '/Users/me/work/web' });
  assert.equal(hub.share('s1', 's2').delivered, 'next-prompt');
  const out = await hub.handle('UserPromptSubmit', { session_id: 's2', cwd: '/Users/me/work/web', prompt: '프론트 맞춰 줘' });
  assert.match(out.hookSpecificOutput.additionalContext, /my-app/);
  assert.match(out.hookSpecificOutput.additionalContext, /\/v2\/users/);
  // 한 번 전달하면 비워짐
  assert.equal(await hub.handle('UserPromptSubmit', { session_id: 's2', cwd: '/Users/me/work/web', prompt: '다음' }), null);
});

test('종료된 세션은 복구 후보가 된다', async () => {
  const hub = hubWith();
  await hub.handle('SessionStart', base);
  await hub.handle('SessionEnd', { ...base, reason: 'other' });
  assert.equal(hub.list().length, 0);
  assert.equal(hub.restorable()[0].id, 's1');
  assert.match(resumeCommand(hub.restorable()[0]), /^cd '\/Users\/me\/work\/my-app' && claude --resume 's1' --rc$/);
});

test('권한 요청 설명', () => {
  assert.deepEqual(describeTool('Bash', { command: 'ls' }), { title: '명령 실행', detail: 'ls' });
  assert.equal(describeTool('Write', { file_path: 'a.md' }).title, '파일 만들기');
});

test('브리지: 토큰 없이는 거절, 훅 스크립트로 권한 요청 왕복', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codepup-home-'));
  const hub = hubWith();
  const bridge = new Bridge({ hub, homeDir: home });
  await bridge.start();
  t.after(() => bridge.stop());

  const res = await fetch(`http://127.0.0.1:${bridge.port}/hook/SessionStart`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);

  bridge.install();
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  for (const { event } of HOOK_EVENTS) assert.ok(JSON.stringify(settings.hooks[event]).includes('codepup-hook.sh'));
  assert.ok(bridge.isInstalled());

  hub.on('changed', (e) => {
    if (e.event.type === 'permission') setTimeout(() => hub.decide('s1', 'allow'), 20);
  });
  const input = JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const out = await new Promise((resolve, reject) => {
    const child = execFile('sh', [bridge.scriptFile, 'PermissionRequest'], { env: { ...process.env, HOME: home } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
    child.stdin.end(input);
  });
  assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'allow');
});

test('브리지: 앱이 꺼져 있으면 훅 스크립트는 조용히 성공한다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codepup-home-'));
  const bridge = new Bridge({ hub: hubWith(), homeDir: home });
  bridge.install(); // env 파일 없음 = 앱 꺼짐
  const out = await new Promise((resolve, reject) => {
    const child = execFile('sh', [bridge.scriptFile, 'Stop'], { env: { ...process.env, HOME: home } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
    child.stdin.end('{}');
  });
  assert.equal(out, '');
});

test('설치기: 기존 훅은 지키고 우리 훅만 추가·제거한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codepup-home-'));
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, model: 'opus' };
  fs.writeFileSync(file, JSON.stringify(mine));
  const bridge = new Bridge({ hub: hubWith(), homeDir: home });
  bridge.install();
  bridge.install(); // 두 번 설치해도 중복 없음
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done');
  assert.ok(fs.existsSync(file + '.codepup-backup'));
  bridge.uninstall();
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s, mine);
});

test('설치기: 이전 이름(Speaki)으로 설치된 훅도 정리한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codepup-home-'));
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh "/Users/me/.speaki/speaki-hook.sh" Stop' }] }] } };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const bridge = new Bridge({ hub: hubWith(), homeDir: home });
  bridge.install();
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(JSON.stringify(s).includes('speaki-hook.sh'), false);
  assert.equal(s.hooks.Stop.length, 1);
});

const { Runner } = require('../src/main/runner');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.sh');

function runOnce(runner, opts) {
  return new Promise((resolve) => {
    runner.once('finished', resolve);
    runner.start(opts).then((r) => {
      if (!r.ok) resolve(r);
    });
  });
}

test('러너: 새 작업을 실행하고 세션 ID와 결과를 받는다', async () => {
  const runner = new Runner({ claudePath: FAKE });
  const r = await runOnce(runner, { cwd: os.tmpdir(), prompt: '테스트 추가' });
  assert.equal(r.ok, true);
  assert.match(r.sessionId, /^fake-/);
  assert.equal(r.result, '완료: 테스트 추가');
});

test('러너: 이어서(--resume)와 이어받기(--fork-session)', async () => {
  const runner = new Runner({ claudePath: FAKE });
  const resumed = await runOnce(runner, { cwd: os.tmpdir(), prompt: '다음', resume: 'abc' });
  assert.equal(resumed.sessionId, 'abc');
  const forked = await runOnce(runner, { cwd: os.tmpdir(), prompt: '다음', resume: 'abc', fork: true });
  assert.match(forked.sessionId, /^fork-/);
});

test('러너: 실패하면 오류 메시지를 알려 준다', async () => {
  const runner = new Runner({ claudePath: FAKE });
  const r = await runOnce(runner, { cwd: os.tmpdir(), prompt: 'FAIL' });
  assert.equal(r.ok, false);
  assert.match(r.error, /가짜 실패/);
  assert.equal((await runner.start({ cwd: '/no/such/dir', prompt: 'x' })).ok, false);
});

test('허브: 펫이 실행한 세션은 자리 비움이어도 기다리지 않고, 말 걸기 경로를 고른다', async () => {
  const hub = hubWith({ awayMode: true });
  await hub.handle('SessionStart', { ...base, session_id: 'own' }, { task: 't1' });
  assert.equal(await hub.handle('Stop', { ...base, session_id: 'own', last_assistant_message: '끝' }), null);
  assert.equal(hub.route('own').kind, 'resume');
  // 터미널 세션: 끝났으면 이어받기, 자리 비움 대기 중이면 바로 답장, 일하는 중이면 busy
  await hub.handle('SessionStart', { ...base, session_id: 'term' });
  await hub.handle('UserPromptSubmit', { ...base, session_id: 'term', prompt: 'x' });
  assert.equal(hub.route('term').kind, 'busy');
  const p = hub.handle('Stop', { ...base, session_id: 'term', last_assistant_message: '끝' });
  assert.equal(hub.route('term').kind, 'reply');
  hub.release('term');
  await p;
  assert.equal(hub.route('term').kind, 'fork');
  assert.equal(hub.route('nope').kind, 'unknown');
});

test('허브: 훅 없이 끝난 펫 작업도 완료 알림을 한 번만 보낸다', async () => {
  const hub = hubWith();
  const events = [];
  hub.on('changed', (e) => events.push(e.event.type));
  hub.taskFinished({ taskId: 't9', cwd: '/w/app', sessionId: 'x9', ok: true, result: '다 했어요' });
  assert.deepEqual(events.filter((t) => t === 'done'), ['done']);
  assert.equal(hub.list()[0].owned, true);
  assert.equal(hub.list()[0].lastMessage, '다 했어요');
});
