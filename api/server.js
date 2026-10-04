// maraton-api: zdieľané prechody bežca + spoločná kópia live dát z čipu (championchip.cz).
// Bez závislostí (Node 24). Dáta v ./data/state.json.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = +process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';  // heslo v appke → vráti ADMIN_TOKEN
const DATA = path.join(__dirname, 'data', 'state.json');
const LOOP = 21097.5;                 // jeden okruh (polmaratón); maratón a štafeta = 2 okruhy
const MAX_TOTAL = 2 * LOOP;
const RACE_TOTAL = { 'Maratón': 2 * LOOP, 'Staf': 2 * LOOP };   // ostatné disciplíny = 1 okruh
const MAX_OBSERVER_DIST = 1000;      // m – pozorovateľ musí byť do 1 km od miesta prechodu
const MAX_ACC_CREDIT = 100;          // m – koľko z nepresnosti GPS mu odpustíme
const MAX_ACCURACY = 1000;           // m – horšia presnosť GPS sa neakceptuje
const TIME_WINDOW = 15 * 60e3;       // čas prechodu môže byť najviac 15 min dozadu
const CHIP_POLL = 60e3;              // championchip raz za minútu pre všetkých
const WATCH_TTL = 15 * 60e3;         // sťahujeme len kým niekto sleduje

// ---------- trasa (rovnaký prepočet ako v klientovi) ----------
const route = JSON.parse(fs.readFileSync(path.join(__dirname, 'route.json'), 'utf8')).points.map(([lat, lng]) => ({ lat, lng }));
function hav(a, b) {
  const r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const cum = [0];
for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + hav(route[i - 1], route[i]));
const K = LOOP / cum[cum.length - 1];
function pointAt(d) {
  let dl = d % LOOP; if (d > 0 && dl === 0) dl = LOOP;
  const g = Math.max(0, Math.min(cum[cum.length - 1], dl / K));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= g) lo = m; else hi = m; }
  const f = (g - cum[lo]) / ((cum[hi] - cum[lo]) || 1), a = route[lo], b = route[hi];
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

// ---------- stav ----------
let state = { claxUrl: 'https://results.championchip.cz/2026100410/MMM%202026.clax', runners: {} };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    fs.writeFileSync(DATA + '.tmp', JSON.stringify(state, null, 1));
    fs.renameSync(DATA + '.tmp', DATA);
  }, 200);
}
const runner = bib => (state.runners[bib] ||= { pace: 295, cps: [] });

// ---------- čip ----------
// dva zdroje: starý súbor Wiclax .clax (results*.championchip.cz) alebo JSON z race.championchip.cz (od 2026)
// oba sa prevedú na chip.runners: bib → { bib, race, name, sex, nat, start, cps:[{id,d,t}] }
const chip = { status: 'ešte nenačítané', updated: null, ver: 0, etag: null, hash: null, runners: null, day: null, tz: 120, splits: {} };
const watched = new Map(); // bib → posledný dopyt
const attrs = tag => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const pad = n => String(n).padStart(2, '0');
const tzStr = () => { const a = Math.abs(chip.tz), sign = chip.tz >= 0 ? '+' : '-'; return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`; };
function claxTime(s) { // "10h30'51,477"
  const m = s && s.match(/(\d+)h(\d+)'(\d+)(?:,(\d+))?/); if (!m) return null;
  return new Date(`${chip.day}T${pad(m[1])}:${pad(m[2])}:${pad(m[3])}${tzStr()}`).getTime() + (m[4] ? +('0.' + m[4]) * 1000 : 0);
}
function clockMs(s) { // "09:16:58,169"
  const m = s && String(s).match(/(\d{1,2}):(\d{2}):(\d{2})(?:[,.](\d+))?/); if (!m) return null;
  return new Date(`${chip.day}T${pad(m[1])}:${m[2]}:${m[3]}${tzStr()}`).getTime() + (m[4] ? +('0.' + m[4]) * 1000 : 0);
}
function durMs(s) { // "1:07:18", "54:39,6", "16:57"
  const m = s && String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[,.](\d+))?$/); if (!m) return null;
  return ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + (m[4] ? +('0.' + m[4]) * 1000 : 0);
}
const raceTotal = race => RACE_TOTAL[race] || LOOP;
function normalizeClax(txt) {
  const head = attrs((txt.match(/<Epreuve\b[^>]*>/) || [''])[0]);
  chip.day = head.dt1; chip.tz = +(head.TZ || 120);
  chip.splits = {};
  for (const m of txt.matchAll(/<Pointage\b[^>]*>/g)) { const a = attrs(m[0]); chip.splits[a.id] = +a.dist; }
  const runners = new Map();
  for (const m of txt.matchAll(/<E\b[^>]*>/g)) {
    const a = attrs(m[0]);
    runners.set(a.d, { bib: a.d, race: a.p || null, name: (a.n || '').replace(/ /g, ' '), sex: a.x === 'F' ? 'F' : 'M', nat: a.na || '', start: claxTime(a.h), cps: [] });
  }
  for (const m of txt.matchAll(/<R\b[^>]*>/g)) {
    const a = attrs(m[0]), x = runners.get(a.d); if (!x) continue;
    const total = raceTotal(x.race);
    for (const [k, v] of Object.entries(a)) {
      const mm = k.match(/^pb(\d+)$/); if (!mm || chip.splits[mm[1]] == null || chip.splits[mm[1]] >= total) continue;
      const t = claxTime(v); if (t) x.cps.push({ id: 'chip' + mm[1], d: chip.splits[mm[1]], t });
    }
    if (a.b) { const t = claxTime(a.b); if (t) x.cps.push({ id: 'chipF', d: total, t }); }
    x.cps.sort((p, q) => p.d - q.d);
  }
  return runners;
}
function normalizeRaceJson(data) {
  const st = (data.stages || []).find(x => x.index === data.activeStage) || (data.stages || [])[0] || {};
  chip.day = data.event && data.event.dateFrom || chip.day; chip.tz = 120; // MMM: CEST
  const pts = {}; for (const p of st.pointages || []) pts[String(p.id)] = p.distanceM;
  const runners = new Map();
  const mk = e => ({ bib: String(e.bib), race: e.race || null, name: String(e.name || '').replace(/\u00a0/g, ' '), sex: e.sex === 'F' ? 'F' : 'M', nat: e.nation || '', start: null, cps: [] });
  for (const e of st.startlist || []) runners.set(String(e.bib), mk(e));
  for (const r of st.rows || []) {
    const x = runners.get(String(r.bib)) || mk(r); runners.set(x.bib, x);
    const total = raceTotal(x.race);
    x.cps = [];
    for (const p of r.splits || []) {
      const id = String(p.id ?? ''), t = clockMs(p.clock); if (!t) continue;
      const fin = id === '' || id === '999', d = fin ? total : pts[id];
      if (d == null || (!fin && d >= total)) continue;
      x.cps.push({ id: fin ? 'chipF' : 'chip' + id, d, t });
      const dt = durMs(p.time); if (!x.start && dt) x.start = t - dt;
    }
    const ft = clockMs(r.finishClock);
    if (ft && !x.cps.some(c => c.d >= total)) x.cps.push({ id: 'chipF', d: total, t: ft });
    const rt = durMs(r.realTime || r.time); if (ft && rt) x.start = ft - rt; // čistý čas → reálny štart
    x.cps.sort((p, q) => p.d - q.d);
  }
  return runners;
}
async function pollRace(src) {
  const q = `event=${encodeURIComponent(src.event)}&block=${encodeURIComponent(src.block)}`;
  let hash = null;
  try { const v = await (await fetch(`https://race.championchip.cz/api/wiclax_version.php?${q}`, { signal: AbortSignal.timeout(8000) })).json(); hash = v.hash || v.sourceHash || null; } catch {}
  if (chip.runners && hash && hash === chip.hash) { chip.status = 'ok'; chip.updated = Date.now(); return; }
  const r = await fetch(`https://race.championchip.cz/api/wiclax_results.php?${q}`, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!j.ok || !j.data) throw new Error(j.error || 'neplatná odpoveď');
  chip.runners = normalizeRaceJson(j.data); chip.hash = hash || j.hash || null; chip.ver++;
  chip.status = 'ok'; chip.updated = Date.now();
}
async function pollChip() {
  const active = [...watched.values()].some(t => Date.now() - t < WATCH_TTL);
  if (!active) return;
  try {
    if (state.raceSrc) return await pollRace(state.raceSrc);
    const res = await fetch(state.claxUrl, { headers: chip.etag ? { 'If-None-Match': chip.etag } : {} });
    if (res.status === 304) { chip.status = 'ok'; chip.updated = Date.now(); return; }
    if (res.status === 404) { chip.status = 'súbor zatiaľ nie je zverejnený (404)'; chip.runners = null; return; }
    if (!res.ok) { chip.status = 'HTTP ' + res.status; return; }
    chip.runners = normalizeClax(await res.text()); chip.ver++;
    chip.etag = res.headers.get('etag'); chip.status = 'ok'; chip.updated = Date.now();
  } catch (e) { chip.status = 'chyba: ' + e.message; }
}
setInterval(pollChip, CHIP_POLL);
function chipFor(bib) {
  const base = { status: chip.status, updated: chip.updated };
  if (!chip.runners) return base;
  const x = chip.runners.get(String(bib));
  if (!x) return { ...base, status: `číslo ${bib} sa v dátach z čipu nenašlo` };
  return { ...base, name: x.name || null, race: x.race, start: x.start, cps: x.cps.map(c => ({ ...c, src: 'chip' })) };
}

// ---------- TRACX (oficiálna appka MYLAPS): číslo → disciplína, štart vlny, meno ----------
// verejné web API: api.tracx.events/v1/web/events/<event>/rankings/<ranking>/results?search=<bib>
const TRACX_EVENT = 2076; // MMM 2026
const TRACX_RACES = [ // [race_id, disciplína, general ranking_id]
  [5752, 'polmaraton', 23054], [5750, 'maraton', 23048], [5751, 'stafeta', 23051],
  [5753, 'inline', 23057], [5754, 'handbike', 23060], [5755, 'family', 23063],
];
const entryCache = new Map(); // bib → {at, data}
async function entryFor(bib) {
  const saved = state.runners[bib] && state.runners[bib].entry;
  if (saved) return saved; // nájdené raz → uložené natrvalo k číslu, TRACX sa už nepýtame
  const c = entryCache.get(bib);
  if (c && Date.now() - c.at < (c.data ? 30 : 5) * 60e3) return c.data;
  // každá trať zvlášť – výpadok jednej požiadavky nesmie zahodiť nájdený výsledok
  const found = await Promise.allSettled(TRACX_RACES.map(async ([race, disc, rk]) => {
    const r = await fetch(`https://api.tracx.events/v1/web/events/${TRACX_EVENT}/rankings/${rk}/results?search=${bib}&itemsPerPage=5`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const it = ((await r.json()).items || []).find(i => String(i.start_number) === String(bib));
    return it && { disc, raceName: it['race.name'], start: it.start_time ? Date.parse(it.start_time) : null,
      name: it.full_name || null, participantId: it.participant && it.participant.id || null };
  }));
  const hit = found.find(f => f.status === 'fulfilled' && f.value);
  const failed = found.some(f => f.status === 'rejected');
  if (hit) { runner(bib).entry = hit.value; save(); return hit.value; }
  if (failed) { console.log('tracx lookup', bib, found.filter(f => f.status === 'rejected').map(f => f.reason.message).join(', ')); return c ? c.data : null; } // neukladať, skúsiť znova
  entryCache.set(bib, { at: Date.now(), data: null }); // naozaj nenájdené
  return null;
}

// TRACX medzičasy = druhý zdroj popri .clax (passing = ms od reálneho štartu pretekára)
const txCache = new Map(); // participantId → {at, data}
async function tracxFor(entry) {
  if (!entry || !entry.participantId) return null;
  const c = txCache.get(entry.participantId);
  if (c && Date.now() - c.at < 60e3) return c.data; // max. 1 dopyt/min na pretekára
  let data = c ? c.data : null;
  try {
    const r = await fetch(`https://api.tracx.events/v1/web/events/${TRACX_EVENT}/participants/${entry.participantId}?include=splits`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    // pred štartom je v „start“ len plánovaný štart trate (bez vĺn) → reálny štart až keď pretekár vybehol
    const started = j.state && j.state !== 'before';
    const start = started && j.start ? Date.parse(j.start) : null;
    const total = entry.disc === 'maraton' || entry.disc === 'stafeta' ? 2 * LOOP : LOOP;
    const cps = [], seen = new Set();
    for (const sp of j.splits || []) {
      if (!start || !(sp.passing > 0)) continue;
      const name = String(sp.split_name || '');
      const m = name.replace(',', '.').match(/([\d.]+)\s*km/i);
      let d = /finish|cie/i.test(name) ? total : m ? Math.round(parseFloat(m[1]) * 1000) : null;
      if (d != null && d > total && d - total < 200) d = total; // „21.1 Km“ pri polmaratóne = cieľ
      if (d == null || d > total || seen.has(d)) continue;
      seen.add(d);
      cps.push({ id: 'tx' + d, d, t: start + sp.passing, src: 'chip', via: 'tracx' });
    }
    data = { status: 'ok', state: j.state || null, start, cps, updated: Date.now() };
  } catch (e) { data = Object.assign({}, data, { status: 'chyba: ' + e.message }); }
  txCache.set(entry.participantId, { at: Date.now(), data });
  return data;
}

// ---------- lídri: prví v každej disciplíne (celkovo, muži, ženy) ----------
// živo zo súboru z čipu: vedie ten, kto je na najvzdialenejšom meraní s najskorším časom;
// pred prvým meraním favoriti = najnižšie čísla (elita) s typickým tempom
const P2KEY = { 'Maratón': 'maraton', 'Polmaratón': 'polmaraton', 'Staf': 'stafeta', 'Inline': 'inline', 'Handbike': 'handbike' };
const ELITE_PACE = { maraton: { M: 182, F: 205 }, polmaraton: { M: 172, F: 195 }, stafeta: { M: 200, F: 225 }, inline: { M: 80, F: 90 }, handbike: { M: 100, F: 120 } };
const TOP = 3;
function pickTop(list, cmp) {
  const sorted = [...list].sort(cmp);
  return { all: sorted.slice(0, TOP), M: sorted.filter(r => r.sex === 'M').slice(0, TOP), F: sorted.filter(r => r.sex === 'F').slice(0, TOP) };
}
function favPace(r) { return (ELITE_PACE[r.key] || {})[r.sex === 'F' ? 'F' : 'M'] || 200; }
let leadersCache = { key: null, data: null };
function leadersFromChip() {
  if (leadersCache.key === chip.ver && leadersCache.data) return leadersCache.data;
  const all = [...chip.runners.values()].map(x => ({ ...x, key: P2KEY[x.race] })).filter(x => x.key);
  const out = {};
  for (const key of Object.values(P2KEY)) {
    const list = all.filter(x => x.key === key);
    const moving = list.filter(x => x.cps.length).map(x => { const l = x.cps[x.cps.length - 1]; return { ...x, maxD: l.d, tAt: l.t }; });
    if (moving.length) {
      const top = pickTop(moving, (p, q) => q.maxD - p.maxD || p.tAt - q.tAt);
      for (const c of ['all', 'M', 'F']) top[c] = top[c].map(({ maxD, tAt, race, ...r }) => ({ ...r, cps: r.cps.map(({ d, t }) => ({ d, t })) }));
      out[key] = { fav: false, ...top };
    } else {
      const top = pickTop(list, (p, q) => (parseInt(p.bib.replace(/\D/g, ''), 10) || 1e9) - (parseInt(q.bib.replace(/\D/g, ''), 10) || 1e9));
      for (const c of ['all', 'M', 'F']) top[c] = top[c].map(({ race, ...r }) => ({ ...r, cps: [], pace: favPace(r) }));
      out[key] = { fav: true, ...top };
    }
  }
  leadersCache = { key: chip.ver, data: out };
  return out;
}
// bez súboru z čipu: favoriti z TRACX (rebríčky sú pred štartom zoradené podľa čísla)
let favTracx = { at: 0, data: null };
async function favoritesFromTracx() {
  if (favTracx.data && Date.now() - favTracx.at < 30 * 60e3) return favTracx.data;
  const out = {};
  await Promise.allSettled(TRACX_RACES.filter(([, k]) => ELITE_PACE[k]).map(async ([race, key, rk]) => {
    const get = async (id) => {
      const r = await fetch(`https://api.tracx.events/v1/web/events/${TRACX_EVENT}/rankings/${id}/results?itemsPerPage=${TOP}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return ((await r.json()).items || []).map(i => {
        const x = { bib: String(i.start_number), name: i.full_name || '', sex: i.gender === 'female' ? 'F' : 'M', nat: i.country_code || '', key, start: null, cps: [] };
        return { ...x, pace: favPace(x) };
      });
    };
    const [all, M, F] = await Promise.all([get(rk), get(rk + 1), get(rk + 2)]); // general, male, female ranking id idú po sebe
    out[key] = { fav: true, all, M, F };
  }));
  if (Object.keys(out).length) favTracx = { at: Date.now(), data: out };
  return out;
}

// ---------- HTTP ----------
const hits = new Map(); // ip → [časy zápisov]
function limited(ip, kind = 'w', max = 10) {
  const key = kind + ip, now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < 60e3);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 10000) req.destroy(); });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error('zlý JSON')); } });
  });
}
const isAdmin = req => ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN;
const publicCp = (c, clientId) => ({ id: c.id, d: c.d, t: c.t, src: c.src, name: c.name || null, mine: !!clientId && c.by === clientId, obsDist: c.obsDist });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const m = url.pathname.match(/^\/api\/runner\/([A-Za-z]?\d{1,6})(?:\/(cp|sim)(?:\/([\w-]+))?)?$/);
  try {
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') return send(res, 200, { claxUrl: state.claxUrl, admin: isAdmin(req) });
      if (req.method === 'PUT') {
        if (!isAdmin(req)) return send(res, 403, { error: 'len pre správcu' });
        const b = await readBody(req);
        let u = String(b.claxUrl || '').trim();
        const rp = u.match(/^https:\/\/race\.championchip\.cz\/results\.php\?(.*)$/);
        if (rp) { // nový systém: JSON API race.championchip.cz (zdroj .clax už nie je verejný)
          const q = new URLSearchParams(rp[1]);
          if (!q.get('event') || !q.get('block')) return send(res, 400, { error: 'v odkaze chýba event alebo block' });
          state.raceSrc = { event: q.get('event'), block: q.get('block') }; state.claxUrl = u;
        } else if (/^https:\/\/results\d*\.championchip\.cz\/.+\.clax$/.test(u)) {
          state.raceSrc = null; state.claxUrl = u.replace(/ /g, '%20');
        } else return send(res, 400, { error: 'neznámy odkaz – vlož odkaz z race.championchip.cz (výsledky) alebo .clax' });
        chip.etag = null; chip.hash = null; chip.runners = null; chip.status = 'načítavam…'; save();
        watched.set('*config', Date.now()); await pollChip();
        return send(res, 200, { claxUrl: state.claxUrl, status: chip.status });
      }
    }
    // POST /api/login – heslo správcu (max. 5 pokusov/min z jednej IP)
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (limited(ip, 'l', 5)) return send(res, 429, { error: 'príliš veľa pokusov, skús o minútu' });
      const b = await readBody(req);
      if (!ADMIN_PASSWORD || String(b.password || '') !== ADMIN_PASSWORD) { console.log(new Date().toISOString(), 'login FAIL', ip); return send(res, 403, { error: 'nesprávne heslo' }); }
      console.log(new Date().toISOString(), 'login ok', ip);
      return send(res, 200, { token: ADMIN_TOKEN });
    }
    // GET /api/leaders – lídri / favoriti všetkých disciplín
    if (url.pathname === '/api/leaders' && req.method === 'GET') {
      const first = !watched.has('*leaders') || Date.now() - watched.get('*leaders') > WATCH_TTL;
      watched.set('*leaders', Date.now());
      if (first && !chip.runners) await pollChip();
      const data = chip.runners ? leadersFromChip() : await favoritesFromTracx();
      return send(res, 200, { source: chip.runners ? 'čip' : 'TRACX', updated: chip.updated, chipStatus: chip.status, disciplines: data });
    }
    if (!m) return send(res, 404, { error: 'nenájdené' });
    const bib = m[1], sub = m[2], subId = m[3];

    // PUT/DELETE /api/runner/:bib/sim – simulácia od správcu, vidia ju všetci
    if (sub === 'sim') {
      if (!isAdmin(req)) return send(res, 403, { error: 'len pre správcu' });
      if (req.method === 'DELETE') { delete runner(bib).sim; runner(bib).simCps = []; save(); return send(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        if (!(b.base > 0) || !(b.speed >= 1 && b.speed <= 120)) return send(res, 400, { error: 'zlé parametre simulácie' });
        runner(bib).sim = { base: Math.round(b.base), t0: Date.now(), speed: +b.speed }; runner(bib).simCps = []; save();
        return send(res, 200, runner(bib).sim);
      }
    }

    // GET /api/runner/:bib – všetko, čo klient potrebuje
    if (req.method === 'GET' && !sub) {
      const first = !watched.has(bib) || Date.now() - watched.get(bib) > WATCH_TTL;
      watched.set(bib, Date.now());
      if (first && !chip.runners) await pollChip();
      const entry = await entryFor(bib);
      const tracx = await tracxFor(entry);
      const r = state.runners[bib] || { cps: [] };
      const pace = r.paceSet || (r.pace && r.pace !== 295) ? r.pace : null; // null → klient použije typické tempo disciplíny
      const cid = url.searchParams.get('clientId');
      return send(res, 200, { bib, pace, sim: r.sim || null, cps: r.cps.map(c => publicCp(c, cid)),
        simCps: r.sim ? (r.simCps || []).map(c => publicCp(c, cid)) : [], chip: chipFor(bib), entry, tracx, serverTime: Date.now(), admin: isAdmin(req) });
    }

    // PUT /api/runner/:bib – plánované tempo (správca)
    if (req.method === 'PUT' && !sub) {
      if (!isAdmin(req)) return send(res, 403, { error: 'len pre správcu' });
      const b = await readBody(req);
      if (b.pace >= 50 && b.pace <= 720) { runner(bib).pace = Math.round(b.pace); runner(bib).paceSet = true; save(); }
      return send(res, 200, { pace: runner(bib).pace });
    }

    // POST /api/runner/:bib/cp – nový prechod od pozorovateľa na trati
    if (req.method === 'POST' && sub === 'cp' && !subId) {
      if (limited(ip)) return send(res, 429, { error: 'príliš veľa zápisov, skús o minútu' });
      const b = await readBody(req);
      const d = +b.d, t = +b.t, now = Date.now();
      if (!(d >= 0 && d <= MAX_TOTAL)) return send(res, 400, { error: 'zlá poloha na trase' });
      const admin = isAdmin(req);
      // prechod počas spoločnej simulácie: bez GPS, čas sa porovnáva so simulovaným časom; zmaže sa s koncom simulácie
      if (b.sim) {
        const r = runner(bib);
        if (!r.sim) return send(res, 409, { error: 'simulácia už nebeží' });
        const simNow = r.sim.base + (now - r.sim.t0) * r.sim.speed;
        if (!(t > r.sim.base - 6 * 3600e3 && t < simNow + 60e3 * r.sim.speed)) return send(res, 400, { error: 'čas je mimo simulácie' });
        const cp = { id: 's' + crypto.randomUUID().slice(0, 7), d: Math.round(d), t: Math.round(t), src: 'manual',
          name: String(b.name || '').slice(0, 30) || null, by: String(b.clientId || '').slice(0, 40), obsDist: null, ip, at: now, sim: true };
        (r.simCps ||= []).push(cp); save();
        return send(res, 201, publicCp(cp, cp.by));
      }
      if (!admin && !(t > now - TIME_WINDOW && t < now + 60e3)) return send(res, 400, { error: 'čas prechodu musí byť z posledných 15 minút' });
      let obsDist = null;
      if (!admin) {
        const lat = +b.lat, lng = +b.lng, acc = +b.acc;
        if (!isFinite(lat) || !isFinite(lng)) return send(res, 403, { error: 'chýba tvoja poloha (povoľ GPS)' });
        if (!(acc <= MAX_ACCURACY)) return send(res, 403, { error: `poloha je príliš nepresná (±${Math.round(acc)} m)` });
        obsDist = Math.round(hav({ lat, lng }, pointAt(d)));
        if (obsDist - Math.min(acc, MAX_ACC_CREDIT) > MAX_OBSERVER_DIST)
          return send(res, 403, { error: `si ${(obsDist / 1000).toFixed(1).replace('.', ',')} km od tohto miesta – upresniť môže len niekto do 1 km` });
      }
      const cp = { id: crypto.randomUUID().slice(0, 8), d: Math.round(d), t: Math.round(t), src: 'manual',
        name: String(b.name || '').slice(0, 30) || null, by: String(b.clientId || '').slice(0, 40), obsDist, ip, at: now };
      const r = runner(bib);
      r.cps.push(cp); save();
      console.log(new Date().toISOString(), 'cp', bib, cp.d, new Date(cp.t).toISOString(), cp.name, obsDist, ip, admin ? 'admin' : '');
      return send(res, 201, publicCp(cp, cp.by));
    }

    // DELETE /api/runner/:bib/cp/:id – autor (clientId) alebo správca
    if (req.method === 'DELETE' && sub === 'cp' && subId) {
      const r = state.runners[bib];
      const cp = r && [...r.cps, ...(r.simCps || [])].find(c => c.id === subId);
      if (!cp) return send(res, 404, { error: 'nenájdené' });
      if (!isAdmin(req) && cp.by !== url.searchParams.get('clientId')) return send(res, 403, { error: 'zmazať môže len autor alebo správca' });
      r.cps = r.cps.filter(c => c !== cp); r.simCps = (r.simCps || []).filter(c => c !== cp); save();
      return send(res, 200, { ok: true });
    }
    send(res, 405, { error: 'nepodporované' });
  } catch (e) { send(res, 400, { error: e.message }); }
}).listen(PORT, () => console.log('maraton-api na porte', PORT));
