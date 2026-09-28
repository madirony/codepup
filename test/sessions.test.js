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
const hubWith = (settings = {}) => new SessionHub({ getSettings: () => ({ permissionWaitSec: 60, ...settings }) });

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
  const hub = hubWith();
  const out = await hub.handle('Stop', { ...base, last_assistant_message: '리팩터링 끝났어요!' });
  assert.equal(out, null);
  assert.equal(hub.list()[0].status, 'done');
  assert.equal(hub.list()[0].lastMessage, '리팩터링 끝났어요!');
});

test('마크다운: 보드에는 HTML 로, 말풍선에는 기호 없는 첫 문장으로', () => {
  const md = require('../src/renderer/shared/md');
  const text = '## 결과\n로그인 API를 **만들었어요**. `/auth/login` 추가.\n\n- 항목\n<script>alert(1)</script>';
  const html = md.toHtml(text);
  assert.match(html, /<b>만들었어요<\/b>/);
  assert.match(html, /<code>\/auth\/login<\/code>/);
  assert.match(html, /<ul><li>항목<\/li><\/ul>/);
  assert.ok(!html.includes('<script>'));
  assert.equal(md.summary(text), '로그인 API를 만들었어요.');
  assert.equal(md.summary('# 제목만'), '제목만');
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

test('정리: claude 가 돌던 터미널이 닫힌 세션만 닫힌 세션으로 옮긴다', async () => {
  let t = 1_000_000;
  const hub = new SessionHub({ getSettings: () => ({}), now: () => t });
  await hub.handle('SessionStart', { session_id: 'open-1', cwd: '/w/app' }, { tty: 'ttys003' });
  hub.observe({ session_id: 'quiet', cwd: '/w/quiet', mtime: t }); // tty 를 모르는 세션
  t += 30 * 60000; // 30분 동안 조용해도
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

test('설치기: 상태 표시줄은 건드리지 않고, 예전 버전이 가로챈 것은 원래대로 되돌린다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codepup-home-'));
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hud = { type: 'command', command: 'node ~/hud/index.js', padding: 1 };
  const bridge = new Bridge({ hub: hubWith(), homeDir: home });

  // 새로 연결: 쓰던 상태 표시줄은 그대로
  fs.writeFileSync(file, JSON.stringify({ statusLine: hud }));
  bridge.install();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, hud);
  assert.ok(bridge.isInstalled());

  // 예전 버전(2.5.1 이하)이 가로챈 상태 → 앱을 켜면 claude-hud 로 되돌림
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  legacy.statusLine = { type: 'command', command: `sh "${path.join(home, '.codepup', STATUSLINE_MARKER)}"`, refreshInterval: 5 };
  fs.writeFileSync(file, JSON.stringify(legacy));
  fs.writeFileSync(path.join(home, '.codepup', 'statusline-prev.json'), JSON.stringify(hud));
  fs.writeFileSync(path.join(home, '.codepup', STATUSLINE_MARKER), '#!/bin/sh\n');
  bridge.refresh();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, hud);
  assert.ok(!fs.existsSync(path.join(home, '.codepup', STATUSLINE_MARKER)));

  // 원래 상태 표시줄이 없었으면 지움
  legacy.statusLine = { type: 'command', command: `sh "${STATUSLINE_MARKER}"` };
  fs.writeFileSync(file, JSON.stringify(legacy));
  bridge.uninstall();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, undefined);
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
  await hub.handle('SessionStart', mk('kept'), { tty: 'ttys009' }); // 열려 있던 세션
  t += 5 * 60000;
  hub.sweep({ aliveTtys: new Set() }); // 맥 재시동 등으로 터미널이 사라짐
  const ids = hub.restorable().map((h) => h.id).sort();
  assert.deepEqual(ids, ['crash', 'kept']);
  assert.equal(hub.history.find((h) => h.id === 'kept').endReason, 'vanished');
  assert.equal(hub.history.find((h) => h.id === 'quit').endReason, 'exit');
});
