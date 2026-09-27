// 펫에게 직접 시킨 작업: 터미널 없이 `claude -p` 로 Claude Code 를 실행합니다.
// - 진행 상황(권한 요청 · 도구 사용 · 완료)은 설치된 훅이 세션 허브로 알려 줘요.
// - 훅을 구분할 수 있도록 CODEPUP_TASK 환경 변수를 넘기고, 훅 스크립트가 이를 헤더로 보냅니다.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_OUTPUT = 4 * 1024 * 1024;

// Finder 로 실행한 앱은 PATH 가 짧아서 claude 를 못 찾는 경우가 많음
function candidatePaths(home = os.homedir()) {
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
  ];
}

function findClaude({ override, home } = {}) {
  return new Promise((resolve) => {
    if (override && fs.existsSync(override)) return resolve(override);
    const hit = candidatePaths(home).find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (hit) return resolve(hit);
    // 로그인 셸의 PATH 로 한 번 더 찾기
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-lc', 'command -v claude'], { timeout: 5000 }, (err, stdout) => {
      const p = String(stdout || '').trim().split('\n').pop();
      resolve(!err && p && fs.existsSync(p) ? p : null);
    });
  });
}

class Runner extends EventEmitter {
  constructor({ claudePath, home } = {}) {
    super();
    this.claudePathOverride = claudePath || process.env.CODEPUP_CLAUDE || '';
    this.home = home;
    this.tasks = new Map(); // taskId -> { child, cwd, sessionId, prompt }
    this.seq = 0;
  }

  /**
   * @param {object} opts
   * @param {string} opts.cwd       작업 폴더
   * @param {string} opts.prompt    시킬 내용
   * @param {string} [opts.resume]  이어서 할 세션 ID
   * @param {boolean} [opts.fork]   원래 세션은 두고 복사본으로 이어서 (터미널에 열린 세션용)
   * @param {string} [opts.model]   사용할 모델 (비우면 사용자의 Claude Code 기본 모델)
   */
  async start({ cwd, prompt, resume, fork, model, retried = false }) {
    const text = String(prompt || '').trim();
    if (!text) return { ok: false, error: '할 일을 적어 주세요' };
    if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: '작업 폴더를 찾을 수 없어요' };
    const bin = await findClaude({ override: this.claudePathOverride, home: this.home });
    if (!bin) return { ok: false, error: 'claude 명령을 찾지 못했어요. Claude Code 가 설치되어 있는지 확인해 주세요.' };

    const taskId = `t${Date.now().toString(36)}${++this.seq}`;
    const args = ['-p', text, '--output-format', 'json'];
    if (resume) args.push('--resume', resume);
    if (resume && fork) args.push('--fork-session');
    if (model && /^[\w.[\]-]+$/.test(model)) args.push('--model', model);
    const env = {
      ...process.env,
      CODEPUP_TASK: taskId,
      PATH: [path.dirname(bin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    const task = { taskId, child, cwd, prompt: text, resume: resume || null, fork: !!fork, model: model || '', retried, sessionId: fork ? null : resume || null, startedAt: Date.now() };
    const request = { cwd, prompt: text, resume: resume || null, fork: !!fork, model: model || '', retried };
    this.tasks.set(taskId, task);

    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      if (out.length < MAX_OUTPUT) out += c;
    });
    child.stderr.on('data', (c) => {
      if (err.length < 64 * 1024) err += c;
    });
    child.on('error', (e) => {
      this.tasks.delete(taskId);
      this.emit('finished', { taskId, cwd, request, ok: false, error: String(e.message || e) });
    });
    child.on('close', (code) => {
      this.tasks.delete(taskId);
      let result = null;
      try {
        result = JSON.parse(out.trim().split('\n').pop());
      } catch {
        // JSON 이 아니면 아래에서 오류로 처리
      }
      if (result && result.session_id) {
        this.emit('finished', {
          taskId,
          cwd,
          request,
          ok: !result.is_error,
          sessionId: result.session_id,
          result: String(result.result || ''),
          error: result.is_error ? String(result.result || result.subtype || '실패했어요') : null,
        });
      } else {
        const msg = (err || out).trim().split('\n').slice(-3).join(' ').slice(0, 300);
        this.emit('finished', { taskId, cwd, request, ok: false, error: msg || `claude 가 종료 코드 ${code} 로 끝났어요` });
      }
    });
    this.emit('started', { taskId, cwd, prompt: text, resume: resume || null, fork: !!fork });
    return { ok: true, taskId };
  }

  cancel(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    t.child.kill('SIGINT');
    return true;
  }

  running() {
    return [...this.tasks.values()].map((t) => ({ taskId: t.taskId, cwd: t.cwd, prompt: t.prompt, startedAt: t.startedAt }));
  }

  stopAll() {
    for (const t of this.tasks.values()) t.child.kill('SIGINT');
  }
}

// 1M 컨텍스트 모델을 쓸 권한(usage credits)이 없을 때의 오류
function isLongContextError(text) {
  return /long context|1M context|usage credits/i.test(String(text || ''));
}

module.exports = { Runner, findClaude, candidatePaths, isLongContextError };
