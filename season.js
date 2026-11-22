// Seasonality of produce grown in Belgium (open ground + common greenhouse crops).
// Only produce that is actually grown in Belgium is listed: imported produce (citrus, mango, ...) has no
// Belgian season and is ignored. Year-round items (aardappel, ui, wortel, knoflook, champignon, ...) carry
// no signal and are ignored too.
//
// Months are 1..12. `range(9, 2)` wraps around the year end (sep..feb).
// This table is a first approximation: refine freely.

const range = (a, b) => {
  const m = [];
  for (let i = a; ; i = (i % 12) + 1) { m.push(i); if (i === b) break; }
  return m;
};

// forms: exact words / word groups as they appear in ingredient lines (singular, plural, common variants)
export const PRODUCE = [
  // groenten
  { name: 'asperge', forms: ['asperge', 'asperges'], months: range(4, 6) },
  { name: 'aubergine', forms: ['aubergine', 'aubergines'], months: range(6, 10) },
  { name: 'rode biet', forms: ['biet', 'bieten', 'rode biet', 'rode bieten', 'bietjes', 'kroot'], months: range(6, 12) },
  { name: 'bloemkool', forms: ['bloemkool', 'bloemkolen'], months: range(5, 11) },
  { name: 'boerenkool', forms: ['boerenkool'], months: range(11, 2) },
  { name: 'broccoli', forms: ['broccoli', 'broccoliroosjes'], months: range(6, 11) },
  { name: 'courgette', forms: ['courgette', 'courgettes'], months: range(6, 10) },
  { name: 'komkommer', forms: ['komkommer', 'komkommers'], months: range(5, 9) },
  { name: 'knolselder', forms: ['knolselder', 'knolselderij'], months: range(9, 4) },
  { name: 'koolrabi', forms: ['koolrabi', 'koolrabi s'], months: range(5, 10) },
  { name: 'koolraap', forms: ['koolraap', 'koolrapen'], months: range(10, 3) },
  { name: 'lente-ui', forms: ['lente ui', 'lente uien', 'lenteui', 'lenteuien', 'bosui', 'bosuien', 'bosuitjes'], months: range(4, 9) },
  { name: 'maïs', forms: ['mais', 'maiskolf', 'maiskolven', 'suikermais'], months: range(7, 10) },
  { name: 'paksoi', forms: ['paksoi', 'pak choi', 'pakchoi'], months: range(5, 11) },
  { name: 'paprika', forms: ['paprika', 'paprika s', 'puntpaprika', 'rode puntpaprika', 'rode paprika', 'gele paprika', 'groene paprika'], months: range(6, 10) },
  { name: 'pastinaak', forms: ['pastinaak', 'pastinaken'], months: range(10, 3) },
  { name: 'pompoen', forms: ['pompoen', 'pompoenen', 'butternut', 'hokkaido', 'muskaatpompoen'], months: range(9, 1) },
  { name: 'prei', forms: ['prei', 'preien'], months: range(9, 4) },
  { name: 'radijs', forms: ['radijs', 'radijsjes'], months: range(4, 10) },
  { name: 'rode kool', forms: ['rode kool'], months: range(9, 3) },
  { name: 'witte kool', forms: ['witte kool'], months: range(9, 3) },
  { name: 'savooikool', forms: ['savooikool', 'savooi'], months: range(9, 3) },
  { name: 'spitskool', forms: ['spitskool'], months: range(5, 10) },
  { name: 'rucola', forms: ['rucola'], months: range(5, 10) },
  { name: 'sla', forms: ['sla', 'kropsla', 'ijsbergsla', 'little gem', 'romeinse sla', 'eikenbladsla', 'sla slierties', 'slasliertjes', 'slaslierties'], months: range(4, 10) },
  { name: 'veldsla', forms: ['veldsla'], months: range(10, 3) },
  { name: 'selder', forms: ['selder', 'stoofselder', 'bleekselder', 'selderij', 'stengelselder'], months: range(7, 12) },
  { name: 'sperziebonen', forms: ['sperziebonen', 'sperzieboontjes', 'snijbonen', 'princessenbonen', 'boontjes'], months: range(6, 10) },
  { name: 'tuinbonen', forms: ['tuinbonen', 'tuinboontjes'], months: range(5, 7) },
  { name: 'spinazie', forms: ['spinazie', 'verse spinazie'], months: [3, 4, 5, 6, 9, 10, 11] },
  { name: 'spruitjes', forms: ['spruitjes', 'spruitkool', 'spruiten'], months: range(9, 3) },
  { name: 'tomaat', forms: ['tomaat', 'tomaten', 'tomaatjes', 'tomaatje', 'trostomaten', 'trostomaat', 'cherrytomaten', 'cherrytomaat', 'cherry tomaten', 'vleestomaten'], months: range(5, 10) },
  { name: 'venkel', forms: ['venkel'], months: range(6, 10) },
  { name: 'witloof', forms: ['witloof'], months: range(9, 5) },
  { name: 'zwarte wortel', forms: ['zwarte wortel', 'schorseneren', 'schorseneer'], months: range(10, 3) },
  // fruit
  { name: 'aardbei', forms: ['aardbei', 'aardbeien'], months: range(5, 8) },
  { name: 'appel', forms: ['appel', 'appels', 'appeltje', 'appeltjes'], months: range(8, 4) },
  { name: 'peer', forms: ['peer', 'peren', 'perentjes'], months: range(8, 4) },
  { name: 'framboos', forms: ['framboos', 'frambozen'], months: range(6, 9) },
  { name: 'braam', forms: ['braam', 'bramen'], months: range(8, 9) },
  { name: 'bosbes', forms: ['bosbes', 'bosbessen', 'blauwe bessen'], months: range(7, 9) },
  { name: 'kers', forms: ['kers', 'kersen'], months: range(6, 7) },
  { name: 'pruim', forms: ['pruim', 'pruimen'], months: range(8, 10) },
  { name: 'druif', forms: ['druif', 'druiven'], months: range(9, 10) },
  { name: 'rabarber', forms: ['rabarber'], months: range(3, 6) },
];

// Lines describing processed/preserved products are not fresh produce.
const PROCESSED = /\b(pulp|passata|puree|saus|gedroogd|gedroogde|blik|blikje|ingeblikt|conserve|augurk|poeder|ketchup|bouillon|jam|siroop|olie|azijn|sap|zest|gepeld|diepvries|verpakking)\b/;

const normLine = s =>
  ' ' + s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

/**
 * Seasonality of a recipe for a given month (1..12).
 * Returns { inSeason: [names], outSeason: [names], score } where score is the share of recognised Belgian
 * produce that is in season (null when the recipe has none: neutral).
 */
export function seasonInfo(recipe, month = new Date().getMonth() + 1) {
  const inSeason = new Set(), outSeason = new Set();
  for (const line of recipe.recipeIngredient ?? []) {
    const n = normLine(line);
    if (PROCESSED.test(n)) continue;
    for (const item of PRODUCE) {
      if (!item.forms.some(f => n.includes(' ' + f + ' '))) continue;
      (item.months.includes(month) ? inSeason : outSeason).add(item.name);
    }
  }
  // 'lente-ui' also contains the word 'ui' etc.: more specific names win over generic ones already (no generic entries).
  const total = inSeason.size + outSeason.size;
  return {
    inSeason: [...inSeason],
    outSeason: [...outSeason],
    score: total ? inSeason.size / total : null,
  };
}
