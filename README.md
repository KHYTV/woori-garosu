# 우리동네가로수

시민이 동네 가로수를 공동보호자로 맡아 기록하는 시민참여형 도시숲 플랫폼의 연구용 데모와 데이터 파이프라인.
전북대학교 데이터커뮤니케이션연구소.

- **웹 데모**: https://khytv.github.io/woori-garosu/ (전주 가로수 37,988그루 + OpenStreetMap 나무 271그루, 서버 없는 정적 사이트)
- **분석 보고서**: https://khytv.github.io/woori-garosu/report/jeonju.html

> 탄소 수치는 일부 계수가 검증 전 가정값이라 방법 시연용이다. 보고서나 정책 근거로 인용하지 않는다.

## 웹 데모 (`docs/`)

GitHub Pages가 `main` 브랜치의 `docs/`를 그대로 배포한다.

### 홈 앱 (`docs/index.html`, `docs/js/home.js`)

화면 설계는 디자인 후보 문서(「우리동네가로수 디자인 후보」)의 최종 추천안 **E(캐릭터 인트로) → D(지도 먼저)** 를 따른다(`docs/design.css`).
하단 탭은 처음 · 지도 · 내 나무 · 전주 현황 · 내 프로필 다섯이고(인트로에서도 보인다, 상단바는 뒤로 가기와 화면 이름만), 첫 화면은 '내 위치 보기' 한 가지 행동으로 지도 화면에 들어간다. 휴대폰 세로 화면 기준이다.

1. **인트로**: 전주 가로수를 수종별 캐릭터(상위 9종, 크기는 그루 수)로 요약한 시작 화면.
2. **전주 현황** (`#city`): 오늘 전주 가로수가 들이마시는 CO₂를 하루 단위로 보여 준다. 연간 흡수량을 서리 없는 생육기간(202일, 7월 20일 중심 사인 곡선)에
   나눠 배분한 가정값이다(`docs/js/daily.js`). 한 해 곡선, 수종별 캐릭터와 오늘 흡수량, 날씨 칩(Open-Meteo, 키 없음).
3. **지도 먼저** (`#map`, 옛 `#near`도 여기로): 화면 전체가 지도이고 위에 검색창(반경 200/300/500m 칩)·내 위치 버튼·수종 범례가 떠 있다. 아래 시트에 가까운 순 목록(상징색 아바타 · 수종 · 도로 · 지름 · 거리)이 있고, 점이나 줄을 누르면 시트가 그 나무의 카드(지름·높이·연간 CO₂ 타일, 현장 확인 안내, 친구 맺기 · 길찾기 · 사진/3D 버튼, 펼치면 식별 정보와 지도 주소)로 바뀐다. 지도에는 기준 위치(파랑), 반경(점선), 선택한 나무('여기서 n m')가 표시된다. 동·도로 이름은 `docs/data/places.json`(동 73개·도로 510개 중심 좌표) 색인으로, 번지·건물은
   OpenStreetMap Nominatim으로 찾는다. 반경 200/300/500m 안의 가로수를 가까운 순서로 '거리 풍경'에 실물풍 그림으로 늘어놓고,
   누르면 카드(흉고·추정 높이·연간 흡수 범위)와 '친구 맺기'가 뜬다. 내 위치(GPS)도 된다.
4. **나무 SNS** (`#sns`, `#tree/<id>`, `#chat/<id>`): 친구 맺은 나무마다 이름을 짓고, 프로필(기분·점수·레벨·오늘/함께한 뒤/돌보는 동안 흡수·내 실천 감축),
   인스타그램 DM 모양의 1:1 대화(나무가 규칙 기반으로 답하고, 날씨에 맞는 돌봄을 먼저 제안한다 `docs/js/talk.js`, `docs/js/weather.js`),
   돌봄 기록(물주기·주변 정리·뿌리 덮개·훼손 신고·둘레 재기·사진 관찰)과 생활 실천 기록(텀블러·대중교통·걷기·장바구니·전자영수증·잔반·절전·분리배출),
   사진 올리기(긴 변 1024px JPEG로 압축), 기록 피드. 활동마다 기여 점수가 쌓이고 생활 실천은 감축량(kgCO₂e)으로 환산해 피드에 붙는다.
5. **내 프로필** (`#profile`, `docs/js/profile.js`): 생활 실천 기록(텀블러·대중교통 등), 내 실천 기록과 활동별 횟수, 누적·이번 달 감축량,
   전체 점수·레벨, 닉네임과 온라인 참여 카드, 동네 순위. 생활 실천은 저장·서버 형식을 바꾸지 않으려고 지금처럼 친구 나무 한 그루에 붙는 활동으로 저장한다.
   기록할 때 함께할 나무를 고르며, 기본값은 `#profile?tree=<id>`(나무 프로필의 '생활 실천' 버튼) → 지난번에 고른 나무(`meta.practice-tree`) → 처음 친구 맺은 나무 순이다.
   친구 나무가 없으면 나무 찾기를 안내한다.

- 동네 전체 보기(`docs/js/area.js`): 검색에서 행정동·법정동을 고르면(`home.js`의 `choosePlace`) 반경 대신 그 동의 경계선과 옅은 채움을 그리고 화면을 경계에 맞춘 뒤,
  경계 안 **모든 가로수**를 수종 상징색 점으로 보여 준다(효자5동 7,060그루라 MapLibre GeoJSON 소스 + circle 레이어, id는 `area-` 접두어).
  아래 시트에는 '○○동 가로수 n그루', 수종 비율 막대와 수종별 그루 수, 동 가운데에서 가까운 순 목록(30그루씩, '더 보기'로 50그루씩 더)이 나온다.
  '동네 전체 | 반경 300m' 전환과 검색창의 반경 칩(동 전체 → 200 → 300 → 500m → 동 전체)으로 동 가운데 기준 반경 보기와 오간다.
  행정동의 나무는 `trees.json`의 동 배정(원본 경계)을 그대로 써서 카드의 '동'과 수가 같다. 장소는 좌표가 아니라 경계 이름(`dongName`, 없으면 `name`)으로 찾는다.
  경계는 `docs/data/dongs.geojson`(행정동 35개, 약 45KB): `python -m pipeline.export_dongs`가 행정동 원본을 이웃 동과 틈 없이 약 10m로 단순화해 만든다(원본과 최대 8m 차이,
  단순화한 경계로 다시 세면 전체 0.16%인 62그루가 이웃 동으로 바뀌는 정도). 법정동 경계는 넣지 못했다: OSM 전주 경계 안에는 법정동(admin_level 10) 경계가 없고,
  국가공간정보포털·브이월드 「법정구역경계(읍면동)」는 회원 키가 있어야 받을 수 있다. 그 파일을 GeoJSON(WGS84)으로 받아 `--jibun`으로 넘기면 `kind: "jibun"`으로 함께 들어간다.
  경계가 없는 법정동(예: 호성동1가)은 지금처럼 그 점 주변 반경 보기로 열리고, 행정동과 이름이 같은 법정동(서신동·금암동 등)은 행정동 경계로 보여 준다.
- 동 배정: 나무의 '동'은 좌표를 전주시 **행정동 경계 35개**(`config/boundaries/jeonju_hangjeongdong.geojson`, vuski/admdongkor ver20260701, 통계청·행안부 경계 기반)에 넣어 정한다.
  원본의 구간 시점·종점 글자에서 뽑은 법정동은 구간이 여러 동을 지나 틀리는 경우가 많아(예: 83488은 글자로는 진북동, 좌표로는 금암동) 검색 별칭(`places.json`의 `jibun`)으로만 쓴다.
  나무 카드의 '지도 주소'는 카드를 열 때 OpenStreetMap 역지오코딩으로 받은 도로명·법정동이며, 원본 도로명과 다르면 경고를 띄운다.
- 위치 확인(`docs/js/minimap.js`): 동네 찾기에는 기준 위치(주황)와 근처 나무(초록)를 찍은 작은 지도가, 나무 프로필에는 그 나무 한 그루의 지도가 붙는다
  (MapLibre + OpenFreeMap, 처음 쓸 때만 불러옴). 나무 카드에는 실물을 찾는 데 필요한 식별 정보 — 관리번호(산림청 시군구별 번호), 도로, 구간(시점 → 종점, `trees.json`의 `sections`),
  동, 좌표, 흉고, 품질 등급 — 와 카카오맵 보기·길찾기, 구글 지도, 연구용 전체 지도 링크가 있다.
- 친구 나무 지도(`docs/js/friends.js`, `docs/friends.css`): 큰 지도에 내 나무를 하트와 내가 지은 이름으로 늘 표시한다(검색 반경과 상관없이 `state.my`의 좌표로 그려, trees.json에 없는 나무도 보인다).
  확대 16 이상이면 화면 안 가로수를 점으로 불러와(최대 1,500그루) 어느 길의 나무든 눌러 친구를 맺을 수 있고, 16 미만이면 '이 지역 가로수 보기' 버튼이 뜬다.
  '내 나무' 칩은 친구 나무 목록(내 위치 또는 지도 가운데에서의 거리, 모두 보기)을 열고, 고르면 그 나무로 가서 카드를 연다. 나무 프로필의 '지도에서 보기'는 `#map?tree=<id>`로 같은 일을 한다.
- 사진·캐릭터·AR(`#photo/<id>`, `#ar/<id>`): 보호자가 사진을 올리면 실제 나무 사진과 캐릭터를 나란히 보여 주고, 'AR로 같이 보기'는 카메라 화면
  (없으면 고른 사진) 위에 캐릭터를 세워 끌기·크기 조절 뒤 합성해 '사진 관찰' 기록으로 저장한다. 실제 크기 3D 모형 AR(model-viewer)은 그대로 '3D · AR'.
  내 나무·동네 찾기 카드·이름 짓기 대화상자에도 캐릭터 전신 그림이 보인다.
- 캐릭터(마스코트) 그림은 디자인 후보의 수정 지침을 따른다: 밑동이 벌어진 줄기와 뿌리, 줄기에서 갈라지는 가지 3개, 둥근 덩어리 여러 개의 수관(아래는 짙게), 얼굴은 수관 가운데.
  색은 계절과 상관없는 수종 상징색(벚 주홍 · 은행 노랑 · 느티 초록(옆으로 넓게) · 이팝 연녹백 · 단풍 자주, `SIGNATURE`)이며, 지도 점과 목록 아바타도 같은 색을 쓴다. 실물풍 그림은 그대로 계절을 따른다.
- 수종별 캐릭터(`docs/js/characters.js`): 22종을 14개 원형(은행·벚·느티형·이팝·단풍·버즘·침엽 원뿔·향·히말라야시다·소나무·감·참·버들·아까시·모감주·목련·기타)으로
  그린다. 얼굴 있는 캐릭터 스타일과 잎·껍질 질감을 넣은 실물풍 스타일, 봄·여름·가을·겨울, 기분 7가지. 크기는 `config/tree_form.json`의 흉고→높이·수관폭 추정을 따른다.
  전체 목록은 `docs/characters.html`.
- 점수·환산 계수(`config/activities.json` → `docs/data/activities.json`): 활동별 점수, 레벨 구간, 하루 기록 한도(나무·활동당 3회), 생활 실천의 kgCO₂e 환산 계수.
  환산 계수는 흔히 인용되는 어림값이라 `status: assumption`이고 화면에 '추정'으로 표시한다. '돌보는 동안 흡수'는 돌봄 뒤 7일 동안의 일일 흡수량 합이며
  나무가 흡수한 양이지 돌봄으로 늘어난 양이 아니다(`protection.note`).
- 저장(`docs/js/db.js`): 내 나무·게시물(사진 Blob 포함)·대화를 IndexedDB `wg-sns`에 둔다. 옛 `wg-guardian`(localStorage) 보호자 기록은 처음 열 때 가져온다.

#### 온라인: 공동보호자 대화와 동네 순위 (`docs/js/cloud.js`, `supabase/sns_schema.sql`)

기기 저장은 그대로 두고, 참여를 켠 사람만 서버(Supabase)에 닉네임·내 나무(관리번호·이름·수종·동)·활동(종류·시각)만 올린다. 사진·메모·위치는 올리지 않는다.

- 기기마다 **익명 계정**(Supabase anonymous sign-in)을 만들어 RLS가 `auth.uid()`로 자기 행만 쓰게 한다. 공개 키만으로는 아무것도 못 쓴다.
- 점수·감축량은 클라이언트 값을 믿지 않고 `activity_catalog`(activities.json에서 생성)에서 트리거가 채운다. 하루 한도(나무·활동당 3회)와 메시지 한도(10분 30개)도 트리거가 막는다.
- 공동보호자 방(`#group/<id>`): 같은 나무를 친구 맺은 사람끼리만 읽고 쓰는 `tree_messages` + 그 나무의 최근 활동(`tree_activity_feed`)을 한 줄 이벤트로 섞어 보여 준다. 8초마다 새 글을 가져온다.
- 동네 순위(`dong_rankings` 보기, 내 프로필 화면): 최근 30일 활동을 동 단위로 모아 점수·보호자 수·감축량 순으로 매긴다. 보호자의 동은 참여할 때 고르고(내 나무의 동을 기본값으로), 활동의 동은 나무의 동이다.
- 서버가 꺼져 있거나 참여 전이면 모든 온라인 기능은 조용히 닫혀 있고, 기록은 기기에 남아 참여하는 순간 한꺼번에 올라간다(`client_id`로 중복 방지).

설정 순서:
1. Supabase 프로젝트 → **Authentication → Sign In / Providers → Anonymous sign-ins 켜기**.
2. SQL Editor에서 `supabase/sns_schema.sql` 실행(`python -m pipeline.sns_sql`로 다시 만들 수 있다). 연구4의 `study_schema.sql`과 같은 프로젝트여도 된다.
3. `docs/data/backend.json`에 Project URL과 **공개 키(anon/publishable)** 를 넣고 커밋. secret/service_role 키는 절대 넣지 않는다.
4. 익명 계정은 Authentication → Users에 쌓인다. 오래된 익명 사용자는 대시보드에서 정리한다.

개발 중에는 `python tests/mock_supabase.py 8791`(가짜 서버: 익명 로그인·표 REST·트리거 규칙 흉내)을 띄우고
`http://localhost:8790/?backend=http://localhost:8791&backendkey=test#sns`로 열면 서버 없이 전체 흐름을 볼 수 있다.

### 지도 (`docs/map.html`, `docs/js/app.js`, 연구용)

- 지도: MapLibre + OpenFreeMap 배경지도, 전주 가로수(확대 14 이하는 묶음 표시), 도로 이름 검색, 수종 필터, 내 위치
- 나무 카드: 연구2의 세 가지 탄소 표시 방식(① 단일값 ② 범위 ③ 범위+한계), 데이터로 만든 나무 이야기, 품질 등급
- 보호자·관찰 기록: 기기(localStorage)에만 저장. 흉고둘레를 입력하면 `docs/js/carbon.js`가 브라우저에서 범위를 다시 계산한다
- 요약: 전체·수종별 결과, 원본 데이터 감사 결과
- 3D 지도(`docs/js/map3d.js`): '3D' 버튼을 누르면 배경지도 건물을 높이대로 세우고, 확대 15 이상에서 화면 안 가로수를
  수종별 모양(원뿔형·둥근형·우산형)의 입체로 그린다. 색은 잎·단풍·겨울·연간 CO₂ 흡수 중에서 고른다.
  deck.gl 9.4는 3D를 처음 켤 때만 불러온다. 원본에 수고·수관폭이 없어 높이·수관폭은 흉고로 추정한 값이다
  (`config/tree_form.json`, 표시 전용이며 탄소 계산에는 쓰지 않음). 수종별 모양·단풍색은 `config/species.csv`에 있다.
- 나무 한 그루 3D·AR(`docs/js/tree3d.js`): 나무 카드의 '3D로 보기 · AR'. three.js 0.186으로 수종 모양·흉고·계절에 맞는
  모형을 만든다(봄 벚나무는 분홍 꽃, 이팝나무는 흰 꽃, 가을 단풍, 겨울 낙엽수는 가지만). 시간 슬라이더로 20년 뒤까지
  흉고 기댓값(`carbon.js`의 `projectDbh`, i-Tree 생장 규칙)에 따른 크기와 CO₂ 저장량 범위를 보여 준다. 키 1.7m 사람 모형으로 크기를 비교한다.
  AR은 같은 모형을 glTF로 내보내 model-viewer 4.3으로 실제 크기(`ar-scale="fixed"`)로 띄운다.
  안드로이드 Chrome(ARCore 지원 기기, WebXR)과 아이폰·아이패드 Safari(Quick Look, USDZ 자동 변환)에서 쓸 수 있다.
  모형을 브라우저에서 만들어 넘기기 때문에, WebXR이 안 되는 안드로이드 브라우저의 Scene Viewer 경로는 동작하지 않는다.

### 연구4 실험 모드 (`docs/study/`)

몰입형 표현이 장소애착·환경친화 행동의도에 미치는 효과를 보는 집단 간 실험(텍스트 / 이미지 / 몰입형 3D).

- 참가자 주소: `https://khytv.github.io/woori-garosu/study/` (앱 메뉴에는 링크하지 않음)
- 연구자 화면: `study/admin.html` — 조건별 완료·중단 수, 주의 점검 통과, 평균 노출 시간, CSV·JSON 저장, 시범 실행 링크
- 흐름: 동의 → 자극물(최소 노출 60초 뒤 '다음') → 설문 5개 화면(조작 점검 4, 장소애착 6, 행동의도 5, 정보 신뢰 2,
  주의 점검 1, 정보 회상 4, 인구 정보 4) → 참여 번호
- 정보량 통제: 세 조건 모두 같은 설명문(수종·크기·계절 변화·CO₂ 저장/흡수 범위·20년 뒤)을 본다.
  이미지 조건은 같은 3D 모형에서 같은 구도로 찍은 정지 그림 5장(봄·여름·가을·겨울·20년 뒤 여름)을,
  몰입형 조건은 같은 모형을 돌리고 계절·시간을 바꿀 수 있는 3D를 더 본다. AR은 노출 조건을 맞추려고 끈다.
- 배정: 기기별 블록 무작위(세 조건을 섞은 묶음을 차례로 소진). `?cond=text|image|immersive`로 고정하면 'forced'로 기록
- 기록: 노출 시간, 몰입형 조작(회전·계절 변경·시간 변경·본 계절·최대 연도), 문항 응답, 회상 정답 여부, 주의 점검, 화면 크기·터치 여부
- 저장: 응답은 항상 기기 브라우저(localStorage)에 먼저 저장하고, `study.json`의 `backend`(Supabase)가 설정돼 있으면
  단계마다 서버로도 보낸다. 실패한 전송은 기기에 '미전송'으로 남겨 다음 접속 때나 연구자 화면에서 다시 보낸다.
  `backend`를 비워 두면 기기 저장만 한다(실험실 기기 운영).
  외부 설문(Qualtrics 등)을 쓰려면 `external_survey_url`(또는 `?survey=`)에 주소를 넣는다. 자극물 뒤 참여 번호(`pid`)와 조건(`cond`)만 넘긴다.

#### Supabase 연결

1. supabase.com에서 프로젝트를 만든다(지역은 Northeast Asia (Seoul) 권장).
2. 대시보드 → SQL Editor에 `supabase/study_schema.sql` 내용을 붙여 넣고 실행한다(다시 실행해도 안전).
   문항을 바꾸면 `python -m pipeline.study_sql`로 다시 만들고 다시 실행한다.
3. Project Settings → API Keys에서 Project URL과 **Publishable key**(또는 legacy anon key)를 `docs/study/study.json`의
   `backend.url`, `backend.key`에 넣고 배포한다. **secret / service_role 키는 넣지 않는다**(공개 저장소다).
4. 원자료는 대시보드 Table Editor의 `study_responses_flat`(문항별 열)에서 CSV로 내보낸다.

보안: 응답 표(`study_responses`)는 RLS를 켜고 정책을 두지 않아 공개 키로는 읽기·쓰기가 안 된다.
참가자 화면은 `submit_study_record` 함수만 부르며(참여 번호 형식·실험 ID 검사, 64KB 제한, 완료된 응답 덮어쓰기 금지),
연구자 화면은 `study_counts`로 조건별 집계만 본다. 공개 키로 아무나 가짜 응답을 넣을 수는 있으므로
분석 전에 회차(`session`)·시각·주의 점검으로 걸러 낸다. 무료 플랜 프로젝트는 일정 기간 요청이 없으면 일시 정지되므로
수집 기간에는 대시보드에서 상태를 확인한다.

개발용 가짜 서버: `python tests/mock_supabase.py 8791` 후
`http://localhost:8790/study/?backend=http://localhost:8791&backendkey=test` (localhost에서만 주소로 서버를 바꿀 수 있음).
- 주소 옵션: `?session=회차이름`(기록에 남음), `?minsec=5`(시범 실행용 노출 시간, 실제 값은 기록에 남음)
- 동의서·문항은 `study/study.json`의 초안이다. IRB 승인 문구와 검증된 척도 번안본으로 바꾼 뒤 본 실험에 쓴다.
  대상 나무는 `tree_id`(현재 명륜1길 느티나무 83428)로 바꾼다.

```bash
.venv/Scripts/python -m pipeline.export_web       # data/out/jeonju_extract → docs/data, 보고서 → docs/report
node tests/web_parity.mjs                         # 브라우저 계산이 파이썬 결과와 같은지 대조
python -m http.server 8790 --directory docs       # http://localhost:8790
```

## 데이터 파이프라인

산림청 「도시숲가로수관리 가로수 현황」 형식의 CSV를 받아 정제·품질 감사·나무별 탄소 범위 계산·집계를 하고,
i-Tree Eco 교차검증용 파일과 결과 보고서(HTML)를 만든다.

- 탄소 계산은 자체 파이프라인으로 한다(비용 0, 범위 표시 가능).
- i-Tree Eco 데스크톱은 검증용으로 한 번 돌린다(`itree_eco_import.csv`).
- 데이터 스키마는 i-Tree Eco 입력 항목과 호환되게 유지해, i-Tree가 중단돼도 데이터가 남게 한다.

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m pipeline.run_all                      # 합성 샘플(없으면 생성)
.venv/Scripts/python -m pytest -q
```

### 전주 실데이터

원본: 공공데이터포털 「산림청_도시숲가로수관리 가로수 현황」 2025-08-26판(파일명 `가로수_20250826.csv`, 143MB, CP949, 이용 제한 없음).
`data/raw/forest_service_street_trees_20250826.csv`로 저장한다(저장소에는 올리지 않는다). 전주 추출본 `data/raw/jeonju_extract.csv`는 저장소에 있다.

원본은 전북 지역 행의 시군구명이 비어 있어 이름으로 전주를 찾을 수 없다.
`extract_region`이 시군구명이 빈 행 중 전주 행정경계(OpenStreetMap, `config/boundaries/jeonju_osm.geojson`) 안의 좌표를 고른다.
경계선과 산림청 좌표가 조금 어긋나 경계 바로 밖(최대 약 170m)에 찍힌 전주 나무 36그루(콩쥐팥쥐로·번영로·춘향로·구이로 등, 구간 주소가 전주 동이고 관리번호가 전주 번호대)가 있어
경계 밖 300m까지 받아들인다(`--buffer-m`, 기본 300). 시군구명이 빈 행 중 전주 경계 3km 안에 드는 것은 이 36행뿐이라 이웃 시군 나무는 섞이지 않는다.

```bash
.venv/Scripts/python -m pipeline.extract_region --input data/raw/forest_service_street_trees_20250826.csv
.venv/Scripts/python -m pipeline.run_all --input data/raw/jeonju_extract.csv --kind real \
    --summary data/raw/jeonju_extract_summary.json --label "전주시 가로수 (산림청 2025-08-26판)"
.venv/Scripts/python -m pipeline.export_web
```

전주 원본에서 확인한 것(2026-09-30 실행):

- 전국 1,051,259행 중 시군구명이 빈 행 67,503행(전북). 전주 경계 안 37,972행 + 경계 밖 300m 안 36행 = 38,008행(지도 37,988그루, 중복 20행 제외) → 2016년 전주시 발표 57,950그루의 66%
- 재추출로 확인(2026-11-04): 좌표계 오표기(5186↔5179·5174)·X/Y 뒤바뀜으로 다시 풀어도 전주로 들어오는 행은 없고, 좌표 결측 행(좌표계 빈 24,184행 포함)은 모두 다른 시군구라 원본 안에서 더 찾을 전주 나무는 없다.
  전주 관리번호는 61422–115931인데 그 사이 16,558개 번호가 비어 있고(특히 63104–75350, 107563–110986) 빈 번호대의 행은 원본 어디에도 없다 → 원본에 올라오지 않은 전주 나무가 있다는 단서
- 전주시 노선별 가로수 현황(공공데이터포털 15080618, 2026-03-17, 완산구 공원녹지과 148개 노선, 좌표 없음)은 완산구 23,728그루로 지도의 완산구 23,483그루와 비슷하다.
  그래서 2016년 발표치와의 차이(약 2만 그루)는 주로 덕진구 쪽이다(지도 덕진구 14,609그루, 산림청 14,520). 노선 단위로는 지도에 한 그루도 없는 완산구 노선이 34개(1,614그루, 거마평로·신봉로·송정로·삼천천변1길·효천중앙로 등)다
- 흉고 끝자리 0·5 비율 72.4%(고르게 분포하면 약 20%)
- 같은 도로구간·수종에서 같은 흉고가 10그루 이상 반복되는 나무 89% → 구간 대표값 일괄 입력 의심. 탄소 계산에서 흉고 오차를 15%로 잡는다(`dbh_error_cv_block`)
- 가로내녹지유형·도로변녹지유형·기후대·입지 4개 항목이 전부 '기타'

#### 보충 자료: OpenStreetMap 나무(`pipeline/osm_trees.py`)

OSM에 점으로 그려진 나무(`natural=tree`, 2026-11-03 기준 전주 345그루)를 `data/raw/jeonju_osm_trees.csv`로 받아 두고(ODbL 1.0, © OpenStreetMap contributors),
`export_web`이 산림청 나무와 5m 안에서 겹치는 것(같은 수종이거나 OSM 수종이 미상이면 같은 나무로 봄, 74그루)을 빼고 271그루를 더한다.
수종은 4그루만 있고(나머지 '기타'), 흉고는 없어 **등급 C(탄소 계산 제외, '흉고 미상' 표시)** 이며 관리번호·도로 정보도 없다(`trees.json`의 `rd`가 null).
한옥마을(풍남동·노송동)과 혁신동에 몰려 있다. 줄로 그린 가로수(`natural=tree_row`, 245개)는 그루 수·위치가 없어 쓰지 않는다.
`trees.json`의 `src`(`srcs` = forest/osm 번호)로 출처를 구분하며, OSM 행은 ODbL을 따른다.

```bash
.venv/Scripts/python -m pipeline.osm_trees           # Overpass에서 다시 받기(키 없음)
.venv/Scripts/python -m pipeline.export_web
.venv/Scripts/python -m pipeline.coverage --markdown  # 공백 진단: 행정동·전북대 캠퍼스·생활권 300m·완산구 노선 대조
```

검토했지만 쓰지 않은 자료: 전주시 노선별 가로수 현황(좌표 없음, 대조에만 사용 `data/raw/jeonju_city_street_trees_wansan_20260317.csv`),
행정안전부 보호수정보(localdata 파일 서버가 자동 내려받기를 막음, 보호수는 가로수가 아님), 산림청 보호수 지정현황(시도 집계표),
전북대 캠퍼스 수목 공개 자료(찾지 못함, OSM에도 캠퍼스 안 나무 점은 0그루).

#### 공백 진단(`pipeline/coverage.py`, 2026-11-04)

| 구역(반경 300m) | 반영 전 | 반영 후 |
|---|---:|---:|
| 전북대학교(캠퍼스 중심) | 13 | 13 |
| 한옥마을(경기전 앞) | 275 | 360 |
| 전주역 | 147 | 155 |
| 서부신시가지(도청) | 633 | 633 |
| 전주시청 | 222 | 227 |
| 에코시티(세병공원) | 0 | 0 |
| 혁신도시(국민연금공단) | 0 | 0 |
| 전북대 캠퍼스 경계 안(130.9ha) | 108 | 108 |
| 행정동 효자2동 / 혁신동 / 호성동 | 0 / 114 / 127 | 0 / 204 / 127 |

전북대 캠퍼스(OSM way 35424732, `config/boundaries/jbnu_campus_osm.geojson`) 안 108그루는 모두 캠퍼스를 지나는 시 도로(창포길 85·조경단로 23)의 가로수이고 교내 길·건물 주변 나무는 0그루다. 산림청 자료는 시가 관리하는 도로변 가로수만 다루므로 캠퍼스 안·공원·신규 개발지(에코시티·혁신도시 중심 300m 0그루, 효자2동 0그루)는 원본 자체가 비어 있다. 이 공백은 시민 직접 등록으로 채워야 한다.

## 구조

| 경로 | 내용 |
|---|---|
| `config/species.csv` | 수종 정규화(별칭), 학명, 상대생장식 대리 수종군, 생장 유형, 성숙 수고 등급 |
| `config/carbon_params.json` | 계수·범위·출처·검증 상태, 시나리오 |
| `config/boundaries/jeonju_osm.geojson` | 전주시 경계(OpenStreetMap relation 7619919, ODbL) |
| `config/boundaries/jeonju_hangjeongdong.geojson` | 전주시 행정동 경계 35개(vuski/admdongkor, 통계청·행안부 경계 기반) — 나무의 동 배정용 |
| `pipeline/make_sample.py` | 산림청 스키마의 합성 샘플(전북대 주변 가상 구간 5개, 결측·이상치 포함) |
| `pipeline/extract_region.py` | 전국 원본에서 한 도시의 행만 추출(시군구명 또는 행정경계) |
| `pipeline/etl.py` | 수종·흉고 정제, 좌표계 변환(WGS84), 범위·중복·일괄 입력 검사, 품질 등급 A/B/C/X |
| `pipeline/carbon.py` | 몬테카를로 탄소 추정, 단일값 계산, 원천별 기여도, 시나리오 |
| `pipeline/aggregate.py` | 100 m 격자 배정(UTM-K) |
| `pipeline/export_itree.py` | i-Tree Eco v6 가져오기용 CSV |
| `pipeline/report.py`, `web/report_template.html` | 결과 보고서 |
| `pipeline/osm_trees.py` | OpenStreetMap 나무 점 받기·수종 매칭·산림청 나무와 중복 제거(보충 자료) |
| `pipeline/coverage.py` | 공백 진단: 행정동·전북대 캠퍼스·주요 생활권 반경 안 그루 수, 전주시 노선별 현황 대조 |
| `config/boundaries/jbnu_campus_osm.geojson` | 전북대학교 전주캠퍼스 경계(OpenStreetMap way 35424732, ODbL) — 공백 진단용 |
| `pipeline/export_dongs.py` | 홈 앱 '동네 전체 보기'용 동 경계 `docs/data/dongs.geojson`(행정동 35개, 약 10m 단순화) |
| `pipeline/export_web.py` | 웹 데모용 정적 데이터(`docs/data`: 나무·요약·계수·장소 색인·활동 계수)와 보고서(`docs/report`) |
| `config/activities.json` | SNS 활동 점수, 레벨, 생활 실천 감축 환산 계수(검증 전) |
| `docs/` | 웹 데모(GitHub Pages). `index.html` 홈 앱, `map.html` 지도, `characters.html` 캐릭터 목록, `study/` 연구4 실험 |
| `docs/js/` | `home.js` 화면 흐름, `profile.js` 내 프로필(생활 실천·동네 순위), `characters.js` 캐릭터, `daily.js` 일일 흡수, `geo.js` 동네 찾기, `weather.js` 날씨·돌봄 제안, `talk.js` 나무 대화, `db.js` 기기 저장, `carbon.js` 탄소, `map3d.js`·`tree3d.js` 3D |
| `tests/` | 파이프라인 테스트(pytest), 브라우저 계산 대조(`web_parity.mjs`), 홈 모듈 검사(`web_home.mjs`: 캐릭터 2,112장·일일 흡수·색인·날씨 제안) |

## 출력 (`data/out/<입력 파일 이름>/`, 저장소에는 올리지 않음)

| 파일 | 내용 |
|---|---|
| `carbon_profiles.csv` | 나무별 정제값·등급·CO2 저장량/연간 흡수량 p10·p50·p90·단일값 |
| `trees.geojson` | 지도 표시용(등급 X 제외) |
| `results.json` | 품질 감사, 전체·구간·수종·격자 합계, 기여도, 시나리오, 서울 트리맵 대조 |
| `itree_eco_import.csv` | i-Tree Eco 가져오기용(수고·수관폭·광노출·고사율은 현장에서 채움) |
| `report.html` | 결과 보고서(한 파일) |

## 계산 방식

지상부 건중량 = exp(b0 + b1·ln DBH)·exp(잔차) (Jenkins 등 2003 수종군 식)
CO2 = 지상부 × 도시보정 × (1 + 뿌리비) × 탄소비율 × 44/12
연간 흡수량 = CO2(DBH) − CO2(DBH − 연간 직경생장량)
연간 직경생장량 = 표준생장(느림 0.58 / 보통 0.84 / 빠름 1.09 cm) × 서리 없는 기간/153 × 수관 광노출 계수 × (1 − 고사율) × 크기 계수

생장 규칙과 크기 계수는 i-Tree 방법서(Nowak 2021, GTR-NRS-200-2021, 43–44쪽)를 따른다.
최대 흉고는 성숙 수고 등급별 38.1 / 76.2 / 114.3cm이고, 흉고가 최대 흉고의 80%를 넘으면
생장을 선형으로 줄여 125%에서 2.22%가 되게 한다. 수종별 성숙 수고 등급(`species.csv`)과
전주 서리 없는 기간(190–215일), 부분 차광 비율(20%)은 가정값이다.

계통 오차(도시보정·뿌리비·탄소비율·수종 대리군·서리 기간)는 추출마다 모든 나무가 공유하고,
개체 오차(흉고 측정·잔차·광노출·생장 편차)는 나무마다 따로 뽑는다. 합계 범위가 지나치게 좁아지지 않게 하기 위해서다.

## 주의

- 합성 샘플은 실제 나무가 아니다.
- `carbon_params.json`에서 `status`가 `to_verify` 또는 `assumption`인 값은 검증 전이다.
  Jenkins 계수는 원문 대조, 범위값은 문헌 확인 후 교체한다.
- 전주 원본의 행정동 집계는 통계청 SGIS 경계를 받은 뒤 추가한다(현재는 도로구간·격자 집계).
- 큰 나무 생장 둔화는 i-Tree 규칙대로 반영했다(0.2.0). 전주에서는 102그루만 둔화 대상이라 전체 흡수량이 0.4%만 줄었다.
  흉고 60cm 이상 604그루(1.6%)가 여전히 흡수량의 9.7%를 차지한다.
- 0.1 → 0.2에서 생장 가정을 i-Tree 표준생장 × 전주 서리 기간 보정(약 ×1.32)으로 바꿔 전주 연간 흡수량 중앙값이 988 → 1,393t으로 늘었다.
  서리 없는 기간은 기상청 전주(146) 서리 자료로 확정해야 한다.

## 출처

가로수 원자료 산림청(공공데이터포털, 이용허락범위 제한 없음) · 보충 나무(natural=tree)·전주시 경계·전북대 캠퍼스 경계 © OpenStreetMap contributors (ODbL 1.0) ·
전주시 노선별 가로수 현황(공공데이터포털, 이용허락범위 제한 없음, 대조용) ·
배경지도 © OpenFreeMap, © OpenStreetMap contributors · 지도 라이브러리 MapLibre GL JS ·
생장·보정 방법 Nowak (2021) *Understanding i-Tree*, GTR-NRS-200-2021
