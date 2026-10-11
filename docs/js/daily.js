// 연간 CO₂ 흡수량(kg/년)을 하루 단위로 나눈다.
// 가정: 흡수는 서리 없는 생육기간(params.growth.frost_free_days.center 일, 7월 20일을 중심으로) 동안만 일어나고,
// 그 안에서 사인 곡선 모양으로 한여름에 가장 많다. 겨울의 흡수량은 0으로 본다. 검증 전 가정이며 표시용이다.
const DAY_MS = 86400000;
const PEAK_DOY = 201; // 7월 20일

export function dayOfYear(date) {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  return Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / DAY_MS) + 1;
}
export function seasonWindow(P) {
  const length = Math.round(P?.growth?.frost_free_days?.center ?? 202);
  const start = PEAK_DOY - Math.round(length / 2);
  return { start, end: start + length - 1, length };
}
// 하루 가중치(한 해 합이 1)
export function dailyWeight(date, P) {
  const { start, length } = seasonWindow(P);
  const d = dayOfYear(date) - start;
  if (d < 0 || d >= length) return 0;
  const norm = Array.from({ length }, (_, k) => Math.sin(Math.PI * (k + 0.5) / length)).reduce((a, b) => a + b, 0);
  return Math.sin(Math.PI * (d + 0.5) / length) / norm;
}
export const dailyUptake = (annualKg, date, P) => annualKg * dailyWeight(date, P);

// from(포함)부터 to(포함)까지 날마다의 흡수량 합. 해가 바뀌어도 된다
export function uptakeBetween(annualKg, from, to, P) {
  let sum = 0;
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  for (let guard = 0; d <= end && guard < 4000; guard++, d.setDate(d.getDate() + 1)) sum += dailyWeight(d, P);
  return annualKg * sum;
}
export const cumulativeThisYear = (annualKg, date, P) => uptakeBetween(annualKg, new Date(date.getFullYear(), 0, 1), date, P);

// 한 해 365일의 일일 흡수량(작은 그래프용)
export function yearProfile(annualKg, year, P) {
  const out = [];
  for (let doy = 1; doy <= 365; doy++) out.push(annualKg * dailyWeight(new Date(year, 0, doy), P));
  return out;
}
