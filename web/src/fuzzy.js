// Tiny fuzzy matcher: returns a score > 0 when every query char appears in order.
export function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.5 + (direct === 0 || /[\s\\/_.-]/.test(t[direct - 1]) ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === ' ') continue;
    const found = t.indexOf(c, ti);
    if (found < 0) return 0;
    const boundary = found === 0 || /[\s\\/_.-]/.test(t[found - 1]) || (text[found] !== t[found] && text[found - 1] === t[found - 1]);
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 6 + (boundary ? 12 : 0) - Math.min(8, found - ti);
    ti = found + 1;
  }
  return Math.max(1, score - t.length * 0.2);
}
