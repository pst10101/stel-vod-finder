// 클립 → 다시보기 장면 위치 계산 확인:  node test/clips.test.mjs
import assert from 'node:assert/strict';
import { parseKst } from '../scripts/lib.mjs';
import { broadcastWindow, windowsFor, findWindow, offsetOf, emptySummary, addClip, mergeSummary, hotSpots, forSite, summariesFor, LEAD_SEC, BIN_SEC, TOP_KEEP } from '../scripts/clips.mjs';

// 실제 예: 리제 2026-11-11 방송 (다시보기 16132502, 길이 6153초)과 그날 만들어진 클립 3개
const video = { no: 16132502, pub: 1794408358617, open: null, dur: 6153 };
const win = broadcastWindow(video);
assert.equal(win.start, video.pub - 6153 * 1000); // 게시 시각 = 방송 끝 → 길이를 빼면 시작
assert.equal(win.end, video.pub);
assert.equal(broadcastWindow({ no: 1, pub: 5000, open: 1000, dur: 2 }).start, 1000); // 시작 시각이 응답에 있으면 그걸 쓴다
assert.equal(broadcastWindow({ no: 1, pub: 5000, dur: 0 }), null);

const windows = windowsFor([video, { no: 16100000, pub: video.pub - 2 * 86400e3, dur: 4000 }]);
assert.deepEqual(windows.map((w) => w.no), [16100000, 16132502]);

const during = parseKst('2026-11-11 23:13:53'); // "휴~" — 방송 중에 만든 클립
const nearEnd = parseKst('2026-11-11 23:43:38'); // 방송 끝나기 직전
const after = parseKst('2026-11-11 23:54:27'); // 방송이 끝나고 8분 뒤 → 위치를 알 수 없음
assert.equal(findWindow(windows, during)?.no, 16132502);
assert.equal(findWindow(windows, nearEnd)?.no, 16132502);
assert.equal(findWindow(windows, after), null);
assert.equal(findWindow(windows, win.start - 1000), null); // 방송 시작 전
assert.equal(findWindow(windows, win.end + 4 * 60e3)?.no, 16132502); // 끝난 직후 몇 분은 방송 중 클립으로 본다
assert.equal(findWindow([], during), null);

// 방송 시작 후 1:10:27에 만든 클립 → 그보다 LEAD_SEC 앞에서부터 보여준다
const made = Math.round((during - win.start) / 1000);
assert.equal(offsetOf(win, during), made - LEAD_SEC);
assert.equal(offsetOf(win, win.start + 30e3), 0); // 방송 초반 클립은 0초부터
assert.ok(offsetOf(win, win.end + 60e3) < win.dur); // 끝난 직후 클립도 영상 길이를 넘지 않는다

// 요약: 개수, 인기 클립, 구간별 개수
const clip = (id, at, views, title = id) => [id, at, 30, views, title];
const sum = emptySummary();
for (let i = 0; i < 30; i++) addClip(sum, win, clip('c' + i, win.start + (600 + i * 100) * 1000, i));
assert.equal(sum.n, 30);
assert.equal(sum.top.length, TOP_KEEP);
assert.equal(sum.top[0][1], 'c29'); // 조회수 많은 순으로 남는다
assert.equal(sum.bins.reduce((a, b) => a + b[1], 0), 30);

// 한 장면에 클립이 몰리면 "몰린 구간"으로 잡힌다
const hotSum = emptySummary();
for (let i = 0; i < 6; i++) addClip(hotSum, win, clip('h' + i, win.start + (3000 + i * 10) * 1000, 5));
for (let i = 0; i < 4; i++) addClip(hotSum, win, clip('s' + i, win.start + (400 + i * 700) * 1000, 50));
const hot = hotSpots(hotSum);
assert.equal(hot.length, 1);
assert.equal(hot[0][0], Math.floor((3000 - LEAD_SEC) / BIN_SEC) * BIN_SEC);
assert.equal(hot[0][1], 6);
const site = forSite(hotSum);
assert.equal(site.n, 10);
assert.deepEqual(site.t.map((x) => x[0]), [...site.t.map((x) => x[0])].sort((a, b) => a - b)); // 화면에는 시간순
assert.ok(site.t.some((x) => x[1] === 's0')); // 조회수 높은 클립은 꼭 들어간다
assert.deepEqual(site.h, hot);

// 나눠서 더한 요약을 합쳐도 한 번에 더한 것과 같다
const a = emptySummary();
const b = emptySummary();
const all = emptySummary();
for (let i = 0; i < 40; i++) {
  const c = clip('m' + i, win.start + (200 + i * 131) * 1000, (i * 37) % 23);
  addClip(i % 2 ? a : b, win, c);
  addClip(all, win, c);
}
const merged = mergeSummary(a, b);
assert.equal(merged.n, all.n);
assert.deepEqual([...merged.bins].sort((x, y) => x[0] - y[0]), [...all.bins].sort((x, y) => x[0] - y[0]));
assert.deepEqual(forSite(merged).t.map((x) => x[3]).sort(), forSite(all).t.map((x) => x[3]).sort());

// 멤버 상태 → 방송별 요약: 접어 둔 요약(old)과 낱개 클립(clips)을 합치고, 방송 밖 클립은 뺀다
const st = { old: { 16100000: { n: 2, top: [[10, 'x', 5, 9, '옛날']], bins: [[0, 2]] } }, clips: [clip('r1', during, 7), clip('r2', nearEnd, 3), clip('r3', after, 99)] };
const sums = summariesFor(st, windows);
assert.equal(sums.get(16132502).n, 2);
assert.equal(sums.get(16100000).n, 2);
assert.equal(st.old[16100000].n, 2); // 원본은 건드리지 않는다

console.log('clip tests ok');
