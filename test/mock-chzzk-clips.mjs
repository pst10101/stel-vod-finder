// 테스트용 가짜 치지직 클립 API. 실제 응답과 같은 모양으로, clipUID 커서(그 클립 다음부터)로 쪽을 넘긴다.
//   node test/mock-chzzk-clips.mjs <fixture.json> [포트]
//   → CHZZK_API_BASE=http://127.0.0.1:포트 REQUEST_DELAY_MS=0 node scripts/fetch-clips.mjs
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const port = Number(process.argv[3] || 8780);
const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

createServer((req, res) => {
  const fx = JSON.parse(readFileSync(file, 'utf8')); // 요청마다 다시 읽어서 파일을 고치면 "조회수가 바뀐 상황" 등을 만들 수 있다
  const u = new URL(req.url, 'http://x');
  const m = /^\/service\/v1\/channels\/([^/]+)\/clips$/.exec(u.pathname);
  res.writeHead(200, { 'content-type': 'application/json' });
  if (!m) return res.end(JSON.stringify({ code: 404, message: 'not found', content: null }));
  const all = (fx[m[1]] || []).slice().sort((a, b) => b.at - a.at);
  const size = Number(u.searchParams.get('size') || 15);
  const cursor = u.searchParams.get('clipUID');
  const from = cursor ? all.findIndex((c) => c.id === cursor) + 1 : 0;
  if (cursor && from === 0) return res.end(JSON.stringify({ code: 500, message: 'unknown cursor', content: null }));
  const data = all.slice(from, from + size);
  const more = from + size < all.length;
  res.end(
    JSON.stringify({
      code: 200,
      message: null,
      content: {
        size,
        page: { next: more ? { clipUID: data[data.length - 1].id } : null, prev: null },
        data: data.map((c) => ({
          clipUID: c.id, videoId: 'X'.repeat(32), clipTitle: c.title, ownerChannelId: m[1], ownerChannel: null,
          thumbnailImageUrl: 'https://example.invalid/t.jpg', categoryType: 'ETC', clipCategory: 'talk', duration: c.dur,
          adult: !!c.adult, createdDate: kst(c.at), recId: '{}', readCount: c.views, blindType: c.blind || null, privateUserBlock: false,
        })),
        hasStreamerClips: false,
        hasAiGeneratedClips: false,
      },
    }),
  );
}).listen(port, '127.0.0.1', () => console.log('mock chzzk clips on', port));
