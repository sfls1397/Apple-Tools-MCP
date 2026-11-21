const URL_WITH_QUERY = /((?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/)[^\s?#<>"']*)([?#][^\s<>"']*)/gi;

export function stripUrlQueries(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(URL_WITH_QUERY, (_, url, query) => url + (query.match(/[)\]]+$/) || [""])[0]);
}

const PASSCODE_LABEL = /\b((?:numeric\s+)?(?:meeting\s+)?(?:passcode|pass\s?code|password|pwd|host\s+key|access\s+code)\b\s*(?:[:=#\uFF1A]|is\b)\s*|\bpin\b\s*(?:[:=#\uFF1A]\s*|is\s+(?=\S*\d)))[^\n]*/gi;
const PASSCODE_BARE = /\b((?:meeting\s+)?(?:passcode|pass\s?code|password|host\s+key|access\s+code)\s+)(?=[^\s:=#\uFF1A]*\d)[^\s:=#\uFF1A]+/gi;
const DIAL_PASSCODE = /(,{2,12}\*)\d{1,20}#/g;
const HIDDEN = "[hidden]";

export function maskPasscodes(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(PASSCODE_LABEL, (_, label) => label + HIDDEN)
    .replace(PASSCODE_BARE, (_, label) => label + HIDDEN)
    .replace(DIAL_PASSCODE, (_, lead) => `${lead}${HIDDEN}#`);
}

export function hideMeetingSecrets(text) {
  return maskPasscodes(stripUrlQueries(text));
}
