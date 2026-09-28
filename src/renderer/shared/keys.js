// 단축키(Electron accelerator) ↔ 화면 표시 · 키 입력으로 만들기
(function (root) {
  const SYM = { CommandOrControl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Space: 'Space' };

  function label(accel) {
    if (!accel) return '';
    const parts = String(accel).split('+');
    const order = ['Control', 'Ctrl', 'Alt', 'Option', 'Shift', 'CommandOrControl', 'Command', 'Cmd'];
    const mods = parts.filter((p) => order.includes(p)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const key = parts.filter((p) => !order.includes(p)).join('+');
    return mods.map((m) => SYM[m]).join('') + (SYM[key] || key);
  }

  // keydown 이벤트 → accelerator (수정키 하나 이상 + 일반 키 하나). 아직 수정키만 눌렀으면 ''
  function fromEvent(e) {
    let key = '';
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
    else if (e.code === 'Space') key = 'Space';
    else if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) key = e.code.slice(5);
    else if (e.code === 'Period') key = '.';
    else if (e.code === 'Comma') key = ',';
    else if (e.code === 'Slash') key = '/';
    else if (e.code === 'Semicolon') key = ';';
    if (!key) return '';
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('CommandOrControl');
    if (!mods.length || (mods.length === 1 && mods[0] === 'Shift' && !/^F\d/.test(key))) return '';
    return [...mods, key].join('+');
  }

  const api = { label, fromEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CodePupKeys = api;
})(typeof window !== 'undefined' ? window : globalThis);
