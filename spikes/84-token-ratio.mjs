#!/usr/bin/env node
// Spike #84: measure how Jev counts input tokens, and what its input limit covers.
//
// Plain Node 24 ES module, zero dependencies. NOT Apps Script: `spikes/run.mjs push`
// uploads only `*.js`. It makes live, billed Jev requests, so it only ever runs by hand
// (never in CI). Synthetic text only: no real mail, names or addresses.
//
//   node spikes/84-token-ratio.mjs --env /path/to/.env [--cache <file>] [--phase <name>] [--max <n>]
//
// --env    a .env file holding JEV_API_KEY (used only if JEV_API_KEY isn't set). Default: the
//          repo root's .env.
// --cache  a JSON file of results already measured (default: spikes/84-token-ratio.results.json).
//          A request whose key is in the cache isn't sent again, so a rerun after an
//          interruption continues where it stopped, and a full rerun makes no live calls.
//          Delete the file (or pass --cache to a new path) to measure afresh.
// --phase  slopes | limits | all (default all). The limit phase's probes were sized from the
//          slope phase's results and from earlier limit probes (see spikes/84-token-ratio.md).
// --max    the cap on live requests counted across all runs in the cache (default 100).
//
// The key is never printed or logged, and request headers are never echoed. Output: one
// JSON object on stdout. Progress (one line per request, with the running token total) goes
// to stderr.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const PRICE_PER_MTOK = 0.042;

// ---------------------------------------------------------------------------------------------
// Arguments and key
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    env: resolve(HERE, '..', '.env'),
    cache: resolve(HERE, '84-token-ratio.results.json'),
    phase: 'all',
    max: 100,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--env') (out.env = resolve(v)), i++;
    else if (a === '--cache') (out.cache = resolve(v)), i++;
    else if (a === '--phase') (out.phase = v), i++;
    else if (a === '--max') (out.max = Number(v)), i++;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function readKey(envFile) {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  if (!existsSync(envFile)) return undefined;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?JEV_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[1];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Deterministic synthetic text
// ---------------------------------------------------------------------------------------------

function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

const WORDS = (
  'the of and to in is that for it as was with be by on not he this are or his from at which ' +
  'but have an they you were her she there been one all we their has would when if so no will ' +
  'more about can said them some could into only time new other then my also any these may ' +
  'meeting schedule invoice project garden weather morning letter customer delivery order ' +
  'account report question answer family holiday travel office library kitchen window river ' +
  'mountain village station bicycle coffee dinner friend neighbour summer autumn winter spring ' +
  'quickly carefully usually probably certainly perhaps tomorrow yesterday tonight together ' +
  'remember forward suggest confirm arrange prepare discuss receive return deliver improve ' +
  'important available possible different general particular national public private simple'
).split(' ');

function prose(r, targetUnits) {
  let out = '';
  while (out.length < targetUnits) {
    const n = 8 + Math.floor(r() * 14);
    const w = [];
    for (let i = 0; i < n; i++) w.push(pick(r, WORDS));
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    let s = w.join(' ') + pick(r, ['.', '.', '.', '?', '!']);
    if (r() < 0.2) s += '\n\n';
    else s += ' ';
    out += s;
  }
  return out.slice(0, targetUnits);
}

const HEX = '0123456789abcdef';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const tok = (r, n, chars) => Array.from({ length: n }, () => pick(r, chars)).join('');

function marketing(r, targetUnits) {
  const hosts = ['shop.example.com', 'click.example.org', 'links.news.example.com', 'img.example.org'];
  const items = ['Wireless Headphones', 'Garden Chair', 'Coffee Grinder', 'Running Shoes', 'Desk Lamp'];
  let out = '';
  while (out.length < targetUnits) {
    const url =
      `https://${pick(r, hosts)}/c/${tok(r, 24, ALNUM)}?utm_source=newsletter&utm_medium=email` +
      `&utm_campaign=fall_sale_${tok(r, 6, HEX)}&utm_content=${tok(r, 10, ALNUM)}&mc_eid=${tok(r, 10, HEX)}` +
      `&redirect=https%3A%2F%2Fshop.example.com%2Fp%2F${tok(r, 8, HEX)}`;
    const price = `$${(5 + Math.floor(r() * 400))}.${String(Math.floor(r() * 100)).padStart(2, '0')}`;
    out += `${pick(r, items)} - now ${price} (was $${(410 + Math.floor(r() * 90))}.00). SAVE ${10 + Math.floor(r() * 60)}%!\n`;
    out += `Shop now: ${url}\n`;
    if (r() < 0.25) {
      out +=
        `\nYou received this email because you subscribed at example.com. Unsubscribe: ` +
        `https://${pick(r, hosts)}/unsubscribe?u=${tok(r, 16, HEX)}&id=${tok(r, 10, HEX)}&e=${tok(r, 12, ALNUM)}\n` +
        `Example Shop Ltd, 1 Example Street, Exampletown EX1 2MP\n\n`;
    }
  }
  return out.slice(0, targetUnits);
}

function escapeHeavy(r, targetUnits) {
  const lines = [
    () => `\t"key_${tok(r, 3, HEX)}": "value \\"${pick(r, WORDS)}\\" here",`,
    () => `C:\\Users\\example\\Documents\\${pick(r, WORDS)}\\${pick(r, WORDS)}.txt`,
    () => `She said, "${pick(r, WORDS)} ${pick(r, WORDS)}," and he replied "${pick(r, WORDS)}!"`,
    () => `regex: ^\\d{3}-\\w+\\s*"${pick(r, WORDS)}"\\\\$`,
    () => `\t\tif (x == "${pick(r, WORDS)}") {\n\t\t\treturn "\\t\\n";\n\t\t}`,
    () => `"${pick(r, WORDS)}"\t"${pick(r, WORDS)}"\t"${pick(r, WORDS)}"`,
  ];
  let out = '';
  while (out.length < targetUnits) out += pick(r, lines)() + '\n';
  return out.slice(0, targetUnits);
}

const CJK = [
  '会议安排在明天上午十点，请准时参加。',
  '您的订单已发货，预计三天内送达。',
  '感谢您的来信，我们会尽快回复。',
  '本月的账单已经生成，请及时付款。',
  '周末天气晴朗，适合去公园散步。',
  '明日の会議は午前十時からです。',
  'ご注文の商品は発送されました。',
  'お問い合わせありがとうございます。',
  'よろしくお願いいたします。',
  'カタカナのテキストとひらがなのテキストを混ぜています。',
  '東京駅で待ち合わせしましょう。',
  '今週末は雨が降るかもしれません。',
];

function cjk(r, targetUnits) {
  let out = '';
  while (out.length < targetUnits) {
    out += pick(r, CJK);
    if (r() < 0.15) out += '\n';
  }
  return out.slice(0, targetUnits);
}

const EMOJI = [
  '😀', '😂', '🥰', '🎉', '🔥', '👍', '👍🏽', '👋🏿', '🙏🏻', '❤️', '✨', '🚀', '🍕', '🌈',
  '👨‍👩‍👧‍👦', '👩🏾‍💻', '🧑‍🤝‍🧑', '🏳️‍🌈', '🇺🇸', '🇯🇵', '🇩🇪', '☕', '✅', '📦', '💯',
];

function emoji(r, targetUnits) {
  let out = '';
  while (out.length < targetUnits) {
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) out += pick(r, EMOJI);
    out += r() < 0.1 ? '\n' : ' ';
  }
  // Don't cut in the middle of a surrogate pair.
  let s = out.slice(0, targetUnits);
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  return s;
}

// Two extra kinds beyond the task's five, added after the first run showed that ASCII text
// alone spans 2.3-5.8 chars per token: base64 (PGP signatures, JWTs in tracking links) as the
// worst case for ASCII, and accented European prose as a common mix of ASCII and non-ASCII.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(r, targetUnits) {
  let out = '';
  while (out.length < targetUnits) out += tok(r, 76, B64) + '\n';
  return out.slice(0, targetUnits);
}

const LATIN = [
  'Die Besprechung wurde auf nächste Woche verschoben, weil größere Änderungen nötig sind.',
  'Vielen Dank für Ihre Bestellung; die Lieferung erfolgt voraussichtlich übermorgen.',
  'La réunion est prévue à neuf heures, près de la gare, avec café et pâtisseries.',
  "Nous avons bien reçu votre message et nous vous répondrons dès que possible.",
  'El señor García llegará mañana por la tarde; la reunión será en el edificio número dos.',
  '¿Podría confirmar la dirección de envío? ¡Gracias por su paciencia!',
  'Não se esqueça de trazer os documentos para a reunião de amanhã.',
  'Grüße aus München und bis bald im Café am Marktplatz.',
];

function latin(r, targetUnits) {
  let out = '';
  while (out.length < targetUnits) out += pick(r, LATIN) + (r() < 0.2 ? '\n\n' : ' ');
  return out.slice(0, targetUnits);
}

// Other scripts, added after the first run: spam in any script reaches an English mailbox,
// and a byte-level tokenizer may spend more than one token on each of these characters.
const SCRIPTS = {
  cyrillic: ['Ваш заказ отправлен и будет доставлен в течение трёх дней.', 'Спасибо за письмо, мы ответим как можно скорее.', 'Встреча назначена на завтра в десять часов утра.'],
  greek: ['Η παραγγελία σας έχει αποσταλεί και θα παραδοθεί σε τρεις ημέρες.', 'Ευχαριστούμε για το μήνυμά σας.', 'Η συνάντηση είναι αύριο στις δέκα το πρωί.'],
  arabic: ['تم شحن طلبك وسيتم توصيله خلال ثلاثة أيام.', 'شكرا لرسالتك، سنرد عليك في أقرب وقت ممكن.', 'الاجتماع غدا في الساعة العاشرة صباحا.'],
  devanagari: ['आपका ऑर्डर भेज दिया गया है और तीन दिनों में पहुंच जाएगा।', 'आपके संदेश के लिए धन्यवाद, हम जल्द ही उत्तर देंगे।', 'बैठक कल सुबह दस बजे है।'],
  thai: ['คำสั่งซื้อของคุณถูกจัดส่งแล้วและจะถึงภายในสามวัน', 'ขอบคุณสำหรับข้อความของคุณ เราจะตอบกลับโดยเร็วที่สุด', 'การประชุมจะมีขึ้นพรุ่งนี้เวลาสิบโมงเช้า'],
  hangul: ['주문하신 상품이 발송되었으며 삼일 이내에 도착합니다.', '메시지를 보내 주셔서 감사합니다. 최대한 빨리 답변 드리겠습니다.', '회의는 내일 오전 열 시입니다.'],
  // CJK Extension B ideographs: each is a surrogate pair (2 UTF-16 code units).
  cjkExtB: ['𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈𠀉', '𡀀𡀁𡀂𡀃𡀄𡀅', '𢀀𢀁𢀂𢀃𢀄', '𣀀𣀁𣀂𣀃'],
  // Rare BMP ideographs (CJK Extension A, U+3400-U+4DBF): one code unit each, likely outside
  // the tokenizer's vocabulary.
  cjkExtA: ['㐀㐁㐂㐃㐄㐅㐆㐇', '㑀㑁㑂㑃㑄㑅', '㒀㒁㒂㒃㒄', '䀀䀁䀂䀃䀄䀅䀆'],
  // Typographic symbols common in newsletters.
  symbols: ['• ™ © ® € £ ¥ § ¶ † ‡', '“quoted” ‘single’ — – … «guillemets»', '→ ← ↑ ↓ ⇒ ✓ ✗ ★ ☆ ♥', '┌─┬─┐ │ ├─┼─┤ └─┴─┘ ═ ║ ╔ ╗'],
};

function script(name) {
  return (r, targetUnits) => {
    let out = '';
    while (out.length < targetUnits) out += pick(r, SCRIPTS[name]) + (r() < 0.2 ? '\n' : ' ');
    let s = out.slice(0, targetUnits);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    return s;
  };
}

const KINDS = {
  prose: { gen: prose, seed: 1 },
  marketing: { gen: marketing, seed: 2 },
  escapes: { gen: escapeHeavy, seed: 3 },
  cjk: { gen: cjk, seed: 4 },
  emoji: { gen: emoji, seed: 5 },
  base64: { gen: base64, seed: 6, targets: [1000, 5000, 15000] },
  latin: { gen: latin, seed: 7, targets: [1000, 5000, 15000] },
  ...Object.fromEntries(
    Object.keys(SCRIPTS).map((name, i) => [name, { gen: script(name), seed: 8 + i, targets: [2000, 8000], guess: 1 }]),
  ),
};

function text(kind, units) {
  const k = KINDS[kind];
  return k.gen(rng(k.seed), units);
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const HEADERS = {
  from: 'Example Sender <news@example.com>',
  to: 'Reader <reader@example.org>',
  subject: 'Synthetic test message for token measurement',
  date: 'Tue, 29 Sep 2026 10:00:00 +0000',
};
const Q = 'Is this email a newsletter or marketing message?';

const message = (body) => ({ ...HEADERS, body });
const oneQ = (instructions) => ({ q1: { type: 'noul', instructions } });

function counts(s) {
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x80) ascii++;
    else nonAscii++;
  }
  return { units: s.length, ascii, nonAscii };
}

function describe(spec) {
  const stateJson = JSON.stringify(spec.state);
  const qs = Object.values(spec.questions).map((q) => q.instructions);
  return {
    stateJson: counts(stateJson),
    questions: qs.map((q) => counts(q).units),
    questionsTotalUnits: qs.reduce((a, q) => a + q.length, 0),
    longestQuestionUnits: Math.max(...qs.map((q) => q.length)),
  };
}

class Runner {
  constructor(key, cachePath, max) {
    this.key = key;
    this.cachePath = cachePath;
    this.max = max;
    this.cache = existsSync(cachePath)
      ? JSON.parse(readFileSync(cachePath, 'utf8'))
      : { liveRequests: 0, totalInputTokens: 0, results: {} };
    this.stopped = undefined;
  }

  save() {
    writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2) + '\n');
  }

  async send(key, spec, meta = {}) {
    if (this.cache.results[key]) return this.cache.results[key];
    if (this.stopped) return undefined;
    if (this.cache.liveRequests >= this.max) {
      this.stopped = `cap of ${this.max} live requests reached`;
      return undefined;
    }
    if (!this.key) {
      this.stopped = 'no JEV_API_KEY';
      return undefined;
    }
    const body = { model: MODEL, state: spec.state, questions: spec.questions };
    const started = Date.now();
    let res;
    let text_;
    try {
      res = await fetch(URL_, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify(body),
      });
      text_ = await res.text();
    } catch (e) {
      this.stopped = `network error: ${String(e && e.message)}`;
      return undefined;
    }
    this.cache.liveRequests++;
    let json;
    try {
      json = JSON.parse(text_);
    } catch {
      json = undefined;
    }
    const r = {
      key,
      ...meta,
      ...describe(spec),
      status: res.status,
      ms: Date.now() - started,
      requestId: res.headers.get('x-typesafe-request-id') ?? undefined,
      model: json?.model,
      inputTokens: json?.usage?.input_tokens,
      outputTokens: json?.usage?.output_tokens,
      answers: res.ok ? json?.answers : undefined,
      // Error bodies hold only synthetic text; they're kept (shortened) for the findings.
      errorBody: res.ok ? undefined : text_.slice(0, 2000),
    };
    if (typeof r.inputTokens === 'number') this.cache.totalInputTokens += r.inputTokens;
    this.cache.results[key] = r;
    this.save();
    const cost = ((this.cache.totalInputTokens / 1e6) * PRICE_PER_MTOK).toFixed(4);
    process.stderr.write(
      `#${this.cache.liveRequests} ${key}: ${r.status} input_tokens=${r.inputTokens ?? '-'} ` +
        `total=${this.cache.totalInputTokens} ($${cost})\n`,
    );
    if (res.status === 401) this.stopped = '401 Unauthorized';
    return r;
  }
}

// ---------------------------------------------------------------------------------------------
// Fits
// ---------------------------------------------------------------------------------------------

function fit(points) {
  // Least squares y = a + b x.
  const n = points.length;
  if (n < 2) return undefined;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const maxAbsResidual = Math.max(...points.map((p) => Math.abs(p.y - (intercept + slope * p.x))));
  return { n, slope, intercept, maxAbsResidual, unitsPerToken: 1 / slope };
}

const ok = (r) => r && r.status === 200 && typeof r.inputTokens === 'number';

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

// Rough guess at code units per token, used only to spread each kind's sizes over about
// 1k-20k tokens. The measured slope replaces it.
const GUESS_UNITS_PER_TOKEN = { prose: 4.5, marketing: 2.5, escapes: 2.5, cjk: 1, emoji: 0.6, base64: 1.5, latin: 3.5 };
const TARGET_TOKENS = [1000, 4000, 10000, 20000];

async function slopes(run) {
  const out = { kinds: {}, question: undefined, messages: undefined, intercept: [], questionCount: undefined };

  for (const kind of Object.keys(KINDS)) {
    const rows = [];
    for (const t of KINDS[kind].targets ?? TARGET_TOKENS) {
      const units = Math.round(t * (GUESS_UNITS_PER_TOKEN[kind] ?? KINDS[kind].guess));
      const body = text(kind, units);
      const r = await run.send(`kind-${kind}-${units}`, { state: [message(body)], questions: oneQ(Q) }, {
        kind,
        body: counts(body),
      });
      if (r) rows.push(r);
    }
    const good = rows.filter(ok);
    out.kinds[kind] = {
      byRawUnits: fit(good.map((r) => ({ x: r.body.units, y: r.inputTokens }))),
      byStateJsonChars: fit(good.map((r) => ({ x: r.stateJson.units, y: r.inputTokens }))),
      nonAsciiShareOfStateJson: good.length
        ? good[good.length - 1].stateJson.nonAscii / good[good.length - 1].stateJson.units
        : undefined,
    };
  }

  // The question's length alone (English prose), with a fixed small state.
  {
    const rows = [];
    for (const units of [50, 2000, 8000, 20000]) {
      const q = units === 50 ? Q : text('prose', units).trimEnd() + ' Is this a newsletter?';
      const r = await run.send(`question-${units}`, { state: [message('Hello, see you soon.')], questions: oneQ(q) }, {
        kind: 'question',
      });
      if (r) rows.push(r);
    }
    out.question = fit(rows.filter(ok).map((r) => ({ x: r.questionsTotalUnits, y: r.inputTokens })));
  }

  // The number of messages alone (tiny bodies, same headers).
  {
    const rows = [];
    for (const n of [1, 4, 16, 64]) {
      const state = Array.from({ length: n }, () => message('Thanks, sounds good.'));
      const r = await run.send(`messages-${n}`, { state, questions: oneQ(Q) }, { kind: 'messages', messages: n });
      if (r) rows.push(r);
    }
    const good = rows.filter(ok);
    out.messages = {
      perMessage: fit(good.map((r) => ({ x: r.messages, y: r.inputTokens }))),
      byStateJsonChars: fit(good.map((r) => ({ x: r.stateJson.units, y: r.inputTokens }))),
    };
  }

  // The number of (short, identical-length) questions alone.
  {
    const rows = [];
    for (const n of [1, 2, 5, 10]) {
      const questions = {};
      for (let i = 1; i <= n; i++) questions[`q${i}`] = { type: 'noul', instructions: Q };
      const r = await run.send(`questions-${n}`, { state: [message('Hello, see you soon.')], questions }, {
        kind: 'questionCount',
        questionCount: n,
      });
      if (r) rows.push(r);
    }
    out.questionCount = fit(rows.filter(ok).map((r) => ({ x: r.questionCount, y: r.inputTokens })));
  }

  // The intercept: a minimal request.
  for (const [key, spec] of [
    ['minimal-body-only', { state: [{ body: 'Hi.' }], questions: oneQ('Spam?') }],
    ['minimal-headers', { state: [message('Hi.')], questions: oneQ('Spam?') }],
    ['minimal-repeat', { state: [{ body: 'Hi.' }], questions: oneQ('Spam?') }],
  ]) {
    const r = await run.send(key, spec, { kind: 'intercept' });
    if (r) out.intercept.push({ key, inputTokens: r.inputTokens, status: r.status, stateJson: r.stateJson });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The estimator chosen from the slopes (see spikes/84-token-ratio.md). The limit phase checks it.
// ---------------------------------------------------------------------------------------------

// The chosen estimator: the UTF-8 byte length of the text, counted from UTF-16 code units
// (spikes/84-token-ratio.md). #83 implements the same thing in src/core/token-estimate.ts.
function estimateTokens(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdfff) n += 2; // each half of a surrogate pair (4 bytes a pair)
    else n += 3;
  }
  return n;
}

const LIMIT = 32768; // state + the longest question
const COMBINED_LIMIT = 65536; // state + all questions
const REQUEST_OVERHEAD = 300;
const QUESTION_OVERHEAD = 10;
const MARGIN = 1000;
const COMBINED_MARGIN = 2000;

// The largest estimate of JSON.stringify(state) the budget rule allows for these questions.
function stateBudget(questionTexts) {
  const ests = questionTexts.map(estimateTokens);
  const single = LIMIT - REQUEST_OVERHEAD - QUESTION_OVERHEAD - MARGIN - Math.max(...ests);
  const combined =
    COMBINED_LIMIT - REQUEST_OVERHEAD - QUESTION_OVERHEAD * ests.length - COMBINED_MARGIN - ests.reduce((a, b) => a + b, 0);
  return Math.min(single, combined);
}

// A one-message state of the given kind whose estimate is as large as possible within budget.
function fillState(kind, budget) {
  let lo = 0;
  let hi = budget;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateTokens(JSON.stringify([message(text(kind, mid))])) <= budget) lo = mid;
    else hi = mid;
  }
  return [message(text(kind, lo))];
}

// Common CJK text costs exactly one token per code unit, and a one-message state with HEADERS
// and Q costs 357 tokens more (measured in the slope phase: slope 1.0000, intercept 357, no
// residual). So cjkTotal(n) is a request whose input_tokens is exactly n.
const CJK_FIXED = 357;
const COMBINED_PROBES = [65770, 65771];
const BOUNDARY_PROBES = [32000, 32001, 32768, 32769, 33100, 34000];
const cjkTotal = (n) => ({ state: [message(text('cjk', n - CJK_FIXED))], questions: oneQ(Q) });

async function limits(run) {
  const out = {};
  const row = (r) =>
    r && {
      key: r.key,
      status: r.status,
      inputTokens: r.inputTokens,
      stateJsonUnits: r.stateJson.units,
      questions: r.questions,
      errorBody: r.errorBody,
    };

  // Clearly over: about 1.5x the limit.
  out.over = row(await run.send('limit-over-48000', cjkTotal(48000), { kind: 'limit' }));

  // The boundary: is it 32,000 or 32,768 tokens of input_tokens?
  out.boundary = [];
  for (const n of BOUNDARY_PROBES) {
    out.boundary.push(row(await run.send(`limit-boundary-${n}`, cjkTotal(n), { kind: 'limit', expectTokens: n })));
  }
  // Bisect between the largest success and the smallest failure above.
  let lo = 32769;
  let hi = 33100;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await run.send(`limit-boundary-${mid}`, cjkTotal(mid), { kind: 'limit', expectTokens: mid });
    if (!r) break;
    out.boundary.push(row(r));
    if (r.status === 200) lo = mid;
    else hi = mid;
  }
  out.largestAccepted = lo;
  out.smallestRejected = hi;

  // Several questions: each state + question is under 32k, but state + all questions is over
  // 32k (3 questions) or over 64k (10 questions). Each question is about 5k tokens of prose.
  out.multi = [];
  const STATE_UNITS = 24700;
  for (const n of [3, 10]) {
    const r = await run.send(`limit-multi-${n}x5k`, { state: [message(text('cjk', STATE_UNITS))], questions: bigQuestions(n) }, {
      kind: 'limit',
    });
    out.multi.push(row(r));
  }

  // The combined limit: 8 questions of about 5k tokens and a CJK state sized to the target
  // total. From limit-multi-3x5k, input_tokens = stateCjkUnits + 40309 with these 8 questions.
  // Hypothesis from the single-question boundary: 65536 counted tokens plus 234 uncounted.
  out.combined = [];
  for (const target of COMBINED_PROBES) {
    const r = await run.send(`limit-combined-8x5k-${target}`, {
      state: [message(text('cjk', target - 40309))],
      questions: bigQuestions(8),
    }, { kind: 'limit', expectTokens: target });
    out.combined.push(row(r));
  }
  // Coarse bisection (8 steps, to stay under the request cap) between the largest accepted
  // probe and limit-multi-10x5k (about 75,000, rejected).
  {
    let lo = 65771;
    let hi = 75001;
    for (let step = 0; step < 8; step++) {
      const target = Math.floor((lo + hi) / 2);
      const r = await run.send(`limit-combined-8x5k-${target}`, {
        state: [message(text('cjk', target - 40309))],
        questions: bigQuestions(8),
      }, { kind: 'limit', expectTokens: target });
      if (!r) break;
      out.combined.push(row(r));
      if (r.status === 200) lo = target;
      else hi = target;
    }
    out.combinedLargestAccepted = lo;
    out.combinedSmallestRejectedAtMost = hi;
  }

  // Just under the planned target, with the tightest kind measured (CJK Extension A, about
  // 0.98 tokens per UTF-8 byte): the state fills the budget rule exactly. Both must succeed.
  out.underTarget = [];
  {
    const qs = [Q];
    const budget = stateBudget(qs);
    const state = fillState('cjkExtA', budget);
    const r = await run.send('under-single-cjkExtA', { state, questions: oneQ(Q) }, { kind: 'underTarget' });
    out.underTarget.push({ ...row(r), rule: 'single', stateBudget: budget, stateEstimate: estimateTokens(JSON.stringify(state)) });
  }
  {
    // Four long Extension A questions, so the combined limit is the binding one.
    const questions = {};
    for (let i = 1; i <= 4; i++) {
      questions[`q${i}`] = { type: 'noul', instructions: `Question ${i}: ${text('cjkExtA', 4000)}?` };
    }
    const qs = Object.values(questions).map((q) => q.instructions);
    const budget = stateBudget(qs);
    const state = fillState('cjkExtA', budget);
    const r = await run.send('under-combined-cjkExtA', { state, questions }, { kind: 'underTarget' });
    out.underTarget.push({
      ...row(r),
      rule: 'combined',
      stateBudget: budget,
      stateEstimate: estimateTokens(JSON.stringify(state)),
      questionEstimates: qs.map(estimateTokens),
    });
  }
  return out;
}

function bigQuestions(n, units = 29000) {
  const qs = {};
  const base = text('prose', units);
  for (let i = 1; i <= n; i++) {
    qs[`q${i}`] = { type: 'noul', instructions: `Question ${i}. ${base} Is this message number ${i} a newsletter?` };
  }
  return qs;
}



// ---------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const run = new Runner(readKey(args.env), args.cache, args.max);
  const result = { script: 'spikes/84-token-ratio.mjs', model: MODEL, endpoint: URL_ };
  if (args.phase === 'slopes' || args.phase === 'all') result.slopes = await slopes(run);
  if (args.phase === 'limits' || args.phase === 'all') result.limits = await limits(run);
  const models = new Set(Object.values(run.cache.results).map((r) => r.model).filter(Boolean));
  result.estimator = {
    formula: 'estimateTokens(s) = UTF-8 byte length of s, from UTF-16 code units: <0x80 -> 1, <0x800 -> 2, surrogate -> 2, else 3',
    LIMIT,
    COMBINED_LIMIT,
    REQUEST_OVERHEAD,
    QUESTION_OVERHEAD,
    MARGIN,
    COMBINED_MARGIN,
  };
  result.returnedModels = [...models];
  result.liveRequests = run.cache.liveRequests;
  result.totalInputTokens = run.cache.totalInputTokens;
  result.estimatedCostUsd = Number(((run.cache.totalInputTokens / 1e6) * PRICE_PER_MTOK).toFixed(4));
  result.stopped = run.stopped;
  result.requests = Object.values(run.cache.results).map(({ answers, ...r }) => r);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (run.stopped) process.exitCode = 1;
}

export { text, counts, message, oneQ, HEADERS, Q };

// Run only when executed directly, so the generators can be imported without live calls.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`error: ${e && e.stack ? e.stack : String(e)}\n`);
    process.exitCode = 1;
  });
}
