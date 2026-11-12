// 치지직 클립 수집 → 다시보기에서 "클립이 나온 장면"으로 바로 가기 위한 재료
//   node scripts/fetch-clips.mjs          → 최근 며칠 치 새로 받고, 남는 요청으로 예전 클립을 조금씩 채움
//   node scripts/fetch-clips.mjs --full   → 최근 구간을 더 길게 다시 받음 (조회수 갱신)
//
// fetch-chzzk.mjs와 같은 비공식 API·같은 원칙: 공개 정보(제목·길이·조회수·만든 시각)만 저장,
// 영상·썸네일 저장 안 함, 요청 간격 유지, 한 번에 보내는 요청 수 제한, 막히면 즉시 중단.
//
// 저장 형태 (data/clips/<멤버>.json):
//   clips — 최근 클립 낱개 [id, 만든 시각, 길이, 조회수, 제목]  (조회수가 계속 바뀌는 기간)
//   old   — 오래된 방송은 방송별 요약만 { 다시보기번호: { n, top, bins } }
//   back  — 예전 클립을 어디까지 채웠는지 { cursor, t } / 다 채웠으면 { done: true }
//   todo  — 최근 구간을 받다가 요청 한도로 끊긴 자리
import { mkdir, writeFile } from 'node:fs/promises';
import { path, readJSON, getJSON, HttpError, sleep, parseKst, loadMembers, log } from './lib.mjs';
import { windowsFor, findWindow, addClip, emptySummary, C_ID, C_AT } from './clips.mjs';

const API = process.env.CHZZK_API_BASE || 'https://api.chzzk.naver.com';
const HEADERS = {
  'User-Agent': process.env.CHZZK_USER_AGENT || 'Mozilla/5.0 (compatible; stel-vod-finder/1.0; non-commercial fan site)',
  Accept: 'application/json',
};
const FULL = process.argv.includes('--full');
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 1500);
const PAGE_SIZE = Number(process.env.CLIP_PAGE_SIZE || 50);
const MAX_REQUESTS = Number(process.env.CLIP_MAX_REQUESTS || (FULL ? 600 : 240)); // 한 번 실행에 보내는 요청 수 한도
const DAY = 86400e3;
const RAW_MS = Number(process.env.CLIP_RAW_DAYS || 21) * DAY; // 이보다 오래된 클립은 방송별 요약으로 접는다
// 이 기간 클립은 매번 다시 받아 조회수 갱신 (접힌 클립을 또 세지 않도록 낱개 보관 기간보다 짧아야 한다)
const REFRESH_MS = Math.min(Number(process.env.CLIP_REFRESH_DAYS || (FULL ? 14 : 2)) * DAY, RAW_MS - DAY);
const UNMATCHED_KEEP_MS = 7 * DAY; // 방송을 못 찾은 클립은 다시보기가 올라올 때까지 이만큼만 기다린다
const BACKFILL_PAGES_PER_TURN = 8;

class Blocked extends Error {}
class OutOfBudget extends Error {}

let used = 0;
let limit = MAX_REQUESTS; // 지금 단계에서 쓸 수 있는 요청 수 (최근 구간 받기에는 전체의 70%까지만 쓴다)
async function call(url) {
  if (used >= limit) throw new OutOfBudget();
  used += 1;
  await sleep(DELAY_MS);
  try {
    const json = await getJSON(url, { headers: HEADERS });
    if (json.code !== undefined && json.code !== 200) throw new Error(`API code ${json.code}: ${json.message}`);
    return json.content;
  } catch (e) {
    // 403·429는 "그만 하라"는 신호로 보고 전체 수집을 멈춘다.
    if (e instanceof HttpError && (e.status === 403 || e.status === 429)) throw new Blocked(e.message);
    throw e;
  }
}

const clipsUrl = (channelId, cursor) =>
  `${API}/service/v1/channels/${channelId}/clips?filterType=ALL&orderType=RECENT&size=${PAGE_SIZE}` +
  (cursor ? `&clipUID=${encodeURIComponent(cursor)}` : '');

// 응답의 클립 한 개 → [id, 만든 시각, 길이, 조회수, 제목] (보여주면 안 되는 클립은 null)
function normalize(c) {
  if (!c || !c.clipUID) return null;
  if (c.adult || c.blindType || c.privateUserBlock) return null;
  const at = parseKst(c.createdDate);
  if (at == null) return null;
  return [String(c.clipUID), at, Number(c.duration) || 0, Number(c.readCount) || 0, String(c.clipTitle || '').trim().slice(0, 60)];
}

async function page(channelId, cursor) {
  const content = await call(clipsUrl(channelId, cursor));
  const data = Array.isArray(content?.data) ? content.data : [];
  const rows = data.map(normalize).filter(Boolean);
  // 걸러진 클립이 있어도 "어디까지 봤는지"는 응답 전체 기준으로 잡는다
  const times = data.map((c) => parseKst(c?.createdDate)).filter((t) => t != null);
  return { rows, count: data.length, oldest: times.length ? Math.min(...times) : null, next: content?.page?.next?.clipUID || '' };
}

// 1) 최근 구간: 맨 위(최신)부터 내려가며, 이미 아는 클립이 나오고 갱신 기간도 지나면 멈춘다
async function recentPass(st, channelId, now) {
  const byId = new Map(st.clips.map((c) => [c[C_ID], c]));
  // 예전 채우기가 맡은 구간(back.t보다 옛날)과 이미 요약으로 접힌 기간의 클립은 건너뛴다 (같은 클립을 두 번 세지 않게).
  // 맨 처음 받을 때(back이 아직 없음)는 받은 것을 전부 담아야 한다 — 그 아래부터가 예전 채우기 몫이 되기 때문.
  const guard = st.back ? Math.max(now - RAW_MS, st.back.done ? -Infinity : st.back.t) : -Infinity;
  const floor = Math.max(now - REFRESH_MS, guard);
  const nothingKnown = st.clips.length === 0;
  let cursor = st.todo || '';
  let end = false;
  let deepest = null;
  let added = 0;
  try {
    for (;;) {
      const p = await page(channelId, cursor);
      let sawKnown = false;
      for (const row of p.rows) {
        if (row[C_AT] < guard) continue;
        if (byId.has(row[C_ID])) sawKnown = true;
        else added += 1;
        byId.set(row[C_ID], row);
      }
      if (p.oldest != null) deepest = deepest == null ? p.oldest : Math.min(deepest, p.oldest);
      if (!p.next || !p.count) {
        end = true;
        break;
      }
      cursor = p.next;
      if (p.oldest != null && p.oldest < floor && (sawKnown || nothingKnown || st.todo)) break;
    }
    delete st.todo;
    // 처음 다 받았을 때: 여기서부터 아래(더 옛날)는 "예전 채우기"가 맡는다
    if (!st.back) st.back = end ? { done: true } : { cursor, t: deepest ?? now };
  } catch (e) {
    if (!(e instanceof OutOfBudget)) throw e;
    st.todo = cursor; // 다음 실행 때 이 자리부터 이어서
  } finally {
    st.clips = [...byId.values()].sort((a, b) => b[C_AT] - a[C_AT]);
  }
  return added;
}

// 2) 예전 채우기: 지난번에 멈춘 자리에서 더 옛날로 내려가며, 방송을 찾은 클립만 방송별 요약에 더한다
async function backfillTurn(st, channelId, windows) {
  if (!st.back || st.back.done) return false;
  if (!windows.length) {
    st.back = { done: true };
    return false;
  }
  const earliest = windows[0].start;
  for (let i = 0; i < BACKFILL_PAGES_PER_TURN; i++) {
    let p;
    try {
      p = await page(channelId, st.back.cursor);
    } catch (e) {
      if (e instanceof OutOfBudget || e instanceof Blocked) throw e;
      // 멈춘 자리의 클립이 지워졌을 수 있다 → 맨 위부터 다시 내려가되, 이미 처리한 시각(t)보다 새 클립은 건너뛴다
      st.back.fail = (st.back.fail || 0) + 1;
      if (st.back.fail >= 3) {
        log(`   예전 채우기를 그만둠 (${e.message}) — 여기까지 채운 것만 사용`);
        st.back = { done: true, stoppedAt: st.back.t };
        return false;
      }
      log(`   예전 채우기 자리를 잃음 (${e.message}) → 맨 위부터 다시 찾음`);
      st.back.cursor = '';
      return true;
    }
    for (const row of p.rows) {
      if (row[C_AT] >= st.back.t) continue; // 이미 처리한 구간
      const win = findWindow(windows, row[C_AT]);
      if (win) addClip((st.old[win.no] ||= emptySummary()), win, row);
    }
    if (p.oldest != null) st.back.t = Math.min(st.back.t, p.oldest);
    if (!p.next || !p.count || (p.oldest != null && p.oldest < earliest)) {
      st.back = { done: true };
      return false;
    }
    st.back.cursor = p.next;
  }
  return true;
}

// 3) 정리: 오래된 낱개 클립은 방송별 요약으로 접고, 방송을 못 찾은 채 오래된 클립은 버린다
function fold(st, windows, now) {
  const keep = [];
  let folded = 0;
  for (const clip of st.clips) {
    const win = findWindow(windows, clip[C_AT]);
    if (clip[C_AT] >= now - RAW_MS) {
      if (win || clip[C_AT] >= now - UNMATCHED_KEEP_MS) keep.push(clip);
      continue;
    }
    if (win) {
      addClip((st.old[win.no] ||= emptySummary()), win, clip);
      folded += 1;
    }
  }
  st.clips = keep;
  // 지워진 다시보기의 요약은 정리
  const alive = new Set(windows.map((w) => String(w.no)));
  for (const no of Object.keys(st.old)) if (!alive.has(no)) delete st.old[no];
  return folded;
}

// 멤버 파일: 클립 한 개·방송 요약 한 개가 한 줄씩 (git diff가 보기 좋게)
function serialize(st) {
  const head = [` "back": ${JSON.stringify(st.back ?? null)}`];
  if (st.todo) head.push(` "todo": ${JSON.stringify(st.todo)}`);
  const clips = st.clips.map((c) => '  ' + JSON.stringify(c)).join(',\n');
  const old = Object.keys(st.old)
    .sort((a, b) => Number(b) - Number(a))
    .map((no) => `  ${JSON.stringify(no)}: ${JSON.stringify(st.old[no])}`)
    .join(',\n');
  return `{\n${head.join(',\n')},\n "clips": [${clips ? '\n' + clips + '\n ' : ''}],\n "old": {${old ? '\n' + old + '\n ' : ''}}\n}\n`;
}

async function main() {
  const members = await loadMembers();
  const chzzk = await readJSON(path('data', 'chzzk.json'), { members: {} });
  const now = Date.now();

  const targets = [];
  for (const m of members) {
    const channelId = m.chzzk || chzzk.members[m.key]?.channelId;
    if (!channelId) continue; // 치지직 채널을 모르는 멤버 (다시보기 수집이 먼저 돌아야 함)
    const file = path('data', 'clips', `${m.key}.json`);
    const st = await readJSON(file, { back: null, clips: [], old: {} });
    st.clips ||= [];
    st.old ||= {};
    targets.push({ m, channelId, st, file, before: serialize(st), windows: windowsFor(chzzk.members[m.key]?.videos) });
  }

  // 요청 한도 때문에 늘 같은 멤버만 받고 끝나지 않도록, 시작 멤버를 실행 때마다 바꾼다 (지난번에 끊긴 멤버가 맨 먼저)
  const turn = Number(process.env.CLIP_ROTATE ?? Math.floor(now / (6 * 3600e3))); // 6시간마다 한 칸씩 (CLIP_ROTATE는 테스트용)
  const rot = targets.length ? turn % targets.length : 0;
  const order = [...targets.slice(rot), ...targets.slice(0, rot)];
  order.sort((a, b) => (b.st.todo ? 1 : 0) - (a.st.todo ? 1 : 0));

  let stop = null;
  try {
    // 1) 최근 구간 (전체 한도의 70%까지)
    limit = Math.floor(MAX_REQUESTS * 0.7);
    for (const t of order) {
      const added = await recentPass(t.st, t.channelId, now);
      log(`✅ ${t.m.name}: 최근 클립 ${t.st.clips.length}개${added ? ` (+${added})` : ''}${t.st.todo ? ' — 한도로 중간에 멈춤, 다음에 이어서' : ''}`);
      if (t.st.todo) break;
    }
    // 2) 남는 요청으로 예전 클립 채우기 (멤버를 돌아가며 조금씩)
    limit = MAX_REQUESTS;
    let active = order.filter((t) => t.st.back && !t.st.back.done);
    while (active.length) {
      const still = [];
      for (const t of active) if (await backfillTurn(t.st, t.channelId, t.windows)) still.push(t);
      active = still;
    }
  } catch (e) {
    stop = e;
    if (e instanceof Blocked) log(`⛔ ${e.message} — 요청이 막혀서 이번 실행은 여기서 중단 (받은 데이터는 저장)`);
    else if (e instanceof OutOfBudget) log(`⏸  이번 실행 요청 한도(${MAX_REQUESTS}) 도달 — 다음 실행 때 이어서`);
    else log(`❌ ${e.message}`);
  }

  for (const t of targets) {
    const folded = fold(t.st, t.windows, now);
    const b = t.st.back;
    const state = !b ? '아직 시작 전' : b.done ? '끝' : `${new Date(b.t + 9 * 3600e3).toISOString().slice(0, 10)}까지`;
    log(`   ${t.m.name}: 방송별 요약 ${Object.keys(t.st.old).length}개${folded ? ` (접음 ${folded})` : ''}, 예전 채우기 ${state}`);
  }
  await mkdir(path('data', 'clips'), { recursive: true });
  for (const t of targets) {
    const text = serialize(t.st);
    if (text !== t.before) await writeFile(t.file, text); // 바뀐 멤버 파일만 다시 쓴다
  }
  log(`치지직 클립 요청 ${used}회`);
  if (stop instanceof Blocked) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
