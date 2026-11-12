// 치지직 클립 → 다시보기의 어느 장면인지 추정하는 계산 (네트워크 없음, 순수 함수)
//
// 클립에는 "어느 방송의 몇 분"인지가 없고 만든 시각만 있다.
// 방송 중에 만든 클립은 만들기 직전 1~2분 안의 장면이므로, 만든 시각이 방송 시간 안에 들어가는 클립만
// "방송 시작 후 몇 초"로 바꾼다. 방송이 끝난 뒤 다시보기에서 만든 클립은 위치를 알 수 없어서 뺀다.

export const LEAD_SEC = 150; // 클립은 만들기 직전 장면 → 이만큼 앞에서부터 보여준다 (조금 일찍 도착하는 쪽이 안전)
export const GRACE_AFTER_MS = 5 * 60 * 1000; // 방송이 끝난 직후에 저장된 클립도 방송 중 클립으로 본다
export const BIN_SEC = 90; // 구간별 개수를 세는 단위. "클립이 몰린 구간"은 이웃한 두 칸(3분)을 묶어서 본다
export const TOP_KEEP = 10; // 방송 하나에 보관하는 인기 클립 수
export const TOP_SHOW = 8; // 사이트에 보여주는 수
export const HOT_SHOW = 5;

// 클립 한 줄: [id, 만든 시각(ms), 길이(초), 조회수, 제목]
export const C_ID = 0, C_AT = 1, C_DUR = 2, C_VIEWS = 3, C_TITLE = 4;

// 치지직 다시보기 한 개의 방송 시간.
// 게시 시각(pub)은 방송이 끝난 시각이라(밤~새벽에 몰려 있음) 길이를 빼면 시작 시각이 된다.
export function broadcastWindow(v) {
  if (!v || !v.dur) return null;
  const start = v.open ?? (v.pub != null ? v.pub - v.dur * 1000 : null);
  if (start == null) return null;
  return { no: v.no, start, end: start + v.dur * 1000, dur: v.dur };
}

// 멤버 한 명의 방송 시간 목록 (시작 시각 오름차순)
export function windowsFor(videos) {
  return (videos || [])
    .map(broadcastWindow)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

// 만든 시각이 들어가는 방송 찾기 (없으면 null)
export function findWindow(windows, at) {
  let lo = 0;
  let hi = windows.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (windows[mid].start <= at) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (hit < 0) return null;
  const w = windows[hit];
  return at <= w.end + GRACE_AFTER_MS ? w : null;
}

// 방송 시작 후 몇 초부터 보면 되는지
export function offsetOf(win, at) {
  const sec = Math.round((at - win.start) / 1000) - LEAD_SEC;
  return Math.min(Math.max(0, sec), Math.max(0, win.dur - 1));
}

// ---- 방송 하나의 클립 요약: { n: 개수, top: 인기 클립, bins: 구간별 개수 } — 조금씩 더해 갈 수 있는 형태 ----
export const emptySummary = () => ({ n: 0, top: [], bins: [] });

export function addClip(sum, win, clip) {
  const off = offsetOf(win, clip[C_AT]);
  sum.n += 1;
  // 구간별 개수
  const bin = Math.floor(off / BIN_SEC);
  const slot = sum.bins.find((b) => b[0] === bin);
  if (slot) slot[1] += 1;
  else sum.bins.push([bin, 1]);
  // 인기 클립: [방송 시작 후 초, id, 길이, 조회수, 제목]
  sum.top.push([off, clip[C_ID], clip[C_DUR], clip[C_VIEWS], clip[C_TITLE]]);
  if (sum.top.length > TOP_KEEP) {
    sum.top.sort((a, b) => b[3] - a[3] || a[0] - b[0]);
    sum.top.length = TOP_KEEP;
  }
  return sum;
}

export function mergeSummary(a, b) {
  const out = { n: a.n + b.n, top: [...a.top, ...b.top], bins: a.bins.map((x) => [...x]) };
  for (const [bin, cnt] of b.bins) {
    const slot = out.bins.find((x) => x[0] === bin);
    if (slot) slot[1] += cnt;
    else out.bins.push([bin, cnt]);
  }
  out.top.sort((x, y) => y[3] - x[3] || x[0] - y[0]);
  out.top.length = Math.min(out.top.length, TOP_KEEP);
  return out;
}

// 클립이 몰린 구간: 이웃한 두 칸(3분) 안에 클립이 3개 이상이고 그 방송 전체의 8% 이상 몰린 곳을, 많은 순으로 겹치지 않게 고른다
export function hotSpots(sum) {
  if (!sum.bins.length) return [];
  const count = new Map(sum.bins);
  const need = Math.max(3, Math.ceil(sum.n * 0.08));
  const starts = new Set();
  for (const bin of count.keys()) {
    starts.add(bin);
    if (bin > 0) starts.add(bin - 1); // 한 장면이 칸 경계에 걸쳐도 잡히게, 앞 칸에서 시작하는 묶음도 본다
  }
  const cands = [...starts]
    .map((bin) => ({ bin, n: (count.get(bin) || 0) + (count.get(bin + 1) || 0) }))
    .filter((c) => c.n >= need)
    .sort((a, b) => b.n - a.n || a.bin - b.bin);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= HOT_SHOW) break;
    if (picked.some((p) => Math.abs(p.bin - c.bin) < 2)) continue; // 이미 고른 구간과 겹침
    picked.push(c);
  }
  return picked
    .sort((a, b) => a.bin - b.bin)
    .map((c) => [(count.get(c.bin) ? c.bin : c.bin + 1) * BIN_SEC, c.n]); // 클립이 실제로 시작되는 칸부터
}

// 사이트용: { n, t: 인기 클립(시간순), h: 몰린 구간 }
export function forSite(sum) {
  const top = [...sum.top].sort((a, b) => b[3] - a[3] || a[0] - b[0]).slice(0, TOP_SHOW).sort((a, b) => a[0] - b[0]);
  const out = { n: sum.n, t: top };
  const hot = hotSpots(sum);
  if (hot.length) out.h = hot;
  return out;
}

// 멤버 한 명의 수집 상태(st)로 방송별 요약을 만든다: 오래된 방송의 요약(st.old) + 아직 낱개로 들고 있는 최근 클립(st.clips)
export function summariesFor(st, windows) {
  const out = new Map();
  for (const [no, sum] of Object.entries(st?.old || {})) out.set(Number(no), { n: sum.n, top: [...sum.top], bins: sum.bins.map((x) => [...x]) });
  for (const clip of st?.clips || []) {
    const win = findWindow(windows, clip[C_AT]);
    if (!win) continue;
    if (!out.has(win.no)) out.set(win.no, emptySummary());
    addClip(out.get(win.no), win, clip);
  }
  return out;
}
