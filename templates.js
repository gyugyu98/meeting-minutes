// 회의록 양식: 저장, 파일에서 읽기(md·txt·docx·hwp·hwpx), 공유 링크, 마크다운 ↔ 화면 변환

/* ---------- 저장 (이 브라우저에만) ---------- */
const TPL_KEY = 'mm_templates', TPL_SEL = 'mm_template_selected';
function loadTemplates() { try { return JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (e) { return []; } }
function saveTemplates(list) { try { localStorage.setItem(TPL_KEY, JSON.stringify(list)); } catch (e) {} }
function selectedTemplateId() { try { return localStorage.getItem(TPL_SEL) || 'default'; } catch (e) { return 'default'; } }
function selectTemplateId(id) { try { localStorage.setItem(TPL_SEL, id); } catch (e) {} }
function upsertTemplate(t) {
  const list = loadTemplates();
  const same = list.find(x => x.name === t.name && x.body === t.body);
  if (same) return same;
  const item = { id: t.id || 't' + Date.now().toString(36), name: t.name, body: t.body };
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
  saveTemplates(list);
  return item;
}
function deleteTemplate(id) { saveTemplates(loadTemplates().filter(x => x.id !== id)); }

/* ---------- 필요할 때만 불러오는 라이브러리 ---------- */
const loaded = {};
function loadScript(src) {
  return loaded[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(src + '를 불러오지 못했습니다'));
    document.head.append(s);
  });
}

/* ---------- 파일 → 양식(마크다운) ---------- */
async function templateFromFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'txt') return (await file.text()).trim();
  const buf = await file.arrayBuffer();
  if (ext === 'docx') {
    await loadScript('vendor/mammoth.browser.min.js');
    const { value } = await window.mammoth.convertToHtml({ arrayBuffer: buf });
    const box = document.createElement('div');
    box.innerHTML = value;
    return htmlToMd(box).trim();
  }
  if (ext === 'hwpx') return (await hwpxToMd(buf)).trim();
  if (ext === 'hwp') {
    await loadScript('vendor/hwp.bundle.js');
    return hwpToMd(window.HWPJS.parse(new Uint8Array(buf), { type: 'array' })).trim();
  }
  throw new Error('md, txt, docx, hwp, hwpx 파일만 읽을 수 있습니다');
}

// 표 한 개를 마크다운 표로. rows: 문자열 2차원 배열
function mdTable(rows) {
  rows = rows.filter(r => r.some(c => c));
  if (!rows.length) return '';
  const cols = Math.max(...rows.map(r => r.length));
  const cell = c => (c || ' ').replace(/\|/g, '\\|').replace(/\n+/g, ' / ');
  const line = r => '| ' + Array.from({ length: cols }, (_, i) => cell(r[i])).join(' | ') + ' |';
  return [line(rows[0]), '|' + ' --- |'.repeat(cols), ...rows.slice(1).map(line)].join('\n');
}

// .hwp (hwp.js가 읽은 문서): 문단 글자와 표만 뽑는다
function hwpToMd(doc) {
  const text = p => (p.content || []).filter(c => c.type === 0 && typeof c.value === 'string').map(c => c.value).join('').trim();
  const out = [];
  const walk = paragraphs => {
    for (const p of paragraphs) {
      const t = text(p);
      if (t) out.push(t);
      for (const ctrl of p.controls || []) {
        if (!Array.isArray(ctrl.content) || !ctrl.rowCount) continue;   // 표만
        const rows = ctrl.content.map(row => (row || []).map(cell => (cell?.items || []).map(text).filter(Boolean).join('\n')));
        const md = mdTable(rows);
        if (md) out.push('', md, '');
      }
    }
  };
  for (const s of doc.sections || []) walk(s.content || []);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// .hwpx (zip 안의 Contents/section*.xml): 문단 글자와 표만 뽑는다
async function hwpxToMd(buf) {
  await loadScript('vendor/jszip.min.js');
  const zip = await window.JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter(n => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  const out = [];
  const kids = (el, name) => [...el.children].filter(c => c.localName === name);
  const textOf = el => [...el.getElementsByTagNameNS('*', 't')].filter(t => !t.closest || !inTable(t, el)).map(t => t.textContent).join('').trim();
  const inTable = (node, stop) => { for (let n = node.parentElement; n && n !== stop; n = n.parentElement) if (n.localName === 'tbl') return true; return false; };
  const table = tbl => mdTable(kids(tbl, 'tr').map(tr => kids(tr, 'tc').map(tc =>
    [...tc.getElementsByTagNameNS('*', 'p')].filter(p => !inTable(p, tc)).map(p => textOf(p)).filter(Boolean).join('\n'))));
  const walk = el => {
    for (const c of el.children) {
      if (c.localName === 'tbl') { const md = table(c); if (md) out.push('', md, ''); continue; }
      if (c.localName === 'p') {
        const t = textOf(c);
        if (t) out.push(t);
        [...c.getElementsByTagNameNS('*', 'tbl')].filter(t2 => !inTable(t2, c)).forEach(t2 => { const md = table(t2); if (md) out.push('', md, ''); });
        continue;
      }
      walk(c);
    }
  };
  for (const n of names) {
    const xml = new DOMParser().parseFromString(await zip.file(n).async('string'), 'application/xml');
    walk(xml.documentElement);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ---------- 화면(HTML) → 마크다운 ---------- */
function htmlToMd(root) {
  const inline = el => [...el.childNodes].map(n => {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeType !== 1) return '';
    const tag = n.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'STRONG' || tag === 'B') { const t = inline(n).trim(); return t ? `**${t}**` : ''; }
    if (tag === 'INPUT' && n.type === 'checkbox') return n.checked ? '☑ ' : '☐ ';
    if (/^(UL|OL|TABLE)$/.test(tag)) return '';
    return inline(n);
  }).join('');
  const out = [];
  const list = (el, depth) => {
    let k = 0;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      k++;
      let t = inline(li).replace(/\s+/g, ' ').trim();
      let mark = el.tagName === 'OL' ? `${k}.` : '-';
      if (/^☐\s*/.test(t)) { mark = '- [ ]'; t = t.replace(/^☐\s*/, ''); }
      else if (/^☑\s*/.test(t)) { mark = '- [x]'; t = t.replace(/^☑\s*/, ''); }
      out.push('  '.repeat(depth) + mark + ' ' + t);
      for (const sub of li.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') list(sub, depth + 1);
    }
  };
  const block = el => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push(t, ''); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      const h = tag.match(/^H([1-6])$/);
      if (h) { out.push('#'.repeat(+h[1]) + ' ' + inline(n).trim(), ''); continue; }
      if (tag === 'UL' || tag === 'OL') { list(n, 0); out.push(''); continue; }
      if (tag === 'TABLE') {
        out.push(mdTable([...n.querySelectorAll('tr')].map(tr => [...tr.children].map(td => inline(td).trim()))), '');
        continue;
      }
      if (tag === 'BLOCKQUOTE') { out.push(...inline(n).trim().split('\n').map(l => '> ' + l), ''); continue; }
      if (tag === 'HR') { out.push('---', ''); continue; }
      if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') { block(n); continue; }
      const t = inline(n).trim();
      if (t) out.push(t, '');
    }
  };
  block(root);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- 마크다운 → 화면(HTML) ---------- */
function mdToHtml(md) {
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = r => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      const body = rows.filter(r => !/^[\s|:-]+$/.test(r));   // 구분선(|---|---|) 줄은 뺀다
      const [head, ...rest] = body.map(cells);
      out.push('<table><thead><tr>' + (head || []).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rest.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (listRe.test(l)) {
      // 들여쓰기로 중첩 목록을 만든다
      const stack = [];
      let html = '';
      while (i < lines.length && listRe.test(lines[i])) {
        const [, sp, mark, rest] = lines[i].match(listRe);
        const depth = Math.floor(sp.replace(/\t/g, '  ').length / 2);
        const tag = /\d/.test(mark) ? 'ol' : 'ul';
        while (stack.length > depth + 1) html += `</li></${stack.pop()}>`;
        if (stack.length === depth + 1 && stack[depth] !== tag) html += `</li></${stack.pop()}>`;
        if (stack.length < depth + 1) { html += `<${tag}>`; stack.push(tag); }
        else html += '</li>';
        let text = rest, box = '';
        const t = rest.match(/^\[( |x|X)\]\s*(.*)$/);
        if (t) { box = t[1] === ' ' ? '☐ ' : '☑ '; text = t[2]; }
        html += `<li>${box}${inline(text)}`;
        i++;
      }
      while (stack.length) html += `</li></${stack.pop()}>`;
      out.push(html);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*\||\s*>|\s*(---|\*\*\*|___)\s*$)/.test(lines[i]) && !listRe.test(lines[i])) { para.push(inline(lines[i].trim())); i++; }
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return out.join('\n');
}

/* ---------- 공유 링크 ---------- */
// 양식을 압축해 링크 뒤(#tpl=...)에 담는다. 서버에 저장하지 않는다.
async function encodeTemplate(t) {
  const bytes = new TextEncoder().encode(JSON.stringify({ n: t.name, b: t.body }));
  let data = bytes, flag = 'r';
  if (window.CompressionStream) {
    data = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    flag = 'z';
  }
  let bin = '';
  data.forEach(b => { bin += String.fromCharCode(b); });
  return flag + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function decodeTemplate(code) {
  const flag = code[0], b64 = code.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  let raw = bytes;
  if (flag === 'z') raw = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  const o = JSON.parse(new TextDecoder().decode(raw));
  if (!o || typeof o.n !== 'string' || typeof o.b !== 'string') throw new Error('양식 링크가 올바르지 않습니다');
  return { name: o.n.slice(0, 60), body: o.b.slice(0, 20000) };
}
