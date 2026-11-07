// 유튜브 영상 제목·설명에서 날짜와 타임라인을 뽑는 파서

// "PT5H12M3S" → 초
export function isoDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const pad = (n) => String(n).padStart(2, '0');

function validDate(y, mo, d, refMs) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== mo - 1) return null; // 2월 31일 같은 것 거르기
  if (t < Date.UTC(2020, 0, 1) || t > refMs + 3 * 86400e3) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

// 제목에 적힌 방송 날짜 → "YYYY-MM-DD" (팬 다시보기 채널은 업로드일이 방송일과 다른 경우가 많아서)
export function parseTitleDate(title, refMs = Date.now()) {
  const t = String(title || '');
  let m;
  // 2024.03.12 / 2024-3-12 / 2024년 3월 12일 / 2024 03 12
  if ((m = /(?<!\d)(20\d{2})(?:\s*[.\-/년]\s*|\s+)(\d{1,2})(?:\s*[.\-/월]\s*|\s+)(\d{1,2})(?!\d)/.exec(t))) {
    const r = validDate(+m[1], +m[2], +m[3], refMs);
    if (r) return r;
  }
  // 20240312
  if ((m = /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/.exec(t))) {
    const r = validDate(+m[1], +m[2], +m[3], refMs);
    if (r) return r;
  }
  // 24.03.12 / 24. 3. 12
  if ((m = /(?<!\d)(\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?!\d)/.exec(t))) {
    const r = validDate(2000 + +m[1], +m[2], +m[3], refMs);
    if (r) return r;
  }
  // 240312
  if ((m = /(?<!\d)(2\d)(\d{2})(\d{2})(?!\d)/.exec(t))) {
    const r = validDate(2000 + +m[1], +m[2], +m[3], refMs);
    if (r) return r;
  }
  // 3월 12일 (연도 없음 → 기준 시각 기준으로 추정)
  if ((m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(t))) {
    const ref = new Date(refMs);
    let y = ref.getUTCFullYear();
    if (+m[1] > ref.getUTCMonth() + 1) y -= 1;
    const r = validDate(y, +m[1], +m[2], refMs);
    if (r) return r;
  }
  return null;
}

const TS = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}`;
const RE_START = new RegExp(String.raw`^\s*(?:[-–—•·▶►*#]+\s*)?[\[(]?(${TS})[\])]?\s*(?:[-–—~:|]+\s*)?(.*)$`);
const RE_END = new RegExp(String.raw`^(.*?\S)\s*(?:[-–—~:|]+\s*)?[\[(]?(${TS})[\])]?\s*$`);
const RE_LEAD_TS = new RegExp(String.raw`^[\[(]?${TS}[\])]?\s*[-–—~:|]*\s*`);

function toSec(ts) {
  return ts.split(':').reduce((acc, x) => acc * 60 + +x, 0);
}

function cleanLabel(s) {
  return s
    .replace(RE_LEAD_TS, '') // "1:00:00 ~ 2:00:00 게임" 같은 구간 표기
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[-–—~:|•·▶►*#\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// 설명란 타임라인 → [[초, "라벨"], ...]  (2개 이상일 때만 인정)
export function parseChapters(description) {
  const out = [];
  for (const line of String(description || '').split(/\r?\n/)) {
    if (line.length > 200) continue;
    let m = RE_START.exec(line);
    let ts, label;
    if (m) [, ts, label] = m;
    else if ((m = RE_END.exec(line))) [, label, ts] = m;
    else continue;
    label = cleanLabel(label || '');
    if (!label) continue;
    out.push([toSec(ts), label]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const dedup = out.filter((c, i) => i === 0 || c[0] !== out[i - 1][0]);
  return dedup.length >= 2 ? dedup.slice(0, 80) : [];
}

// 제목에 멤버 이름이 있는지 (공용 다시보기 채널에서 멤버 구분용)
export function titleMentions(title, member) {
  const t = String(title || '');
  const flat = t.replace(/\s+/g, '');
  if (flat.includes(member.name.replace(/\s+/g, ''))) return true;
  for (const short of member.short || []) {
    // 짧은 이름은 앞뒤가 한글이 아닐 때만 (예: "린"이 다른 단어 속에 섞인 경우 제외)
    const re = new RegExp(`(?<![가-힣])${short}(?![가-힣])`);
    if (re.test(t)) return true;
  }
  return false;
}
