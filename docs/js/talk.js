// 나무가 보호자에게 보내는 말. 규칙 기반이라 서버 없이 바로 답한다.
import { careSuggestions, weatherLabel } from "./weather.js";

export function josa(word, withFinal, withoutFinal) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code < 11172 && code % 28 !== 0;
  return word + (hasFinal ? withFinal : withoutFinal);
}
// 1kg 미만은 g, 10kg 미만은 소수 한 자리
const kg = v => (Math.abs(v) < 1 ? `${Math.round(v * 1000)}g` : Math.abs(v) < 10 ? `${v.toFixed(1)}kg` : `${Math.round(v).toLocaleString("ko-KR")}kg`);
const pick = (arr, seed = Date.now()) => arr[Math.floor((seed / 1000) % arr.length)];

const SEASON_LINE = {
  spring: ["새잎이 돋는 중이에요. 하루가 다르게 초록이 짙어져요.", "꽃가루가 날리는 때라 가끔 재채기가 나요. 농담이에요."],
  summer: ["해가 길어서 요즘 제일 바쁘게 일해요. 하루 중 한낮에 CO₂를 가장 많이 들이마셔요.", "뿌리 쪽 흙이 금방 말라요. 물이 제일 고마운 계절이에요."],
  autumn: ["잎 색을 바꾸는 중이에요. 올해 일은 거의 끝나가요.", "낙엽이 떨어지면 제 뿌리를 덮어 주는 이불이 돼요."],
  winter: ["지금은 쉬는 계절이에요. 잎이 없어서 흡수량은 거의 0이지만, 뿌리는 봄을 준비해요.", "겨울눈 속에 벌써 내년 잎이 들어 있어요."],
};

// 처음 친구가 됐을 때
export function greeting(ctx) {
  const { tree, weather, season } = ctx;
  const lines = [`안녕하세요, ${ctx.guardianName ? ctx.guardianName + "님" : "보호자님"}! 저는 ${tree.road}에 서 있는 ${josa(tree.species, "이에요", "예요")}. ${tree.name}라고 불러 주셔서 고마워요.`];
  if (tree.dbh) lines.push(`줄기 지름은 ${Math.round(tree.dbh)}cm쯤이고, 한 해에 CO₂를 약 ${kg(tree.annualKg)} 들이마셔요.`);
  if (weather) {
    const w = weatherLabel(weather.current.code);
    lines.push(`지금 전주는 ${w.icon} ${w.text}, ${Math.round(weather.current.temp)}℃예요.`);
  }
  lines.push(pick(SEASON_LINE[season] || SEASON_LINE.summer));
  return lines.join(" ");
}

// 날씨·계절에 맞춰 먼저 건네는 제안
export function proactive(ctx) {
  const s = careSuggestions({ weather: ctx.weather, season: ctx.season, measured: ctx.measured, lastCareDays: ctx.lastCareDays, species: ctx.tree.species });
  if (!s.length) return null;
  return { text: s[0].text, activity: s[0].activity, why: s[0].why };
}

// 보호자가 보낸 말에 답하기(키워드 규칙)
export function reply(text, ctx) {
  const t = text.trim();
  const { tree, weather, season, todayKg, yearKg, practiceKg, points } = ctx;
  const has = (...ws) => ws.some(w => t.includes(w));
  if (has("안녕", "하이", "헬로", "반가")) return `안녕하세요! 오늘도 와 주셔서 좋아요. ${pick(SEASON_LINE[season] || SEASON_LINE.summer)}`;
  if (has("이름")) return `${tree.name}, 마음에 들어요. 프로필에서 언제든 바꿔 주셔도 돼요.`;
  if (has("몇 살", "나이", "언제 심")) return `제 나이는 기록에 없어요. 줄기 지름 ${Math.round(tree.dbh)}cm로 보면 ${tree.dbh < 12 ? "아직 어린 편" : tree.dbh < 30 ? "한창 자라는 중" : "꽤 오래 자란 나무"}이에요.`;
  if (has("키", "높이", "얼마나 커")) return `정확한 키는 재지 않았지만 줄기 굵기로 어림하면 ${tree.heightM ? Math.round(tree.heightM) + "m" : "10m 안팎"}쯤 돼요.`;
  if (has("탄소", "co2", "CO2", "흡수", "얼마나")) {
    return `오늘은 약 ${kg(todayKg)}, 올해 들어 약 ${kg(yearKg)}의 CO₂를 들이마셨어요. 한 해로 치면 약 ${kg(tree.annualKg)}이에요(추정값이에요).`;
  }
  if (has("점수", "레벨", "포인트")) return `지금까지 ${points}점이에요. 돌봄과 생활 실천을 기록할 때마다 올라가요.`;
  if (has("실천", "감축", "줄였")) return `보호자님의 생활 실천으로 지금까지 약 ${kg(practiceKg)}을 줄였어요. 저와 함께하는 숫자예요.`;
  if (has("물", "목말")) {
    if (weather?.flags?.dry || weather?.flags?.heat) return "네, 사실 요즘 목이 말라요. 한 통만 천천히 부어 주시면 뿌리까지 스며들어요. 물을 주셨으면 '돌봄 기록'에 남겨 주세요.";
    return "요즘은 비가 적당히 와서 괜찮아요. 그래도 주신다면 고맙게 마시죠.";
  }
  if (has("더워", "덥", "폭염")) return weather?.flags?.heat ? "오늘 정말 더워요. 그늘을 만드는 게 제 일이지만, 저도 그늘이 필요할 지경이에요. 아침저녁 물이 큰 도움이 돼요." : "오늘은 견딜 만해요. 제 그늘에서 쉬다 가세요.";
  if (has("추워", "춥", "한파", "눈")) return weather?.flags?.freeze ? "뿌리 쪽에 제설제가 쌓이지 않게만 해 주시면 겨울은 잘 넘겨요." : "겨울눈을 단단히 감싸고 있어서 괜찮아요.";
  if (has("사진")) return "지금 모습을 사진으로 남겨 주세요. 계절마다 모이면 제 한 해 앨범이 돼요. '사진 올리기'에서 할 수 있어요.";
  if (has("고마", "감사", "사랑")) return "저도요. 보호자님이 오실 때마다 잎이 조금 더 반짝이는 것 같아요.";
  if (has("날씨", "비", "바람")) {
    if (!weather) return "지금은 날씨 정보를 못 받아왔어요. 잠시 뒤 다시 물어봐 주세요.";
    const w = weatherLabel(weather.current.code);
    return `지금은 ${w.icon} ${w.text}, ${Math.round(weather.current.temp)}℃, 바람 ${Math.round(weather.current.wind)}m/s예요. 지난 7일 비는 ${weather.past7Rain}mm 왔어요.`;
  }
  if (has("뭐 해", "뭐해", "할 일", "도와", "해줄")) {
    const s = proactive(ctx);
    return s ? s.text : "오늘은 특별히 급한 일은 없어요. 지나가다 한 번 봐 주시는 것만으로도 좋아요.";
  }
  if (has("?", "？")) return "음, 그건 제가 잘 몰라요. 물, 날씨, 탄소, 점수, 사진에 대해서는 대답할 수 있어요.";
  return pick(["네, 듣고 있어요. 바람 소리에 섞여 잘 들려요.", "오늘도 이야기해 줘서 고마워요.", `${pick(SEASON_LINE[season] || SEASON_LINE.summer)}`]);
}

// 활동을 기록했을 때 나무의 반응
export function reaction(activity, ctx) {
  const { tree, todayKg, protectedKg, practiceKg, points, gainedPoints, gainedKg } = ctx;
  const head = {
    water: "고마워요, 뿌리까지 시원해졌어요.",
    tidy: "주변이 깨끗해지니 숨쉬기 편해요.",
    mulch: "뿌리 이불 덕분에 흙이 촉촉하게 오래가겠어요.",
    report: "알려 주셔서 고마워요. 시에서 와서 봐 주면 좋겠어요.",
    measure: "제 둘레를 직접 재 주셨네요! 이제 제 탄소 이야기가 훨씬 정확해졌어요.",
    observe: "사진 잘 받았어요. 오늘의 제 모습이 기록으로 남았어요.",
  }[activity.id] || "기록해 주셔서 고마워요.";
  const parts = [head];
  if (activity.kind === "practice") {
    if (gainedKg > 0) parts.push(`이번 실천으로 약 ${kg(gainedKg)}(추정)을 줄였어요. 보호자님의 실천 감축은 모두 ${kg(practiceKg)}이에요.`);
    else parts.push("이 실천은 감축량을 숫자로 매기지 않지만 점수는 드려요.");
  } else {
    parts.push(`오늘 저는 약 ${kg(todayKg)}의 CO₂를 들이마셨고, 보호자님이 돌봐 주시는 동안 들이마신 양은 ${kg(protectedKg)}이 됐어요.`);
  }
  parts.push(`+${gainedPoints}점, 모두 ${points}점이에요.`);
  return parts.join(" ");
}
