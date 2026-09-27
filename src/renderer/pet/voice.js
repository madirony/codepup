// 옹알이 목소리: 녹음 파일 없이 WebAudio로 즉석에서 만드는 귀여운 소리.
// - speak(text): 말풍선 글자 수에 맞춰 "뽀로롱" 옹알이 (동물의 숲 느낌)
// - cue(name): 상황별 효과음 (멍멍, 낑낑, 으르렁, 레벨업 …)
/* exported PupVoice */
const PupVoice = (() => {
  let ctx = null;
  let master = null;

  function audio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 짧은 소리 하나: 주파수가 f0 → f1 으로 미끄러짐
  function blip(t, { f0, f1 = f0, dur = 0.08, type = 'triangle', gain = 0.35, formant = 1800, q = 3 }) {
    const c = audio();
    const osc = c.createOscillator();
    const g = c.createGain();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = formant;
    bp.Q.value = q;
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.015, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // 원음 + 포먼트 필터를 섞어 목소리처럼
    const dry = c.createGain();
    dry.gain.value = 0.45;
    osc.connect(dry).connect(g);
    osc.connect(bp).connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(t, { dur = 0.06, gain = 0.2, freq = 2500 }) {
    const c = audio();
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(master);
    src.start(t);
  }

  // 멍! : 빠르게 올라갔다 떨어지는 짧은 소리 + 약간의 숨소리
  function bark(t, p, size = 1) {
    blip(t, { f0: 520 * p, f1: 900 * p, dur: 0.045 * size, type: 'sawtooth', gain: 0.3, formant: 1400 * p, q: 2 });
    blip(t + 0.04 * size, { f0: 900 * p, f1: 430 * p, dur: 0.09 * size, type: 'sawtooth', gain: 0.32, formant: 1200 * p, q: 2 });
    noise(t, { dur: 0.05, gain: 0.08, freq: 3000 });
  }

  const CUES = {
    greet: (t, p) => {
      bark(t, p);
      bark(t + 0.18, p * 1.08);
    },
    done: (t, p) => {
      bark(t, p * 1.05);
      bark(t + 0.16, p * 1.15);
      blip(t + 0.36, { f0: 880 * p, f1: 1320 * p, dur: 0.14, gain: 0.25 });
    },
    permission: (t, p) => {
      blip(t, { f0: 600 * p, f1: 820 * p, dur: 0.1, gain: 0.3 });
      blip(t + 0.14, { f0: 700 * p, f1: 1150 * p, dur: 0.18, gain: 0.32 });
    },
    happy: (t, p) => {
      bark(t, p * 1.1, 0.8);
      bark(t + 0.13, p * 1.2, 0.8);
    },
    chatter: (t, p) => bark(t, p),
    eat: (t) => {
      for (let i = 0; i < 4; i++) noise(t + i * 0.11, { dur: 0.05, gain: 0.25, freq: 1800 + Math.random() * 800 });
    },
    hungry: (t, p) => blip(t, { f0: 900 * p, f1: 600 * p, dur: 0.55, type: 'sine', gain: 0.25, formant: 1100 }),
    carry: (t, p) => {
      blip(t, { f0: 1000 * p, f1: 1400 * p, dur: 0.12, gain: 0.3 });
      blip(t + 0.13, { f0: 1300 * p, f1: 800 * p, dur: 0.3, gain: 0.28 });
    },
    flung: (t, p) => blip(t, { f0: 1500 * p, f1: 500 * p, dur: 0.6, type: 'sawtooth', gain: 0.25, formant: 1500 }),
    annoyed: (t, p) => {
      blip(t, { f0: 120, f1: 110, dur: 0.45, type: 'sawtooth', gain: 0.35, formant: 400, q: 1.5 });
      bark(t + 0.5, p * 0.9, 1.2);
    },
    sing: (t, p) => {
      const notes = [0, 4, 7, 12, 7, 4, 9, 7, 4, 0];
      notes.forEach((n, i) => blip(t + i * 0.16, { f0: 520 * p * Math.pow(2, n / 12), dur: 0.14, type: 'triangle', gain: 0.28 }));
    },
    levelup: (t, p) => {
      [0, 4, 7, 12, 16].forEach((n, i) => blip(t + i * 0.08, { f0: 660 * p * Math.pow(2, n / 12), dur: 0.12, type: 'square', gain: 0.18, formant: 2500 }));
      bark(t + 0.5, p * 1.2);
    },
    wake: (t, p) => blip(t, { f0: 500 * p, f1: 300 * p, dur: 0.7, type: 'sine', gain: 0.28, formant: 900 }),
  };

  return {
    setVolume(v) {
      audio();
      master.gain.value = Math.max(0, Math.min(1, v));
    },
    has(name) {
      return !!CUES[name];
    },
    cue(name, pitch = 1) {
      const fn = CUES[name];
      if (!fn) return;
      fn(audio().currentTime + 0.02, pitch);
    },
    // 글자마다 짧은 음절. 한글은 받침·모음에 따라 음높이가 조금씩 달라져서 말하는 것처럼 들려요.
    speak(text, pitch = 1) {
      const c = audio();
      let t = c.currentTime + 0.02;
      const chars = [...String(text)].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).slice(0, 24);
      for (const ch of chars) {
        const code = ch.codePointAt(0);
        const step = (code % 7) - 3;
        const f = 520 * pitch * Math.pow(2, step / 12);
        blip(t, { f0: f * 1.06, f1: f * 0.94, dur: 0.07, type: 'triangle', gain: 0.26, formant: 1600 + (code % 5) * 250 });
        t += 0.075 + (code % 3) * 0.008;
      }
    },
  };
})();
