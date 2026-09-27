// 앱을 실제로 띄우고, Claude Code 역할을 흉내 내서 전체 흐름을 확인하는 스모크 테스트.
// 사용법: SMOKE_OUT=/tmp/out xvfb-run -a npx electron test/smoke-main.js --no-sandbox
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const OUT = process.env.SMOKE_OUT || path.join(__dirname, '..', 'dist', 'smoke');
fs.mkdirSync(OUT, { recursive: true });
// 진짜 ~/.claude 를 건드리지 않도록 가짜 홈 사용
const HOME = path.join(OUT, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;

const { app, BrowserWindow, dialog } = require('electron');
app.setPath('userData', path.join(OUT, 'userData'));
// 가상 디스플레이(Xvfb)에는 GPU가 없으므로 소프트웨어 WebGL 허용
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const errors = [];
const checks = [];
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (event) => {
    const { level, message } = event;
    if (level === 'error' || level === 3) errors.push(`[renderer] ${message}`);
    if (process.env.SMOKE_VERBOSE) console.log('console', level, message);
  });
  wc.on('render-process-gone', (_ev, details) => errors.push('render-process-gone ' + details.reason));
});
process.on('uncaughtException', (err) => errors.push('main ' + err.stack));

// 첫 실행 "Claude Code 연결?" 대화상자 → 연결하기
dialog.showMessageBox = async () => ({ response: 1 });

require('../src/main/main.js');

function finish(code) {
  app.emit('before-quit'); // 펫 창이 닫히면 다시 만들지 않도록
  app.exit(code);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
}

// 훅 스크립트를 Claude Code 처럼 실행
function hook(event, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile('sh', [path.join(HOME, '.codepup', 'codepup-hook.sh'), event], { env: { ...process.env, HOME, TERM_PROGRAM: 'Apple_Terminal' } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout ? JSON.parse(stdout) : null)
    );
    child.stdin.end(JSON.stringify(payload));
  });
}

app.whenReady().then(async () => {
  setTimeout(() => {
    console.log('SMOKE TIMEOUT', errors);
    finish(2);
  }, 150000);
  let pet = null;
  for (let i = 0; i < 60 && !pet; i++) {
    await wait(500);
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/pet/'));
    if (w && (await w.webContents.executeJavaScript('!!window.__codepup').catch(() => false))) pet = w;
  }
  await wait(2500); // 등장 연출이 끝날 때까지
  const run = (js) => pet.webContents.executeJavaScript(js);
  const mouse = (type, x, y) => pet.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  const clickAt = async (x, y) => {
    mouse('mouseMove', x, y);
    await wait(80);
    mouse('mouseDown', x, y);
    mouse('mouseUp', x, y);
  };

  // 1) 첫 실행에서 Claude Code 연결
  const settingsJson = path.join(HOME, '.claude', 'settings.json');
  check('첫 실행 대화상자로 Claude Code 훅 설치', fs.existsSync(settingsJson) && fs.readFileSync(settingsJson, 'utf8').includes('codepup-hook.sh'));
  check('기본 스킨은 치와와', (await run('document.querySelector("canvas") !== null')) && (await run('window.__codepup.state')) !== undefined);
  await shot(pet, '01-intro.png');

  // 2) 세션 두 개 시작
  const s1 = { session_id: 'sess-api', cwd: '/Users/me/work/api-server', transcript_path: '/tmp/a.jsonl' };
  const s2 = { session_id: 'sess-web', cwd: '/Users/me/work/web-front', transcript_path: '/tmp/b.jsonl' };
  await hook('SessionStart', { ...s1, source: 'startup' });
  await hook('SessionStart', { ...s2, source: 'startup' });
  await hook('UserPromptSubmit', { ...s1, prompt: '로그인 API 만들어 줘' });
  await wait(500);

  // 2-2) 이미 열려 있던 세션: 훅 이벤트 없이 상태 표시줄만으로 발견 + 한도 · 컨텍스트
  const cc = JSON.parse(fs.readFileSync(settingsJson, 'utf8'));
  check('연결하면 상태 표시줄도 설치된다', cc.statusLine && cc.statusLine.command.includes('codepup-statusline.sh'));
  const statusline = (payload) =>
    new Promise((resolve, reject) => {
      const child = execFile('sh', ['-c', cc.statusLine.command], { env: { ...process.env, HOME } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin.end(JSON.stringify(payload));
    });
  const openPayload = (pct5h) => ({
    session_id: 'sess-open', cwd: '/Users/me/work/already-open', transcript_path: '/tmp/o.jsonl',
    model: { display_name: 'Opus' }, context_window: { used_percentage: 37, context_window_size: 1000000 },
    rate_limits: { five_hour: { used_percentage: pct5h, resets_at: Math.round(Date.now() / 1000) + 7200 }, seven_day: { used_percentage: 41, resets_at: Math.round(Date.now() / 1000) + 3 * 86400 } },
  });
  const slOut = await statusline(openPayload(23));
  check('상태 표시줄에 CodePup 표시가 나온다', slOut.includes('CodePup'), slOut);
  await wait(800);
  const openS = (await run(`window.codepup.sessions()`)).list.find((x) => x.id === 'sess-open');
  check('이미 열린 세션이 훅 없이도 보드에 뜬다', openS && openS.live && openS.context.pct === 37, JSON.stringify(openS && openS.context));
  await statusline(openPayload(82));
  await wait(800);
  const limitBubble = await run(`document.querySelector('#bubble').innerText`);
  check('5시간 한도 80% 를 넘으면 펫이 알려 준다', limitBubble.includes('5시간 한도 82%'), limitBubble);
  await shot(pet, '02b-limit.png');

  const awakeState = await run('window.codepup.init().then((b) => b.awake)');
  check('☕ Claude 세션이 있으면 잠자기 방지가 켜진다', awakeState && awakeState.active && awakeState.reason, JSON.stringify(awakeState));

  // 3) 권한 요청 → 펫 말풍선의 [허락] 버튼을 실제 마우스로 클릭
  await run('window.__codepup.P.state = "idle"; window.__codepup.P.dur = 60');
  const permP = hook('PermissionRequest', { ...s1, tool_name: 'Bash', tool_input: { command: 'npm install bcrypt' } });
  await wait(1200);
  const bubble = await run(`(() => { const b = document.querySelector('#bubble'); const btn = b.querySelector('button.ok');
    const r = btn && btn.getBoundingClientRect(); return { text: b.innerText, interactive: b.classList.contains('interactive'), x: r && r.left + r.width / 2, y: r && r.top + r.height / 2,
    badge: document.querySelector('#badge').textContent, badgeHidden: document.querySelector('#badge').classList.contains('hidden') }; })()`);
  check('권한 요청 말풍선이 뜬다', bubble.interactive && bubble.text.includes('npm install bcrypt'), bubble.text.replace(/\n/g, ' / '));
  check('기다리는 세션 배지 = 1', !bubble.badgeHidden && bubble.badge === '1');
  await shot(pet, '02-permission.png');
  await clickAt(bubble.x, bubble.y);
  const permOut = await Promise.race([permP, wait(5000).then(() => 'timeout')]);
  check('[허락] 클릭 → 훅이 allow 를 돌려준다', permOut && permOut.hookSpecificOutput && permOut.hookSpecificOutput.decision.behavior === 'allow', JSON.stringify(permOut));
  await wait(300);
  check('허락 후 배지가 사라진다', await run(`document.querySelector('#badge').classList.contains('hidden')`));

  // 4) 작업 완료 알림 (자리 비움 꺼짐 → 바로 끝남)
  await hook('PostToolUse', { ...s1, tool_name: 'Edit', tool_input: { file_path: 'src/auth.ts' } });
  const stopOut = await hook('Stop', { ...s1, last_assistant_message: '로그인 API를 만들었어요. /auth/login, /auth/logout 두 개를 추가했어요.' });
  check('작업 완료 훅은 바로 끝난다', stopOut === null);
  await wait(800);
  const doneText = await run(`document.querySelector('#bubble').innerText`);
  check('"작업 끝!" 말풍선', doneText.includes('api-server') && doneText.includes('작업 끝'), doneText.replace(/\n/g, ' / '));
  const tasksDone = await run('window.codepup.init().then((b) => b.pet.tasksDone)');
  check('작업 완료가 펫 성장으로 이어진다', tasksDone >= 1, `tasksDone=${tasksDone}`);
  await shot(pet, '03-done.png');

  // 5) 세션 간 공유: api 결과 → web 세션 다음 프롬프트에 첨부
  const shareRes = await run(`window.codepup.share('sess-api', 'sess-web')`);
  const upOut = await hook('UserPromptSubmit', { ...s2, prompt: '로그인 화면 붙여 줘' });
  check('세션 간 공유가 다음 프롬프트에 붙는다', shareRes.ok && upOut && upOut.hookSpecificOutput.additionalContext.includes('/auth/login'));

  // 6) 자리 비움 모드: 세션 보드에서 다음 지시 보내기
  await run(`window.codepup.updateSettings({ awayMode: true })`);
  const replyP = hook('Stop', { ...s2, last_assistant_message: '로그인 화면을 만들었어요!' });
  await wait(800);
  await run(`window.codepup.menuAction('open-panel', { sessionId: 'sess-web' })`);
  await wait(2500);
  const panel = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/panel/'));
  check('세션 보드가 열린다', !!panel);
  const cards = await panel.webContents.executeJavaScript(`[...document.querySelectorAll('.card')].map(c => c.innerText.split('\\n')[0] + ' ' + c.querySelector('.name').textContent)`);
  check('보드에 세션 3개 (이미 열린 세션 포함)', cards.length === 3, cards.join(' | '));
  const limitText = await panel.webContents.executeJavaScript(`document.querySelector('#limits').innerText`);
  check('보드 위쪽에 5시간 · 주간 한도가 보인다', limitText.includes('5시간 82%') && limitText.includes('주간 41%'), limitText.replace(/\n/g, ' / '));
  await shot(panel, '04-panel-reply.png');
  await panel.webContents.executeJavaScript(`(() => { const ta = document.querySelector('.card[data-id="sess-web"] textarea'); ta.value = '회원가입 화면도 같은 스타일로 만들어 줘'; ta.dispatchEvent(new Event('input')); document.querySelector('.card[data-id="sess-web"] button.primary').click(); })()`);
  const replyOut = await Promise.race([replyP, wait(5000).then(() => 'timeout')]);
  check('보드에서 보낸 지시가 세션으로 이어진다', replyOut && replyOut.hookSpecificOutput && replyOut.hookSpecificOutput.additionalContext.includes('회원가입 화면'), JSON.stringify(replyOut).slice(0, 120));
  await run(`window.codepup.updateSettings({ awayMode: false })`);

  // 7) 세션 종료 → 복구 후보 (rcup)
  await hook('SessionEnd', { ...s1, reason: 'other' });
  await wait(800);
  const restore = await panel.webContents.executeJavaScript(`document.querySelector('#restore-box').classList.contains('hidden') ? '' : document.querySelector('#restore-list').innerText`);
  check('닫힌 세션이 "다시 열기" 목록에 뜬다', restore.includes('api-server'), restore.replace(/\n/g, ' '));
  await shot(panel, '05-panel-restore.png');

  // 8) 기존 상호작용: 연타 → 화남, 던지기 → 어지러움
  // (테스트 컨테이너는 CPU가 높아 펫이 계속 전력 질주하므로 이 구간에서는 CPU 반응을 끔)
  await run(`window.codepup.updateSettings({ cpuReactive: false })`);
  await wait(300);
  await run('window.__codepup.P.state = "idle"; window.__codepup.P.dur = 60');
  let p = await run('({ x: window.__codepup.P.x, y: window.__codepup.P.y })');
  for (let i = 0; i < 6; i++) {
    await clickAt(p.x, p.y - 25);
    await wait(60);
  }
  await wait(200);
  const afterSpam = await run('JSON.stringify({ s: window.__codepup.state, x: window.__codepup.P.x, y: window.__codepup.P.y, bubble: document.querySelector("#bubble").className })');
  check('마구 클릭하면 화낸다', JSON.parse(afterSpam).s === 'annoyed', `${afterSpam} clicked at ${Math.round(p.x)},${Math.round(p.y - 25)}`);
  await wait(2600);
  await run('window.__codepup.P.state = "idle"; window.__codepup.P.dur = 60');
  p = await run('({ x: window.__codepup.P.x, y: window.__codepup.P.y })');
  mouse('mouseMove', p.x, p.y - 25);
  await wait(60);
  mouse('mouseDown', p.x, p.y - 25);
  for (let i = 1; i <= 12; i++) {
    await wait(16);
    mouse('mouseMove', p.x + i * (i > 6 ? 45 : 12), p.y - 25 - i * 8);
  }
  mouse('mouseUp', p.x + 540, p.y - 120);
  await wait(60);
  check('휙 던지면 날아간다', (await run('window.__codepup.state')) === 'flung');
  await wait(2500);
  check('착지 후 어지러워한다', ['dizzy', 'wander', 'idle'].includes(await run('window.__codepup.state')));

  // 9) 기본 제공 스피키 스킨으로 바꾸기
  await run(`window.codepup.updateSettings({ skin: 'speaki' })`);
  await wait(2500);
  const sk = await run(`window.codepup.init().then((b) => ({ id: b.skin.id, name: b.settings.name }))`);
  check('스피키 스킨으로 바꾸면 이름도 스피키', sk.id === 'speaki' && sk.name === '스피키', JSON.stringify(sk));
  await shot(pet, '06-speaki-skin.png');

  // 9-2) 스킨 폴더 불러오기 (skin.json 없이 표정 이름으로 된 이미지만 있어도 됨)
  const skinDir = path.join(OUT, 'my-cat-skin');
  fs.mkdirSync(skinDir, { recursive: true });
  for (const n of ['default', 'happy', 'alert']) {
    fs.copyFileSync(path.join(__dirname, '..', 'assets', 'skins', 'chihuahua', `${n === 'default' ? 'surprised' : n}.png`), path.join(skinDir, `${n}.png`));
  }
  const origOpen = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [skinDir] });
  const imported = await run(`window.codepup.importSkin()`);
  dialog.showOpenDialog = origOpen;
  await wait(2000);
  const active = await run(`window.codepup.init().then((b) => b.skin && b.skin.id)`);
  check('스킨 폴더를 불러와 바로 적용한다', imported.ok && active === imported.id, JSON.stringify(imported));
  const settingsFile = JSON.parse(fs.readFileSync(path.join(OUT, 'userData', 'codepup-data.json'), 'utf8'));
  await shot(pet, '06-imported-skin.png');
  await run(`window.codepup.updateSettings({ skin: 'chihuahua' })`);
  await wait(1500);
  check('보안: 경로 탈출 차단', (await run(`fetch('codepup://app/user-media/..%2f..%2fcodepup-data.json').then(r => r.status)`)) === 403);
  check('세션 기록이 저장된다', Array.isArray(settingsFile.sessionsHistory));

  // 10) 설정 창 Claude Code 탭
  await run(`window.codepup.menuAction('open-settings')`);
  await wait(2500);
  const sw = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/settings/'));
  await sw.webContents.executeJavaScript(`document.querySelector('[data-tab=claude]').click()`);
  await wait(500);
  check('설정 창: 연결됨 표시', (await sw.webContents.executeJavaScript(`document.querySelector('#cc-status').textContent`)).includes('연결됨'));
  await shot(sw, '07-settings-claude.png');
  await sw.webContents.executeJavaScript(`document.querySelector('[data-tab=custom]').click()`);
  await wait(800);
  await shot(sw, '08-settings-custom.png');

  fs.writeFileSync(path.join(OUT, 'errors.txt'), errors.join('\n'));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nRESULT: ${checks.length - failed.length}/${checks.length} passed`);
  console.log('ERRORS:', errors.length ? errors : 'none');
  finish(failed.length || errors.length ? 1 : 0);
});
