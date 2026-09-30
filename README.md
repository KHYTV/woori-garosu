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
