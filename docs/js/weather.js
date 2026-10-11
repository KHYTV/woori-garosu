// 전주 날씨(Open-Meteo, 키 없음)와 날씨에 맞는 돌봄 제안
const KEY = "wg-weather-v1";
const TTL_MS = 60 * 60 * 1000;

const CODES = [[0, "맑음", "☀️"], [1, "대체로 맑음", "🌤️"], [2, "구름 조금", "⛅"], [3, "흐림", "☁️"], [45, "안개", "🌫️"], [48, "안개", "🌫️"],
  [51, "이슬비", "🌦️"], [53, "이슬비", "🌦️"], [55, "이슬비", "🌦️"], [61, "비", "🌧️"], [63, "비", "🌧️"], [65, "강한 비", "🌧️"],
  [71, "눈", "🌨️"], [73, "눈", "🌨️"], [75, "많은 눈", "❄️"], [80, "소나기", "🌦️"], [81, "소나기", "🌧️"], [82, "강한 소나기", "⛈️"], [95, "뇌우", "⛈️"], [96, "뇌우", "⛈️"], [99, "뇌우", "⛈️"]];
export function weatherLabel(code) {
  const hit = CODES.find(([c]) => c === code) || CODES.find(([c]) => c > code) || CODES[0];
  return { text: hit[1], icon: hit[2] };
}

function summarize(raw) {
  const days = raw.daily.time.map((date, k) => ({ date, tmax: raw.daily.temperature_2m_max[k], tmin: raw.daily.temperature_2m_min[k],
    rain: raw.daily.precipitation_sum[k] ?? 0, wind: raw.daily.wind_speed_10m_max[k] ?? 0 }));
  const todayIdx = days.findIndex(d => d.date === raw.current.time.slice(0, 10));
  const past = days.slice(Math.max(0, todayIdx - 7), todayIdx);
  const today = days[todayIdx] || days[0];
  const past7Rain = past.reduce((a, d) => a + d.rain, 0);
  const next = days.slice(todayIdx + 1, todayIdx + 3);
  const flags = {
    dry: past7Rain < 5 && today.tmax >= 22,
    heat: today.tmax >= 33,
    freeze: today.tmin <= -5,
    storm: today.wind >= 12 || next.some(d => d.wind >= 12),
    heavyRain: today.rain >= 30 || past.slice(-1).some(d => d.rain >= 30),
    rainSoon: next.some(d => d.rain >= 5),
  };
  return { fetchedAt: Date.now(), current: { temp: raw.current.temperature_2m, code: raw.current.weather_code, wind: raw.current.wind_speed_10m, precip: raw.current.precipitation },
    today, past7Rain: Math.round(past7Rain * 10) / 10, next, flags };
}

export async function fetchWeather(lon = 127.148, lat = 35.824) {
  try {
    const cached = JSON.parse(localStorage.getItem(KEY));
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  } catch { /* 캐시 없음 */ }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&wind_speed_unit=ms&past_days=7&forecast_days=3&timezone=Asia%2FSeoul`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`weather ${r.status}`);
  const w = summarize(await r.json());
  try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* 저장 못 해도 됨 */ }
  return w;
}

/**
 * 오늘 날씨·계절·나무 상태에 맞는 돌봄 제안. 앞에 올수록 급하다.
 * @returns [{activity, text, why}]
 */
export function careSuggestions({ weather, season, measured = false, lastCareDays = null, species = "" }) {
  const out = [];
  const f = weather?.flags || {};
  if (f.heat) out.push({ activity: "water", text: "오늘 33도가 넘어요. 해 지기 전이나 이른 아침에 물 한 통 부탁해요.", why: `최고 ${Math.round(weather.today.tmax)}℃` });
  if (f.dry && !f.heat) out.push({ activity: "water", text: `일주일 동안 비가 ${weather.past7Rain}mm밖에 안 왔어요. 뿌리 주변에 물을 천천히 부어 주세요.`, why: "7일 강수량 5mm 미만" });
  if (f.storm) out.push({ activity: "report", text: "바람이 세게 불 예보예요. 지지대와 가지가 흔들리는지 봐 주세요.", why: "최대풍속 12m/s 이상" });
  if (f.heavyRain) out.push({ activity: "report", text: "큰비가 왔어요. 뿌리 쪽 흙이 파이거나 나무가 기울지 않았는지 봐 주세요.", why: "하루 강수량 30mm 이상" });
  if (f.freeze) out.push({ activity: "tidy", text: "한파예요. 제 뿌리 쪽에 제설제(염화칼슘)가 쌓이지 않게 치워 주시면 좋아요.", why: `최저 ${Math.round(weather.today.tmin)}℃` });
  if (f.dry && season === "summer") out.push({ activity: "mulch", text: "흙이 마르기 쉬운 때예요. 낙엽이나 나무껍질로 뿌리 주변을 덮어 주면 물이 오래가요.", why: "건조" });
  if (!measured) out.push({ activity: "measure", text: "제 흉고는 아직 아무도 직접 재지 않았어요. 1.2m 높이의 둘레를 줄자로 재 주시면 제 탄소 이야기가 훨씬 정확해져요.", why: "흉고 미측정" });
  if (season === "spring") out.push({ activity: "observe", text: "새잎과 꽃이 나오는 때예요. 지금 모습을 사진으로 남겨 주세요.", why: "봄" });
  if (season === "autumn") out.push({ activity: "observe", text: "잎 색이 바뀌고 있어요. 단풍 사진을 남겨 주시면 한 해 기록이 돼요.", why: "가을" });
  if (season === "winter") out.push({ activity: "observe", text: "잎이 없을 때는 가지 모양이 잘 보여요. 부러진 가지가 있는지 봐 주세요.", why: "겨울" });
  if (lastCareDays === null || lastCareDays > 14) out.push({ activity: "tidy", text: "제 주변에 쓰레기나 담배꽁초가 쌓이지 않았는지 한 번 봐 주세요.", why: "정기 점검" });
  return out.slice(0, 3);
}
