// 전설의 길 (E6, #86, docs/spec PKM-26): which legends a breakthrough (PKM-24) and 전설의 향 can bring.
// Per generation, the share of its ordinary species (not legendary / mythical) you have caught:
// 50 % opens its legends, 80 % its cover legends too. The three Gen-1 birds are open from the start.
// Plain facts about the games (numbers, Korean names) — no Pokémon pictures or data files here.
const GENS = [
  { gen: 1, region: "관동", from: 1, to: 151 },
  { gen: 2, region: "성도", from: 152, to: 251 },
  { gen: 3, region: "호연", from: 252, to: 386 },
  { gen: 4, region: "신오", from: 387, to: 493 },
  { gen: 5, region: "하나", from: 494, to: 649 },
];
const LEGENDS = {
  144: "프리저", 145: "썬더", 146: "파이어", 150: "뮤츠",
  243: "라이코", 244: "앤테이", 245: "스이쿤", 249: "루기아", 250: "칠색조",
  377: "레지락", 378: "레지아이스", 379: "레지스틸", 380: "라티아스", 381: "라티오스", 382: "가이오가", 383: "그란돈", 384: "레쿠쟈",
  480: "유크시", 481: "엠라이트", 482: "아그놈", 483: "디아루가", 484: "펄기아", 485: "히드런", 486: "레지기가스", 487: "기라티나", 488: "크레세리아",
  638: "코바르온", 639: "테라키온", 640: "비리디온", 641: "토네로스", 642: "볼트로스", 643: "레시라무", 644: "제크로무", 645: "랜드로스", 646: "큐레무",
};
const MYTHICALS = { 151: "뮤", 251: "세레비", 385: "지라치", 386: "테오키스", 489: "피오네", 490: "마나피", 491: "다크라이", 492: "쉐이미", 493: "아르세우스", 494: "비크티니", 647: "케르디오", 648: "메로엣타", 649: "게노세크트" };
const COVERS = new Set([150, 249, 250, 382, 383, 384, 483, 484, 487, 643, 644, 646]); // open at 80 %
const START = new Set([144, 145, 146]); // open from the start (the first breakthrough is already a legend)
const OPEN_AT = 0.5, COVER_AT = 0.8;

const genOf = (id) => GENS.find((g) => id >= g.from && id <= g.to);
const special = (id) => id in LEGENDS || id in MYTHICALS;
const nameOf = (id) => LEGENDS[id] || MYTHICALS[id] || `#${id}`;
const ordinary = GENS.map((g) => { let n = 0; for (let i = g.from; i <= g.to; i++) if (!special(i)) n++; return n; });

// each generation: caught / ordinary, and its legends with open / owned (caught: species ids you caught,
// owned: species you have now — a legend comes once a species)
function road(caught, owned = new Set()) {
  return GENS.map((g, i) => {
    let got = 0;
    for (const id of caught) if (id >= g.from && id <= g.to && !special(id)) got++;
    const share = got / ordinary[i];
    const legends = Object.keys(LEGENDS).map(Number).filter((id) => id >= g.from && id <= g.to).map((id) => ({
      id, name: LEGENDS[id], cover: COVERS.has(id), owned: owned.has(id),
      open: START.has(id) || (COVERS.has(id) ? share >= COVER_AT : share >= OPEN_AT),
    }));
    return { ...g, got, of: ordinary[i], pct: Math.floor(share * 100), legends };
  });
}
const openLegends = (caught, owned) => road(caught, owned).flatMap((g) => g.legends.filter((l) => l.open));

module.exports = { GENS, LEGENDS, MYTHICALS, COVERS, road, openLegends, nameOf, special, genOf, isLegend: (id) => id in LEGENDS, isMythical: (id) => id in MYTHICALS };
