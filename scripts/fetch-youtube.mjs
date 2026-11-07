// 유튜브 다시보기 수집 (YouTube Data API v3 — 공식 API, 키 필요)
//   YOUTUBE_API_KEY=... node scripts/fetch-youtube.mjs          → 증분
//   YOUTUBE_API_KEY=... node scripts/fetch-youtube.mjs --full   → 전체 새로고침
//
// 키가 없으면 아무것도 안 하고 넘어간다. (치지직만 쓰는 것도 가능)
// YouTube API 정책상 저장한 데이터는 주기적으로 새로 받아야 해서, 워크플로가 매주 --full을 돌린다.
import { path, readJSON, writeJSON, getJSON, HttpError, redact, log } from './lib.mjs';
import { isoDuration, parseChapters, parseTitleDate, titleMentions } from './parse.mjs';

const KEY = process.env.YOUTUBE_API_KEY;
const API = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const FULL = process.argv.includes('--full');
const BUDGET = Number(process.env.YOUTUBE_QUOTA_BUDGET || 8000); // 하루 기본 한도 10,000 중 여유 두고
const MIN_LONG_SEC = 40 * 60; // 라이브가 아닌 업로드는 40분 이상만 다시보기로 봄

let used = 0;
class QuotaStop extends Error {}

async function yt(endpoint, params) {
  if (used >= BUDGET) throw new QuotaStop(`이번 실행 한도(${BUDGET}) 도달`);
  const u = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', KEY);
  used += 1; // channels / playlistItems / videos 모두 1회 = 1 유닛
  try {
    return await getJSON(u);
  } catch (e) {
    if (e instanceof HttpError && e.status === 403 && /quota/i.test(e.body)) throw new QuotaStop('YouTube 일일 한도 초과');
    if (e instanceof HttpError) throw new Error(`${e.message} ${e.body.slice(0, 200)}`);
    throw new Error(redact(e.message));
  }
}

async function resolveChannel(ref) {
  const params = { part: 'snippet,contentDetails' };
  if (/^UC[\w-]{22}$/.test(ref)) params.id = ref;
  else params.forHandle = ref.startsWith('@') ? ref : '@' + ref;
  const res = await yt('channels', params);
  const ch = res.items?.[0];
  if (!ch) throw new Error(`채널을 못 찾음: ${ref}`);
  return { id: ch.id, title: ch.snippet?.title || '', uploads: ch.contentDetails.relatedPlaylists.uploads };
}

async function listUploadIds(uploads, known) {
  const ids = [];
  let pageToken = '';
  for (let i = 0; i < 400; i++) {
    const res = await yt('playlistItems', {
      part: 'contentDetails',
      playlistId: uploads,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    let sawKnown = false;
    for (const it of res.items || []) {
      const id = it.contentDetails?.videoId;
      if (!id) continue;
      if (known.has(id)) sawKnown = true;
      else ids.push(id);
    }
    pageToken = res.nextPageToken;
    if (!pageToken || (!FULL && sawKnown)) break;
  }
  return ids;
}

async function details(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await yt('videos', { part: 'snippet,contentDetails,liveStreamingDetails', id: ids.slice(i, i + 50).join(',') });
    out.push(...(res.items || []));
  }
  return out;
}

function toEntry(v, member, channelId) {
  const live = v.liveStreamingDetails || {};
  const pub = Date.parse(v.snippet.publishedAt);
  return {
    id: v.id,
    ch: channelId,
    m: member,
    title: v.snippet.title,
    pub,
    liveStart: live.actualStartTime ? Date.parse(live.actualStartTime) : null,
    liveEnd: live.actualEndTime ? Date.parse(live.actualEndTime) : null,
    dur: isoDuration(v.contentDetails?.duration),
    titleDate: parseTitleDate(v.snippet.title, pub),
    chapters: parseChapters(v.snippet.description),
  };
}

// 다시보기로 볼 영상인지: 라이브였던 영상이거나 40분 이상 업로드
function classify(v, mode) {
  if (v.snippet.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none') return 'later'; // 예정·진행 중
  if (mode === 'all') return 'keep';
  if (v.liveStreamingDetails?.actualStartTime) return 'keep';
  if (isoDuration(v.contentDetails?.duration) >= MIN_LONG_SEC) return 'keep';
  return 'skip';
}

function channelRefs(cfg) {
  const refs = [];
  for (const m of cfg.members.filter((m) => m.enabled !== false)) {
    for (const r of m.youtube || []) {
      const o = typeof r === 'string' ? { channel: r } : r;
      refs.push({ ...o, member: m.key });
    }
  }
  for (const r of cfg.sharedYoutube || []) {
    const o = typeof r === 'string' ? { channel: r } : r;
    refs.push({ ...o, member: null }); // 공용 채널: 제목으로 멤버 구분
  }
  return refs;
}

async function main() {
  if (!KEY) {
    log('YOUTUBE_API_KEY가 없어서 유튜브 수집은 건너뜀');
    return;
  }
  const cfg = await readJSON(path('members.json'));
  const members = cfg.members.filter((m) => m.enabled !== false);
  const cachePath = path('data', 'youtube.json');
  const cache = await readJSON(cachePath, { updatedAt: null, channels: {} });
  const refs = channelRefs(cfg);
  if (refs.length === 0) log('members.json에 유튜브 채널이 하나도 없음');

  try {
    for (const ref of refs) {
      const slot = (cache.channels[ref.channel] ||= { videos: [], skip: [] });
      try {
        if (!slot.uploads || FULL) Object.assign(slot, await resolveChannel(ref.channel));
        const prev = FULL ? [] : slot.videos;
        const known = new Set(FULL ? [] : [...slot.videos.map((v) => v.id), ...slot.skip]);
        const ids = await listUploadIds(slot.uploads, known);
        const items = await details(ids);
        const kept = [];
        const skip = FULL ? [] : [...slot.skip];
        for (const v of items) {
          const c = classify(v, ref.mode);
          if (c === 'skip') skip.push(v.id);
          if (c !== 'keep') continue;
          let member = ref.member;
          if (!member) member = members.find((m) => titleMentions(v.snippet.title, m))?.key || null;
          if (!member) {
            skip.push(v.id);
            continue;
          }
          kept.push(toEntry(v, member, slot.id));
        }
        const map = new Map(prev.map((v) => [v.id, v]));
        for (const e of kept) map.set(e.id, e);
        slot.videos = [...map.values()].sort((a, b) => b.pub - a.pub);
        slot.skip = [...new Set(skip)].slice(-20000);
        slot.member = ref.member;
        log(`✅ ${slot.title || ref.channel}: 다시보기 ${slot.videos.length}개 (새로 ${kept.length})`);
      } catch (e) {
        if (e instanceof QuotaStop) throw e;
        log(`❌ ${ref.channel}: ${e.message}`);
      }
    }
  } catch (e) {
    if (!(e instanceof QuotaStop)) throw e;
    log(`⛔ ${e.message} — 다음 실행 때 이어서 수집`);
  }

  // members.json에서 빠진 채널 정리
  const live = new Set(refs.map((r) => r.channel));
  for (const k of Object.keys(cache.channels)) if (!live.has(k)) delete cache.channels[k];

  cache.updatedAt = Date.now();
  await writeJSON(cachePath, cache);
  log(`YouTube API 사용량: ${used} 유닛`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
