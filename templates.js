// 회의록 양식: 저장, 파일에서 읽기(md·txt·docx·hwp·hwpx), 마크다운 ↔ 화면 변환, 양식 파일(hwpx·docx)에 채우기

/* ---------- 저장 (이 브라우저에만) ---------- */
const TPL_KEY = 'mm_templates', TPL_SEL = 'mm_template_selected';
function loadTemplates() { try { return JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (e) { return []; } }
function saveTemplates(list) {
  try { localStorage.setItem(TPL_KEY, JSON.stringify(list)); return true; }
  catch (e) { return false; }   // 저장 공간 부족 등
}
function selectedTemplateId() { try { return localStorage.getItem(TPL_SEL) || 'default'; } catch (e) { return 'default'; } }
function selectTemplateId(id) { try { localStorage.setItem(TPL_SEL, id); } catch (e) {} }
// t: { id?, name, body, file?: { name, kind: 'hwpx' | 'docx', data(base64) } }
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
const loadHwpConvert = () => loadScript('vendor/hwp-convert.js');   // hwp 글자 읽기용 (hwp → hwpx)

function bytesToB64(bytes) {
  let bin = '';
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
  return btoa(bin);
}
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

/* ---------- 파일 → 양식 ---------- */
// 돌려주는 값: { body: 마크다운, file?: { kind, bytes } }
// hwpx·docx는 원본 파일을 함께 돌려줘서, 나중에 그 파일에 글자만 채워 같은 형식으로 내려준다.
// hwp는 브라우저에서 쓸 수 없고 hwpx로 바꾸는 과정에서 서식이 깨지므로(로고·머리 표) 글자 구성만 읽는다.
async function templateFromFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'txt') return { body: (await file.text()).trim() };
  const buf = new Uint8Array(await file.arrayBuffer());
  if (ext === 'hwpx' || ext === 'docx') return { body: (await formToMd(await openDoc(buf, ext))).trim(), file: { kind: ext, bytes: buf } };
  if (ext === 'hwp') {
    await loadHwpConvert();
    const hwpx = await window.HwpConvert.hwpToHwpx(buf, { title: file.name.replace(/\.[^.]+$/, '') });
    return { body: (await formToMd(await openDoc(hwpx, 'hwpx'))).trim(), hwpOnly: true };
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

/* ---------- 양식 파일(hwpx·docx) 열기 ---------- */
// 두 형식의 같은 역할 요소 이름 (네임스페이스 접두어는 떼고 localName으로 비교)
const KIND = {
  hwpx: { run: 'run', t: 't', parts: n => /^Contents\/section\d+\.xml$/i.test(n) },
  docx: { run: 'r', t: 't', parts: n => n === 'word/document.xml' },
};
const kids = (el, name) => [...el.children].filter(c => c.localName === name);
const inside = (node, name, stop) => { for (let n = node.parentElement; n && n !== stop; n = n.parentElement) if (n.localName === name) return n; return null; };
const OBJECT = /^(pic|ole|equation|drawing|pict|object|container|rect|ellipse|line|txbxContent)$/;
async function openDoc(bytes, kind) {
  await loadJSZip();
  const zip = await window.JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter(KIND[kind].parts).sort((a, b) => (parseInt(a.match(/\d+/)) || 0) - (parseInt(b.match(/\d+/)) || 0));
  if (!names.length) throw new Error('문서 본문을 찾지 못했습니다');
  const parts = [];
  for (const n of names) parts.push({ name: n, doc: new DOMParser().parseFromString(await zip.file(n).async('string'), 'application/xml') });
  return { kind, zip, parts };
}
// 문단의 글자 (안쪽 표의 글자는 빼고, 줄바꿈은 \n)
function paraText(p) {
  let s = '';
  const visit = el => {
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { if (c.parentElement?.localName === 't') s += c.textContent; continue; }
      if (c.nodeType !== 1) continue;
      if (c.localName === 'tbl' || c.localName === 'rPr' || c.localName === 'pPr') continue;
      if (c.localName === 'lineBreak' || c.localName === 'br' || c.localName === 'cr') { s += '\n'; continue; }
      if (c.localName === 'tab') { s += '\t'; continue; }
      visit(c);
    }
  };
  visit(p);
  return s;
}
const hasObject = el => [...el.getElementsByTagNameNS('*', '*')].some(k => OBJECT.test(k.localName));
const attr = (el, name) => el && [...el.attributes].find(a => a.localName === name)?.value;

// 표 하나를 칸 목록으로: { el, sub(문단이 들어 있는 요소), paras, row, col, colSpan, rowSpan, merged(위 칸에 합쳐진 빈 칸) }
function tableCells(tbl, kind) {
  const cells = [];
  kids(tbl, 'tr').forEach((tr, row) => {
    let col = 0;
    for (const tc of kids(tr, 'tc')) {
      if (kind === 'hwpx') {
        const addr = tc.getElementsByTagNameNS('*', 'cellAddr')[0], span = tc.getElementsByTagNameNS('*', 'cellSpan')[0];
        const sub = kids(tc, 'subList')[0] || tc;
        cells.push({ el: tc, sub, paras: kids(sub, 'p'), row: +attr(addr, 'rowAddr') || 0, col: +attr(addr, 'colAddr') || 0, colSpan: +attr(span, 'colSpan') || 1, rowSpan: +attr(span, 'rowSpan') || 1 });
      } else {
        const tcPr = kids(tc, 'tcPr')[0];
        const colSpan = +attr(tcPr && kids(tcPr, 'gridSpan')[0], 'val') || 1;
        const vm = tcPr && kids(tcPr, 'vMerge')[0];
        cells.push({ el: tc, sub: tc, paras: kids(tc, 'p'), row, col, colSpan, rowSpan: 1, vMerge: vm ? (attr(vm, 'val') || 'continue') : null });
        col += colSpan;
      }
    }
  });
  if (kind === 'docx') {   // 세로 병합: restart 칸의 rowSpan을 세고, 이어지는 칸은 merged로 표시
    for (const c of cells) {
      if (c.vMerge === 'continue') { c.merged = true; continue; }
      if (c.vMerge === 'restart') { let r = c.row + 1; while (cells.some(d => d.row === r && d.col === c.col && d.vMerge === 'continue')) r++; c.rowSpan = r - c.row; }
    }
  }
  return cells;
}

/* ---------- 양식 → 화면용 양식 글(마크다운) ---------- */
// 회의록 양식은 대개 "머리글 칸 | 값 칸"이 짝을 이루는 서식표와, 내용이 여러 문단으로 들어가는 큰 칸으로 되어 있다.
// 표를 마크다운 표로 옮기면 내용 구성("1. 회의 목적" 등)이 표의 행처럼 보여 양식이 깨지므로,
// 머리글 칸은 "- 일시: 값" 목록으로, 큰 칸의 문단은 제목·목록이 있는 본문으로 옮긴다.
async function formToMd(pack) {
  const out = [];
  const compact = s => s.replace(/\s+/g, '');
  const isLabel = t => t && compact(t).length <= 6 && !/[.:,0-9]/.test(t);
  const table = tbl => {
    const cells = tableCells(tbl, pack.kind).filter(c => !c.merged).map(c => {
      const lines = c.paras.map(paraText).map(s => s.replace(/\s+$/, ''));
      const filled = lines.filter(l => l.trim()).length;
      // 내용 칸: 글 있는 문단이 많거나, 빈 양식처럼 제목 몇 줄과 빈 줄로 된 여러 문단 칸
      return { ...c, lines, text: lines.filter(l => l.trim()).join(' ').trim(), many: filled > 3 || (filled >= 2 && lines.length >= 3) };
    });
    const rows = [...new Set(cells.map(c => c.row))].sort((a, b) => a - b).map(r => cells.filter(c => c.row === r).sort((a, b) => a.col - b.col));
    for (const rowCells of rows) {
      for (let k = 0; k < rowCells.length; k++) {
        const c = rowCells[k];
        if (c.many) { out.push('', ...contentLines(c.lines), ''); continue; }   // 내용 칸: 본문 구성 그대로
        if (!c.text) continue;
        if (c.rowSpan > 1) { out.push(`# ${c.text}`, ''); continue; }   // 여러 행을 차지하는 칸 = 문서 제목
        if (isLabel(c.text) && k + 1 < rowCells.length && !rowCells[k + 1].many) {   // 머리글 | 값
          out.push(`- ${compact(c.text)}: ${rowCells[k + 1].text}`);
          k++;
          continue;
        }
        if (isLabel(c.text) && rowCells.length === 1) { out.push('', `## ${compact(c.text)}`); continue; }   // 한 줄을 다 차지하는 머리글(예: 내 용)
        out.push(c.text);
      }
    }
    out.push('');
  };
  // 내용 칸 문단: "1. 회의 목적" → 제목, "- 항목" → 목록, ": 세부" → 하위 목록, 짧은 이름 줄(발표자·팀) → 소제목
  const contentLines = lines => {
    const res = [];
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) { res.push(''); continue; }
      const [first, ...rest] = l.split('\n').map(s => s.trim()).filter(Boolean);
      const detail = rest.map(s => '  - ' + s.replace(/^[:\-•·▪○◦]\s*/, ''));
      if (/^\d+[.)]\s*\S/.test(first)) res.push(`## ${first}`);
      else if (/^[-•·▪○◦]\s*/.test(first)) res.push(rest.length ? `- **${first.replace(/^[-•·▪○◦]\s*/, '')}**` : `- ${first.replace(/^[-•·▪○◦]\s*/, '')}`);
      else if (/^:\s*/.test(first)) res.push('  - ' + first.replace(/^:\s*/, ''));
      else if (first.length <= 15 && !/[.,:;!?]/.test(first)) res.push(`### ${first}`);
      else res.push(first);
      res.push(...detail);
    }
    return res;
  };
  const walk = el => {
    for (const c of el.children) {
      if (c.localName === 'tbl') { table(c); continue; }
      if (c.localName === 'p') {
        const t = paraText(c).trim();
        if (t) out.push(t);
        [...c.getElementsByTagNameNS('*', 'tbl')].filter(t2 => !inside(t2, 'tbl', c)).forEach(table);   // 한글은 표가 문단 안에 있다
        continue;
      }
      walk(c);
    }
  };
  for (const p of pack.parts) walk(p.doc.documentElement);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ---------- 양식 파일에 채우기 ---------- */
// 양식의 칸(C번호)과 문단(P번호)을 목록으로 만든다. Gemini는 이 목록을 보고 어느 칸에 어떤 문단을 넣을지 정한다.
async function docInventory(bytes, kind) {
  const pack = await openDoc(bytes, kind);
  const R = KIND[kind];
  const cells = [], paras = [], lines = [];
  let tableNo = 0;
  for (const part of pack.parts) {
    for (const tbl of part.doc.getElementsByTagNameNS('*', 'tbl')) {
      tableNo++;
      const tcs = tableCells(tbl, kind);
      for (const tc of tcs) {
        if (tc.merged) continue;
        const cell = { ...tc, id: 'C' + (cells.length + 1), tbl: tableNo, paras: [] };
        cells.push(cell);
        // 왼쪽 칸이 작성자·부서 같은 머리글이면 이 칸은 회의와 상관없는 고정 정보라 바꾸지 않는다
        const left = tcs.find(c => !c.merged && c.row === tc.row && c.col + c.colSpan === tc.col);
        const label = left ? left.paras.map(paraText).join('').replace(/\s+/g, '') : '';
        cell.fixed = /^(작성자|부서|소속|직위|직급|결재|서명|확인|비고|담당자)$/.test(label);
        lines.push(`${cell.id} (표${tableNo} ${tc.row + 1}행 ${tc.col + 1}열${tc.colSpan > 1 || tc.rowSpan > 1 ? `, ${tc.rowSpan}×${tc.colSpan} 병합` : ''})${cell.fixed ? ' [바꾸지 않음]' : ''}`);
        for (const p of tc.paras) {
          const runs = kids(p, R.run);
          const objects = hasObject(p);
          const para = { id: 'P' + (paras.length + 1), el: p, cell: cell.id, usable: !objects };
          paras.push(para); cell.paras.push(para);
          const parts = runs.filter(r => !hasObject(r)).map(r => paraText(r).replace(/\n/g, '⏎')).filter((t, k, a) => t || a.length === 1);
          lines.push(objects ? `  ${para.id}: [그림·개체]` : `  ${para.id}: ` + (parts.length > 1 ? parts.map((t, k) => `조각${k + 1}"${t}"`).join(' + ') : `"${parts[0] || ''}"`));
        }
      }
    }
  }
  return { pack, cells, paras, text: lines.join('\n') };
}

// plan: { cells: [{ cell: 'C5', paragraphs: [{ like: 'P13', parts: ['…'] }] }] }
// 원본 파일을 그대로 두고, 계획에 든 칸의 문단만 견본 문단을 복제해 글자를 바꾼다.
async function fillDoc(bytes, kind, plan) {
  const inv = await docInventory(bytes, kind);
  const cellById = Object.fromEntries(inv.cells.map(c => [c.id, c]));
  const paraById = Object.fromEntries(inv.paras.map(p => [p.id, p]));
  // 한글 문단 id는 문서 전체(표 밖 문단 포함)에서 겹치지 않게 매긴다
  const allIds = inv.pack.parts.flatMap(s => [...s.doc.getElementsByTagNameNS('*', 'p')].map(p => parseInt(p.getAttribute('id')) || 0));
  let nextId = Math.max(0, ...allIds) + 1;
  for (const change of plan.cells || []) {
    const cell = cellById[change.cell];
    if (!cell || cell.fixed || !Array.isArray(change.paragraphs) || !change.paragraphs.length) continue;
    // 문단 모양 견본: 지정한 문단이 쓸 수 없으면 그 칸의 첫 글자 문단을 쓴다
    const fallback = cell.paras.find(p => p.usable) || inv.paras.find(p => p.usable);
    const made = normalizeParagraphs(change.paragraphs, paraById, kind).map(np => {
      const like = (paraById[np.like]?.usable ? paraById[np.like] : fallback);
      return like ? cloneWithText(like.el, np.parts, kind, nextId++) : null;
    }).filter(Boolean);
    if (!made.length) continue;
    // 칸 안의 문단만 갈아 끼운다 (칸 속성 tcPr 등은 그대로)
    const anchor = cell.paras.at(-1).el.nextSibling;
    cell.paras.forEach(p => p.el.remove());
    made.forEach(p => cell.sub.insertBefore(p, anchor));
    // 워드: 한글이 내보낸 docx는 내용 칸 행에 큰 최소 높이(한 쪽 가득)가 걸려 있는데, 워드는 줄 간격 계산이 달라
    // 그 높이가 한 쪽을 넘쳐 다음 쪽으로 밀린다. 내용을 채운 행은 높이를 내용에 맡기고, 쪽을 넘어 이어지게 한다.
    if (kind === 'docx') {
      const trPr = kids(cell.el.parentElement, 'trPr')[0];
      if (trPr) {
        kids(trPr, 'trHeight').filter(h => +attr(h, 'val') > 2000).forEach(h => h.remove());
        kids(trPr, 'cantSplit').forEach(c => c.remove());
      }
    }
  }
  const { zip, parts } = inv.pack;
  const ser = new XMLSerializer();
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  for (const s of parts) {
    const xml = ser.serializeToString(s.doc);
    zip.file(s.name, xml.startsWith('<?xml') ? xml : decl + xml);
  }
  if (kind === 'hwpx' && zip.file('Preview/PrvText.txt')) {   // 탐색기 미리보기 글도 새 내용으로
    const text = parts.map(s => [...s.doc.getElementsByTagNameNS('*', 'p')].map(paraText).filter(t => t.trim()).join('\r\n')).join('\r\n');
    zip.file('Preview/PrvText.txt', text.slice(0, 1000));
  }
  // 원래 순서대로 다시 묶는다. hwpx는 mimetype이 맨 앞, 압축하지 않음
  const out = new window.JSZip();
  for (const n of Object.keys(zip.files).filter(n => !zip.files[n].dir)) {
    out.file(n, await zip.file(n).async('uint8array'), { createFolders: false, ...(n === 'mimetype' ? { compression: 'STORE' } : {}) });
  }
  return await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: kind === 'hwpx' ? 'application/hwp+zip' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

// Gemini가 준 문단을 문서에 맞게 다듬는다:
// 마크다운 기호(**, [ ])를 빼고, 한 문단에 여러 목록 항목("  - …  - …")을 이어 쓴 경우 항목마다 문단을 나눈다.
function normalizeParagraphs(list, paraById, kind) {
  const clean = s => String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\s)-\s\[[ xX]\]\s*/g, '$1- ').replace(/^\s*\[[ xX]\]\s*/, '');
  const out = [];
  for (const np of list) {
    const parts = (Array.isArray(np.parts) ? np.parts : [np.parts]).map(clean);
    const likeRuns = paraById[np.like] ? kids(paraById[np.like].el, KIND[kind].run).filter(r => paraText(r)).length : 1;
    if (parts.length === 1 && likeRuns <= 1) {
      const items = parts[0].split(/(?<=\S)\s{2,}(?=-\s)/);   // "  - 가  - 나" → "  - 가", "- 나"
      if (items.length > 1) {
        const lead = items[0].match(/^\s*/)[0];
        items.forEach((t, k) => out.push({ like: np.like, parts: [k ? lead + t.trim() : t] }));
        continue;
      }
    }
    out.push({ like: np.like, parts });
  }
  return out;
}

// 견본 문단을 복제해 글자만 바꾼다. 글자 조각(parts)은 견본의 글자 모양 조각(run)에 차례로 넣는다.
function cloneWithText(src, parts, kind, id) {
  const p = src.cloneNode(true);
  const doc = src.ownerDocument, ns = src.namespaceURI, prefix = src.prefix ? src.prefix + ':' : '';
  const R = KIND[kind];
  if (kind === 'hwpx') {
    p.setAttribute('id', String(id));
    kids(p, 'linesegarray').forEach(x => x.remove());   // 줄 배치 정보는 한글이 다시 계산한다
  } else {
    // 워드: 문단 고유번호는 겹치면 안 되므로 지우고, 책갈피·맞춤법 표시 같은 부속 요소도 뺀다
    [...p.attributes].filter(a => /^(paraId|textId|rsidR|rsidRDefault|rsidP)$/.test(a.localName)).forEach(a => p.removeAttributeNode(a));
    [...p.children].filter(c => c.localName !== 'pPr' && c.localName !== 'r').forEach(c => c.remove());
  }
  let runs = kids(p, R.run);
  runs.filter(r => hasObject(r)).forEach(r => r.remove());
  runs = kids(p, R.run);
  // 글자 조각이 없는 견본(빈 문단): 문단 끝 글자 모양으로 조각을 하나 만든다
  if (!runs.length) {
    const r = doc.createElementNS(ns, prefix + R.run);
    if (kind === 'hwpx') r.setAttribute('charPrIDRef', '0');
    else { const mark = p.getElementsByTagNameNS(ns, 'rPr')[0]; if (mark) r.append(mark.cloneNode(true)); }
    p.append(r);
    runs = [r];
  }
  // 글자가 있는 조각만 채울 자리로 쓰고, 빈 조각은 지운다(첫 조각은 남김)
  const textRuns = runs.filter(r => paraText(r));
  const slots = textRuns.length ? textRuns : [runs[0]];
  runs.filter(r => !slots.includes(r)).forEach(r => r.remove());
  if (!parts.length) parts = [''];
  parts = parts.map(s => String(s ?? '').replace(/⏎/g, '\n'));
  slots.forEach((r, k) => {
    if (k >= parts.length) { if (k > 0) r.remove(); else setRunText(r, ''); return; }
    let text = k === slots.length - 1 ? parts.slice(k).join('') : parts[k];
    // 견본 조각이 줄바꿈으로 끝나면(예: 굵은 안건 ⏎ 세부 내용) 새 글자도 같은 자리에서 줄을 바꾼다
    if (k < slots.length - 1 && /\n$/.test(paraText(r)) && !/\n$/.test(text) && parts[k + 1]) text += '\n';
    setRunText(r, text);
  });
  function setRunText(r, text) {
    [...r.childNodes].filter(c => !(c.nodeType === 1 && c.localName === 'rPr')).forEach(c => c.remove());
    if (!text) return;
    const pieces = String(text).split('\n');
    if (kind === 'hwpx') {
      const t = doc.createElementNS(ns, prefix + 't');
      pieces.forEach((piece, k) => {
        if (k) t.append(doc.createElementNS(ns, prefix + 'lineBreak'));
        if (piece) t.append(doc.createTextNode(piece));
      });
      r.append(t);
    } else {
      pieces.forEach((piece, k) => {
        if (k) r.append(doc.createElementNS(ns, prefix + 'br'));
        const t = doc.createElementNS(ns, prefix + 't');
        t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
        t.append(doc.createTextNode(piece));
        r.append(t);
      });
    }
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
