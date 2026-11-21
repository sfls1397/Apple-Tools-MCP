
const DASH_CHARS = "‒–—―⸺⸻︱︲﹘";
const DASH_RUN = new RegExp(`[ \\t]*[${DASH_CHARS}]+[ \\t]*`, "g");
const NUMBER_RANGE = /(\d)[‒–—](?=\d)/g;
const SPACED_HYPHEN = /(\S)[ \t]+(?:-{1,3}|[‐‑−])[ \t]+(?=\S)/g;
const TRAILING_HYPHEN = /(\S)[ \t]+(?:-{1,3}|[‐‑−])[ \t]*$/;
const HTML_DASH_ENTITY = /&(?:mdash|ndash|horbar);|&#(?:8210|8211|8212|8213|x201[2345]);/gi;

function rewriteLine(line) {
  let count = 0;
  let text = line.replace(NUMBER_RANGE, (_, digit) => {
    count += 1;
    return `${digit} to `;
  });
  text = text.replace(DASH_RUN, (match, offset, whole) => {
    count += 1;
    if (!whole.slice(0, offset).trim()) return match.match(/^[ \t]*/)[0];
    if (!whole.slice(offset + match.length).trim()) return "";
    return ", ";
  });
  text = text.replace(SPACED_HYPHEN, (_, before) => {
    count += 1;
    return `${before}, `;
  });
  text = text.replace(TRAILING_HYPHEN, (_, before) => {
    count += 1;
    return before;
  });
  if (count > 0) {
    text = text.replace(/,[ \t]*,/g, ",").replace(/,[ \t]*([.;:!?)\]])/g, "$1").replace(/([(\[])[ \t]*,[ \t]*/g, "$1");
  }
  return { text, count };
}

export function rewriteDashes(value, { html = false } = {}) {
  if (typeof value !== "string" || value === "") return { text: value ?? "", count: 0 };
  const source = html ? value.replace(HTML_DASH_ENTITY, "—") : value;
  let count = 0;
  const lines = source.split("\n").map((line) => {
    const out = rewriteLine(line);
    count += out.count;
    return out.text;
  });
  return count > 0 ? { text: lines.join("\n"), count } : { text: value, count: 0 };
}

export function findDashes(value, opts = {}) {
  if (typeof value !== "string" || value === "") return [];
  const source = opts.html ? value.replace(HTML_DASH_ENTITY, "—") : value;
  return source.split("\n").filter((line) => rewriteLine(line).count > 0);
}

export const DASH_FIELDS = {
  mail_send: ["subject", "body"],
  mail_draft: ["subject", "body"],
  mail_reply: ["body"],
  mail_forward: ["body"],
  messages_send: ["text"]
};

export function withoutDashes(tool, args) {
  const fields = DASH_FIELDS[tool];
  if (!fields || !args || typeof args !== "object") return { args, count: 0 };
  const html = String(args.body_format || "").toLowerCase() === "html";
  const out = { ...args };
  let count = 0;
  for (const field of fields) {
    if (typeof out[field] !== "string") continue;
    const rewritten = rewriteDashes(out[field], { html: html && field === "body" });
    out[field] = rewritten.text;
    count += rewritten.count;
  }
  return { args: count > 0 ? out : args, count };
}

export function dashNote(count) {
  return ` Rewrote ${count} ${count === 1 ? "dash" : "dashes"} (em dash, en dash or spaced hyphen) as commas or words before writing; nothing goes out with dashes.`;
}
