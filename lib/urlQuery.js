// Meeting links in calendar titles and locations often carry the join passcode
// in their query string (zoom.us/j/123?pwd=...). Calendar tools print each URL
// with its scheme, host and path only: the ?query and #fragment are dropped, so
// a passcode never reaches a chat that reads the calendar.
//
// A URL here is a scheme with "//" (https://, zoommtg://), a "www." host, or a
// bare host.tld/ path. The query runs to the next space, angle bracket or quote;
// closing ) or ] at its end are kept, since they close the text around the URL.
const URL_WITH_QUERY = /((?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/)[^\s?#<>"']*)([?#][^\s<>"']*)/gi;

export function stripUrlQueries(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(URL_WITH_QUERY, (_, url, query) => url + (query.match(/[)\]]+$/) || [""])[0]);
}

// Invite notes also carry passcodes as plain lines ("Passcode: 123456",
// "Meeting password: abc", "PIN: 123 456 789#", "PIN is 1234", Webex
// "Host key: 123456" and "Access code: 123 456", "Passcode 123456") and inside
// one-tap dial strings ("+15550100,,1000000001#,,,,*123456#"). The value after a
// passcode label is hidden to the end of its line; a dial string keeps its
// digits up to the passcode and hides the passcode itself. A full-width colon
// (U+FF1A) counts as a colon. "PIN is" needs a value with a digit ("the pin is
// in the drawer" stays). A bare ",,1000000001#" is the meeting or
// conference ID, which the tools print like any meeting ID.
const PASSCODE_LABEL = /\b((?:numeric\s+)?(?:meeting\s+)?(?:passcode|pass\s?code|password|pwd|host\s+key|access\s+code)\b\s*(?:[:=#\uFF1A]|is\b)\s*|\bpin\b\s*(?:[:=#\uFF1A]\s*|is\s+(?=\S*\d)))[^\n]*/gi;
// "Passcode 123456" with no separator: only a following token with a digit.
const PASSCODE_BARE = /\b((?:meeting\s+)?(?:passcode|pass\s?code|password|host\s+key|access\s+code)\s+)(?=[^\s:=#\uFF1A]*\d)[^\s:=#\uFF1A]+/gi;
// Bounded comma run: an unbounded ,{2,} is quadratic on a long run of commas.
const DIAL_PASSCODE = /(,{2,12}\*)\d{1,20}#/g;
const HIDDEN = "[hidden]";

export function maskPasscodes(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(PASSCODE_LABEL, (_, label) => label + HIDDEN)
    .replace(PASSCODE_BARE, (_, label) => label + HIDDEN)
    .replace(DIAL_PASSCODE, (_, lead) => `${lead}${HIDDEN}#`);
}

/** URLs without their query strings, and passcode values hidden. */
export function hideMeetingSecrets(text) {
  return maskPasscodes(stripUrlQueries(text));
}
