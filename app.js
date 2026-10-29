
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// 받아쓰기 전용 모델은 화자 구분을 켜면 요청 하나에 30분까지 받는다. 그보다 길면 브라우저에서 잘라 보낸다.
const PIECE_MAX = 29 * 60;
const PARALLEL = 2;          // 동시에 받아쓰는 조각 수 (무료 키의 분당 한도가 작아서 낮게)

/* ---------- 저장소 (이 브라우저에만) ---------- */
function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
const key = () => load('gemini_key');
function models() { try { return JSON.parse(load('gemini_models')) || null; } catch (e) { return null; } }
async function ensureModels() {
  let m = models();
  if (!m) { m = await pickModels(key()); store('gemini_models', JSON.stringify(m)); }
  return m;
}

/* ---------- 상태 ---------- */
let job = null;     // 진행 중인 회의 하나
let busy = false;

// 녹음을 30분 이하 조각으로 고르게 나눈다. 길이를 모르면 통째로 하나.
function makeRanges(duration) {
  if (!(duration > PIECE_MAX)) return [{ s: 0, e: duration || 0, done: false, segs: [] }];
  const n = Math.ceil(duration / PIECE_MAX), size = duration / n;
  return Array.from({ length: n }, (_, i) => ({ s: Math.round(i * size), e: i === n - 1 ? duration : Math.round((i + 1) * size), done: false, segs: [] }));
}
function newJob(file, duration) {
  return {
    file, duration, ranges: makeRanges(duration), stats: [],
    audio: null,     // 30분 넘는 녹음을 자르려고 브라우저에서 풀어둔 소리
    meta: {
      title: $('#mTitle').value.trim(), date: $('#mDate').value, people: splitPeople($('#mPeople').value), level: $('input[name=level]:checked').value,
      template: loadTemplates().find(t => t.id === $('#tplSelect').value) || null,   // null이면 기본 양식
    },
    segments: [], minutes: null, names: {},
  };
}
const splitPeople = s => s.split(',').map(x => x.trim()).filter(Boolean);

/* ---------- 화면 전환 ---------- */
function go(name) {
  $$('[data-view]').forEach(v => v.hidden = v.dataset.view !== name);
  $$('[data-step]').forEach(b => b.dataset.step === name ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current'));
  window.scrollTo({ top: 0 });
}

/* ---------- 1. 키 ---------- */
function renderKey() {
  const has = !!key();
  $('#keyChip').textContent = has ? 'API 키 저장됨 · 지우기' : 'API 키 없음';
  $('#keyChip').classList.toggle('ok', has);
}
$('#saveKey').addEventListener('click', async () => {
  const v = $('#apiKey').value.trim();
  if (!v) return toast('키를 붙여넣어 주세요');
  if (!v.startsWith('AIza')) return toast('Gemini 키는 AIza로 시작합니다. 복사가 잘 됐는지 확인해 주세요');
  const btn = $('#saveKey');
  btn.disabled = true; btn.textContent = '키 확인 중…';
  try {
    const m = await pickModels(v);
    store('gemini_key', v); store('gemini_models', JSON.stringify(m));
    $('#apiKey').value = '';
    renderKey(); go('upload');
    toast(m.transcribe ? '키를 확인했습니다' : '키를 확인했습니다. 받아쓰기 전용 모델이 없어 Flash-Lite로 받아씁니다');
  } catch (e) {
    toast(e instanceof ApiError && e.invalidKey ? '키가 올바르지 않습니다. AI Studio에서 다시 복사해 주세요' : `키를 확인하지 못했습니다: ${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '저장하고 시작';
  }
});
$('#keyChip').addEventListener('click', () => {
  if (busy) return toast('처리 중에는 키를 바꿀 수 없습니다');
  if (key()) { store('gemini_key', null); store('gemini_models', null); store('gemini_model', null); renderKey(); toast('이 브라우저에서 키를 지웠습니다'); }
  go('key');
});

/* ---------- 2. 업로드 ---------- */
let picked = null;
function pick(f) {
  if (!f) return;
  if (!/^audio\//.test(f.type) && !/\.(m4a|mp3|wav|aac|ogg|oga|flac|aiff?|webm|mp4)$/i.test(f.name)) return toast('녹음 파일(m4a, mp3, wav 등)을 골라주세요');
  picked = f;
  $('#drop').classList.add('has');
  $('#dropTitle').textContent = f.name;
  $('#dropSub').textContent = (f.size / 1048576).toFixed(1) + ' MB · 다른 파일을 고르려면 다시 누르세요';
  $('#startBtn').disabled = false;
}
$('#file').addEventListener('change', e => pick(e.target.files[0]));
const drop = $('#drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); });

function resetUpload() {
  picked = null; $('#file').value = '';
  $('#drop').classList.remove('has');
  $('#dropTitle').textContent = '녹음 파일을 끌어다 놓거나 눌러서 고르세요';
  $('#dropSub').textContent = '휴대폰 녹음(m4a), mp3, wav · 1시간 이상도 됩니다';
  $('#startBtn').disabled = true;
  $('#mTitle').value = ''; $('#mPeople').value = '';
  $('#mDate').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function audioDuration(file) {
  return new Promise(resolve => {
    const a = new Audio(), u = URL.createObjectURL(file);
    const done = d => { URL.revokeObjectURL(u); resolve(isFinite(d) && d > 0 ? d : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 10000);
    a.src = u;
  });
}

$('#startBtn').addEventListener('click', async () => {
  if (!key()) return go('key');
  if (!picked) return;
  $('#startBtn').disabled = true;
  job = newJob(picked, await audioDuration(picked));
  $('#startBtn').disabled = false;
  go('work');
  run();
});

/* ---------- 3. 처리 ---------- */
/* 30분 넘는 녹음 자르기: 브라우저에서 녹음을 풀어(16kHz) 조각마다 wav 파일로 만든다. */
async function decodeAudio(file) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('이 브라우저는 녹음을 자를 수 없습니다');
  const ctx = new Ctx(1, 16000, 16000);
  return await ctx.decodeAudioData(await file.arrayBuffer());
}
function wavPiece(audio, s, e, name) {
  const rate = audio.sampleRate;
  const from = Math.floor(s * rate), to = Math.min(audio.length, Math.ceil(e * rate));
  const n = Math.max(0, to - from);
  const chans = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, t) => [...t].forEach((ch, k) => v.setUint8(o + k, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let k = 0; k < n; k++) {
    let x = 0;
    for (const ch of chans) x += ch[from + k];
    x = Math.max(-1, Math.min(1, x / chans.length));
    v.setInt16(44 + k * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new File([buf], name, { type: 'audio/wav' });
}

function steps() {
  const multi = job.ranges.length > 1;
  const list = multi ? [{ id: 'cut', label: '녹음 자르기', sub: `${job.ranges.length}조각 · 30분 이하씩` }] : [];
  job.ranges.forEach((r, i) => list.push({ id: 'r' + i, label: multi ? `받아쓰기 ${i + 1}/${job.ranges.length}` : '받아쓰기', sub: r.e ? `${clock(r.s)}–${clock(r.e)}` : (job.file.size / 1048576).toFixed(1) + ' MB' }));
  list.push({ id: 'min', label: '회의록 정리', sub: '주제·논의·결론·Task' });
  return list;
}
// running: 지금 진행 중인 단계 id 모음, failed: 멈췄을 때 그 단계들을 빨갛게
function renderProg(running = new Set(), failed = false) {
  const list = steps();
  const doneIds = new Set([job.audio || job.ranges.every(r => r.done) ? 'cut' : null, ...job.ranges.map((r, i) => r.done ? 'r' + i : null), job.minutes ? 'min' : null].filter(Boolean));
  $('#prog').innerHTML = list.map(s => `<li class="${running.has(s.id) ? (failed ? 'fail' : 'run') : doneIds.has(s.id) ? 'done' : ''}" data-id="${s.id}"><i></i><span>${esc(s.label)}</span><small>${esc(s.sub)}</small></li>`).join('');
  $('#barFill').style.width = (list.filter(s => doneIds.has(s.id)).length / list.length * 100) + '%';
}

// 받아쓴 내용 미리보기: 끝난 조각(과 Flash-Lite로 받는 중인 조각)에서 마지막 몇 줄
function renderLive() {
  const lines = job.ranges.flatMap(r => r.done ? r.segs : (r.partial || []));
  const box = $('#live');
  box.hidden = !lines.length;
  $('#liveList').innerHTML = lines.slice(-6).map(s => `<div class="line"><time>${timeLabel(s)}</time><span class="who">${esc(s.who)}</span><p>${esc(s.text)}</p></div>`).join('');
  $('#liveCount').textContent = `${lines.length}줄`;
}
// 요청별 측정값: 첫 글자까지 걸린 시간, 전체 시간, 입력·추론·출력 토큰
function addStat(label, st) {
  const u = st.usage, n = v => (v || 0).toLocaleString();
  const line = `${label} · ${st.firstSec == null ? '' : `첫 글자 ${st.firstSec.toFixed(0)}초 · `}전체 ${st.totalSec.toFixed(0)}초 · 입력 ${n(u.promptTokenCount)} · 추론 ${n(u.thoughtsTokenCount)} · 출력 ${n(u.candidatesTokenCount)} 토큰 · 추론설정 ${st.thinking}`;
  job.stats.push(line);
  console.log('[회의록 측정]', line, u);
  $('#stats').hidden = false;
  $('#statsList').innerHTML = job.stats.map(l => `<li>${esc(l)}</li>`).join('');
}
function setSub(id, text) { const el = $(`#prog [data-id="${id}"] small`); if (el) el.textContent = text; }
function note(text) { $('#workNote').hidden = !text; $('#workNote').textContent = text || ''; }
const onWait = (s, why) => note(s > 0 ? `${why} (${s}초)` : '');

async function run() {
  busy = true;
  renderLive();
  $('#stats').hidden = !job.stats.length;
  $('#statsList').innerHTML = job.stats.map(l => `<li>${esc(l)}</li>`).join('');
  $('#workError').hidden = true;
  $('#workTitle').textContent = '회의록을 만들고 있습니다';
  const running = new Set();
  const started = Date.now();
  const tick = () => { $('#elapsed').textContent = mmss((Date.now() - started) / 1000); };
  tick();
  const elapsed = setInterval(tick, 1000);
  try {
    const m = await ensureModels();
    renderProg(running);

    // 30분 넘는 녹음은 브라우저에서 풀어 조각으로 자른다
    if (job.ranges.length > 1 && !job.audio && job.ranges.some(r => !r.done)) {
      running.add('cut'); renderProg(running);
      try { job.audio = await decodeAudio(job.file); }
      catch (e) { throw new ApiError(400, `브라우저가 이 녹음을 풀지 못해 30분 단위로 자를 수 없습니다. 녹음 앱에서 mp3로 내보내 다시 올려주세요. (${e.message})`); }
      running.delete('cut');
    }

    const todo = job.ranges.map((r, i) => i).filter(i => !job.ranges[i].done);
    await pool(todo, PARALLEL, async i => {
      running.add('r' + i); renderProg(running);
      await transcribeRange(i, m);
      running.delete('r' + i); renderProg(running);
    });
    job.audio = null;   // 풀어둔 소리는 메모리를 많이 차지하므로 받아쓰기가 끝나면 버린다
    if (!job.ranges.some(r => r.segs.length)) throw new ApiError(400, '녹음에서 말소리를 찾지 못했습니다. 파일이 맞는지 확인해 주세요.');

    running.add('min'); renderProg(running);
    const minutes = await summarizeWithFallback(job.meta.level, true);
    applySpeakerMap(minutes.speakerMap || []);
    job.minutes = minutes;
    running.clear(); renderProg(running);
    busy = false;
    showSpeakers();
  } catch (e) {
    busy = false;
    renderProg(running, true);
    showError(e);
  } finally {
    clearInterval(elapsed);
  }
}

// 동시에 limit개까지 돌리고, 하나라도 실패하면 새로 시작하지 않고 그 오류를 낸다
async function pool(items, limit, fn) {
  let next = 0, error = null;
  const lane = async () => {
    while (!error && next < items.length) {
      const it = items[next++];
      try { await fn(it); } catch (e) { error = error || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (error) throw error;
}

// 조각 하나: 올리기 → 받아쓰기 → Google에 올린 파일 지우기
async function transcribeRange(i, m) {
  const r = job.ranges[i];
  const multi = job.ranges.length > 1;
  const file = multi ? wavPiece(job.audio, r.s, r.e, `piece${i + 1}.wav`) : job.file;
  setSub('r' + i, '올리는 중');
  const remote = await withRetry(() => uploadFile(key(), file, p => setSub('r' + i, `올리는 중 ${Math.round(p * 100)}%`)), onWait);
  try {
    setSub('r' + i, '받아쓰는 중');
    const label = `받아쓰기${multi ? ' ' + (i + 1) + '조각' : ''}`;
    let segs = null;
    if (m.transcribe && !job.noTranscribe) {
      try {
        const raw = await withRetry(() => transcribeAudio(key(), m.transcribe, remote, { onStats: st => addStat(`${label} (${m.transcribe})`, st) }), onWait);
        segs = withTimes(raw, r);
      } catch (e) {
        if (!(e instanceof ApiError) || !(e.modelUnavailable || e.dailyQuota)) throw e;
        console.log('[회의록] 받아쓰기 전용 모델을 쓸 수 없어 Flash-Lite로 받아씁니다', e.message);
        job.noTranscribe = true;
        note('받아쓰기 전용 모델을 쓸 수 없어 Flash-Lite로 받아씁니다 (조금 느릴 수 있습니다)');
      }
    }
    if (!segs) segs = await transcribeWithLlm(r, remote, m.lite, st => addStat(`${label} (${m.lite})`, st));
    r.segs = segs; r.done = true; r.partial = null;
    renderLive();
  } finally {
    deleteFile(key(), remote.name);
  }
}

// 받아쓰기 전용 모델 결과에 시각을 붙인다. 시각이 없으면 글자 수 비율로 어림잡는다(≈ 표시).
function withTimes(raw, r) {
  const span = (r.e || job.duration || 0) - r.s;
  const total = raw.reduce((a, x) => a + x.text.length, 0) || 1;
  let acc = 0;
  return raw.map(x => {
    const approx = x.sec == null;
    const t = r.s + (approx ? span * acc / total : x.sec);
    acc += x.text.length;
    return { t, approx: approx && span > 0, noTime: approx && !(span > 0), who: normSpeaker(x.speaker), text: x.text };
  });
}

// 받아쓰기 전용 모델을 못 쓸 때: Flash-Lite에게 지시문으로 받아쓰게 한다
async function transcribeWithLlm(r, remote, liteModel, onStats) {
  const people = job.meta.people.length ? `\n참석자는 ${job.meta.people.join(', ')}입니다. 다만 화자 표기는 이름이 아니라 번호로 하세요.` : '';
  const prompt = `첨부한 회의 녹음을 전부 한국어로 받아써 주세요.
규칙:
- 말하는 사람이 바뀔 때마다 새 항목으로 나눕니다. 한 사람이 1분 넘게 이어 말하면 나눠도 됩니다.
- speaker는 "화자1", "화자2"처럼 번호로 씁니다. 처음 말하는 사람부터 1번입니다.
- 말한 내용을 그대로 적되 "음", "어" 같은 군말과 말 더듬은 뺍니다. 알아듣기 어려운 부분은 (불명확)으로 씁니다.
- time은 첨부한 오디오 시작을 00:00:00으로 한 HH:MM:SS 입니다.${people}`;
  const toSegs = list => list.filter(s => s.text && s.text.trim()).map(s => ({ t: r.s + parseClock(s.time), who: normSpeaker(s.speaker), text: s.text.trim() }));
  const out = await withRetry(() => generateJSON(key(), liteModel, [
    { fileData: { fileUri: remote.uri, mimeType: remote.mimeType } },
    { text: prompt },
  ], TRANSCRIPT_SCHEMA, {
    thinking: 'fast',
    onText: text => {
      const done = [];
      for (const m of text.matchAll(/\{[^{}]*\}/g)) { try { const o = JSON.parse(m[0]); if (o.text && o.time) done.push(o); } catch (e) {} }
      r.partial = toSegs(done); renderLive();
    },
    onStats,
  }), onWait);
  return toSegs(out.segments || []);
}

const TRANSCRIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    segments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { time: { type: 'STRING' }, speaker: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['time', 'speaker', 'text'] } },
  },
  required: ['segments'],
};

const MINUTES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    topic: { type: 'STRING' },
    agendas: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, points: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['title', 'points'] } },
    conclusions: { type: 'ARRAY', items: { type: 'STRING' } },
    undecided: { type: 'ARRAY', items: { type: 'STRING' } },
    tasks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, owner: { type: 'STRING' }, due: { type: 'STRING' } }, required: ['text', 'owner', 'due'] } },
  },
  required: ['title', 'topic', 'agendas', 'conclusions', 'undecided', 'tasks'],
};

// 정리 수준별 지시. 가벼운 모델은 분량을 정해주지 않으면 짧게 줄이므로, 회의 길이(분)에 비례한 최소 항목 수를 준다.
const LEVELS = {
  '간단': mins => `안건마다 주요 의견과 그 근거를 points 2~4개로 씁니다. 각 항목은 1~2문장이고, 누구의 의견인지 화자 표기를 넣습니다. 전체 points는 ${Math.max(4, Math.round(mins * 0.3))}개 안팎입니다.`,
  '보통': mins => `안건마다 논의 흐름을 순서대로 씁니다. 누가 어떤 의견을 냈고, 어떤 반론과 근거가 오갔고, 어떻게 결론에 이르렀는지 담습니다. 각 항목은 1~3문장이고, 언급된 숫자·일정·이름·대안은 그대로 남깁니다. 전체 points는 최소 ${Math.max(8, Math.round(mins * 0.7))}개입니다.`,
  '자세히': mins => `대화록을 읽지 않은 사람이 회의 내용을 거의 다 알 수 있을 만큼 촘촘하게 씁니다. 안건을 잘게 나누고, 안건마다 발언 순서를 따라 각 발언자의 주장, 근거, 예시, 질문과 답변, 반론, 의견이 바뀐 과정, 결론에 이른 이유를 빠짐없이 적습니다. 언급된 숫자·일정·이름·사례·대안·우려 사항은 모두 남깁니다. 각 항목은 2~3문장입니다. 전체 points는 최소 ${Math.max(15, Math.round(mins * 1.5))}개이며, 내용이 더 있으면 더 써도 됩니다. 요약하느라 내용을 빼지 마세요.`,
};
// 회의 길이(분). 녹음 길이를 모르면 대화록 글자 수로 어림한다(한국어 말 1분 ≈ 300자).
function meetingMinutes(text) { return job.duration > 0 ? job.duration / 60 : text.length / 300; }

// 조각마다 따로 매긴 화자 번호(2조각·화자1)를 회의 전체 번호(화자N)로 바꾼다
const localLabel = (i, who) => `${i + 1}조각·${who}`;
function applySpeakerMap(map) {
  if (job.ranges.length === 1) { job.segments = job.ranges[0].segs.slice(); return; }
  const dict = {};
  map.forEach(m => { if (m.local && m.global) dict[m.local.replace(/\s/g, '')] = normSpeaker(m.global); });
  let extra = Math.max(0, ...Object.values(dict).map(speakerNum).filter(n => n < 999));
  job.segments = job.ranges.flatMap((r, i) => r.segs.map(s => {
    const k = localLabel(i, s.who);
    if (!dict[k]) dict[k] = '화자' + (++extra);   // 짝을 못 찾은 화자는 새 번호
    return { ...s, who: dict[k] };
  }));
}

// 회의록 정리는 Flash-Lite로 한다. Flash는 답하기 전 대기가 길고(실측 5분 이상) 무료 한도도 하루 20번이라,
// Flash-Lite 하루 한도에 걸렸을 때만 Flash로 다시 한다.
async function summarizeWithFallback(level, first, onWaitFn = onWait, onProgress) {
  const m = await ensureModels();
  const [primary, backup] = [m.lite || m.summary, m.summary];
  try {
    return await withRetry(() => summarize(level, first, primary, onProgress), onWaitFn);
  } catch (e) {
    if (!(e instanceof ApiError) || !(e.dailyQuota || e.modelUnavailable) || primary === backup) throw e;
    onWaitFn(1, `${primary}의 오늘 한도를 다 써서 ${backup}로 정리합니다`);
    return await withRetry(() => summarize(level, first, backup, onProgress), onWaitFn);
  }
}

// first: 받아쓰기 직후 첫 정리. 여러 조각이면 화자 번호 맞추기도 함께 시킨다.
function summarize(level, first, useModel, onProgress) {
  const multi = first && job.ranges.length > 1;
  const line = (s, who) => `[${timeLabel(s)}] ${who}: ${s.text}`;
  // 첫 정리 때는 job.segments가 아직 비어 있으므로(화자 번호를 맞춘 뒤 채움) 조각별 받아쓰기에서 바로 만든다
  const transcript = multi
    ? job.ranges.flatMap((r, i) => r.segs.map(s => line(s, localLabel(i, s.who)))).join('\n')
    : (first ? job.ranges.flatMap(r => r.segs) : job.segments).map(s => line(s, s.who)).join('\n');
  if (!transcript.trim()) throw new ApiError(400, '정리할 대화록이 비어 있습니다.');
  const mapRule = multi ? `
- 이 대화록은 녹음을 조각으로 나눠 받아쓴 것이라 화자 번호가 조각마다 따로 매겨져 있습니다(예: 2조각·화자1). 대화 흐름(이름을 부르는 말, 맡은 역할, 말투, 조각 경계에서 이어지는 발언)을 보고 같은 사람끼리 묶어 회의 전체 번호(화자1, 화자2 …)를 붙이세요.
- speakerMap에 모든 조각 화자의 대응을 빠짐없이 적습니다. local은 "2조각·화자1" 표기 그대로, global은 "화자1" 형식입니다.
- 회의록 본문에서 사람을 가리킬 때는 회의 전체 번호(화자1, 화자2 …)를 씁니다.
` : '';
  const date = job.meta.date ? `회의 일시는 ${job.meta.date.replace('T', ' ')}입니다.` : '';
  const mapSchema = { speakerMap: { type: 'ARRAY', items: { type: 'OBJECT', properties: { local: { type: 'STRING' }, global: { type: 'STRING' } }, required: ['local', 'global'] } } };
  const opts = {
    thinking: 'low',
    onText: text => { setSub('min', `작성 중 · ${text.length.toLocaleString()}자`); onProgress?.(text.length); },
    onStats: st => addStat(`${first ? '회의록 정리' : `다시 정리(${level})`} (${useModel})`, st),
  };

  // 사용자 양식: 양식의 구조를 그대로 지킨 마크다운 한 덩어리로 받는다
  const tpl = job.meta.template;
  if (tpl) {
    const people = job.meta.people.length ? `참석자는 ${job.meta.people.join(', ')}입니다.` : '참석자는 대화록의 화자들입니다.';
    const tplPrompt = `아래 [회의록 양식]에 맞춰 회의 대화록으로 회의록을 작성하세요. 회의록은 markdown 필드에 마크다운으로 씁니다.${mapRule}
- 양식의 제목·소제목·항목 이름과 순서를 그대로 지킵니다. 양식에 없는 큰 제목을 새로 만들지 않습니다. 양식에 맞는 자리가 없는 중요한 내용은 가장 가까운 항목에 넣습니다.
- 양식 안의 괄호 설명, 예시 문구, 빈칸 표시(○○, ___, "내용" 같은 자리 표시)는 그 칸에 무엇을 쓸지 알려주는 지침입니다. 실제 내용으로 바꿔 쓰고 지침 문구는 남기지 않습니다.
- 양식이 표인 곳은 마크다운 표로, 목록인 곳은 목록으로, 체크박스인 곳은 "- [ ]"로 씁니다. 표의 행 수는 내용에 맞게 늘리거나 줄입니다.
- 대화록에서 확인할 수 없는 항목(장소 등)은 지어내지 말고 "-"로 둡니다.
- 사람을 가리킬 때는 화자 표기(화자1, 화자2 …)를 그대로 씁니다.
- 논의 내용 분량: ${LEVELS[level](meetingMinutes(transcript)).replace(/points/g, '논의 항목')}
- 할 일은 회의 중에 누군가 하겠다고 했거나 누구에게 맡긴 일만 씁니다. ${date ? '"다음 주 화요일"처럼 상대적인 기한은 회의 일시를 기준으로 MM/DD로 바꾸고 괄호 안에 원래 표현을 남깁니다.' : ''}
- title: ${job.meta.title ? `"${job.meta.title}" 를 그대로 씁니다.` : '회의 내용을 나타내는 짧은 제목입니다.'} 양식에 회의 제목 자리가 있으면 그 자리에도 씁니다.
${date} ${people}

[회의록 양식]
<<<
${tpl.body}
>>>

대화록:
${transcript}`;
    const schema = { type: 'OBJECT', properties: { title: { type: 'STRING' }, markdown: { type: 'STRING' }, ...(multi ? mapSchema : {}) }, required: ['title', 'markdown', ...(multi ? ['speakerMap'] : [])] };
    return generateJSON(key(), useModel, [{ text: tplPrompt }], schema, opts);
  }

  const prompt = `아래 회의 대화록으로 회의록을 작성하세요.${mapRule}
- 사람을 가리킬 때는 화자 표기(화자1, 화자2 …)를 그대로 씁니다.
- title: ${job.meta.title ? `"${job.meta.title}" 를 그대로 씁니다.` : '회의 내용을 나타내는 짧은 제목입니다.'}
- topic: 회의의 목적과 주제를 ${level === '간단' ? '1~2' : '2~3'}문장으로 씁니다.
- agendas: 다룬 안건별로 나눕니다. ${LEVELS[level](meetingMinutes(transcript))}
- conclusions: 회의에서 합의되거나 결정된 사항만 씁니다. 추측해서 만들지 않습니다.
- undecided: 결론이 나지 않았거나 다음으로 미룬 안건입니다. 없으면 빈 배열입니다.
- tasks: 회의 중에 누군가 하겠다고 했거나 누구에게 맡긴 일만 넣습니다. owner는 화자 표기, 맡은 사람이 분명하지 않으면 빈 문자열입니다. due는 말한 기한이고, 없으면 빈 문자열입니다. ${date ? '"다음 주 화요일"처럼 상대적인 기한은 회의 일시를 기준으로 MM/DD로 바꾸고 괄호 안에 원래 표현을 남깁니다.' : ''}
${date}

대화록:
${transcript}`;
  const schema = multi ? {
    ...MINUTES_SCHEMA,
    properties: { ...MINUTES_SCHEMA.properties, ...mapSchema },
    required: [...MINUTES_SCHEMA.required, 'speakerMap'],
  } : MINUTES_SCHEMA;
  return generateJSON(key(), useModel, [{ text: prompt }], schema, opts);
}

function showError(e) {
  let msg;
  if (e instanceof ApiError && e.dailyQuota) msg = '오늘 무료 사용량을 다 썼습니다. 한국 시간 오후 4~5시에 다시 채워집니다.\n이 창을 닫지 않으면 지금까지 받아쓴 내용은 남아 있고, 그때 [이어서 다시 시도]를 누르면 이어서 진행합니다.';
  else if (e instanceof ApiError && e.invalidKey) msg = 'API 키가 올바르지 않거나 권한이 없습니다. 상단의 키 표시를 눌러 키를 다시 넣어주세요.';
  else if (e instanceof ApiError && e.status === 400 && /mime|unsupported/i.test(e.raw)) msg = 'Gemini가 이 파일 형식을 받지 않았습니다. 녹음 앱에서 mp3나 wav로 내보내 다시 올려주세요.';
  else msg = `처리하지 못했습니다: ${e.message || e}`;
  $('#workTitle').textContent = '중간에 멈췄습니다';
  $('#workErrorMsg').textContent = msg;
  $('#workError').hidden = false;
  note('');
}
$('#retryBtn').addEventListener('click', () => { if (!busy) run(); });
$('#restartBtn').addEventListener('click', () => { job = null; resetUpload(); go('upload'); });

/* ---------- 4. 화자 ---------- */
function speakerStats() {
  const segs = job.segments, stats = {};
  segs.forEach((s, i) => {
    const next = segs[i + 1];
    const dur = Math.min(Math.max((next ? next.t : job.duration || s.t + 10) - s.t, 0), 90) || s.text.length / 5;
    const st = stats[s.who] ||= { sec: 0, quote: '' };
    st.sec += dur;
    if (s.text.length > st.quote.length && s.text.length > 15) st.quote = s.text;
  });
  return Object.entries(stats).sort((a, b) => speakerNum(a[0]) - speakerNum(b[0]));
}
function showSpeakers() {
  const list = speakerStats();
  $('#spkLead').textContent = `목소리로 ${list.length}명을 구분했습니다. 대표 발언을 보고 이름을 정해주세요. 같은 사람이 둘로 나뉘었으면 같은 이름을 넣으면 합쳐집니다. 건너뛰면 화자1, 화자2로 남습니다.`;
  $('#spkList').innerHTML = list.map(([id, st], i) => `
    <div class="spk">
      <div class="tag">${esc(id)}<small>발언 약 ${Math.max(1, Math.round(st.sec / 60))}분</small></div>
      <div class="field">
        <input class="input" id="spk${i}" data-id="${esc(id)}" list="peopleList" value="${esc(job.names[id] || '')}" placeholder="이름" aria-label="${esc(id)} 이름">
        <p class="quote">“${esc(st.quote.length > 110 ? st.quote.slice(0, 110) + '…' : st.quote)}”</p>
      </div>
    </div>`).join('') + `<datalist id="peopleList">${job.meta.people.map(p => `<option value="${esc(p)}">`).join('')}</datalist>`;
  go('speaker');
}
$('#applyNames').addEventListener('click', () => {
  job.names = {};
  $$('#spkList input').forEach(inp => { if (inp.value.trim()) job.names[inp.dataset.id] = inp.value.trim(); });
  showResult();
});
$('#skipNames').addEventListener('click', () => { job.names = {}; showResult(); });

/* ---------- 5. 회의록 ---------- */
const speakerName = id => job.names[normSpeaker(id)] || id;
// "화자1이" → "김민지가"처럼 이름으로 바꾸면서 받침에 맞게 조사도 고친다
const JOSA = { '이': ['이', '가'], '가': ['이', '가'], '은': ['은', '는'], '는': ['은', '는'], '을': ['을', '를'], '를': ['을', '를'], '과': ['과', '와'], '와': ['과', '와'], '으로': ['으로', '로'], '로': ['으로', '로'] };
function hasBatchim(word) {
  const c = word.charCodeAt(word.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 !== 0;
  return /[0-9lmnr]$/i.test(word);
}
const sub = text => String(text || '').replace(/화자\s?(\d+)(으로|이|가|은|는|을|를|과|와|로)?/g, (m, n, josa) => {
  const nm = job.names['화자' + n];
  if (!nm) return m;
  if (!josa) return nm;
  const [withB, withoutB] = JOSA[josa];
  return nm + (hasBatchim(nm) ? withB : withoutB);
});
let tasks = [];
let dirty = false;

function showResult() {
  const m = job.minutes;
  $('#docTitle').value = sub(m.title) || job.meta.title || '회의록';
  $('#pDate').textContent = formatDate(job.meta.date, job.duration);
  const speakersInOrder = [...new Set(job.segments.map(s => s.who))].sort((a, b) => speakerNum(a) - speakerNum(b));
  $('#pPeople').textContent = job.meta.people.length ? job.meta.people.join(', ') : speakersInOrder.map(speakerName).join(', ');
  renderMinutes(m);
  renderTranscript();
  selectTab('minutes');
  go('result');
}
function renderMinutes(m) {
  $('#pLevel').textContent = job.meta.level;
  $('#pTemplate').textContent = job.meta.template ? job.meta.template.name : '기본 양식';
  $('#redoLevel').value = job.meta.level;
  if (m.markdown != null) {   // 사용자 양식: 양식 모양 그대로 그려서 그 자리에서 고치게 한다
    $('#customDoc').innerHTML = mdToHtml(sub(m.markdown));
    dirty = false; resetRedo();
    return;
  }
  $('#topic').textContent = sub(m.topic);
  const disc = $('#discussion');
  disc.replaceChildren();
  (m.agendas || []).forEach(a => {
    if (a.title) { const h = document.createElement('h4'); h.textContent = sub(a.title); disc.append(h); }
    disc.append(listOf(a.points));
  });
  $('#conclusion').replaceChildren(...listOf(m.conclusions).children);
  const und = m.undecided || [];
  $('#undecidedWrap').hidden = !und.length;
  $('#undecided').replaceChildren(...listOf(und).children);
  tasks = (m.tasks || []).map(t => ({ done: false, text: sub(t.text), who: t.owner ? speakerName(t.owner) : '', due: t.due || '' }));
  renderTasks();
  dirty = false; resetRedo();
}
function listOf(items) {
  const ul = document.createElement('ul');
  (items || []).forEach(t => { const li = document.createElement('li'); li.textContent = sub(t); ul.append(li); });
  return ul;
}

function renderTasks() {
  $('#taskBody').innerHTML = tasks.map((t, i) => `<tr>
    <td><input type="checkbox" id="td${i}" ${t.done ? 'checked' : ''} aria-label="완료"></td>
    <td><input class="cell" id="tt${i}" value="${esc(t.text)}" aria-label="할 일"></td>
    <td><input class="cell" id="tw${i}" value="${esc(t.who)}" aria-label="담당"></td>
    <td><input class="cell" id="tu${i}" value="${esc(t.due)}" aria-label="기한"></td>
    <td><button class="del" data-i="${i}" type="button" aria-label="삭제">×</button></td></tr>`).join('');
  tasks.forEach((t, i) => {
    $('#td' + i).onchange = e => { t.done = e.target.checked; };
    $('#tt' + i).oninput = e => { t.text = e.target.value; };
    $('#tw' + i).oninput = e => { t.who = e.target.value; };
    $('#tu' + i).oninput = e => { t.due = e.target.value; };
  });
  $$('.del').forEach(b => b.onclick = () => { tasks.splice(+b.dataset.i, 1); dirty = true; renderTasks(); });
}
$('#addTask').addEventListener('click', () => { tasks.push({ done: false, text: '', who: '', due: '' }); renderTasks(); $('#tt' + (tasks.length - 1)).focus(); });
$('#minutes').addEventListener('input', () => { dirty = true; });

function renderTranscript() {
  $('#transcriptList').innerHTML = job.segments.map(s =>
    `<div class="line"><time>${timeLabel(s)}</time><span class="who">${esc(speakerName(s.who))}</span><p>${esc(s.text)}</p></div>`).join('');
}

/* 다시 정리 */
let redoArmed = false;
function resetRedo() { redoArmed = false; $('#redo').textContent = '이 수준으로 다시 정리'; $('#redo').disabled = false; }
$('#redo').addEventListener('click', async () => {
  if (dirty && !redoArmed) { redoArmed = true; $('#redo').textContent = '고친 내용이 사라집니다. 한 번 더 누르면 진행'; return; }
  const level = $('#redoLevel').value;
  const btn = $('#redo'), started = Date.now();
  let chars = 0, waitMsg = '';
  const show = () => {
    const sec = Math.floor((Date.now() - started) / 1000);
    btn.textContent = waitMsg || `다시 정리하는 중 · ${sec}초${chars ? ` · ${chars.toLocaleString()}자 받음` : ' · 응답 기다리는 중'}`;
  };
  btn.disabled = true; show();
  const timer = setInterval(show, 1000);
  busy = true;
  try {
    const m = await summarizeWithFallback(level, false,
      (s, why) => { waitMsg = s ? `${why} (${s}초)` : ''; show(); },
      n => { chars = n; show(); });
    job.minutes = m; job.meta.level = level;
    renderMinutes(m);
    toast(`${level} 수준으로 다시 정리했습니다 (${Math.round((Date.now() - started) / 1000)}초)`);
  } catch (e) {
    toast(e instanceof ApiError && e.dailyQuota ? '오늘 무료 사용량을 다 썼습니다. 오후 4~5시 이후에 다시 해주세요' : `다시 정리하지 못했습니다: ${e.message}`);
    resetRedo();
  } finally { clearInterval(timer); busy = false; }
});

/* 탭 */
const customMode = () => job?.minutes?.markdown != null;
function selectTab(t) {
  $$('[data-tab]').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === t));
  $('#minutes').hidden = t !== 'minutes' || customMode();
  $('#customDoc').hidden = t !== 'minutes' || !customMode();
  $('#transcript').hidden = t !== 'transcript';
}
$$('[data-tab]').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));

/* 복사 */
function bullets(el) { return [...el.querySelectorAll('li')].map(li => '- ' + li.textContent.trim()).filter(l => l !== '- ').join('\n'); }
function discussionMd() {
  const out = [];
  [...$('#discussion').children].forEach(el => {
    if (/^H\d$/.test(el.tagName)) out.push(`\n### ${el.textContent.trim()}`);
    else if (el.tagName === 'UL' || el.tagName === 'OL') out.push(bullets(el));
    else if (el.textContent.trim()) out.push(el.textContent.trim());
  });
  if (!out.length && $('#discussion').textContent.trim()) out.push($('#discussion').textContent.trim());
  return out.join('\n').trim();
}
function minutesMd(notion) {
  const live = tasks.filter(t => t.text.trim());
  const taskLines = !live.length ? '- 없음' : notion
    ? live.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}${t.who ? ` · ${t.who}` : ''}${t.due ? ` · ${t.due}` : ''}`).join('\n')
    : ['| 완료 | 할 일 | 담당 | 기한 |', '|---|---|---|---|', ...live.map(t => `| ${t.done ? '✓' : ''} | ${cellMd(t.text)} | ${cellMd(t.who)} | ${cellMd(t.due)} |`)].join('\n');
  const und = bullets($('#undecided'));
  return `# ${$('#docTitle').value.trim()}

- 일시: ${$('#pDate').textContent.trim()}
- 참석자: ${$('#pPeople').textContent.trim()}

## 회의 주제
> ${$('#topic').textContent.trim()}

## 논의 과정
${discussionMd()}

## 결론
${bullets($('#conclusion')) || '- 없음'}
${!$('#undecidedWrap').hidden && und ? `\n### 결론 나지 않은 것\n${und}\n` : ''}
## Task
${taskLines}
`;
}
const cellMd = s => s.replace(/\|/g, '\\|');
function transcriptMd() {
  return `# ${$('#docTitle').value.trim()} 대화록\n\n` + job.segments.map(s => `**${speakerName(s.who)}**${s.noTime ? '' : ` \`${timeLabel(s)}\``}  \n${s.text}\n`).join('\n');
}
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    toast(ok ? msg : '복사하지 못했습니다. 브라우저 권한을 확인해 주세요');
  }
}
const onTranscript = () => !$('#transcript').hidden;
const docMd = notion => onTranscript() ? transcriptMd() : customMode() ? htmlToMd($('#customDoc')) : minutesMd(notion);
$('#copyNotion').addEventListener('click', () => copy(docMd(true), '복사했습니다. 노션 페이지에 붙여넣으세요'));
$('#copyMd').addEventListener('click', () => copy(docMd(false), '마크다운으로 복사했습니다'));
$('#customDoc').addEventListener('input', () => { dirty = true; });
$('#newBtn').addEventListener('click', () => { job = null; resetUpload(); go('upload'); });

/* ---------- 공용 ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}
// 대화록 시각 표시: 어림값이면 ≈, 모르면 빈칸
function timeLabel(s) { return s.noTime ? '' : (s.approx ? '≈' : '') + clock(s.t); }
function mmss(sec) { sec = Math.floor(sec); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function parseClock(t) {
  const p = String(t || '').trim().split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return p.reduce((acc, n) => acc * 60 + n, 0);
}
function normSpeaker(s) {
  const m = String(s || '').match(/(\d+)/);
  return m ? '화자' + Number(m[1]) : (String(s || '').trim() || '화자?');
}
const speakerNum = id => Number((id.match(/\d+/) || [999])[0]);
function formatDate(v, dur) {
  if (!v) return '';
  const d = new Date(v);
  const day = '일월화수목금토'[d.getDay()];
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  let len = '';
  if (dur) { const mins = Math.round(dur / 60), h = Math.floor(mins / 60); len = ` · ${h ? h + '시간 ' : ''}${mins % 60}분`; }
  return `${ymd} (${day}) ${hm}${len}`;
}
let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 3200); }

window.addEventListener('beforeunload', e => { if (busy || (job && job.segments.length)) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- 회의록 양식 ---------- */
const PUBLIC_URL = 'https://gyugyu98.github.io/meeting-minutes/';
let editingId = null, deleteArmed = false;
function renderTplSelect() {
  const list = loadTemplates(), sel = selectedTemplateId();
  $('#tplSelect').innerHTML = `<option value="default">기본 양식 (주제·논의·결론·Task)</option>` +
    list.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  $('#tplSelect').value = list.some(t => t.id === sel) ? sel : 'default';
  const custom = $('#tplSelect').value !== 'default';
  $('#tplEdit').disabled = $('#tplShare').disabled = !custom;
  $('#tplHint').textContent = custom
    ? '이 양식의 제목·항목·표 모양 그대로 채웁니다. 정리 수준은 논의 내용의 분량에 적용됩니다.'
    : '내 회의록 양식을 쓰려면 [새 양식]을 눌러 등록하세요. 한글(hwp)·워드 파일에서 불러올 수 있습니다.';
}
$('#tplSelect').addEventListener('change', () => { selectTemplateId($('#tplSelect').value); renderTplSelect(); });
function openEditor(t) {
  editingId = t ? t.id : null;
  deleteArmed = false;
  $('#tplEditorTitle').textContent = t ? '양식 편집' : '새 양식';
  $('#tplName').value = t ? t.name : '';
  $('#tplBody').value = t ? t.body : '';
  $('#tplDelete').hidden = !t;
  $('#tplDelete').textContent = '이 양식 삭제';
  $('#tplEditor').hidden = false;
  $('#tplName').focus();
}
$('#tplNew').addEventListener('click', () => openEditor(null));
$('#tplEdit').addEventListener('click', () => openEditor(loadTemplates().find(t => t.id === $('#tplSelect').value)));
$('#tplCancel').addEventListener('click', () => { $('#tplEditor').hidden = true; });
$('#tplSave').addEventListener('click', () => {
  const name = $('#tplName').value.trim(), body = $('#tplBody').value.trim();
  if (!name) return toast('양식 이름을 넣어주세요');
  if (!body) return toast('양식 내용을 넣어주세요');
  const saved = upsertTemplate({ id: editingId || undefined, name, body });
  selectTemplateId(saved.id); renderTplSelect();
  $('#tplEditor').hidden = true;
  toast(`'${name}' 양식을 저장했습니다`);
});
$('#tplDelete').addEventListener('click', () => {
  if (!deleteArmed) { deleteArmed = true; $('#tplDelete').textContent = '한 번 더 누르면 삭제됩니다'; return; }
  deleteTemplate(editingId); selectTemplateId('default'); renderTplSelect();
  $('#tplEditor').hidden = true;
  toast('양식을 삭제했습니다');
});
$('#tplFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  toast(`${f.name} 읽는 중…`);
  try {
    const md = await templateFromFile(f);
    if (!md) return toast('파일에서 글자를 찾지 못했습니다');
    $('#tplBody').value = md;
    if (!$('#tplName').value.trim()) $('#tplName').value = f.name.replace(/\.[^.]+$/, '').slice(0, 60);
    toast('불러왔습니다. 필요한 부분을 고친 뒤 저장하세요');
  } catch (err) {
    console.log('[회의록] 양식 파일 읽기 실패', err);
    toast(`파일을 읽지 못했습니다: ${err.message}. 내용을 복사해 붙여넣어 주세요`);
  }
});
$('#tplShare').addEventListener('click', async () => {
  const t = loadTemplates().find(x => x.id === $('#tplSelect').value);
  if (!t) return;
  const base = location.protocol.startsWith('http') ? location.origin + location.pathname : PUBLIC_URL;
  copy(base + '#tpl=' + await encodeTemplate(t), `'${t.name}' 양식 링크를 복사했습니다. 받은 사람이 열면 양식이 추가됩니다`);
});
// 양식 공유 링크로 열었으면 그 양식을 추가하고 고른다
async function importTemplateFromLink() {
  const m = location.hash.match(/^#tpl=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  try {
    const t = upsertTemplate(await decodeTemplate(m[1]));
    selectTemplateId(t.id); renderTplSelect();
    toast(`'${t.name}' 양식을 추가했습니다`);
  } catch (e) { toast('양식 링크를 읽지 못했습니다'); }
  history.replaceState(null, '', location.pathname + location.search);
}

/* ---------- 시작 ---------- */
resetUpload();
renderKey();
renderTplSelect();
importTemplateFromLink();
go(key() ? 'upload' : 'key');
