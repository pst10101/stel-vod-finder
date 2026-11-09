// 수집한 데이터 → 사이트용 docs/data/broadcasts.json
// 치지직 다시보기와 유튜브 다시보기를 "같은 멤버 + 같은 날짜/시각"으로 묶는다.
//   node scripts/build.mjs
import { path, readJSON, writeJSON, kstDate, log } from './lib.mjs';

const H = 3600 * 1000;
const LIVE_MATCH_MS = 2 * H; // 유튜브 라이브 시작과 치지직 방송 시작 차이 허용
const SEG_MATCH_MS = 20 * 60 * 1000; // 카테고리 기록과 다시보기 시작 차이 허용

// 치지직 응답에 라이브 시작 시각이 없으면 게시 시각이 시작인지 종료인지 애매해서 둘 다 후보로 본다.
function starts(c) {
  if (c.open) return [c.open];
  return c.dur ? [c.pub, c.pub - c.dur * 1000] : [c.pub];
}
const startOf = (c) => c.open ?? c.pub;
const closest = (list, t) => Math.min(...list.map((x) => Math.abs(x - t)));

async function main() {
  const cfg = await readJSON(path('members.json'));
  const members = cfg.members.filter((m) => m.enabled !== false);
  const chzzk = await readJSON(path('data', 'chzzk.json'), { updatedAt: null, members: {} });
  const youtube = await readJSON(path('data', 'youtube.json'), { updatedAt: null, channels: {} });
  const segments = await readJSON(path('data', 'segments.json'), {});

  const ytByMember = {};
  for (const ch of Object.values(youtube.channels)) {
    for (const v of ch.videos || []) (ytByMember[v.m] ||= new Map()).set(v.id, v);
  }

  const items = [];
  const stats = { chzzk: 0, youtube: 0, matched: 0, ytOnly: 0, segments: 0 };

  for (const m of members) {
    const cz = (chzzk.members[m.key]?.videos || []).filter((c) => c.pub);
    const yts = [...(ytByMember[m.key]?.values() || [])];
    stats.chzzk += cz.length;
    stats.youtube += yts.length;

    const czBcs = cz.map((c) => ({ m: m.key, s: startOf(c), t: c.title, c: { n: c.no, k: c.cat, u: c.dur, r: c.type }, y: [], _c: c }));
    const bcs = [...czBcs];
    const ytOnlyByDate = new Map(); // 같은 날 나눠 올린 유튜브 다시보기(1부/2부)는 한 방송으로

    // 유튜브 → 치지직 짝짓기 (오래된 것부터 해야 1부·2부 순서가 맞음)
    yts.sort((a, b) => (a.liveStart ?? a.pub) - (b.liveStart ?? b.pub));
    for (const v of yts) {
      let best = null;
      if (v.liveStart) {
        let bestScore = Infinity;
        for (const b of czBcs) {
          const score = closest(starts(b._c), v.liveStart);
          if (score < bestScore) [best, bestScore] = [b, score];
        }
        if (bestScore > LIVE_MATCH_MS) best = null;
      } else if (v.titleDate) {
        // 시작 시각 날짜가 같은 방송을 먼저 찾고, 없을 때만 "게시 시각이 종료 시각일 경우"까지 본다.
        let same = czBcs.filter((b) => kstDate(startOf(b._c)) === v.titleDate);
        if (!same.length) same = czBcs.filter((b) => starts(b._c).some((t) => kstDate(t) === v.titleDate) && !b.y.length);
        best = same.sort((a, b) => b._c.dur - a._c.dur)[0] || null;
      }
      const y = { i: v.id, t: v.title, u: v.dur };
      if (v.liveStart) y.ls = v.liveStart;
      if (v.chapters?.length) y.ch = v.chapters;
      if (best) {
        best.y.push(y);
        if (v.liveStart && !best._c.open && !best._ls) best.s = best._ls = v.liveStart; // 시작 시각 보정
        stats.matched++;
      } else if (!v.liveStart && v.titleDate && ytOnlyByDate.has(v.titleDate)) {
        ytOnlyByDate.get(v.titleDate).y.push(y);
        stats.ytOnly++;
      } else {
        // 짝이 없는 유튜브 다시보기 (트위치 시절 등) → 따로 한 방송으로
        const s = v.liveStart ?? (v.titleDate ? Date.parse(v.titleDate + 'T12:00:00+09:00') : v.pub);
        const b = { m: m.key, s, t: v.title, y: [y], _c: null, _d: v.titleDate || kstDate(v.liveStart ?? v.pub) };
        if (!v.liveStart && !v.titleDate) b.a = 1; // 날짜가 업로드일 기준이라 부정확할 수 있음
        if (!v.liveStart && v.titleDate) ytOnlyByDate.set(v.titleDate, b);
        bcs.push(b);
        stats.ytOnly++;
      }
    }

    // 방송 중 카테고리 기록 붙이기 (2단계)
    for (const sess of segments[m.key] || []) {
      let best = null;
      let bestScore = Infinity;
      for (const b of bcs) {
        const cands = b._c ? starts(b._c) : b.y.map((y) => y.ls).filter(Boolean);
        if (!cands.length) continue;
        const score = closest(cands, sess.open);
        if (score < bestScore) [best, bestScore] = [b, score];
      }
      if (!best || bestScore > SEG_MATCH_MS) continue;
      best.o = sess.open;
      best.s = sess.open; // 정확한 시작 시각으로 보정
      best.g = sess.changes.map(([t, cat]) => [Math.max(0, Math.round((t - sess.open) / 1000)), cat]);
      stats.segments++;
    }

    for (const b of bcs) {
      b.d = b._d || kstDate(b.s);
      delete b._c;
      delete b._d;
      delete b._ls;
      if (!b.y.length) delete b.y;
      items.push(b);
    }
  }

  items.sort((a, b) => b.s - a.s);
  // 사이트 하단 "삭제 요청" 링크: CONTACT_URL 변수가 있으면 그것, 없으면 이 저장소의 이슈
  const contactEnv = (process.env.CONTACT_URL || '').trim();
  const repo = process.env.GITHUB_REPOSITORY;
  const contact = /^https?:\/\//.test(contactEnv) ? contactEnv : repo ? `https://github.com/${repo}/issues` : null;

  const out = {
    updatedAt: Math.max(chzzk.updatedAt || 0, youtube.updatedAt || 0) || Date.now(),
    contact,
    members: members.map(({ key, name, unit, graduated }) => ({ key, name, unit, ...(graduated ? { graduated } : {}) })),
    items,
  };
  await writeJSON(path('docs', 'data', 'broadcasts.json'), out, { compact: true });
  log(
    `방송 ${items.length}개 — 치지직 ${stats.chzzk}, 유튜브 ${stats.youtube} (치지직과 매칭 ${stats.matched}, 유튜브만 ${stats.ytOnly}), 카테고리 기록 ${stats.segments}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
