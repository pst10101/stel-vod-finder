// 치지직 다시보기 목록 수집
//   node scripts/fetch-chzzk.mjs          → 증분 (새 영상만)
//   node scripts/fetch-chzzk.mjs --full   → 전체 다시 수집 (삭제·비공개된 영상 정리)
//
// 치지직 웹사이트가 내부적으로 쓰는 비공식 API를 사용한다.
// 원칙: 공개 메타데이터만 저장, 영상·썸네일 저장 안 함, 요청 간격 유지, 막히면 즉시 중단.
import { path, readJSON, writeJSON, getJSON, HttpError, sleep, parseKst, normName, loadMembers, log } from './lib.mjs';

const API = process.env.CHZZK_API_BASE || 'https://api.chzzk.naver.com';
const HEADERS = {
  'User-Agent': process.env.CHZZK_USER_AGENT || 'Mozilla/5.0 (compatible; stel-vod-finder/1.0; non-commercial fan site)',
  Accept: 'application/json',
};
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 1500);
const PAGE_SIZE = 50;
const MAX_PAGES = 300;
const FULL = process.argv.includes('--full');

class Blocked extends Error {}

async function call(url) {
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

async function resolveChannelId(member, idCache) {
  if (member.chzzk) return member.chzzk;
  if (idCache[member.key]) return idCache[member.key];
  // members.json에 ID가 비어 있으면 채널 검색으로 "이름이 정확히 같은" 채널만 찾는다.
  const content = await call(`${API}/service/v1/search/channels?keyword=${encodeURIComponent(member.name)}&offset=0&size=10`);
  const hit = (content?.data || []).map((d) => d.channel || d).find((c) => normName(c.channelName) === normName(member.name));
  if (!hit) {
    log(`⚠️  ${member.name}: 채널 ID를 못 찾음 → members.json에 직접 넣어줘`);
    return null;
  }
  log(`🔎 ${member.name}: 채널 ID ${hit.channelId} (검색으로 찾음, members.json에 넣어두면 확실함)`);
  idCache[member.key] = hit.channelId;
  return hit.channelId;
}

function allowed(v) {
  if (v.adult) return false; // 연령 제한
  if (v.blindType) return false; // 블라인드 처리
  if (v.paidProductId) return false; // 유료·구독자 전용
  // 참고: exposure는 공개 다시보기도 false로 와서 공개 여부 판단에 쓰면 안 됨
  return true;
}

function normalize(v) {
  const pub = Number.isFinite(v.publishDateAt) ? v.publishDateAt : parseKst(v.publishDate);
  const open = parseKst(v.liveOpenDate);
  return {
    no: v.videoNo,
    title: (v.videoTitle || '').trim(),
    type: v.videoType || null, // REPLAY(다시보기) / UPLOAD(업로드)
    cat: v.videoCategoryValue || v.videoCategory || '',
    pub, // 게시 시각
    open: open ?? null, // 라이브 시작 시각 (응답에 있을 때만)
    dur: v.duration || 0, // 초
  };
}

async function fetchMember(member, channelId, known) {
  const fresh = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const content = await call(
      `${API}/service/v1/channels/${channelId}/videos?sortType=LATEST&pagingType=PAGE&page=${page}&size=${PAGE_SIZE}`,
    );
    const data = content?.data || [];
    let sawKnown = false;
    for (const v of data) {
      if (known.has(v.videoNo)) sawKnown = true;
      if (allowed(v)) fresh.push(normalize(v));
    }
    const totalPages = content?.totalPages ?? 0;
    if (data.length === 0 || page + 1 >= totalPages) break;
    if (!FULL && sawKnown) break; // 증분: 이미 아는 영상이 나오면 거기서 멈춤
  }
  return fresh;
}

async function main() {
  const members = await loadMembers();
  const cachePath = path('data', 'chzzk.json');
  const cache = await readJSON(cachePath, { updatedAt: null, members: {} });
  const idCache = await readJSON(path('data', 'channel-ids.json'), {});
  let blocked = false;

  for (const m of members) {
    if (blocked) break;
    try {
      const channelId = await resolveChannelId(m, idCache);
      if (!channelId) continue;
      const prev = cache.members[m.key]?.videos || [];
      const known = new Set(prev.map((v) => v.no));
      const fetched = await fetchMember(m, channelId, known);

      let videos;
      if (FULL || prev.length === 0) {
        // 전체 수집 결과가 기존보다 터무니없이 적으면 API 이상일 수 있으니 기존 유지
        if (prev.length > 20 && fetched.length < prev.length * 0.5) {
          log(`⚠️  ${m.name}: 전체 수집 결과가 ${fetched.length}개로 기존 ${prev.length}개보다 너무 적어서 기존 데이터 유지`);
          videos = mergeById(prev, fetched);
        } else videos = fetched;
      } else {
        videos = mergeById(prev, fetched);
      }
      videos.sort((a, b) => (b.pub ?? 0) - (a.pub ?? 0));
      const added = videos.length - prev.length;
      cache.members[m.key] = { channelId, videos };
      log(`✅ ${m.name}: ${videos.length}개${added ? ` (${added > 0 ? '+' : ''}${added})` : ''}`);
    } catch (e) {
      if (e instanceof Blocked) {
        blocked = true;
        log(`⛔ ${m.name}: ${e.message} — 요청이 막혀서 이번 실행은 여기서 중단 (받은 데이터는 저장)`);
      } else {
        log(`❌ ${m.name}: ${e.message}`);
      }
    }
  }

  cache.updatedAt = Date.now();
  await writeJSON(cachePath, cache);
  await writeJSON(path('data', 'channel-ids.json'), idCache);
  if (blocked) process.exitCode = 1;
}

function mergeById(prev, fresh) {
  const map = new Map(prev.map((v) => [v.no, v]));
  for (const v of fresh) map.set(v.no, v); // 제목·카테고리 수정 반영
  return [...map.values()];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
