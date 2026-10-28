#!/usr/bin/env node
/*
 * Builds data/awards.json from the award lists in data/award-lists.txt.
 *
 *  1. Wikipedia API: article title -> Wikidata item (follows redirects)
 *  2. Wikidata Query Service: winners of each award, direct ("award received")
 *     or through a person's award with a "for work" qualifier
 *  3. Wikidata entity API: titles, alternate titles, release/run years and
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
  const query = `SELECT DISTINCT ?work ?year WHERE {
  { ?work p:P166 ?st . ?st ps:P166 wd:${qid} . }
  UNION
  { ?person p:P166 ?st . ?st ps:P166 wd:${qid} ; pq:P1686 ?work . }
  OPTIONAL { ?st pq:P585 ?date . BIND(YEAR(?date) AS ?year) }
}`;
  const j = await request(WDQS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
    body: new URLSearchParams({ query, format: "json" }),
  });
  return (j.results?.bindings || []).map((b) => ({
    w: b.work.value.split("/").pop(),
    y: b.year && /^\d{4}$/.test(b.year.value) ? +b.year.value : 0,
  }));
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

async function main() {
  const titles = (await readFile(LISTS, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
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
      const ai = awards.push({ ...prevAward }) - 1;
      const oldIndex = previous.awards.indexOf(prevAward);
      for (const w of previous.winners.filter((x) => x.a === oldIndex)) rows.push({ a: ai, w: w.w, y: w.y });
      console.warn(`  kept ${previous.winners.filter((x) => x.a === oldIndex).length} winners from the previous build`);
    };
    if (!r) { console.warn(`! Not found on Wikipedia: ${t}`); keepPrevious("not found on Wikipedia"); continue; }
    try {
      const list = await winners(r.qid);
      if (!list.length) throw new Error("no winners returned");
      const ai = awards.push({ list: t, title: r.title, qid: r.qid, url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(r.title.replace(/ /g, "_")) }) - 1;
      for (const x of list) rows.push({ a: ai, ...x });
      console.log(`  ${r.title} (${r.qid}): ${list.length} winners`);
    } catch (e) {
      console.warn(`! ${t}: ${e.message}`);
      keepPrevious(e.message);
    }
    await sleep(1000);
  }

  const workIds = [...new Set(rows.map((x) => x.w))];
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

  const winnersOut = rows.filter((x) => works[x.w]).sort((a, b) => a.a - b.a || a.y - b.y || a.w.localeCompare(b.w));
  if (!winnersOut.length) { console.error("No winners at all — not writing awards.json."); process.exit(1); }

  const data = {
    generated: new Date().toISOString().slice(0, 10),
    source: "Wikipedia and Wikidata (CC0). Built by scripts/build-awards.mjs.",
    awards, winners: winnersOut,
    works: Object.fromEntries(Object.entries(works).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))),
  };
  await writeFile(OUT, JSON.stringify(data, null, 0).replace(/\],"/g, '],\n"').replace(/\},"Q/g, '},\n"Q') + "\n");
  console.log(`Wrote ${awards.length} awards, ${winnersOut.length} winning entries, ${Object.keys(works).length} works.`);
  if (problems.length) console.warn("Problems:\n  " + problems.join("\n  "));
}

main().catch((e) => { console.error(e); process.exit(1); });
