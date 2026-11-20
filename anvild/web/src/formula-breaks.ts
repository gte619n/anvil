/**
 * Where a long formula written without spaces (`L*W*T-(4-pi)*5^2*T`) may wrap on a narrow screen, so
 * a card's "new" value never runs off a phone. Breaks go only around operators — after `* / ^ ( )`
 * and before a binary `+` / `-` — never inside a number: not between digits, not after a sign, not in
 * an exponent like `1e-6`, not after a thousands comma.
 */
export function formulaSegments(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const prev = text[i - 1];
    const next = text[i + 1];
    const inWord = prev !== undefined && !/\s/.test(prev);
    // Before a binary + or -: one that follows a name, a number or ")" — not an exponent's sign.
    const exponentSign = (prev === "e" || prev === "E") && /\d/.test(text[i - 2] ?? "");
    if ((c === "+" || c === "-") && inWord && /[A-Za-z0-9_.)\]]/.test(prev!) && !exponentSign && cur) {
      out.push(cur);
      cur = "";
    }
    cur += c;
    // After * / ^ ( ): when more of the same word follows.
    if ("*/^()".includes(c) && next !== undefined && !/\s/.test(next)) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The same text as HTML (escaped) with a `<wbr>` at each place it may wrap. */
export function formulaHtml(text: string, esc: (s: string) => string): string {
  return formulaSegments(text).map(esc).join("<wbr>");
}

/** Fill an element with the text, a `<wbr>` at each place it may wrap. */
export function appendFormula(el: HTMLElement, text: string): HTMLElement {
  formulaSegments(text).forEach((seg, i) => {
    if (i) el.appendChild(document.createElement("wbr"));
    el.appendChild(document.createTextNode(seg));
  });
  return el;
}
