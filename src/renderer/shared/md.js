// Claude 답변(마크다운)을 보기 좋게: 보드에서는 간단한 HTML 로, 말풍선에서는 기호를 걷어낸 한 줄 요약으로.
// 외부 라이브러리 없이 자주 쓰는 문법만 (제목 · 굵게 · 기울임 · 코드 · 목록 · 인용 · 링크 · 표 줄).
(function (root) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(text) {
    const codes = [];
    let s = esc(text).replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/__([^_\n]+)__/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<u title="$2">$1</u>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  function toHtml(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol'
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*```/.exec(line);
      if (fence) {
        flushPara();
        closeList();
        const body = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
        out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      if (!line.trim()) {
        flushPara();
        closeList();
        continue;
      }
      let m;
      if ((m = /^\s*(#{1,6})\s+(.*)$/.exec(line))) {
        flushPara();
        closeList();
        out.push(`<h${Math.min(6, m[1].length + 2)}>${inline(m[2])}</h${Math.min(6, m[1].length + 2)}>`);
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara();
        closeList();
        out.push('<hr>');
      } else if ((m = /^\s*[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ul') {
          closeList();
          out.push('<ul>');
          list = 'ul';
        }
        const box = m[1] === undefined ? '' : m[1] === ' ' ? '☐ ' : '☑ ';
        out.push(`<li>${box}${inline(m[2])}</li>`);
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ol') {
          closeList();
          out.push('<ol>');
          list = 'ol';
        }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
        flushPara();
        closeList();
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        flushPara();
        closeList();
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // 표 구분선
        const cells = line.trim().slice(1, -1).split('|').map((c) => inline(c.trim()));
        out.push(`<div class="md-row">${cells.map((c) => `<span>${c}</span>`).join('')}</div>`);
      } else {
        closeList();
        para.push(line.trim());
      }
    }
    flushPara();
    closeList();
    return out.join('');
  }

  // 말풍선용: 마크다운 기호를 걷어내고 첫 문장(또는 첫 줄) 위주로 짧게
  function summary(md, n = 70) {
    let raw = String(md || '')
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .split('\n');
    const body = raw.filter((l) => l.trim() && !/^\s*#{1,6}\s/.test(l));
    if (body.length) raw = body; // 제목 줄은 건너뛰고 본문부터
    const text = raw
      .map((l) =>
        l
          .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
          .replace(/^\s*\|.*\|\s*$/, '')
          .replace(/^\s*([-*_])(\s*\1){2,}\s*$/, '')
          .replace(/\*\*|__|~~|`/g, '')
          .replace(/(^|[^\w])\*([^*]+)\*/g, '$1$2')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .trim()
      )
      .filter(Boolean);
    let s = lines(text);
    const cut = s.search(/[.!?。](\s|$)/);
    if (cut > 12 && cut < n) s = s.slice(0, cut + 1).replace(/\s+$/, '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  const lines = (arr) => arr.join(' ').replace(/\s+/g, ' ').trim();

  const api = { toHtml, summary, inline, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CodePupMd = api;
})(typeof window !== 'undefined' ? window : globalThis);
