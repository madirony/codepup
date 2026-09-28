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
  assert.match(resumeCommand(hub.restorable()[0]), /^cd '\/Users\/me\/work\/my-app' && env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT claude --resume 's1' --rc$/);
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
const { STATUSLINE_MARKER } = require('../src/main/bridge');
const { parseTail, scanActive } = require('../src/main/transcripts');

const statusPayload = (extra = {}) => ({
  session_id: 'open-1',
  cwd: '/Users/me/work/already-open',
  transcript_path: '/tmp/o.jsonl',
  model: { id: 'claude-sonnet-5', display_name: 'Sonnet' },
  context_window: { used_percentage: 42, context_window_size: 1000000 },
  cost: { total_cost_usd: 0.52 },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1790000000 }, seven_day: { used_percentage: 41.2, resets_at: 1790500000 } },
  ...extra,
});

test('상태 표시줄: 이미 열린 세션을 찾고 컨텍스트 · 한도를 기록한다', () => {
  const hub = hubWith();
  const events = [];
  const limits = [];
  hub.on('changed', (e) => events.push(e.event.type));
  hub.on('limits', (l) => limits.push(l));
  hub.status(statusPayload());
  const [s] = hub.list();
  assert.equal(s.name, 'already-open');
  assert.equal(s.live, true);
  assert.deepEqual(s.context, { pct: 42, size: 1000000 });
  assert.equal(s.model, 'Sonnet');
  assert.equal(events[0], 'discovered');
  assert.equal(hub.limits.five_hour.pct, 23.5);
  assert.equal(limits.length, 1);
  // 같은 값이 다시 오면 조용히
  hub.status(statusPayload());
  assert.equal(events.length, 1);
  assert.equal(limits.length, 1);
});

test('상태 표시줄: 한도 50 · 80 · 95% 를 넘을 때 한 번씩만 알린다', () => {
  const hub = hubWith();
  const alerts = [];
  hub.on('limits', (l) => l.alert && alerts.push(l.alert.level));
  for (const pct of [30, 55, 60, 81, 85, 96, 97]) {
    hub.status(statusPayload({ rate_limits: { five_hour: { used_percentage: pct, resets_at: 1790000000 } } }));
  }
  assert.deepEqual(alerts, [50, 80, 95]);
  // 창이 초기화되면(resets_at 변경) 다시 알림
  hub.status(statusPayload({ rate_limits: { five_hour: { used_percentage: 52, resets_at: 1790018000 } } }));
  assert.deepEqual(alerts, [50, 80, 95, 50]);
});

test('상태 표시줄: 컨텍스트 85% 를 넘으면 한 번 알리고, 압축 후 다시 알릴 수 있다', () => {
  const hub = hubWith();
  const ctx = [];
  hub.on('changed', (e) => e.event.type === 'context' && ctx.push(e.event.pct));
  for (const pct of [70, 86, 90, 20, 88]) hub.status(statusPayload({ context_window: { used_percentage: pct } }));
  assert.deepEqual(ctx, [86, 88]);
});

test('정리: claude 가 돌던 터미널이 닫힌 세션만 닫힌 세션으로 옮긴다', () => {
  let t = 1_000_000;
  const hub = new SessionHub({ getSettings: () => ({}), now: () => t });
  hub.status(statusPayload(), { tty: 'ttys003' });
  hub.status(statusPayload({ session_id: 'quiet', cwd: '/w/quiet' }));
  t += 30 * 60000; // 30분 동안 조용해도 (새로고침 주기가 없으면 신호가 안 옴)
  hub.sweep({ aliveTtys: new Set(['ttys003']) });
  assert.equal(hub.list().length, 2);
  hub.sweep({ aliveTtys: new Set() }); // 터미널 창을 닫음
  assert.deepEqual(hub.list().map((s) => s.id), ['quiet']);
  assert.equal(hub.restorable()[0].id, 'open-1');
  t += 3 * 60 * 60000; // tty 를 모르는 세션은 오래 조용하면 정리
  hub.sweep({ aliveTtys: new Set() });
  assert.equal(hub.list().length, 0);
});

test('다시 열기 명령은 Claude 의 하위 세션 표시를 지우고 실행한다', () => {
  const { resumeCommand, cleanEnv } = require('../src/main/terminals');
  const cmd = resumeCommand({ id: 'abc', cwd: '/w/app' });
  assert.match(cmd, /env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION .*claude --resume 'abc' --rc/);
  const env = cleanEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('대화 기록 파일로 열린 세션을 찾는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codepup-home-'));
  const dir = path.join(home, '.claude', 'projects', '-Users-me-work-app');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', sessionId: 'tx-1', cwd: '/Users/me/work/app', message: { content: 'hi' } },
    { type: 'assistant', sessionId: 'tx-1', cwd: '/Users/me/work/app', message: { stop_reason: 'end_turn' } },
  ];
  fs.writeFileSync(path.join(dir, 'tx-1.jsonl'), '{"broken\n' + lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const found = scanActive({ home });
  assert.equal(found.length, 1);
  assert.equal(found[0].session_id, 'tx-1');
  assert.equal(parseTail('garbage\n'), null);
  const hub = hubWith();
  hub.observe(found[0]);
  assert.equal(hub.list()[0].name, 'app');
  assert.equal(scanActive({ home, now: Date.now() + 10 * 60000 }).length, 0);
});

test('설치기: 쓰던 상태 표시줄(claude-hud 등)은 이어서 실행하고, 해제하면 되돌린다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codepup-home-'));
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hud = { type: 'command', command: 'echo "[HUD] $(cat | wc -c)"', padding: 1 };
  fs.writeFileSync(file, JSON.stringify({ statusLine: hud }));
  const hub = hubWith();
  const bridge = new Bridge({ hub, homeDir: home });
  await bridge.start();
  try {
    bridge.install();
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(s.statusLine.command.includes(STATUSLINE_MARKER));
    assert.equal(s.statusLine.refreshInterval, undefined); // 새로고침 주기를 강제하지 않음 (429 방지)
    assert.equal(s.statusLine.padding, 1);
    // Claude Code 처럼 상태 표시줄 명령 실행 → 원래 HUD 출력 + CodePup 에 데이터 전달
    const out = await new Promise((resolve, reject) => {
      const child = execFile('sh', ['-c', s.statusLine.command], { env: { ...process.env, HOME: home } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin.end(JSON.stringify(statusPayload()));
    });
    assert.match(out, /^\[HUD\] +\d+/); // macOS 의 wc 는 숫자 앞에 공백을 붙임
    for (let i = 0; i < 40 && !hub.list().length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(hub.list()[0].id, 'open-1');
    bridge.uninstall();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, hud);
  } finally {
    bridge.stop();
  }
});

const { KeepAwake, awakeReason, GRACE_MS } = require('../src/main/keep-awake');

function fakeBlocker() {
  const b = { started: new Set(), seq: 0 };
  b.start = () => {
    const id = ++b.seq;
    b.started.add(id);
    return id;
  };
  b.stop = (id) => b.started.delete(id);
  return b;
}

test('☕ 세션이 일하는 동안만 잠자기를 막고, 끝나면 유예 뒤 푼다', () => {
  let t = 1_000_000;
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ blocker, now: () => t, detectExternal: false });
  awake.configure({ mode: 'working' });
  const changes = [];
  awake.on('changed', (s) => changes.push(s.active));
  const working = [{ name: 'api', status: 'working', updatedAt: t }];
  assert.equal(awake.evaluate({ sessions: [], tasks: 0 }).active, false);
  assert.equal(awake.evaluate({ sessions: working, tasks: 0 }).active, true);
  assert.equal(blocker.started.size, 1);
  // 작업 끝 → 바로 풀지 않고 유예
  t += 10_000;
  assert.equal(awake.evaluate({ sessions: [{ name: 'api', status: 'done', updatedAt: t }], tasks: 0 }).active, true);
  t += GRACE_MS + 1;
  assert.equal(awake.evaluate({ sessions: [{ name: 'api', status: 'done', updatedAt: t }], tasks: 0 }).active, false);
  assert.equal(blocker.started.size, 0);
  assert.deepEqual(changes, [true, false]);
});

test('☕ 수동 "계속 깨어 있기"와 자동 끄기', () => {
  const blocker = fakeBlocker();
  const awake = new KeepAwake({ blocker, detectExternal: false });
  awake.configure({ manual: true });
  assert.equal(awake.evaluate({ sessions: [], tasks: 0 }).active, true);
  awake.configure({ manual: false, auto: false });
  const now = Date.now();
  assert.equal(awake.evaluate({ sessions: [{ name: 'a', status: 'working', updatedAt: now }], tasks: 0 }).active, false);
});

test('☕ 오래 소식이 없는 "작업 중" 세션은 이유로 치지 않는다', () => {
  const now = 10_000_000;
  assert.equal(awakeReason({ sessions: [{ name: 'a', status: 'working', updatedAt: now - 30 * 60000 }], now, mode: 'working' }), null);
  assert.equal(awakeReason({ sessions: [{ name: 'a', status: 'done', pending: { kind: 'permission' }, updatedAt: now }], now }).kind, 'sessions');
  assert.equal(awakeReason({ sessions: [], tasks: 1, now }).kind, 'task');
});

test('☕ 원격 작업 모드: 세션이 열려 있기만 해도 깨어 있는다', () => {
  const now = 10_000_000;
  const idle = [{ name: 'api', status: 'done', updatedAt: now - 60 * 60000 }];
  assert.equal(awakeReason({ sessions: idle, now, mode: 'open' }).kind, 'open');
  assert.equal(awakeReason({ sessions: idle, now, mode: 'working' }), null);
  assert.equal(awakeReason({ sessions: [], now, mode: 'open' }), null);
});

test('닫힌 세션 다시 열기: 권한 확인 건너뛰기 옵션', () => {
  const h = { id: 's1', cwd: '/Users/me/work/my-app' };
  assert.equal(resumeCommand(h, { remoteControl: true, skipPermissions: true }), "cd '/Users/me/work/my-app' && env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT claude --resume 's1' --rc --dangerously-skip-permissions");
  assert.equal(resumeCommand(h, { remoteControl: false }), "cd '/Users/me/work/my-app' && env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT claude --resume 's1'");
});

test('닫힌 세션 다시 열기: /exit 로 직접 끝낸 세션은 복구하지 않는다', async () => {
  let t = 1_000_000;
  const hub = new SessionHub({ getSettings: () => ({}), now: () => t });
  const mk = (id) => ({ session_id: id, cwd: `/w/${id}` });
  for (const id of ['kept', 'quit', 'crash', 'switched']) await hub.handle('SessionStart', mk(id));
  await hub.handle('SessionEnd', { ...mk('quit'), reason: 'prompt_input_exit' }); // 사용자가 /exit
  await hub.handle('SessionEnd', { ...mk('switched'), reason: 'resume' }); // /resume 로 다른 세션으로
  await hub.handle('SessionEnd', { ...mk('crash'), reason: 'other' }); // 터미널 창이 닫힘
  hub.status({ session_id: 'kept', cwd: '/w/kept' }, { tty: 'ttys009' }); // 상태 표시줄로 살아 있던 세션
  t += 5 * 60000;
  hub.sweep({ aliveTtys: new Set() }); // 맥 재시동 등으로 터미널이 사라짐
  const ids = hub.restorable().map((h) => h.id).sort();
  assert.deepEqual(ids, ['crash', 'kept']);
  assert.equal(hub.history.find((h) => h.id === 'kept').endReason, 'vanished');
  assert.equal(hub.history.find((h) => h.id === 'quit').endReason, 'exit');
});
