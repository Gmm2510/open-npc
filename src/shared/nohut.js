// Building names: maps the words people use for small shelters to the builder's own kinds.
const GUIDE_HUT = /\s*\(the classic dirt or plank hut\)/gi;
const KIND_LINE = /\bkind: hut or house\b/g;

const IDS = [['quick_hut', 'quick_shelter'], ['dirt_hut', 'dirt_shelter'], ['emergency_hut', 'emergency_shelter'], ['build_hut', 'build_shelter']];
const KINDS_BACK = { small_house: 'hut', dirt_shelter: 'dirt_hut', shelter: 'hut', small_shelter: 'hut' };

const on = (sp) => !!(sp && sp.v12 && sp.v12.on && sp.v12.on.noHut);

function swapWord(text) {
  return String(text).replace(/(\bpizza[\s-]+)?\b(hut)(s?)\b/gi, (m, pizza, w, s) => {
    if (pizza) return m;
    const word = s ? 'houses' : 'house';
    if (w === 'HUT') return word.toUpperCase();
    if (w[0] === 'H') return word[0].toUpperCase() + word.slice(1);
    return word;
  });
}

function swapPrompt(text) {
  let s = String(text);
  if (!/hut/i.test(s)) return s;
  s = s.replace(GUIDE_HUT, '').replace(KIND_LINE, 'kind: small_house or house');
  for (const [real, shown] of IDS) s = s.replace(new RegExp(`\\b${real}\\b`, 'g'), shown);
  return swapWord(s);
}

function rewriteMessages(msgs, sp) {
  if (!on(sp) || !Array.isArray(msgs)) return msgs;
  for (const m of msgs) if (m && typeof m.content === 'string') m.content = swapPrompt(m.content);
  return msgs;
}

function actionBack(name, actions) {
  if (typeof name !== 'string' || !Array.isArray(actions) || actions.includes(name)) return name;
  for (const [real, shown] of IDS) if (name === shown && actions.includes(real)) return real;
  return name;
}

const kindBack = (kind) => (Object.prototype.hasOwnProperty.call(KINDS_BACK, kind) ? KINDS_BACK[kind] : kind);

const sayText = (text) => (/hut/i.test(String(text || '')) ? swapWord(text) : text);

module.exports = { on, swapWord, swapPrompt, rewriteMessages, actionBack, kindBack, sayText, IDS, KINDS_BACK };
