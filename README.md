# 스텔 다시보기 찾기

스텔라이브 멤버가 **어떤 게임을 한 방송인지** 검색해서 치지직·유튜브 다시보기로 바로 가는 비공식 팬사이트.

- 게임 이름이나 줄임말로 검색 (마크, 발로, 롤… → `docs/aliases.json`에서 추가 가능)
- 멤버·플랫폼·연도 필터, 검색 상태가 주소에 남아서 링크 공유 가능
- 치지직 다시보기와 같은 날 유튜브 다시보기를 자동으로 묶음
- 한 방송에서 여러 게임을 했으면 막대에서 그 구간이 노란색으로 표시되고, 유튜브는 그 시간으로 바로 이동

**구조**: GitHub Actions가 6시간마다 다시보기 목록을 수집해서 `docs/` 폴더를 갱신하고,
Cloudflare Pages가 그 `docs/` 폴더를 웹사이트로 띄운다. 서버가 따로 없고 비용은 0원.
방문자는 미리 만들어둔 파일만 받아서 자기 브라우저에서 검색하기 때문에, 방문자가 많아도
치지직·유튜브 API 사용량은 늘지 않는다.

## 처음 설정

### 1. GitHub 저장소
1. GitHub에서 저장소를 만들고 이 폴더 내용을 전부 올린다. (공개/비공개 둘 다 됨, 아래 "비공개 저장소" 참고)
2. Settings → Actions → General → Workflow permissions → **Read and write permissions** 선택 후 저장.
3. (선택) 유튜브 키 넣기 → 아래 "유튜브 다시보기 연결"
4. **첫 수집**: Actions 탭 → `update` → Run workflow → **전체 다시 수집** 체크 → 실행.
   끝나면 `docs/data/broadcasts.json`이 채워진 커밋이 생긴다.

### 2. Cloudflare Pages
1. [Cloudflare 대시보드](https://dash.cloudflare.com/) 가입/로그인 (카드 등록 필요 없음)
2. **Workers & Pages** → **Create application** → **Pages** → **Connect to Git** → GitHub 연결 → 이 저장소 선택
3. 빌드 설정
   - Project name: `stel-vod-finder` (→ 사이트 주소가 `stel-vod-finder.pages.dev`가 됨. 이미 있으면 다른 이름)
   - Production branch: `main`
   - Framework preset: **None**
   - Build command: **비워두기**
   - Build output directory: `docs`
4. **Save and Deploy**
5. 프로젝트 → Settings → Build → **Build watch paths** → Include에 `docs/*` 만 넣기
   (방송 기록 같은 데이터 커밋마다 쓸데없이 배포되는 걸 막음. 무료는 한 달 500번까지 배포 가능)

이후엔 6시간마다 새 다시보기만 받아오고, 매주 일요일 새벽에 전체를 새로 받아서 삭제된 영상을 정리한다.
데이터가 바뀔 때마다 Cloudflare가 알아서 사이트를 다시 배포한다.

### 사이트 하단 "삭제 요청" 링크
기본은 이 저장소의 GitHub 이슈로 연결된다. 다른 곳(이메일 폼, X 계정 등)으로 받고 싶으면
저장소 Settings → Secrets and variables → Actions → **Variables** 탭 → `CONTACT_URL` 변수에 주소를 넣는다.
(비공개 저장소면 남들이 이슈를 못 보니까 꼭 넣어줄 것)

### 비공개 저장소
Cloudflare Pages는 비공개 저장소도 연결된다. 코드와 GitHub 아이디를 숨기고 싶으면 비공개로 해도 된다.
다만 비공개 저장소는 GitHub Actions가 **한 달 2,000분**까지만 무료라서,
2단계(방송 중 카테고리 기록)를 켤 땐 `live.yml`의 간격을 `*/30`(30분)으로 늘려야 한도 안에 들어온다.
공개 저장소는 Actions 시간 제한이 없다.

### GitHub Pages로 띄우고 싶으면
Cloudflare 대신 GitHub Pages를 쓰려면: Settings → Pages → Source를 **GitHub Actions**로 하고,
Settings → Secrets and variables → Actions → Variables에 `USE_GITHUB_PAGES` = `true` 를 추가한다.
주소는 `아이디.github.io/저장소이름`. 공개 저장소에서만 무료, 한 달 트래픽 100GB 권장.

## 멤버 채널 ID (`members.json`)

`chzzk`가 비어 있으면 첫 수집 때 **이름이 정확히 같은 채널**을 검색해서 쓴다. 로그에 찾은 ID가 찍히니까,
확인해서 `members.json`에 직접 넣어두면 확실하다. 채널 ID는 치지직 채널 주소 `chzzk.naver.com/` 뒤 32자리.

멤버가 바뀌면 `members.json`에 줄을 추가하거나 `"enabled": false`로 끄면 된다.

## 유튜브 다시보기 연결

유튜브는 **공식 YouTube Data API**를 쓴다 (무료, 하루 10,000 유닛 — 이 사이트는 보통 몇십~몇백 유닛).

1. [Google Cloud Console](https://console.cloud.google.com/projectcreate)에서 프로젝트 만들기 (무료 체험 신청은 필요 없음)
2. [YouTube Data API v3 사용 설정](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
3. [사용자 인증 정보](https://console.cloud.google.com/apis/credentials) → API 키 만들기 → API 제한을 YouTube Data API v3만, 애플리케이션 제한은 없음
4. GitHub 저장소 Settings → Secrets and variables → Actions → New repository secret
   이름 `YOUTUBE_API_KEY`, 값에 키 붙여넣기. **키를 파일에 직접 쓰거나 커밋하면 안 됨.**
5. `members.json`에 다시보기 채널 넣기
   - 멤버 전용 채널: 그 멤버의 `"youtube": ["@핸들"]`
   - 여러 멤버를 같이 올리는 채널: `"sharedYoutube": ["@핸들"]` → 제목에 있는 멤버 이름으로 자동 구분

**날짜 맞추는 방식**
- 라이브로 올라간 다시보기 → 유튜브 방송 시작 시각과 치지직 방송 시작이 2시간 안이면 같은 방송
- 업로드된 다시보기 → 제목의 날짜(`2024.03.12`, `240312`, `3월 12일` 등)로 같은 날 치지직 방송과 연결
- 짝이 없으면 (트위치 시절 등) 유튜브 다시보기만 따로 한 방송으로 나옴
- 설명란에 `1:23:45 게임이름` 같은 타임라인이 있으면 구간으로 쓰고, 클릭하면 그 시간으로 이동

## (2단계) 방송 중 카테고리 기록

한 방송에서 5부까지 하면 치지직 다시보기엔 카테고리가 하나만 남는다. `live` 워크플로가 방송 중에
10분마다 카테고리를 확인해서 바뀐 시각을 `data/segments.json`에 쌓고, 다시보기와 자동으로 연결한다.

1. Actions → `live` → Run workflow로 한 번 돌려서 에러가 없는지 확인
2. `.github/workflows/live.yml`의 `schedule` 두 줄 앞 `#`을 지워서 켜기 (비공개 저장소면 `*/30`으로)

기록은 켠 이후 방송부터 쌓이고, 체크 간격만큼 몇 분 오차가 있다. 치지직 다시보기는 시간 지정 링크가 없어서
"몇 분부터"를 글자로 보여주고, 같은 방송의 유튜브 라이브 다시보기가 있으면 그 시간으로 바로 연결한다.

## 지키는 원칙

- 공개된 다시보기 정보(제목, 게임, 날짜, 길이)만 저장. **영상·썸네일은 저장하지 않고 원본으로 연결**
- 성인·블라인드·비공개 영상 제외
- 치지직 요청은 1.5초 간격, 처음 한 번만 전체 수집하고 이후엔 새 영상만. 403/429가 오면 즉시 중단
- 로그인 정보 없이 익명으로만 요청
- 비상업: 광고 없음. 스텔라이브 로고·공식 이미지 사용 안 함, 사이트에 비공식 표기
- 방문자 추적·분석 코드 없음
- 내려달라는 요청이 오면 바로 내림

치지직 다시보기 목록은 공식 Open API에 없어서 치지직 웹사이트가 쓰는 비공식 API를 쓴다. 구조가 바뀌면
수집이 멈출 수 있으니 Actions 로그를 가끔 확인할 것. 치지직 이용약관과 스텔라이브 2차 창작 가이드라인은
배포 전에 한 번 읽어보는 걸 권장.

## 파일 구조

```
members.json              멤버·채널 설정
scripts/fetch-chzzk.mjs   치지직 다시보기 수집
scripts/fetch-youtube.mjs 유튜브 다시보기 수집 (공식 API)
scripts/track-live.mjs    (2단계) 방송 중 카테고리 기록
scripts/build.mjs         치지직·유튜브 매칭 → docs/data/broadcasts.json
data/                     수집 캐시 (Actions가 자동 커밋)
docs/                     사이트 (index.html, app.js, style.css, aliases.json)
```

로컬에서 돌려보기 (Node 20 이상):
```sh
node scripts/fetch-chzzk.mjs --full
YOUTUBE_API_KEY=키 node scripts/fetch-youtube.mjs --full
node scripts/build.mjs
cd docs && python -m http.server 8000   # → http://localhost:8000
```
