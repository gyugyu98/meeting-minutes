// 회의록 양식: 저장, 파일에서 읽기(md·txt·docx·hwp·hwpx), 마크다운 ↔ 화면 변환, 한글 양식(hwpx)에 채우기

/* ---------- 저장 (이 브라우저에만) ---------- */
const TPL_KEY = 'mm_templates', TPL_SEL = 'mm_template_selected';
function loadTemplates() { try { return JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (e) { return []; } }
function saveTemplates(list) {
  try { localStorage.setItem(TPL_KEY, JSON.stringify(list)); return true; }
  catch (e) { return false; }   // 저장 공간 부족 등
}
function selectedTemplateId() { try { return localStorage.getItem(TPL_SEL) || 'default'; } catch (e) { return 'default'; } }
function selectTemplateId(id) { try { localStorage.setItem(TPL_SEL, id); } catch (e) {} }
// t: { id?, name, body, file?: { name, hwpx(base64) } }
function upsertTemplate(t) {
  const list = loadTemplates();
  const item = { id: t.id || 't' + Date.now().toString(36), name: t.name, body: t.body, ...(t.file ? { file: t.file } : {}) };
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
  if (!saveTemplates(list)) throw new Error('브라우저 저장 공간이 부족합니다. 쓰지 않는 양식을 지워주세요');
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
const loadJSZip = () => loadScript('vendor/jszip.min.js');
const loadHwpConvert = () => loadScript('vendor/hwp-convert.js');   // hwp → hwpx, 마크다운 → hwpx

function bytesToB64(bytes) {
  let bin = '';
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
  return btoa(bin);
}
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

/* ---------- 파일 → 양식 ---------- */
// 돌려주는 값: { body: 마크다운, hwpx?: Uint8Array } — hwp·hwpx는 서식을 그대로 둔 hwpx도 함께 돌려준다
async function templateFromFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'txt') return { body: (await file.text()).trim() };
  const buf = new Uint8Array(await file.arrayBuffer());
  if (ext === 'docx') {
    await loadScript('vendor/mammoth.browser.min.js');
    const { value } = await window.mammoth.convertToHtml({ arrayBuffer: buf.buffer });
    const box = document.createElement('div');
    box.innerHTML = value;
    return { body: htmlToMd(box).trim() };
  }
  if (ext === 'hwp' || ext === 'hwpx') {
    let hwpx = buf;
    if (ext === 'hwp') {
      await loadHwpConvert();
      hwpx = await window.HwpConvert.hwpToHwpx(buf, { title: file.name.replace(/\.[^.]+$/, '') });
    }
    return { body: (await hwpxToMd(hwpx)).trim(), hwpx };
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

/* ---------- hwpx 읽기 ---------- */
const kids = (el, name) => [...el.children].filter(c => c.localName === name);
const inside = (node, name, stop) => { for (let n = node.parentElement; n && n !== stop; n = n.parentElement) if (n.localName === name) return n; return null; };
// 문단의 글자 (안쪽 표의 글자는 빼고, 줄바꿈은 \n)
function paraText(p) {
  let s = '';
  const visit = el => {
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { if (inside(c, 't', p)) s += c.textContent; continue; }
      if (c.nodeType !== 1) continue;
      if (c.localName === 'tbl') continue;
      if (c.localName === 'lineBreak') { s += '\n'; continue; }
      if (c.localName === 'tab') { s += '\t'; continue; }
      visit(c);
    }
  };
  visit(p);
  return s;
}
async function openHwpx(bytes) {
  await loadJSZip();
  const zip = await window.JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter(n => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  const sections = [];
  for (const n of names) sections.push({ name: n, doc: new DOMParser().parseFromString(await zip.file(n).async('string'), 'application/xml') });
  return { zip, sections };
}

// 양식 글(마크다운)로: 표는 표로, 문단이 많은 큰 칸은 표 아래에 문단 그대로 풀어 쓴다
async function hwpxToMd(bytes) {
  const { sections } = await openHwpx(bytes);
  const out = [];
  const table = tbl => {
    const after = [];
    const rows = kids(tbl, 'tr').map(tr => kids(tr, 'tc').map(tc => {
      const paras = [...tc.getElementsByTagNameNS('*', 'p')].filter(p => inside(p, 'tc', null) === tc);
      const lines = paras.map(paraText).map(s => s.replace(/\s+$/, ''));
      if (lines.filter(l => l.trim()).length > 3) { after.push(...lines); return '(아래 내용)'; }
      return lines.filter(l => l.trim()).join('\n');
    }));
    const md = mdTable(rows);
    if (md) out.push('', md, '');
    if (after.length) out.push(...after.map(l => l.trim() ? l : ''), '');
  };
  const walk = el => {
    for (const c of el.children) {
      if (c.localName === 'tbl') { table(c); continue; }
      if (c.localName === 'p') {
        const t = paraText(c).trim();
        if (t) out.push(t);
        [...c.getElementsByTagNameNS('*', 'tbl')].filter(t2 => !inside(t2, 'tbl', c)).forEach(table);
        continue;
      }
      walk(c);
    }
  };
  for (const s of sections) walk(s.doc.documentElement);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ---------- 한글 양식(hwpx)에 채우기 ---------- */
// 양식의 칸(C번호)과 문단(P번호)을 목록으로 만든다. Gemini는 이 목록을 보고 어느 칸에 어떤 문단을 넣을지 정한다.
async function hwpxInventory(bytes) {
  const pack = await openHwpx(bytes);
  const cells = [], paras = [];
  let tableNo = 0;
  const lines = [];
  for (const s of pack.sections) {
    for (const tc of s.doc.getElementsByTagNameNS('*', 'tc')) {
      const tbl = inside(tc, 'tbl', null);
      if (!tbl.__no) tbl.__no = ++tableNo;
      const addr = tc.getElementsByTagNameNS('*', 'cellAddr')[0];
      const span = tc.getElementsByTagNameNS('*', 'cellSpan')[0];
      const sub = kids(tc, 'subList')[0] || tc;
      const cell = { id: 'C' + (cells.length + 1), el: tc, sub, paras: [] };
      cells.push(cell);
      const ps = kids(sub, 'p');
      lines.push(`${cell.id} (표${tbl.__no} ${+addr?.getAttribute('rowAddr') + 1}행 ${+addr?.getAttribute('colAddr') + 1}열${span && (span.getAttribute('colSpan') !== '1' || span.getAttribute('rowSpan') !== '1') ? `, ${span.getAttribute('rowSpan')}×${span.getAttribute('colSpan')} 병합` : ''})`);
      for (const p of ps) {
        const runs = kids(p, 'run');
        const textRuns = runs.filter(r => !r.querySelector('*') || [...r.children].every(k => k.localName === 't'));
        const objects = runs.some(r => [...r.children].some(k => k.localName !== 't'));
        const para = { id: 'P' + (paras.length + 1), el: p, cell: cell.id, usable: !objects && runs.length > 0 };
        paras.push(para); cell.paras.push(para);
        const parts = textRuns.map(r => paraText(r).replace(/\n/g, '⏎'));
        lines.push(objects ? `  ${para.id}: [그림·개체]` : `  ${para.id}: ` + (parts.length > 1 ? parts.map((t, k) => `조각${k + 1}"${t}"`).join(' + ') : `"${parts[0] || ''}"`));
      }
    }
  }
  return { pack, cells, paras, text: lines.join('\n') };
}

// plan: { cells: [{ cell: 'C5', paragraphs: [{ like: 'P13', parts: ['…'] }] }] }
async function fillHwpx(bytes, plan) {
  const inv = await hwpxInventory(bytes);
  const cellById = Object.fromEntries(inv.cells.map(c => [c.id, c]));
  const paraById = Object.fromEntries(inv.paras.map(p => [p.id, p]));
  let nextId = Math.max(0, ...inv.paras.map(p => parseInt(p.el.getAttribute('id')) || 0)) + 1;
  for (const change of plan.cells || []) {
    const cell = cellById[change.cell];
    if (!cell || !Array.isArray(change.paragraphs) || !change.paragraphs.length) continue;
    // 문단 모양 견본: 지정한 문단이 쓸 수 없으면 그 칸의 첫 글자 문단을 쓴다
    const fallback = cell.paras.find(p => p.usable) || inv.paras.find(p => p.usable);
    const made = change.paragraphs.map(np => {
      const like = (paraById[np.like]?.usable ? paraById[np.like] : fallback);
      return like ? cloneWithText(like.el, Array.isArray(np.parts) ? np.parts : [String(np.parts ?? '')], nextId++) : null;
    }).filter(Boolean);
    if (!made.length) continue;
    cell.paras.forEach(p => p.el.remove());
    made.forEach(p => cell.sub.append(p));
  }
  const { zip, sections } = inv.pack;
  const ser = new XMLSerializer();
  for (const s of sections) zip.file(s.name, ser.serializeToString(s.doc));
  // 탐색기 미리보기 글도 새 내용으로
  if (zip.file('Preview/PrvText.txt')) {
    const text = sections.map(s => [...s.doc.getElementsByTagNameNS('*', 'p')].map(paraText).filter(t => t.trim()).join('\r\n')).join('\r\n');
    zip.file('Preview/PrvText.txt', text.slice(0, 1000));
  }
  // hwpx 규칙: mimetype이 맨 앞, 압축하지 않음
  const out = new window.JSZip();
  const order = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  out.file('mimetype', await zip.file('mimetype').async('uint8array'), { compression: 'STORE', createFolders: false });
  for (const n of order) if (n !== 'mimetype') out.file(n, await zip.file(n).async('uint8array'), { createFolders: false });
  return await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/hwp+zip' });
}

// 견본 문단을 복제해 글자만 바꾼다. 글자 조각(parts)은 견본의 글자 모양 조각(run)에 차례로 넣는다.
function cloneWithText(src, parts, id) {
  const p = src.cloneNode(true);
  p.setAttribute('id', String(id));
  kids(p, 'linesegarray').forEach(x => x.remove());   // 줄 배치 정보는 한글이 다시 계산한다
  const runs = kids(p, 'run');
  const ns = src.namespaceURI, prefix = src.prefix ? src.prefix + ':' : '';
  if (!parts.length) parts = [''];
  parts = parts.map(s => String(s ?? '').replace(/⏎/g, '\n'));
  runs.forEach((r, k) => {
    if (k >= parts.length) { if (k > 0) r.remove(); else setRunText(r, ''); return; }
    let text = k === runs.length - 1 ? parts.slice(k).join('') : parts[k];
    // 견본 조각이 줄바꿈으로 끝나면(예: 굵은 안건 ⏎ 세부 내용) 새 글자도 같은 자리에서 줄을 바꾼다
    if (k < runs.length - 1 && /\n$/.test(paraText(r)) && !/\n$/.test(text) && parts[k + 1]) text += '\n';
    setRunText(r, text);
  });
  function setRunText(r, text) {
    [...r.childNodes].forEach(c => c.remove());
    if (!text) return;
    const t = r.ownerDocument.createElementNS(ns, prefix + 't');
    String(text).split('\n').forEach((piece, k) => {
      if (k) t.append(r.ownerDocument.createElementNS(ns, prefix + 'lineBreak'));
      if (piece) t.append(r.ownerDocument.createTextNode(piece));
    });
    r.append(t);
  }
  return p;
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
