# 우리동네가로수

시민이 동네 가로수를 공동보호자로 맡아 기록하는 시민참여형 도시숲 플랫폼의 연구용 데모와 데이터 파이프라인.
전북대학교 데이터커뮤니케이션연구소.

- **웹 데모**: https://khytv.github.io/woori-garosu/ (전주 가로수 37,952그루, 서버 없는 정적 사이트)
- **분석 보고서**: https://khytv.github.io/woori-garosu/report/jeonju.html

> 탄소 수치는 일부 계수가 검증 전 가정값이라 방법 시연용이다. 보고서나 정책 근거로 인용하지 않는다.

## 웹 데모 (`docs/`)

GitHub Pages가 `main` 브랜치의 `docs/`를 그대로 배포한다.

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

```bash
.venv/Scripts/python -m pipeline.extract_region --input data/raw/forest_service_street_trees_20250826.csv
.venv/Scripts/python -m pipeline.run_all --input data/raw/jeonju_extract.csv --kind real \
    --summary data/raw/jeonju_extract_summary.json --label "전주시 가로수 (산림청 2025-08-26판)"
.venv/Scripts/python -m pipeline.export_web
```

전주 원본에서 확인한 것(2026-09-30 실행):

- 전국 1,051,259행 중 시군구명이 빈 행 67,503행(전북). 전주 경계 안 37,972행 → 2016년 전주시 발표 57,950그루의 66%
- 흉고 끝자리 0·5 비율 72.4%(고르게 분포하면 약 20%)
- 같은 도로구간·수종에서 같은 흉고가 10그루 이상 반복되는 나무 89% → 구간 대표값 일괄 입력 의심. 탄소 계산에서 흉고 오차를 15%로 잡는다(`dbh_error_cv_block`)
- 가로내녹지유형·도로변녹지유형·기후대·입지 4개 항목이 전부 '기타'

## 구조

| 경로 | 내용 |
|---|---|
| `config/species.csv` | 수종 정규화(별칭), 학명, 상대생장식 대리 수종군, 생장 유형, 성숙 수고 등급 |
| `config/carbon_params.json` | 계수·범위·출처·검증 상태, 시나리오 |
| `config/boundaries/jeonju_osm.geojson` | 전주시 경계(OpenStreetMap relation 7619919, ODbL) |
| `pipeline/make_sample.py` | 산림청 스키마의 합성 샘플(전북대 주변 가상 구간 5개, 결측·이상치 포함) |
| `pipeline/extract_region.py` | 전국 원본에서 한 도시의 행만 추출(시군구명 또는 행정경계) |
| `pipeline/etl.py` | 수종·흉고 정제, 좌표계 변환(WGS84), 범위·중복·일괄 입력 검사, 품질 등급 A/B/C/X |
| `pipeline/carbon.py` | 몬테카를로 탄소 추정, 단일값 계산, 원천별 기여도, 시나리오 |
| `pipeline/aggregate.py` | 100 m 격자 배정(UTM-K) |
| `pipeline/export_itree.py` | i-Tree Eco v6 가져오기용 CSV |
| `pipeline/report.py`, `web/report_template.html` | 결과 보고서 |
| `pipeline/export_web.py` | 웹 데모용 정적 데이터(`docs/data`)와 보고서(`docs/report`) |
| `docs/` | 웹 데모(GitHub Pages) |
| `tests/` | 파이프라인 테스트(pytest), 브라우저 계산 대조(`web_parity.mjs`) |

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

가로수 원자료 산림청(공공데이터포털) · 전주시 경계 © OpenStreetMap contributors (ODbL 1.0) ·
배경지도 © OpenFreeMap, © OpenStreetMap contributors · 지도 라이브러리 MapLibre GL JS ·
생장·보정 방법 Nowak (2021) *Understanding i-Tree*, GTR-NRS-200-2021
