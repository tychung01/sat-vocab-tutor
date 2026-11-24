// A small, safe parser for the function expressions in SAT Math graphs, like
// "2*x^2 - 3*x + 1" or "sqrt(x+4)". The Cloud Functions use it to check a graph
// before students see it; SAT Math's app has a copy (public/mathexpr.js) that
// draws the graph. Keep the two the same.
//
// compile(expr) returns a function of x, or throws an Error saying what's wrong.
// Supported: numbers, x, + - * / ^, parentheses, unary minus, pi, e, and the
// functions sqrt, abs, sin, cos, tan, log (base 10), ln, exp. Implicit
// multiplication ("2x", "3(x+1)", "x(x-1)") is allowed too.

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  log: Math.log10, ln: Math.log, exp: Math.exp,
};
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(expr) {
  const tokens = [];
  const s = String(expr).replace(/\s+/g, "").replace(/\*\*/g, "^").replace(/π/g, "pi");
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const num = s.slice(i).match(/^(\d+\.?\d*|\.\d+)/);
    if (num) { tokens.push({ t: "num", v: Number(num[1]) }); i += num[1].length; continue; }
    const word = s.slice(i).match(/^[a-z]+/i);
    if (word) {
      const w = word[0].toLowerCase();
      // Split runs like "xsin" or "pix" into known names.
      let j = 0;
      while (j < w.length) {
        const name = Object.keys(FUNCS).concat(Object.keys(CONSTS), ["x"]).sort((a, b) => b.length - a.length).find((n) => w.startsWith(n, j));
        if (!name) throw new Error(`unknown name in "${expr}"`);
        tokens.push(FUNCS[name] ? { t: "fn", v: name } : name === "x" ? { t: "x" } : { t: "num", v: CONSTS[name] });
        j += name.length;
      }
      i += w.length;
      continue;
    }
    if ("+-*/^()".includes(c)) { tokens.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`unexpected "${c}" in "${expr}"`);
  }
  // Implicit multiplication: between a value and a following value, function, or "(".
  const out = [];
  for (const tok of tokens) {
    const prev = out[out.length - 1];
    const prevValue = prev && (prev.t === "num" || prev.t === "x" || (prev.t === "op" && prev.v === ")"));
    const nextValue = tok.t === "num" || tok.t === "x" || tok.t === "fn" || (tok.t === "op" && tok.v === "(");
    if (prevValue && nextValue) out.push({ t: "op", v: "*" });
    out.push(tok);
  }
  return out;
}

// Recursive descent: expr = term (+|- term)*; term = unary (*|/ unary)*;
// unary = -unary | power; power = atom (^ unary)?; atom = num | x | fn(expr) | (expr).
export function compile(expr) {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v) => peek()?.t === "op" && peek().v === v;
  const expect = (v) => {
    if (!isOp(v)) throw new Error(`expected "${v}" in "${expr}"`);
    pos++;
  };
  function atom() {
    const tok = tokens[pos++];
    if (!tok) throw new Error(`"${expr}" ends too soon`);
    if (tok.t === "num") return () => tok.v;
    if (tok.t === "x") return (x) => x;
    if (tok.t === "fn") {
      expect("(");
      const inner = sum();
      expect(")");
      const f = FUNCS[tok.v];
      return (x) => f(inner(x));
    }
    if (tok.t === "op" && tok.v === "(") {
      const inner = sum();
      expect(")");
      return inner;
    }
    throw new Error(`unexpected "${tok.v}" in "${expr}"`);
  }
  function power() {
    const base = atom();
    if (isOp("^")) {
      pos++;
      const exponent = unary();
      return (x) => base(x) ** exponent(x);
    }
    return base;
  }
  function unary() {
    if (isOp("-")) { pos++; const v = unary(); return (x) => -v(x); }
    if (isOp("+")) { pos++; return unary(); }
    return power();
  }
  function term() {
    let left = unary();
    while (isOp("*") || isOp("/")) {
      const op = tokens[pos++].v;
      const right = unary();
      const l = left;
      left = op === "*" ? (x) => l(x) * right(x) : (x) => l(x) / right(x);
    }
    return left;
  }
  function sum() {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = tokens[pos++].v;
      const right = term();
      const l = left;
      left = op === "+" ? (x) => l(x) + right(x) : (x) => l(x) - right(x);
    }
    return left;
  }
  if (!tokens.length) throw new Error("the expression is empty");
  const f = sum();
  if (pos !== tokens.length) throw new Error(`unexpected "${tokens[pos].v ?? tokens[pos].t}" in "${expr}"`);
  return f;
}

// A number as a student or the answer key writes it: "3/4", "-2.5", ".75", "12".
// Returns NaN if it isn't one.
export function parseNumber(text) {
  const s = String(text).trim().replace(/\s+/g, "").replace(/^\+/, "");
  const frac = s.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (frac) return Number(frac[2]) === 0 ? NaN : Number(frac[1]) / Number(frac[2]);
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

// Whether a typed answer matches the key, as the SAT grades fill-in answers: an
// exact value, or a decimal that fills the space (at least 3 decimal places for a
// value between -1 and 1, or 4 characters otherwise) rounded or cut off.
export function gridMatches(typed, key) {
  const v = parseNumber(typed);
  const k = parseNumber(key);
  if (Number.isNaN(v) || Number.isNaN(k)) return false;
  if (Math.abs(v - k) < 1e-9) return true;
  const s = String(typed).trim();
  const decimals = (s.split(".")[1] || "").length;
  if (!s.includes(".") || decimals < 2) return false;
  const step = 10 ** -decimals;
  const long = s.replace("-", "").length >= 5 || decimals >= 3;
  return long && Math.abs(v - k) < step;
}

// Whether a key fits the SAT's fill-in format: up to 5 characters (6 with a minus sign).
export function fitsGrid(key) {
  const s = String(key).trim();
  if (Number.isNaN(parseNumber(s))) return false;
  return s.replace(/^-/, "").length <= 5;
}
