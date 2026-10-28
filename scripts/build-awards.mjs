#!/usr/bin/env node
/*
 * Builds data/awards.json from the award lists in data/award-lists.txt.
 *
 *  1. Wikipedia API: article title -> Wikidata item (follows redirects)
 *  2. Wikidata Query Service: winners of each award, direct ("award received")
 *     or through a person's award with a "for work" qualifier
 *  3. Wikipedia winner tables: the bolded titles under each year in the award
 *     article's tables, linked to Wikidata. Fills the gaps: Wikidata is thin
 *     for Emmys and Golden Globes.
 *  4. Wikidata entity API: titles, alternate titles, release/run years and
 *     directors for every winning work (batched, 50 at a time)
 *
 * If one award fails to load, its entries from the previous awards.json are
 * kept, so a bad night at Wikidata never wipes good data.
 *
 * Usage: node scripts/build-awards.mjs
 * Env (for testing): WIKI_API, WDQS, WIKIDATA_API
 */
import { readFile, writeFile } from "node:fs/promises";

const WIKI_API = process.env.WIKI_API || "https://en.wikipedia.org/w/api.php";
const WDQS = process.env.WDQS || "https://query.wikidata.org/sparql";
const WIKIDATA_API = process.env.WIKIDATA_API || "https://www.wikidata.org/w/api.php";
const UA = "MARC-Enrich award data builder (https://github.com/systemslibrarian/marc-enrich)";
const OUT = new URL("../data/awards.json", import.meta.url);
const LISTS = new URL("../data/award-lists.txt", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init = {}, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 90_000);
    try {
      const r = await fetch(url, { ...init, signal: ctl.signal, headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${new URL(url).host}`), { fatal: true });
      return await r.json();
    } catch (e) {
      if (e.fatal || attempt >= tries) throw e;
      const wait = 5000 * attempt;
      console.warn(`  retry ${attempt} after ${wait / 1000}s (${e.name === "AbortError" ? "timeout" : e.message})`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function resolveTitles(titles) {
  const out = {};
  for (let k = 0; k < titles.length; k += 40) {
    const batch = titles.slice(k, k + 40);
    const params = new URLSearchParams({ action: "query", prop: "pageprops", ppprop: "wikibase_item", redirects: "1", format: "json", titles: batch.join("|") });
    const j = await request(`${WIKI_API}?${params}`);
    const q = j.query || {};
    const hop = (t, list) => (list || []).find((x) => x.from === t)?.to || t;
    const pages = Object.values(q.pages || {});
    for (const t of batch) {
      const final = hop(hop(t, q.normalized), q.redirects);
      const p = pages.find((x) => x.title === final);
      if (p?.pageprops?.wikibase_item) out[t] = { qid: p.pageprops.wikibase_item, title: p.title };
    }
  }
  return out;
}

async function winners(qid) {
  // Wikidata records the same win in several ways; collect all of them.
  const query = `SELECT DISTINCT ?work ?year WHERE {
  {
    # 1. the work itself has "award received"
    ?work p:P166 ?st . ?st ps:P166 wd:${qid} .
    OPTIONAL { ?st pq:P585 ?date . }
  } UNION {
    # 2. a person won it "for work"
    ?person p:P166 ?st . ?st ps:P166 wd:${qid} ; pq:P1686 ?work .
    OPTIONAL { ?st pq:P585 ?date . }
  } UNION {
    # 3. the award item lists its "winner"s
    wd:${qid} p:P1346 ?st . ?st ps:P1346 ?w0 .
    OPTIONAL { ?st pq:P1686 ?fw . }
    BIND(COALESCE(?fw, ?w0) AS ?work)
    OPTIONAL { ?st pq:P585 ?date . }
  } UNION {
    # 4. a ceremony lists a "winner" "of" this award
    ?ceremony p:P1346 ?st . ?st ps:P1346 ?w0 ; pq:P642 wd:${qid} .
    OPTIONAL { ?st pq:P1686 ?fw . }
    BIND(COALESCE(?fw, ?w0) AS ?work)
    OPTIONAL { ?ceremony wdt:P585 ?date . }
  }
  BIND(YEAR(?date) AS ?year)
}`;
  const j = await request(WDQS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
    body: new URLSearchParams({ query, format: "json" }),
  });
  const rows = (j.results?.bindings || []).filter((b) => b.work?.type === "uri").map((b) => ({
    w: b.work.value.split("/").pop(),
    y: b.year && /^\d{4}$/.test(b.year.value) ? +b.year.value : 0,
  }));
  // drop a yearless row when the same work also has a dated one
  const dated = new Set(rows.filter((r) => r.y).map((r) => r.w));
  const seen = new Set();
  return rows.filter((r) => (r.y || !dated.has(r.w)) && !seen.has(r.w + ":" + r.y) && seen.add(r.w + ":" + r.y));
}

// A wikitext table cell's content: what follows the first "|" outside [[ ]] and {{ }} (before it are attributes).
function cellContent(cell) {
  let depth = 0;
  for (let i = 0; i < cell.length; i++) {
    const two = cell.slice(i, i + 2);
    if (two === "[[" || two === "{{") { depth++; i++; continue; }
    if (two === "]]" || two === "}}") { depth = Math.max(0, depth - 1); i++; continue; }
    if (cell[i] === "|" && depth === 0) return cell.slice(i + 1);
  }
  return cell;
}
// Citations and comments carry their own years, links and bold text; remove them first.
const stripRefs = (s) => s
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<ref[^>]*\/>/gi, "")
  .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");

/** Readable text of a cell: links -> their label, wrapper templates -> their text, other templates removed. */
function plainCell(cell) {
  let t = stripRefs(cellContent(cell)).replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1");
  for (let k = 0; k < 6 && t.includes("{{"); k++) {
    t = t.replace(/\{\{\s*(?:nowrap|nobr|center|small|big|sort|nts|anchor)\s*\|([^{}]*)\}\}/gi, (_, a) => a.split("|").pop())
      .replace(/\{\{[^{}]*\}\}/g, " ");
  }
  return t.replace(/<[^>]+>/g, " ").replace(/'{2,}/g, "").replace(/\s+/g, " ").trim();
}

// Year of the Nth ceremony, so table years (often the film year) match Wikidata's award dates.
const CEREMONY_BASE = [[/Golden Globe/, 1943], [/Academy Award/, 1928], [/Emmy/, 1948]];

/** The award year a table cell stands for, or 0. Prefers the ceremony number when present. */
function cellYear(cell, base) {
  const t = plainCell(cell);
  const m = t.match(/^((?:19[2-9]|20[0-4])\d)\b/);
  if (!m || t.length > 40) return 0;
  if (base) {
    // ceremony number in a link target ([[82nd Golden Globe Awards|2024]]) or shown as "(82nd)"
    const raw = stripRefs(cellContent(cell));
    const ord = raw.match(/\[\[\s*(\d{1,3})(?:st|nd|rd|th)\s+[^\]|]*(?:Award|Emmy)/i) || t.match(/\((\d{1,3})(?:st|nd|rd|th)\)/);
    if (ord) return base + +ord[1];
  }
  return +m[1];
}
// Winners are bolded; film and show titles are also italic ('''''Title'''''), while the
// producers and networks bolded in the same row are not — so only bold-italic text counts.
const BOLD_ITALIC = /'{5}(.+?)'{2,5}/g;
const seasonless = (t) => t.replace(/\s*\((?:season|series) \d+\)$/i, "").replace(/,? season \d+$/i, "").trim();

/** Winners from the award article's tables: bolded links in each year's group of rows. */
async function wikipediaWinners(title) {
  const base = (CEREMONY_BASE.find(([re]) => re.test(title)) || [])[1] || 0;
  const params = new URLSearchParams({ action: "parse", page: title, prop: "wikitext", format: "json", formatversion: "2", redirects: "1" });
  const j = await request(`${WIKI_API}?${params}`);
  const text = j.parse?.wikitext || "";
  // Wikipedia links a title only the first time, so remember label -> article for unlinked repeats.
  const linkMap = new Map();
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) {
    const label = (m[2] || m[1]).replace(/'{2,}/g, "").trim();
    if (!linkMap.has(label)) linkMap.set(label, m[1].trim());
  }
  const out = [];
  for (const table of text.match(/\{\|[\s\S]*?\n\|\}/g) || []) {
    let year = 0;
    for (const row of table.split(/\n\|-[^\n]*/)) {
      for (const cell of row.split(/\n[|!]|\|\||!!/)) {
        const y = cellYear(cell, base);
        if (y) year = y;
      }
      if (!year) continue;
      for (const m of stripRefs(row).matchAll(BOLD_ITALIC)) {
        const link = m[1].match(/\[\[([^\]|#]+)/);
        let title = link ? link[1].trim() : "";
        if (!title) {
          const label = plainCell("|" + m[1]);
          title = linkMap.get(label) || label;
        }
        title = seasonless(title);
        if (title) out.push({ title, y: year });
      }
      // same idea, nested the other way: ''[[Hamnet (film)|'''Hamnet''']]'' or '''[[X|''X'']]'''
      for (const m of stripRefs(row).matchAll(/(?:''\s*\[\[([^\]|#]+)\|\s*'''|'''\s*\[\[([^\]|#]+)\|\s*''(?!'))/g)) {
        const title = seasonless((m[1] || m[2]).trim());
        if (title) out.push({ title, y: year });
      }
    }
  }
  const seen = new Set();
  return out.filter((r) => !seen.has(r.title + ":" + r.y) && seen.add(r.title + ":" + r.y));
}

async function entities(ids, props) {
  const out = {};
  for (let k = 0; k < ids.length; k += 50) {
    const params = new URLSearchParams({ action: "wbgetentities", ids: ids.slice(k, k + 50).join("|"), props, languages: "en", format: "json" });
    const j = await request(`${WIKIDATA_API}?${params}`);
    Object.assign(out, j.entities || {});
    await sleep(300);
  }
  return out;
}

const claimIds = (e, p) => (e.claims?.[p] || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
const claimYear = (e, p) => {
  const ys = (e.claims?.[p] || []).map((c) => c.mainsnak?.datavalue?.value?.time).filter(Boolean)
    .map((t) => +String(t).slice(1, 5)).filter((y) => y > 1800);
  return ys.length ? Math.min(...ys) : 0;
};

const CORRECTIONS = new URL("../data/award-corrections.txt", import.meta.url);
const CSV = new URL("../data/awards.csv", import.meta.url);

const SOURCE_NAMES = { wp: "Wikipedia winner table", wd: "Wikidata", fix: "Manual correction" };

/** One row per win, for people to check the data (GitHub shows CSV files as a searchable table). */
function toCsv(data) {
  const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [["award", "year", "title", "directors", "release_or_start_year", "source", "wikidata_id", "wikidata_url", "winner_list_url"].join(",")];
  for (const x of data.winners) {
    const aw = data.awards[x.a], w = data.works[x.w];
    lines.push([aw.title, x.y || "", w.l, (w.d || []).join("; "), w.p || w.s || "", SOURCE_NAMES[x.s] || "Wikidata",
      x.w, "https://www.wikidata.org/wiki/" + x.w, aw.url].map(cell).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Lines: "remove | <award title> | <Wikidata QID> | <year or *>" or "add | <award title> | <QID> | <year>". */
async function readCorrections() {
  let text = "";
  try { text = await readFile(CORRECTIONS, "utf8"); } catch { return []; }
  const out = [];
  for (const [n, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [op, award, qid, year = "*"] = line.split("|").map((s) => s.trim());
    if (!/^(add|remove)$/i.test(op) || !award || !/^Q\d+$/.test(qid || "")) {
      console.warn(`! award-corrections.txt line ${n + 1} not understood: ${raw}`);
      continue;
    }
    out.push({ op: op.toLowerCase(), award, qid, year: /^\d{4}$/.test(year) ? +year : null });
  }
  return out;
}

async function main() {
  // "Wikipedia title | short local name" per line
  const names = {};
  const titles = (await readFile(LISTS, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => { const [t, n] = l.split("|").map((s) => s.trim()); if (n) names[t] = n; return t; });
  const shortName = (title) => title.replace(/^Primetime /, "").replace(/ for /, " - ").replace(/\s*–\s*/g, " - ");
  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, "utf8")); } catch { /* first build */ }

  console.log(`Resolving ${titles.length} award titles on Wikipedia…`);
  const resolved = await resolveTitles(titles);

  const awards = [];
  const rows = [];
  const problems = [];
  for (const t of titles) {
    const r = resolved[t];
    const prevAward = previous?.awards?.find((a) => a.list === t);
    const keepPrevious = (why) => {
      problems.push(`${t}: ${why}`);
      if (!prevAward) return;
      const ai = awards.push({ ...prevAward, name: names[t] || prevAward.name || shortName(prevAward.title) }) - 1;
      const oldIndex = previous.awards.indexOf(prevAward);
      for (const w of previous.winners.filter((x) => x.a === oldIndex)) rows.push({ a: ai, w: w.w, y: w.y, s: w.s || "wd" });
      console.warn(`  kept ${previous.winners.filter((x) => x.a === oldIndex).length} winners from the previous build`);
    };
    if (!r) { console.warn(`! Not found on Wikipedia: ${t}`); keepPrevious("not found on Wikipedia"); continue; }
    try {
      const list = await winners(r.qid);
      let table = [];
      try {
        const wp = await wikipediaWinners(r.title);
        const ids = await resolveTitles([...new Set(wp.map((x) => x.title))]);
        for (const x of wp) {
          if (!ids[x.title]) continue;
          const w = ids[x.title].qid;
          // one row per win; back-to-back wins (Veep 2015–2017) are separate wins
          if (!table.some((k) => k.w === w && k.y === x.y)) table.push({ w, y: x.y, s: "wp" });
        }
      } catch (e) { console.warn(`  (Wikipedia table not read: ${e.message})`); }
      // The table has consistent ceremony years, so it wins. Wikidata only adds dated wins
      // for works the table doesn't list (its dates mix film and ceremony years, and it holds
      // some undated or mistaken wins).
      let final, extra = [];
      if (table.length >= 5) {
        const inTable = new Set(table.map((x) => x.w));
        extra = list.filter((d) => d.y && !inTable.has(d.w)).map((d) => ({ ...d, s: "wd" }));
        final = [...table, ...extra];
      } else {
        final = list.map((d) => ({ ...d, s: "wd" }));
      }
      if (!final.length) throw new Error("no winners returned");
      const ai = awards.push({ list: t, title: r.title, name: names[t] || shortName(r.title), qid: r.qid, url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(r.title.replace(/ /g, "_")) }) - 1;
      for (const x of final) rows.push({ a: ai, ...x });
      console.log(table.length >= 5
        ? `  ${r.title} (${r.qid}): ${table.length} from the Wikipedia table + ${extra.length} more from Wikidata`
        : `  ${r.title} (${r.qid}): ${list.length} from Wikidata (table not usable)`);
    } catch (e) {
      console.warn(`! ${t}: ${e.message}`);
      keepPrevious(e.message);
    }
    await sleep(1000);
  }

  const corrections = await readCorrections();
  const workIds = [...new Set([...rows.map((x) => x.w), ...corrections.filter((c) => c.op === "add").map((c) => c.qid)])];
  console.log(`Fetching details for ${workIds.length} works…`);
  const ents = await entities(workIds, "labels|aliases|claims");
  const works = {};
  const directorIds = new Set();
  for (const id of workIds) {
    const e = ents[id];
    if (!e || e.missing !== undefined) continue;
    if (claimIds(e, "P31").includes("Q5")) continue; // a person, not a work
    const label = e.labels?.en?.value;
    if (!label) continue;
    const d = claimIds(e, "P57");
    d.forEach((x) => directorIds.add(x));
    works[id] = {
      l: label,
      alt: (e.aliases?.en || []).map((a) => a.value).filter((a) => a !== label),
      p: claimYear(e, "P577"), s: claimYear(e, "P580"), e: claimYear(e, "P582"), d,
    };
  }
  console.log(`Fetching ${directorIds.size} director names…`);
  const dents = await entities([...directorIds], "labels");
  for (const w of Object.values(works)) w.d = w.d.map((id) => dents[id]?.labels?.en?.value).filter(Boolean);

  // Keep only films and series: items with a release or run date. Drops people, duos,
  // and networks that are bolded in the same table rows.
  const dated = (id) => works[id] && (works[id].p || works[id].s);
  let winnersOut = rows.filter((x) => dated(x.w));

  // Hand corrections (data/award-corrections.txt), re-applied on every build.
  for (const c of corrections) {
    const ai = awards.findIndex((a) => a.list === c.award || a.title === c.award);
    if (ai < 0) { problems.push(`correction for unknown award: ${c.award}`); continue; }
    if (c.op === "remove") {
      const before = winnersOut.length;
      winnersOut = winnersOut.filter((x) => !(x.a === ai && x.w === c.qid && (c.year === null || x.y === c.year)));
      console.log(`  correction: removed ${before - winnersOut.length} row(s) for ${c.qid} from ${c.award}`);
    } else if (works[c.qid]) {
      winnersOut = winnersOut.filter((x) => !(x.a === ai && x.w === c.qid && Math.abs(x.y - (c.year || 0)) <= 1));
      winnersOut.push({ a: ai, w: c.qid, y: c.year || 0, s: "fix" });
      console.log(`  correction: added ${works[c.qid].l} (${c.year}) to ${c.award}`);
    } else {
      problems.push(`correction add: ${c.qid} has no English label on Wikidata`);
    }
  }
  winnersOut.sort((a, b) => a.a - b.a || a.y - b.y || a.w.localeCompare(b.w));
  if (!winnersOut.length) { console.error("No winners at all — not writing awards.json."); process.exit(1); }
  const used = new Set(winnersOut.map((x) => x.w));
  for (const id of Object.keys(works)) if (!used.has(id)) delete works[id];

  const data = {
    generated: new Date().toISOString().slice(0, 10),
    source: "Wikipedia and Wikidata (CC0). Built by scripts/build-awards.mjs.",
    awards, winners: winnersOut,
    works: Object.fromEntries(Object.entries(works).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))),
  };
  await writeFile(OUT, JSON.stringify(data, null, 0).replace(/\],"/g, '],\n"').replace(/\},"Q/g, '},\n"Q') + "\n");
  await writeFile(CSV, toCsv(data));
  console.log(`Wrote ${awards.length} awards, ${winnersOut.length} winning entries, ${Object.keys(works).length} works.`);
  if (problems.length) console.warn("Problems:\n  " + problems.join("\n  "));
}

main().catch((e) => { console.error(e); process.exit(1); });
