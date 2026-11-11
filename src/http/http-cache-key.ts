import { escapeKeyArg } from '../core/key-builder.js';

export interface ParsedHttpUrl {
  path: string;
  query: Record<string, string | string[]>;
}

function split(url: string): { path: string; pairs: [string, string][] } {
  const index = url.indexOf('?');
  if (index === -1) return { path: url, pairs: [] };
  return {
    path: url.slice(0, index),
    pairs: [...new URLSearchParams(url.slice(index + 1))],
  };
}

/** Splits a request URL into its path and query. A name seen once is a string, several times an array in input order. */
export function parseHttpUrl(url: string): ParsedHttpUrl {
  const { path, pairs } = split(url);
  const query: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;
  for (const [name, value] of pairs) {
    const seen = query[name];
    if (seen === undefined) query[name] = value;
    else if (typeof seen === 'string') query[name] = [seen, value];
    else seen.push(value);
  }
  return { path, query: { ...query } };
}

/** Default `@HttpCache` key: the path plus the query sorted by name then value, with `%` and `:` percent-encoded. */
export function httpCacheKey(url: string): string {
  const { path, pairs } = split(url);
  const sorted = pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  const query = new URLSearchParams(sorted).toString();
  return escapeKeyArg(query === '' ? path : `${path}?${query}`);
}
