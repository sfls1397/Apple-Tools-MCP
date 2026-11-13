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
