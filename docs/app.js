// 스텔 다시보기 찾기 — 정적 사이트 (데이터: data/broadcasts.json, 별명: aliases.json)
const $ = (s) => document.querySelector(s);
const CHUNK = 40;

const state = { q: '', members: new Set(), platform: 'all', year: '', sort: 'new', shown: CHUNK };
const CAT_LABEL = { talk: '저챗' }; // 치지직 카테고리 표시 이름
let DATA = null;
let ALIASES = [];
let memberName = {};

// ---------- 텍스트 ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const norm = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣ぁ-んァ-ヶ一-龥]/g, '');

function hms(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function length(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}시간${m ? ` ${m}분` : ''}` : `${m}분`;
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
function dateLabel(d) {
  const [y, mo, da] = d.split('-').map(Number);
  return `${String(mo).padStart(2, '0')}.${String(da).padStart(2, '0')} (${WEEK[new Date(Date.UTC(y, mo - 1, da)).getUTCDay()]})`;
}

const chzzkUrl = (n) => `https://chzzk.naver.com/video/${encodeURIComponent(n)}`;
const ytUrl = (id, t) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${t ? `&t=${Math.floor(t)}s` : ''}`;

// ---------- 방송 구간 ----------
// 구간 출처 우선순위: 방송 중 카테고리 기록 > 유튜브 설명란 타임라인 > 다시보기 카테고리 하나
function buildParts(it) {
  const ys = it.y || [];
  const total = it.c?.u || Math.max(0, ...ys.map((y) => y.u || 0));
  let parts;
  let span = total;

  if (it.g?.length) {
    const yLive = ys.find((y) => y.ls);
    parts = it.g.map(([off, cat]) => {
      const p = { off, label: cat, src: 'live' };
      if (yLive && it.o) {
        const t = off - (yLive.ls - it.o) / 1000;
        if (t >= 0) Object.assign(p, { y: yLive.i, yt: t });
      }
      return p;
    });
  } else {
    const yc = ys.filter((y) => y.ch?.length).sort((a, b) => b.ch.length - a.ch.length)[0];
    if (yc) {
      span = yc.u || total;
      parts = yc.ch.map(([sec, label]) => ({ off: sec, label, src: 'yt', y: yc.i, yt: sec }));
    } else {
      parts = [{ off: 0, label: it.c?.k || null, src: 'cat' }];
    }
  }
  if (parts[0].off > 0) parts.unshift({ off: 0, label: null, src: parts[0].src });

  const widths = parts.map((p, i) => Math.max(0, (parts[i + 1]?.off ?? span) - p.off));
  const sum = widths.reduce((a, b) => a + b, 0);
  parts.forEach((p, i) => {
    p.w = sum > 0 ? widths[i] / sum : 1 / parts.length;
    const shown = p.src === 'yt' ? p.label : CAT_LABEL[p.label] || p.label;
    p.n = [p.label, shown].map(norm).join('|');
    p.label = shown;
  });
  return parts;
}

function prepare(it) {
  it.parts = buildParts(it);
  const games = [];
  for (const g of [it.c?.k, ...(it.g || []).map((x) => x[1])]) if (g && !games.includes(g)) games.push(g);
  it.games = games.map((g) => ({ label: CAT_LABEL[g] || g, n: norm(g) }));
  it.hay = norm(
    [it.t, ...games, ...(it.y || []).flatMap((y) => [y.t, ...(y.ch || []).map((c) => c[1])]), memberName[it.m]].join(' '),
  );
}

// ---------- 검색 ----------
function termVariants(term) {
  const n = norm(term);
  if (!n) return null;
  for (const group of ALIASES) {
    const ns = group.map(norm);
    if (ns.includes(n)) return [...new Set([n, ...ns])];
  }
  return [n];
}

function query() {
  const terms = state.q.split(/\s+/).map(termVariants).filter(Boolean);
  const out = [];
  for (const it of DATA.items) {
    if (state.members.size && !state.members.has(it.m)) continue;
    if (state.platform === 'chzzk' && !it.c) continue;
    if (state.platform === 'youtube' && !it.y) continue;
    if (state.year && !it.d.startsWith(state.year)) continue;
    if (!terms.every((vs) => vs.some((v) => it.hay.includes(v)))) continue;
    out.push(it);
  }
  if (state.sort === 'old') out.reverse();
  return { list: out, variants: terms.flat() };
}

// ---------- 그리기 ----------
function partLine(p, it) {
  const time = p.y
    ? `<a href="${esc(ytUrl(p.y, p.yt))}" target="_blank" rel="noopener">${hms(p.yt)}</a>`
    : `<span title="치지직 다시보기에서 이 시간으로 이동해 주세요">${hms(p.off)}</span>`;
  const src = p.src === 'yt' ? ' <span class="src">유튜브 타임라인</span>' : p.src === 'live' && !p.y && it.c ? ' <span class="src">치지직에서 이 시간부터</span>' : '';
  return `<li class="${p.hit ? 'hit' : ''}"><span class="t">${time}</span><span>${esc(p.label)}${src}</span></li>`;
}

function card(it, variants) {
  const parts = it.parts;
  for (const p of parts) p.hit = !!(variants.length && p.n && variants.some((v) => p.n.includes(v)));
  const named = parts.filter((p) => p.label);
  const hits = named.filter((p) => p.hit);
  const dur = it.c?.u || Math.max(0, ...(it.y || []).map((y) => y.u || 0));

  const bar = parts
    .map((p) => `<span class="${p.hit ? 'hit' : ''}${p.label ? '' : ' unknown'}" style="flex:${p.w.toFixed(4)}"></span>`)
    .join('');
  const barLabel = named.length ? named.map((p) => `${hms(p.off)} ${p.label}`).join(', ') : '구간 정보 없음';

  let partsHtml = '';
  if (named.length > 1 || (hits.length && named.length === 1 && named[0].off > 0)) {
    if (hits.length) partsHtml += `<ul class="parts">${hits.map((p) => partLine(p, it)).join('')}</ul>`;
    if (named.length > hits.length) {
      partsHtml += `<details class="all-parts"><summary>구간 ${named.length}개 모두 보기</summary><ul class="parts">${named
        .map((p) => partLine(p, it))
        .join('')}</ul></details>`;
    }
  }

  const links = [];
  if (it.c) links.push(`<a class="btn" href="${esc(chzzkUrl(it.c.n))}" target="_blank" rel="noopener"><span class="dot"></span>치지직 다시보기</a>`);
  (it.y || []).forEach((y, i, arr) => {
    const label = arr.length > 1 ? `유튜브 ${i + 1}` : '유튜브 다시보기';
    links.push(`<a class="btn" href="${esc(ytUrl(y.i))}" target="_blank" rel="noopener" title="${esc(y.t)}"><span class="dot"></span>${label}</a>`);
  });

  return `<article class="bc">
    <div class="bc-head">
      <span class="bc-date">${dateLabel(it.d)}</span>
      <span class="bc-who">${esc(memberName[it.m] || it.m)}</span>
      ${dur ? `<span class="bc-len">${length(dur)}</span>` : ''}
      ${it.a ? '<span class="bc-approx">날짜는 업로드일 기준</span>' : ''}
    </div>
    <h3 class="bc-title">${esc(it.t)}</h3>
    ${it.games.length ? `<p class="bc-games">${it.games.map((g) => `<span class="${variants.some((v) => g.n.includes(v)) ? 'hit' : ''}">${esc(g.label)}</span>`).join('')}</p>` : ''}
    <div class="bar" role="img" aria-label="${esc(barLabel)}">${bar}</div>
    ${partsHtml}
    <div class="links">${links.join('')}</div>
  </article>`;
}

function render() {
  const { list, variants } = query();
  const count = $('#count');
  const listEl = $('#list');
  const more = $('#more');

  if (!DATA.items.length) {
    count.textContent = '';
    listEl.innerHTML = `<div class="empty"><p>아직 수집된 방송이 없어요.</p><p>저장소의 Actions 탭에서 update를 한 번 실행하면 채워져요.</p></div>`;
    more.hidden = true;
    return;
  }

  count.textContent = `방송 ${list.length.toLocaleString('ko-KR')}개`;
  if (!list.length) {
    const q = state.q.trim();
    listEl.innerHTML = `<div class="empty"><p>${q ? `‘${esc(q)}’ 검색 결과가 없어요.` : '조건에 맞는 방송이 없어요.'}</p><p>영문 이름이나 줄임말로 찾아보거나, 멤버·연도 필터를 풀어 보세요.</p></div>`;
    more.hidden = true;
    return;
  }

  let html = '';
  let month = '';
  for (const it of list.slice(0, state.shown)) {
    const mo = it.d.slice(0, 7);
    if (mo !== month) {
      month = mo;
      html += `<h2 class="month">${Number(mo.slice(0, 4))}년 ${Number(mo.slice(5, 7))}월</h2>`;
    }
    html += card(it, variants);
  }
  listEl.innerHTML = html;
  more.hidden = list.length <= state.shown;
}

// ---------- 상태 ↔ 주소(#) ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get('q') || '';
  state.members = new Set((p.get('m') || '').split(',').filter((k) => memberName[k]));
  state.platform = ['chzzk', 'youtube'].includes(p.get('p')) ? p.get('p') : 'all';
  state.year = /^\d{4}$/.test(p.get('y') || '') ? p.get('y') : '';
  state.sort = p.get('s') === 'old' ? 'old' : 'new';
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.members.size) p.set('m', [...state.members].join(','));
  if (state.platform !== 'all') p.set('p', state.platform);
  if (state.year) p.set('y', state.year);
  if (state.sort !== 'new') p.set('s', state.sort);
  const h = p.toString();
  history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
}

function syncControls() {
  $('#q').value = state.q;
  for (const b of document.querySelectorAll('#members .chip')) {
    const k = b.dataset.k;
    b.setAttribute('aria-pressed', String(k ? state.members.has(k) : state.members.size === 0));
  }
  for (const b of document.querySelectorAll('#platform button')) b.setAttribute('aria-pressed', String(b.dataset.v === state.platform));
  $('#year').value = state.year;
  $('#sort').value = state.sort;
}

function update({ resetPage = true } = {}) {
  if (resetPage) state.shown = CHUNK;
  writeHash();
  syncControls();
  render();
}

// ---------- 시작 ----------
function setupControls() {
  const box = $('#members');
  box.innerHTML =
    `<button type="button" class="chip" aria-pressed="true">모든 멤버</button>` +
    DATA.members.map((m) => `<button type="button" class="chip" data-k="${esc(m.key)}" aria-pressed="false" title="${esc(m.unit || '')}">${esc(m.name)}</button>`).join('');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const k = b.dataset.k;
    if (!k) state.members.clear();
    else if (state.members.has(k)) state.members.delete(k);
    else state.members.add(k);
    update();
  });

  $('#platform').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.platform = b.dataset.v;
    update();
  });

  const years = [...new Set(DATA.items.map((it) => it.d.slice(0, 4)))].sort().reverse();
  $('#year').insertAdjacentHTML('beforeend', years.map((y) => `<option value="${y}">${y}년</option>`).join(''));
  $('#year').addEventListener('change', (e) => { state.year = e.target.value; update(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; update(); });

  let t;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value; update(); }, 150);
  });

  const more = $('#more');
  more.addEventListener('click', () => { state.shown += CHUNK; update({ resetPage: false }); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting) && !more.hidden) more.click(); }, { rootMargin: '600px' }).observe(more);
  }

  window.addEventListener('hashchange', () => { readHash(); syncControls(); render(); });
}

function setupFooter(contact) {
  // 문의 주소는 build.mjs가 데이터에 넣어준다 (저장소 이슈 또는 CONTACT_URL 변수).
  let url = /^https?:\/\//.test(contact || '') ? contact : null;
  if (!url) {
    const m = /^([\w-]+)\.github\.io$/i.exec(location.hostname);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    if (m) url = `https://github.com/${m[1]}/${repo || `${m[1]}.github.io`}/issues`;
  }
  if (!url) return;
  $('#contact').href = url;
  $('#contact-line').hidden = false;
}

function showUpdated(ms) {
  const d = new Date(ms);
  const f = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  $('#updated').textContent = `${f.format(d)} 갱신`;
}

async function main() {
  try {
    const [data, aliases] = await Promise.all([
      fetch('data/broadcasts.json', { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      }),
      fetch('aliases.json').then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]);
    DATA = data;
    ALIASES = Array.isArray(aliases) ? aliases.filter(Array.isArray) : [];
    setupFooter(DATA.contact);
  } catch {
    setupFooter(null);
    $('#count').textContent = '';
    $('#list').innerHTML = `<div class="empty"><p>방송 목록을 불러오지 못했어요.</p><p>잠시 뒤 새로고침해 주세요.</p></div>`;
    return;
  }
  memberName = Object.fromEntries(DATA.members.map((m) => [m.key, m.name]));
  DATA.items.forEach(prepare);
  if (DATA.updatedAt) showUpdated(DATA.updatedAt);
  setupControls();
  readHash();
  syncControls();
  render();
}

main();
