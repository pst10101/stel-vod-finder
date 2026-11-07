// (2단계) 방송 중 카테고리 변경 기록 → 한 방송에서 여러 게임 한 걸 "몇 분부터" 찾게 해줌
//   node scripts/track-live.mjs
// 워크플로(live.yml)가 10분마다 돌린다. 체크 간격만큼 몇 분 오차가 생길 수 있음.
import { path, readJSON, writeJSON, getJSON, HttpError, sleep, parseKst, loadMembers, log } from './lib.mjs';

const API = process.env.CHZZK_API_BASE || 'https://api.chzzk.naver.com';
const HEADERS = {
  'User-Agent': process.env.CHZZK_USER_AGENT || 'Mozilla/5.0 (compatible; stel-vod-finder/1.0; non-commercial fan site)',
  Accept: 'application/json',
};
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 1000);
const LATE_MS = 15 * 60 * 1000; // 방송 시작 후 15분 넘어서 처음 봤으면 그 전 구간은 모름

async function liveDetail(channelId) {
  // 버전이 바뀌는 경우가 있어서 v3 → v2 순서로 시도
  for (const v of ['v3', 'v2']) {
    try {
      const json = await getJSON(`${API}/service/${v}/channels/${channelId}/live-detail`, { headers: HEADERS, retries: 1 });
      if (json?.content) return json.content;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 403 || e.status === 429)) throw e;
    }
  }
  return null;
}

async function main() {
  const members = await loadMembers();
  const ids = { ...(await readJSON(path('data', 'channel-ids.json'), {})) };
  const chzzk = await readJSON(path('data', 'chzzk.json'), { members: {} });
  const file = path('data', 'segments.json');
  const store = await readJSON(file, {});
  const now = Date.now();
  let changed = false;

  for (const m of members) {
    const channelId = m.chzzk || ids[m.key] || chzzk.members[m.key]?.channelId;
    if (!channelId) continue;
    await sleep(DELAY_MS);
    let c;
    try {
      c = await liveDetail(channelId);
    } catch (e) {
      log(`⛔ ${e.message} — 중단`);
      break;
    }
    if (!c || c.status !== 'OPEN') continue;

    const cat = c.liveCategoryValue || c.liveCategory || '';
    const open = parseKst(c.openDate) ?? now;
    const sessions = (store[m.key] ||= []);
    let s = sessions.find((x) => (c.liveId && x.liveId === c.liveId) || Math.abs(x.open - open) < 5 * 60 * 1000);
    if (!s) {
      s = { liveId: c.liveId ?? null, open, changes: [] };
      sessions.push(s);
      const first = now - open < LATE_MS ? open : now;
      if (first !== open) s.changes.push([open, null]); // 시작~첫 확인 사이는 기록 없음
      s.changes.push([first, cat]);
      changed = true;
      log(`🔴 ${m.name}: 방송 시작 감지 — ${cat || '카테고리 없음'}`);
    } else {
      const last = s.changes[s.changes.length - 1];
      if (last[1] !== cat) {
        s.changes.push([now, cat]);
        changed = true;
        log(`🔁 ${m.name}: ${last[1] || '?'} → ${cat}`);
      }
    }
  }

  // 1년 지난 기록은 정리
  for (const k of Object.keys(store)) {
    store[k] = store[k].filter((s) => now - s.open < 365 * 86400e3);
  }
  if (changed) await writeJSON(file, store);
  else log('변경 없음');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
