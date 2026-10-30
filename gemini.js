// Gemini API 호출 (브라우저에서 직접, 사용자 본인 키 사용)
const API = 'https://generativelanguage.googleapis.com';

class ApiError extends Error {
  constructor(status, message, raw) {
    super(message);
    this.status = status;
    this.raw = raw || '';
  }
  get invalidKey() { return this.status === 400 && /API_KEY_INVALID|API key not valid/i.test(this.raw) || this.status === 401 || this.status === 403; }
  // 새 형식(AQ.) 키를 일부 계정에서 거절하는 경우
  get tokenTypeUnsupported() { return this.status === 401 && /ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(this.raw); }
  get dailyQuota() { return this.status === 429 && /PerDay/i.test(this.raw); }
  get rateLimited() { return this.status === 429 && !this.dailyQuota; }
  get transient() { return this.status >= 500 || this.status === 0; }
  // 이 모델을 쓸 수 없다는 응답 (없는 모델, 이 키에 열리지 않은 모델)
  get modelUnavailable() { return this.status === 404 || (this.status === 400 && /model|not supported|not found/i.test(this.raw) && !/mime|audio format/i.test(this.raw)); }
  // 429 응답이 알려주는 대기 시간(초)
  get retryDelaySec() {
    try {
      const ri = (JSON.parse(this.raw).error.details || []).find(d => /RetryInfo/.test(d['@type'] || ''));
      const s = ri && parseFloat(ri.retryDelay);
      return s > 0 ? s : 0;
    } catch (e) { return 0; }
  }
}

// 응답이 길이 제한에 걸려 잘린 경우
class TooLongError extends Error {}

async function call(key, path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, '인터넷 연결을 확인해 주세요.');
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error.message; } catch (e) {}
    throw new ApiError(res.status, msg, text);
  }
  return { res, data: text ? JSON.parse(text) : {} };
}

// 키 확인 겸 쓸 모델 고르기
// transcribe: 받아쓰기 전용 모델, summary: 회의록 정리(Flash), lite: 대신 쓸 가벼운 모델(Flash-Lite)
async function pickModels(key) {
  const { data } = await call(key, '/v1beta/models?pageSize=1000');
  const names = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''));
  const newest = re => names
    .map(n => ({ n, m: n.match(re) }))
    .filter(x => x.m)
    .sort((a, b) => parseFloat(b.m[1]) - parseFloat(a.m[1]))[0]?.n || null;

  const transcribe = newest(/^gemini-(\d+(?:\.\d+)?)-transcribe$/);
  const summary = names.includes('gemini-flash-latest') ? 'gemini-flash-latest' : newest(/^gemini-(\d+(?:\.\d+)?)-flash$/);
  const lite = names.includes('gemini-flash-lite-latest') ? 'gemini-flash-lite-latest' : newest(/^gemini-(\d+(?:\.\d+)?)-flash-lite$/);
  if (!summary && !lite) throw new ApiError(404, '이 키로 쓸 수 있는 Gemini Flash 모델을 찾지 못했습니다.');
  return { transcribe, summary: summary || lite, lite: lite || summary };
}

function mimeOf(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const map = { m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mp3', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aiff: 'audio/aiff', aif: 'audio/aiff', webm: 'audio/webm' };
  return map[ext] || file.type || 'audio/mp3';
}

// Files API 재개 가능 업로드. onProgress(0~1)
async function uploadFile(key, file, onProgress) {
  const mime = mimeOf(file);
  const { res } = await call(key, '/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': mime,
    },
    body: { file: { display_name: file.name.slice(0, 120) } },
  });
  let url = res.headers.get('x-goog-upload-url');
  if (!url) {
    const id = res.headers.get('x-guploader-uploadid');
    if (!id) throw new ApiError(0, '업로드 주소를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
    url = `${API}/upload/v1beta/files?upload_id=${encodeURIComponent(id)}&upload_protocol=resumable`;
  }

  const uploaded = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
    xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText).file); } catch (e) { reject(new ApiError(0, '업로드 응답을 읽지 못했습니다.')); }
      } else reject(new ApiError(xhr.status, xhr.responseText.slice(0, 300), xhr.responseText));
    };
    xhr.onerror = () => reject(new ApiError(0, '업로드 중 연결이 끊겼습니다.'));
    xhr.send(file);
  });

  let f = uploaded;
  for (let i = 0; f.state === 'PROCESSING' && i < 90; i++) {
    await sleep(2000);
    f = (await call(key, `/v1beta/${f.name}`)).data;
  }
  if (f.state === 'FAILED') throw new ApiError(400, 'Google이 이 녹음 파일을 처리하지 못했습니다. 다른 형식(mp3, wav)으로 바꿔 올려 보세요.');
  return { name: f.name, uri: f.uri, mimeType: f.mimeType || mime };
}

function deleteFile(key, name) {
  return call(key, `/v1beta/${name}`, { method: 'DELETE' }).catch(() => {});
}

// 받아쓰기 전용 모델: 화자 구분 대화록을 돌려준다. [{sec|null, speaker, text}]
async function transcribeAudio(key, model, remote, { onStats } = {}) {
  const t0 = performance.now();
  const { data } = await call(key, `/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    body: {
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: remote.uri, mimeType: remote.mimeType } }] }],
      generationConfig: { audioTranscriptionConfig: { languageCodes: ['ko-KR'], diarization: true } },
    },
  });
  onStats?.({ firstSec: null, totalSec: (performance.now() - t0) / 1000, usage: data.usageMetadata || {}, thinking: '없음' });
  if (data.promptFeedback?.blockReason) throw new ApiError(400, `Gemini가 요청을 거절했습니다 (${data.promptFeedback.blockReason}).`);
  const cand = data.candidates?.[0];
  const parts = cand?.content?.parts || [];
  console.log('[회의록] 받아쓰기 응답 앞부분', JSON.stringify(parts.slice(0, 3)).slice(0, 1500));

  const offset = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const out = [];
  for (const p of parts) {
    const at = p.audioTranscription;
    const words = at?.words || [];
    const text = (p.text || words.map(w => w.word).join(' ')).trim();
    if (!text) continue;
    const speaker = at?.speakerLabel || '';
    const sec = words.length ? offset(words[0].startOffset) : null;
    const prev = out.at(-1);
    if (prev && speaker && prev.speaker === speaker) prev.text += ' ' + text;   // 같은 사람이 이어 말한 조각은 합친다
    else out.push({ sec, speaker: speaker || 'spk_1', text });
  }
  if (!out.length && cand?.finishReason === 'MAX_TOKENS') throw new TooLongError();
  return out;
}

// 추론을 줄이는 설정. fast는 받아쓰기(추론 불필요), low는 회의록 정리(조금만).
// 모델 세대마다 받는 설정이 달라서, 거절되면 다음 후보로 넘어가고 통한 설정을 기억한다.
const THINKING = {
  fast: [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, { thinkingBudget: 0 }, null],
  low: [{ thinkingLevel: 'low' }, { thinkingBudget: 1024 }, null],
};
const thinkIdx = { fast: 0, low: 0 };

// JSON 응답을 받는 생성 요청.
// thinking: 'fast' | 'low', onText(지금까지 받은 글자): 스트리밍, onStats({firstSec,totalSec,usage,thinking}): 측정값
async function generateJSON(key, model, parts, schema, { thinking: mode, onText, onStats } = {}) {
  for (;;) {
    const generationConfig = { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 };
    const used = mode ? thinkIdx[mode] : -1;
    const thinking = mode ? THINKING[mode][used] : null;
    if (thinking) generationConfig.thinkingConfig = thinking;
    const body = { contents: [{ role: 'user', parts }], generationConfig };
    const t0 = performance.now();
    try {
      const { text, finish, first, usage } = onText ? await streamText(key, model, body, onText) : await onceText(key, model, body);
      onStats?.({
        firstSec: first ? (first - t0) / 1000 : null,
        totalSec: (performance.now() - t0) / 1000,
        usage: usage || {},
        thinking: thinking ? String(Object.values(thinking)[0]) : '기본',
      });
      if (finish === 'MAX_TOKENS') throw new TooLongError();
      try { return JSON.parse(text); }
      catch (e) { throw new ApiError(500, `응답을 읽지 못했습니다 (${finish || '빈 응답'}).`); }
    } catch (e) {
      if (thinking && e instanceof ApiError && e.status === 400 && /thinking/i.test(e.raw + e.message)) {
        // 동시에 보낸 다른 요청이 이미 다음 설정으로 넘겼으면 그 설정으로 다시 보내기만 한다
        if (thinkIdx[mode] === used && used < THINKING[mode].length - 1) thinkIdx[mode]++;
        if (thinkIdx[mode] !== used) continue;
      }
      throw e;
    }
  }
}

function textOf(data) {
  if (data.promptFeedback?.blockReason) throw new ApiError(400, `Gemini가 요청을 거절했습니다 (${data.promptFeedback.blockReason}).`);
  const cand = data.candidates?.[0];
  return { text: (cand?.content?.parts || []).filter(p => !p.thought && p.text).map(p => p.text).join(''), finish: cand?.finishReason || '' };
}

async function onceText(key, model, body) {
  const { data } = await call(key, `/v1beta/models/${model}:generateContent`, { method: 'POST', body });
  return { ...textOf(data), usage: data.usageMetadata };
}

// 서버가 보내는 대로 받아 onText로 넘긴다 (SSE)
async function streamText(key, model, body, onText) {
  let res;
  try {
    res = await fetch(`${API}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch (e) { throw new ApiError(0, '인터넷 연결을 확인해 주세요.'); }
  if (!res.ok) {
    const raw = await res.text();
    let msg = raw;
    try { msg = JSON.parse(raw).error.message; } catch (e) {}
    throw new ApiError(res.status, msg, raw);
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', finish = '', first = 0, usage = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = JSON.parse(line.slice(5));
        if (data.error) throw new ApiError(data.error.code || 500, data.error.message || '스트리밍 중 오류', JSON.stringify(data.error));
        const part = textOf(data);
        if (part.text && !first) first = performance.now();
        text += part.text;
        if (part.finish) finish = part.finish;
        if (data.usageMetadata) usage = data.usageMetadata;
        if (part.text) onText(text);
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, '응답을 받는 중 연결이 끊겼습니다.');
  }
  return { text, finish, first, usage };
}

// 일시적 오류·분당 한도는 기다렸다 다시 시도. onWait(초, 이유)
async function withRetry(fn, onWait) {
  let limited = 0, failed = 0;
  for (;;) {
    try { return await fn(); }
    catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.rateLimited && limited++ < 5) {
        await countdown(Math.ceil(e.retryDelaySec || 60), s => onWait(s, '분당 사용 한도에 걸려 Google이 알려준 시간만큼 기다렸다가 이어갑니다'));
        continue;
      }
      if (e.transient && failed++ < 4) { await countdown(5 * 2 ** (failed - 1), s => onWait(s, 'Google 서버가 바빠서 잠시 뒤 다시 시도합니다')); continue; }
      throw e;
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function countdown(sec, tick) {
  for (let s = sec; s > 0; s--) { tick(s); await sleep(1000); }
  tick(0);
}
