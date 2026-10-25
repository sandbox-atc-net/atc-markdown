// Punycode (RFC 3492) decoding, to show internationalized domain names
// (`xn--…`) the way they look — which is how look-alike domains are spotted.

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 22; // 0-9 → 26-35
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z
  return BASE;
}

/** Decodes one punycode label (without `xn--`). Returns `undefined` if it is invalid. */
export function decodeLabel(input: string): string | undefined {
  const output: number[] = [];
  const basicEnd = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(basicEnd, 0); j += 1) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return undefined;
    output.push(code);
  }

  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let index = basicEnd > 0 ? basicEnd + 1 : 0; index < input.length; ) {
    const oldI = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return undefined;
      const d = digit(input.charCodeAt(index++));
      if (d >= BASE) return undefined;
      i += d * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
      if (!Number.isSafeInteger(i) || !Number.isSafeInteger(w)) return undefined;
    }
    const length = output.length + 1;
    bias = adapt(i - oldI, length, oldI === 0);
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff) return undefined;
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

/** `xn--pple-43d.com` → `аpple.com`; other labels are left as they are. */
export function toUnicodeHost(host: string): string {
  return host
    .split(".")
    .map((label) => (label.toLowerCase().startsWith("xn--") ? (decodeLabel(label.slice(4)) ?? label) : label))
    .join(".");
}
