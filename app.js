/* MARC-Enrich — app logic. Depends on marc-core.js (window.MarcCore). */
(() => {
  "use strict";
  const M = window.MarcCore;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fmt = (n) => Number(n).toLocaleString();
  const plain = M.plain;

  const TAG_NAMES = {
    "001": "Control number", "003": "Control number identifier", "005": "Date of latest transaction", "006": "Fixed data — additional", "007": "Physical description fixed field",
    "008": "Fixed-length data elements", "010": "LCCN", "015": "National bibliography number", "016": "National bibliographic agency control no.", "020": "ISBN", "022": "ISSN", "024": "Other standard identifier", "028": "Publisher number",
    "035": "System control number", "040": "Cataloging source", "041": "Language code", "042": "Authentication code", "043": "Geographic area code", "049": "Local holdings (OCLC)",
    "050": "LC call number", "082": "Dewey number", "090": "Local LC-type call number", "092": "Local Dewey call number", "099": "Local call number",
    "100": "Main entry — personal name", "110": "Main entry — corporate name", "111": "Main entry — meeting name", "130": "Main entry — uniform title",
    "240": "Uniform title", "245": "Title statement", "246": "Varying form of title", "250": "Edition statement", "255": "Cartographic data",
    "260": "Publication (older)", "264": "Production, publication, distribution", "300": "Physical description", "306": "Playing time",
    "336": "Content type", "337": "Media type", "338": "Carrier type", "340": "Physical medium", "344": "Sound characteristics", "347": "Digital file characteristics",
    "440": "Series statement (obsolete)", "490": "Series statement", "500": "General note", "504": "Bibliography note", "505": "Formatted contents note",
    "506": "Restrictions on access", "508": "Production credits", "511": "Participant or performer", "520": "Summary", "521": "Target audience",
    "530": "Additional physical form", "538": "System details", "546": "Language note", "586": "Awards note", "588": "Source of description",
    "600": "Subject — personal name", "610": "Subject — corporate name", "611": "Subject — meeting name", "630": "Subject — uniform title", "650": "Subject — topical",
    "651": "Subject — geographic", "655": "Genre/form", "690": "Local subject", "700": "Added entry — personal name", "710": "Added entry — corporate name",
    "711": "Added entry — meeting name", "730": "Added entry — uniform title", "740": "Added entry — related title", "776": "Additional physical form entry",
    "800": "Series added entry — personal name", "810": "Series added entry — corporate name", "811": "Series added entry — meeting name", "830": "Series added entry — uniform title",
    "856": "Electronic location and access", "880": "Alternate graphic representation", "596": "Local note", "590": "Local note", "999": "Local holdings / item data",
  };
  const tagName = (t) => TAG_NAMES[t] || (/^9/.test(t) ? "Local field" : /^59/.test(t) ? "Local note" : "");

  const S = {
    src: null,
    tagCounts: new Map(),
    encCounts: { utf8: 0, marc8: 0 },
    bad: [],
    view: 0,
    task: "summary",
    found: [],          // candidates from the latest lookup task
    foundTask: null,
    findHits: [],       // record indexes from the Find task
    run: { active: false, paused: false, stop: false },
    changes: new Map(), // record index -> { summary?: candidate, series?: candidate }
    filter: "review",
    shown: 50,
    exported: true,
    log: [],
  };

  // ---------- storage (best effort) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("marcenrich:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("marcenrich:" + k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem("marcenrich:" + k); } catch { /* ignore */ } },
  };

  // ---------- toast / log ----------
  let toastTimer = 0;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3800);
  }
  function log(line) {
    S.log.push(line);
    if (S.log.length > 300) S.log.shift();
    const el = $("#runLog");
    el.textContent = S.log.join("\n");
    el.scrollTop = el.scrollHeight;
  }

  // ---------- sample data ----------
  function f008(year, place) {
    const s = "250101s" + year + "    " + place + " ".repeat(11) + "000 1 eng d";
    return s.replace(/ /g, "\\");
  }
  const SAMPLE = String.raw`=LDR  00000nam\a2200000\i\4500
=001  sample0001
=008  ${f008("2003", "enk")}
=020  \\$a9780141439518$q(paperback)
=100  1\$aAusten, Jane,$d1775-1817,$eauthor.
=245  10$aPride and prejudice /$cJane Austen ; edited with an introduction and notes by Vivien Jones.
=264  \1$aLondon :$bPenguin Books,$c2003.
=300  \\$axliv, 435 pages ;$c20 cm.
=490  1\$aPenguin classics
=650  \0$aCourtship$vFiction.

=LDR  00000nam\a2200000\i\4500
=001  sample0002
=008  ${f008("2003", "enk")}
=020  \\$a9780141439471$q(paperback)
=100  1\$aShelley, Mary Wollstonecraft,$d1797-1851,$eauthor.
=245  10$aFrankenstein, or, The modern Prometheus /$cMary Shelley.
=264  \1$aLondon :$bPenguin Books,$c2003.
=300  \\$axlvi, 273 pages ;$c20 cm.
=650  \0$aScientists$vFiction.

=LDR  00000nam\a2200000\i\4500
=001  sample0003
=008  ${f008("2003", "nyu")}
=020  \\$a9780142437247$q(paperback)
=100  1\$aMelville, Herman,$d1819-1891,$eauthor.
=245  10$aMoby-Dick, or, The whale /$cHerman Melville.
=264  \1$aNew York :$bPenguin Books,$c2003.
=490  1\$aPenguin classics
=520  \\$aA young sailor signs on with the whaler Pequod, whose captain is set on hunting the white whale that cost him his leg.
=650  \0$aWhaling$vFiction.
=830  \0$aPenguin classics.

=LDR  00000nam\a2200000\i\4500
=001  sample0004
=008  ${f008("2019", "flu")}
=110  2\$aSample County Historical Society.
=245  10$aNeighborhood memories :$boral histories /$ccollected by the Sample County Historical Society.
=264  \1$aSample City, Florida :$bSample County Historical Society,$c2019.
=650  \0$aOral history.

=LDR  00000nam\a2200000\i\4500
=001  sample0005
=008  ${f008("1998", "nyu")}
=020  \\$a9780590353403
=100  1\$aRowling, J. K.,$eauthor.
=245  10$aHarry Potter and the sorcerer's stone /$cJ.K. Rowling ; illustrations by Mary GrandPré.
=264  \1$aNew York :$bArthur A. Levine Books,$c1998.
=650  \0$aWizards$vFiction.

=LDR  00000ngm\a2200000\i\4500
=001  sample0006
=008  ${f008("2012", "cau")}
=245  00$aTitanic /$cParamount Pictures and Twentieth Century Fox present ; a Lightstorm Entertainment production ; written and directed by James Cameron.
=264  \1$aHollywood, California :$bParamount Home Entertainment,$c2012.
=300  \\$a2 videodiscs (194 min.) :$bsound, color ;$c4 3/4 in.
=500  \\$aOriginally released as a motion picture in 1997.
=508  \\$aDirector of photography, Russell Carpenter.
=700  1\$aCameron, James,$d1954-$efilm director,$escreenwriter.

=LDR  00000ngm\a2200000\i\4500
=001  sample0007
=008  ${f008("2004", "cau")}
=245  04$aThe Sopranos.$pThe complete fifth season /$cHBO Original Programming.
=264  \1$aNew York :$bHBO Video,$c2004.
=300  \\$a4 videodiscs (approximately 676 min.) :$bsound, color ;$c4 3/4 in.
=500  \\$aOriginally broadcast on HBO in 2004.
=700  1\$aChase, David,$d1945-$ecreator.
`;

  // ---------- sources ----------
  function latin1(bytes) { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }

  function binarySource(name, size, u8) {
    const idx = M.indexRecords(u8);
    const sl = (i) => u8.subarray(idx[i][0], idx[i][1]);
    return {
      name, size, kind: "mrc", count: idx.length,
      raw: sl, get: (i) => M.parseRecord(sl(i)), tags: (i) => M.scanTags(sl(i)), leader: (i) => latin1(sl(i).subarray(0, 24)),
    };
  }
  function textSource(name, size, records) {
    return {
      name, size, kind: "mrk", count: records.length,
      raw: () => null, get: (i) => records[i], tags: (i) => records[i].fields.map((f) => f.tag), leader: (i) => records[i].leader,
    };
  }

  async function loadBytes(name, u8, isSample = false) {
    let src, warnings = [];
    if (M.looksLikeBinaryMarc(u8)) {
      src = binarySource(name, u8.length, u8);
    } else {
      const text = new TextDecoder("utf-8").decode(u8).replace(/^﻿/, "");
      if (!/^\s*=/.test(text)) throw new Error("This doesn't look like a MARC file. Use binary MARC (.mrc) or MarcEdit mnemonic text (.mrk).");
      const r = M.parseMnemonic(text);
      warnings = r.warnings;
      src = textSource(name, u8.length, r.records);
    }
    if (!src.count) throw new Error("No records were found in this file.");
    if (S.changes.size && !S.exported) {
      // loading a new file discards approvals for the old one
      log("Discarded " + S.changes.size + " unexported approvals from the previous file.");
    }
    src.sample = isSample;
    S.src = src;
    S.found = []; S.foundTask = null; S.findHits = []; S.changes.clear(); S.exported = true; S.view = 0;
    $("#findResult").hidden = true; $("#runBox").hidden = true; $("#runBtn").disabled = true;
    await computeStats(warnings);
    renderAll();
  }

  async function computeStats(warnings) {
    const src = S.src;
    S.tagCounts = new Map();
    S.encCounts = { utf8: 0, marc8: 0 };
    S.bad = [];
    const hint = $("#fileHint");
    for (let i = 0; i < src.count; i++) {
      try {
        const ldr = src.leader(i);
        S.encCounts[ldr[9] === "a" ? "utf8" : "marc8"]++;
        for (const t of new Set(src.tags(i))) S.tagCounts.set(t, (S.tagCounts.get(t) || 0) + 1);
      } catch (e) {
        S.bad.push({ i, msg: e.message });
      }
      if (i % 2000 === 1999) { hint.textContent = "Reading… " + fmt(i + 1) + " of " + fmt(src.count); await tick(); }
    }
    const lines = [];
    for (const w of warnings.slice(0, 50)) lines.push(w);
    for (const b of S.bad.slice(0, 50)) lines.push("Record " + (b.i + 1) + ": " + b.msg);
    const lg = $("#loadLog");
    lg.hidden = !lines.length;
    lg.textContent = lines.join("\n");
  }

  // ---------- record helpers ----------
  const cleanEnd = (s) => plain(s).replace(/[\s/:;,=]+$/, "").replace(/(?<!\b[A-Z])\.+$/, "").replace(/[\s/:;,=]+$/, "").trim();
  function recTitle(rec) {
    const f = M.getFields(rec, "245")[0];
    if (!f) return "(no 245)";
    return cleanEnd([M.sub(f, "a")[0], M.sub(f, "b")[0]].filter(Boolean).map(cleanEnd).join(" : ")) || "(no title)";
  }
  function recAuthor(rec) {
    for (const t of ["100", "110", "111"]) { const v = M.firstSub(rec, t, "a"); if (v) return cleanEnd(v); }
    return cleanEnd(M.firstSub(rec, "245", "c"));
  }
  function recIsbns(rec) {
    const out = [];
    for (const f of M.getFields(rec, "020")) for (const v of M.sub(f, "a")) {
      const m = plain(v).replace(/-/g, "").match(/\b(97[89]\d{10}|\d{9}[\dXx])\b/);
      if (m && !out.includes(m[1].toUpperCase())) out.push(m[1].toUpperCase());
    }
    return out;
  }
  function recYear(rec) {
    const c = M.firstSub(rec, "264", "c") || M.firstSub(rec, "260", "c");
    const m = plain(c).match(/\d{4}/);
    if (m) return m[0];
    const f = M.getFields(rec, "008")[0];
    return f && /^\d{4}$/.test(f.data.substr(7, 4)) ? f.data.substr(7, 4) : "";
  }
  const recId = (rec) => plain((M.getFields(rec, "001")[0] || {}).data || "");
  // Leader/06 codes for each record-type choice
  const TYPE_CODES = { text: "at", audio: "i", video: "g", media: "atig" };
  const typeOk = (ldr, type) => type === "all" || (TYPE_CODES[type] || "at").includes(ldr[6]);

  const norm = (s) => plain(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().replace(/^(the|a|an) /, "");

  function splitSeries(s) {
    // "Harry Potter (1)", "Penguin classics ; 12", "Discworld -- bk. 3", "Series, #4"
    const t = plain(s).trim();
    const m = t.match(/^(.*?)[\s,;:]*(?:\(|--|;|,|#|\bno\.|\bbk\.|\bbook\b|\bv\.|\bvol\.)\s*(?:#|no\.|bk\.|book|v\.|vol\.)?\s*(\d+[a-z]?)\)?\s*\.?$/i);
    if (m && m[1].trim()) return { series: cleanEnd(m[1]), volume: m[2] };
    return { series: cleanEnd(t), volume: "" };
  }

  // ---------- options ----------
  function opts() {
    return {
      task: S.task,
      sumType: $("#sumType").value, sumLimit: +$("#sumLimit").value || 0, sumWords: Math.max(15, +$("#sumWords").value || 60),
      sumInd1: $("#sumInd1").value, sumC: $("#sumC").value.trim(), sumNote: $("#sumNote").value.trim(),
      srcOL: $("#srcOL").checked, srcGB: $("#srcGB").checked, srcTitle: $("#srcTitle").checked, sumNoAI: $("#sumNoAI").checked,
      serMode: $("input[name=serMode]:checked").value, serType: $("#serType").value, serLimit: +$("#serLimit").value || 0,
      serAdd490: $("#serAdd490").checked, serUri: $("#serUri").checked, serAI: $("#serAI").checked,
      awdType: $("#awdType").value, awdMode: $("#awdMode").value, awdLimit: +$("#awdLimit").value || 0,
      awdTpl: $("#awdTpl").value.trim() || "{award}, {year}",
      awdTitles: $$("#awdList input:checked").map((x) => x.value),
      findTags: $("#findTags").value, findCond: $("#findCond").value, findType: $("#findType").value,
      apiKey: $("#apiKey").value.trim(), model: $("#model").value.trim() || "claude-haiku-5-5",
      endpoint: $("#endpoint").value.trim() || "https://api.anthropic.com/v1/messages",
      gbKey: $("#gbKey").value.trim(), concurrency: Math.min(8, Math.max(1, +$("#concurrency").value || 3)),
    };
  }
  const SETTING_IDS = ["sumType", "sumLimit", "sumWords", "sumInd1", "sumC", "sumNote", "srcOL", "srcGB", "srcTitle", "sumNoAI",
    "serType", "serLimit", "serAdd490", "serUri", "serAI", "awdType", "awdMode", "awdLimit", "awdTpl", "findTags", "findCond", "findType", "model", "endpoint", "concurrency", "rememberKey"];
  function saveSettings() {
    const o = {};
    for (const id of SETTING_IDS) { const el = $("#" + id); o[id] = el.type === "checkbox" ? el.checked : el.value; }
    o.serMode = $("input[name=serMode]:checked").value;
    o.awdOff = $$("#awdList input").filter((x) => !x.checked).map((x) => x.value);
    o.task = S.task;
    store.set("settings", o);
    if ($("#rememberKey").checked) store.set("keys", { apiKey: $("#apiKey").value, gbKey: $("#gbKey").value });
    else store.del("keys");
  }
  function loadSettings() {
    const o = store.get("settings", null);
    if (o) {
      for (const id of SETTING_IDS) { const el = $("#" + id); if (!el || o[id] === undefined) continue; if (el.type === "checkbox") el.checked = !!o[id]; else el.value = o[id]; }
      const r = $(`input[name=serMode][value="${o.serMode}"]`); if (r) r.checked = true;
      if (o.task) { const t = $(`input[name=task][value="${o.task}"]`); if (t) { t.checked = true; S.task = o.task; } }
    }
    const k = store.get("keys", null);
    if (k) { $("#apiKey").value = k.apiKey || ""; $("#gbKey").value = k.gbKey || ""; }
  }

  // ---------- network ----------
  const netCache = new Map();
  function getJSON(url) {
    if (netCache.has(url)) return netCache.get(url);
    const p = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      let r;
      try {
        r = await fetch(url, { signal: ctl.signal });
      } catch (e) {
        throw new Error("Could not reach " + new URL(url).host + (e.name === "AbortError" ? " (timed out)" : " (network or browser blocked the request)"));
      } finally { clearTimeout(timer); }
      if (r.status === 404) return null;
      if (r.status === 429) throw new Error(new URL(url).host + " is rate-limiting requests; lower 'Lookups at once' or add an API key");
      if (!r.ok) throw new Error(new URL(url).host + " returned " + r.status);
      return r.json();
    })();
    netCache.set(url, p);
    p.catch(() => netCache.delete(url));
    return p;
  }

  const textOf = (d) => (typeof d === "string" ? d : d && typeof d.value === "string" ? d.value : "");
  function stripHtml(s) {
    if (!s) return "";
    return new DOMParser().parseFromString(String(s), "text/html").body.textContent || "";
  }
  function cleanDesc(s) {
    return String(s || "")
      .split(/\n\s*-{3,}/)[0]
      .replace(/\(\s*\[source\]\[\d+\]\s*\)/gi, "")
      .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
      .replace(/\[([^\]]+)\]\[\d+\]/g, "$1")
      .replace(/^\s*\[\d+\]:.*$/gm, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);
  }

  async function olEdition(isbn) {
    const ed = await getJSON(`https://openlibrary.org/isbn/${isbn}.json`);
    if (!ed) return null;
    const wkey = ed.works && ed.works[0] && ed.works[0].key;
    const work = wkey ? await getJSON(`https://openlibrary.org${wkey}.json`) : null;
    return { ed, work, url: "https://openlibrary.org" + (wkey || ed.key || "") };
  }
  async function olDescription(isbn) {
    const r = await olEdition(isbn);
    if (!r) return null;
    const text = cleanDesc(textOf(r.work && r.work.description) || textOf(r.ed.description));
    if (text.length < 40) return null;
    return { name: "Open Library", title: (r.work && r.work.title) || r.ed.title || "", text, url: r.url };
  }
  async function olSearchDescription(title, author) {
    const q = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}${author ? "&author=" + encodeURIComponent(author.split(",")[0]) : ""}&limit=1&fields=key,title,author_name`;
    const j = await getJSON(q);
    const doc = j && j.docs && j.docs[0];
    if (!doc || !doc.key) return null;
    const work = await getJSON(`https://openlibrary.org${doc.key}.json`);
    const text = cleanDesc(textOf(work && work.description));
    if (text.length < 40) return null;
    return { name: "Open Library (title search)", title: doc.title + (doc.author_name ? " / " + doc.author_name.join(", ") : ""), text, url: "https://openlibrary.org" + doc.key };
  }
  async function gbVolume(isbn, o) {
    const j = await getJSON(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${o.gbKey ? "&key=" + encodeURIComponent(o.gbKey) : ""}`);
    const item = j && j.items && j.items[0];
    if (!item) return null;
    const vi = item.volumeInfo || {};
    return { vi, url: vi.infoLink || vi.canonicalVolumeLink || "", title: [vi.title, vi.subtitle].filter(Boolean).join(" : ") + (vi.authors ? " / " + vi.authors.join(", ") : "") };
  }
  async function gbSeriesTitle(seriesId, o) {
    const j = await getJSON(`https://www.googleapis.com/books/v1/series/get?series_id=${encodeURIComponent(seriesId)}${o.gbKey ? "&key=" + encodeURIComponent(o.gbKey) : ""}`);
    return (j && j.series && j.series[0] && j.series[0].title) || "";
  }
  // JSONP fallback for services that support ?callback= but not CORS
  let jsonpSeq = 0;
  function getJSONP(url) {
    if (netCache.has("jsonp:" + url)) return netCache.get("jsonp:" + url);
    const p = new Promise((resolve, reject) => {
      const name = "__marcEnrichCb" + ++jsonpSeq;
      const s = document.createElement("script");
      const done = () => { delete window[name]; s.remove(); clearTimeout(timer); };
      const timer = setTimeout(() => { done(); reject(new Error("Could not reach " + new URL(url).host + " (timed out)")); }, 20000);
      window[name] = (data) => { done(); resolve(data); };
      s.onerror = () => { done(); reject(new Error("Could not reach " + new URL(url).host)); };
      s.src = url + (url.includes("?") ? "&" : "?") + "callback=" + name;
      document.head.append(s);
    });
    netCache.set("jsonp:" + url, p);
    p.catch(() => netCache.delete("jsonp:" + url));
    return p;
  }
  let lcUseJsonp = false;
  async function lcSeries(q) {
    const url = `https://id.loc.gov/authorities/names/suggest2?q=${encodeURIComponent(q)}&searchtype=keyword&count=20`;
    let j;
    if (!lcUseJsonp) {
      try { j = await getJSON(url); }
      catch (e) { if (!/network or browser blocked/.test(e.message)) throw e; lcUseJsonp = true; }
    }
    if (lcUseJsonp) j = await getJSONP(url);
    const hits = (j && j.hits) || [];
    return hits
      .filter((h) => ((h.more && h.more.rdftypes) || []).some((t) => t === "Title" || t === "NameTitle"))
      .slice(0, 8)
      .map((h) => ({
        label: h.aLabel || h.suggestLabel || "",
        uri: h.uri || "",
        marcKey: ((h.more && h.more.marcKeys) || [])[0] || "",
        note: ((h.more && h.more.sources) || [])[0] || "",
      }));
  }

  // ---------- AI ----------
  async function claude(o, system, user, maxTokens = 500) {
    if (!o.apiKey) { const e = new Error("Add an Anthropic API key under AI and lookup settings."); e.fatal = true; throw e; }
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(o.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json", "x-api-key": o.apiKey, "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({ model: o.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
        });
      } catch (e) {
        if (attempt < 3) { await sleep(1500 * 2 ** attempt); continue; }
        throw new Error("Could not reach the AI endpoint.");
      }
      if (r.ok) {
        const j = await r.json();
        return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      }
      let msg = "";
      try { const j = await r.json(); msg = (j.error && j.error.message) || ""; } catch { /* ignore */ }
      if ((r.status === 429 || r.status === 529 || r.status >= 500) && attempt < 4) { await sleep(2000 * 2 ** attempt); continue; }
      const e = new Error(`AI request failed (${r.status})${msg ? ": " + msg : ""}`);
      e.fatal = [400, 401, 403, 404].includes(r.status);
      throw e;
    }
  }
  function parseJSON(t) {
    const m = String(t).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AI reply was not JSON");
    return JSON.parse(m[0]);
  }

  const SUMMARY_SYSTEM = (words) => `You write summary notes (MARC field 520) for a public library catalog.

Rules:
- Use only facts stated in the SOURCE texts. Never add plot points, characters, settings, themes, awards, reviews, reading levels, or praise that the sources do not state.
- Neutral, objective tone. No marketing language (for example "gripping", "must-read", "bestselling", "beloved"), no review quotations, no second person.
- Present tense, third person. Do not begin with the title, "This book", or "In this".
- Do not reveal endings or twists.
- One to three sentences, at most ${words} words, ending with a period.
- Write in your own words. Never copy a run of more than five words from a source.
- First check that the sources describe the same work as the CATALOG RECORD (same title and author). If they describe a different work, describe only the author, or contain no description of the content, do not write a summary.

Reply with JSON only and nothing else, in one of these forms:
{"skip": false, "summary": "...", "source": "<name of the source you relied on most>"}
{"skip": true, "reason": "<short reason>"}`;

  const SERIES_SYSTEM = `You match a book's series statement to a Library of Congress series authority heading.

Choose a candidate only if it clearly names the same series. Allow differences in capitalization, punctuation, initial articles, and numbering. Do not choose a translated, regional, or differently named sub-series unless the statement names it. Use the record's title, author, and publisher to decide between close candidates. If no candidate fits, choose null.

Reply with JSON only and nothing else:
{"pick": <candidate number or null>, "volume": "<the book's number in the series, or empty>", "reason": "<short reason>"}`;

  function recordBlock(c) {
    return `CATALOG RECORD\nTitle: ${c.title}\nAuthor: ${c.author || "(none)"}\nPublished: ${[c.publisher, c.year].filter(Boolean).join(", ") || "(unknown)"}\nISBN: ${c.isbns.join(", ") || "(none)"}`;
  }

  // ---------- candidates ----------
  function makeCandidate(i, rec) {
    return {
      i, id: recId(rec), title: recTitle(rec), author: recAuthor(rec), isbns: recIsbns(rec), year: recYear(rec),
      publisher: cleanEnd(M.firstSub(rec, "264", "b") || M.firstSub(rec, "260", "b")),
      s490: M.getFields(rec, "490").map((f) => ({ a: plain(M.sub(f, "a").join(" ")), v: plain(M.sub(f, "v")[0] || ""), ind1: f.ind1 })),
      status: "queued", sources: [], props: {}, note: "", opts: null,
    };
  }

  function tagMatcher(spec) {
    const toks = String(spec).split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    return toks.map((t) => {
      if (/^[0-9X]{3}$/.test(t)) { const re = new RegExp("^" + t.replace(/X/g, "\\d") + "$"); return (tags) => [...tags].some((x) => re.test(x)); }
      return (tags) => tags.has(t);
    });
  }

  function selector(o) {
    const SERIES_8XX = ["800", "810", "811", "830"];
    if (o.task === "summary") return { type: o.sumType, test: (tags) => !tags.has("520") };
    if (o.task === "awards") return { type: o.awdType, test: (tags) => o.awdMode !== "no586" || !tags.has("586") };
    if (o.task === "series") {
      if (o.serMode === "untraced") return { type: o.serType, test: (tags) => tags.has("490") && !SERIES_8XX.some((t) => tags.has(t)) };
      return { type: o.serType, test: (tags) => !tags.has("490") && !tags.has("440") && !SERIES_8XX.some((t) => tags.has(t)) };
    }
    const ms = tagMatcher(o.findTags);
    if (!ms.length) return null;
    const cond = o.findCond;
    return {
      type: o.findType,
      test: (tags) => cond === "hasAny" ? ms.some((m) => m(tags)) : cond === "missingAny" ? ms.some((m) => !m(tags)) : ms.every((m) => !m(tags)),
    };
  }

  async function findRecords() {
    if (!S.src) return toast("Load a file first.");
    if (S.run.active) return toast("Wait for the current run to finish or stop it.");
    const o = opts();
    const sel = selector(o);
    if (!sel) return toast("Enter at least one tag to search for.");
    const btn = $("#findBtn");
    btn.disabled = true;
    const hits = [];
    const res = $("#findResult");
    res.hidden = false;
    for (let i = 0; i < S.src.count; i++) {
      try {
        if (typeOk(S.src.leader(i), sel.type) && sel.test(new Set(S.src.tags(i)))) hits.push(i);
      } catch { /* bad record: skip */ }
      if (i % 3000 === 2999) { res.innerHTML = `<p class="muted">Searching… ${fmt(i + 1)} of ${fmt(S.src.count)}</p>`; await tick(); }
    }
    btn.disabled = false;

    if (o.task === "find") {
      S.findHits = hits;
      renderFindResult(o);
      $("#runBtn").disabled = true;
      return;
    }
    const limit = o.task === "summary" ? o.sumLimit : o.task === "awards" ? o.awdLimit : o.serLimit;
    const take = limit ? hits.slice(0, limit) : hits;
    S.found = take.map((i) => makeCandidate(i, S.src.get(i)));
    S.foundTask = o.task;
    S.filter = "review";
    S.shown = 50;
    const label = o.task === "summary" ? "records with no 520" : o.task === "awards" ? (({ video: "video records", audio: "audiobook records", text: "book records", media: "book, audiobook and video records" }[o.awdType] || "records")) + (o.awdMode === "no586" ? " with no 586" : " to check")
      : o.serMode === "untraced" ? "records with a 490 but no series added entry" : "records with no series fields";
    const noIsbn = S.found.filter((c) => !c.isbns.length).length;
    res.innerHTML = `<p><strong>${fmt(hits.length)}</strong> ${esc(label)}${limit && hits.length > limit ? ` — the first <strong>${fmt(limit)}</strong> will be looked up` : ""}.</p>`
      + (o.task === "summary" || (o.task === "series" && o.serMode === "none") ? `<p class="muted" style="font-size:.88rem">${fmt(noIsbn)} of these ${noIsbn === 1 ? "has" : "have"} no ISBN${o.task === "summary" && !o.srcTitle ? " and will be skipped" : ""}.</p>` : "")
      + `<ul style="margin:8px 0 0;padding-left:20px;font-size:.9rem">${S.found.slice(0, 5).map((c) => `<li>${esc(c.title)}${c.author ? ` <span class="muted">— ${esc(c.author)}</span>` : ""}</li>`).join("")}</ul>`;
    $("#runBtn").disabled = !S.found.length;
    renderReviewCounts();
  }

  function renderFindResult(o) {
    const n = S.findHits.length;
    const res = $("#findResult");
    res.innerHTML = `<p><strong>${fmt(n)}</strong> of ${fmt(S.src.count)} records match.</p>
      <div class="btnrow" style="margin-top:10px">
        <button class="btn small" data-find="csv" ${n ? "" : "disabled"}>Download list .csv</button>
        <button class="btn small" data-find="mrc" ${n ? "" : "disabled"}>Download these records .mrc</button>
        <button class="btn small" data-find="mrk" ${n ? "" : "disabled"}>Download these records .mrk</button>
        <button class="btn small" data-find="view" ${n ? "" : "disabled"}>View first match</button>
      </div>`;
  }

  // ---------- run ----------
  async function pool(items, n, fn) {
    let next = 0;
    async function worker() {
      for (;;) {
        if (S.run.stop) return;
        while (S.run.paused && !S.run.stop) await sleep(250);
        if (S.run.stop) return;
        const k = next++;
        if (k >= items.length) return;
        await fn(items[k]);
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
  }

  async function runLookups() {
    if (!S.found.length || S.run.active) return;
    const o = opts();
    saveSettings();
    if (S.foundTask === "summary" && !o.sumNoAI && !o.apiKey) {
      $("#aiBox").open = true; $("#apiKey").focus();
      return toast("Add an Anthropic API key, or tick 'Fetch sources only, no AI'.");
    }
    if (S.foundTask === "summary" && !o.srcOL && !o.srcGB && !o.srcTitle) return toast("Choose at least one place to look.");
    if (S.foundTask === "awards") {
      if (!o.awdTitles.length) return toast("Choose at least one award list.");
      log("Loading the saved award winner lists…");
      try {
        const { report } = await loadAwardIndex(o);
        for (const line of report) log(line);
      } catch (e) { return toast(e.message); }
    }
    const items = S.found.filter((c) => c.status === "queued" || c.status === "error");
    if (!items.length) return toast("Every record in this set has been looked up. Find records again to start over.");
    S.run = { active: true, paused: false, stop: false };
    S.log = [];
    $("#runBox").hidden = false;
    $("#runBtn").disabled = true; $("#findBtn").disabled = true;
    $("#pauseBtn").hidden = false; $("#pauseBtn").textContent = "Pause"; $("#stopBtn").hidden = false;
    let done = 0;
    log(`Starting ${S.foundTask} lookups for ${fmt(items.length)} records with ${o.concurrency} at a time.`);
    const t0 = Date.now();
    await pool(items, o.concurrency, async (c) => {
      c.opts = o;
      try {
        await PROCESS[S.foundTask](c, o);
      } catch (e) {
        c.status = "error";
        c.note = e.message;
        if (e.fatal) { S.run.stop = true; toast(e.message); }
      }
      done++;
      log(`#${c.i + 1} ${c.title.slice(0, 60)} — ${statusLabel(c.status)}${c.note ? ": " + c.note : ""}`);
      updateRunStats(done, items.length);
      scheduleReviewRender();
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    log(S.run.stop ? `Stopped after ${fmt(done)} records.` : `Finished ${fmt(done)} records in ${secs}s.`);
    S.run.active = false;
    $("#pauseBtn").hidden = true; $("#stopBtn").hidden = true; $("#findBtn").disabled = false;
    $("#runBtn").disabled = !S.found.some((c) => c.status === "queued" || c.status === "error");
    $("#runBtn").textContent = S.found.some((c) => c.status === "queued" || c.status === "error") ? "Resume lookups" : "Run lookups";
    updateRunStats(done, items.length);
    renderReview();
    if (!S.run.stop) toast("Lookups finished. Review the results.");
  }

  function updateRunStats(done, total) {
    $("#runBar").style.width = (total ? (100 * done) / total : 0) + "%";
    const c = countStatuses();
    $("#runStats").innerHTML = `<span>${fmt(done)} / ${fmt(total)} done</span>`
      + ["ready", "review", "nosource", "nomatch", "skipped", "error"].filter((k) => c[k]).map((k) => `<span>${statusLabel(k)}: ${fmt(c[k])}</span>`).join("");
  }

  async function processSummary(c, o) {
    c.status = "working"; c.note = ""; c.sources = []; c.props = {};
    if (!c.isbns.length && !o.srcTitle) { c.status = "nosource"; c.note = "No ISBN"; return; }
    const sources = [];
    for (const isbn of c.isbns.slice(0, 3)) {
      if (o.srcOL && !sources.some((s) => s.name === "Open Library")) {
        try { const d = await olDescription(isbn); if (d) sources.push(d); } catch (e) { c.note = e.message; }
      }
      if (o.srcGB && !sources.some((s) => s.name === "Google Books")) {
        try {
          const g = await gbVolume(isbn, o);
          const text = g && cleanDesc(stripHtml(g.vi.description));
          if (text && text.length >= 40) sources.push({ name: "Google Books", title: g.title, text, url: g.url });
        } catch (e) { c.note = e.message; }
      }
      if (sources.length >= (o.srcOL ? 1 : 0) + (o.srcGB ? 1 : 0)) break;
    }
    if (!sources.length && o.srcTitle && c.title) {
      try { const d = await olSearchDescription(c.title, c.author); if (d) sources.push(d); } catch (e) { c.note = e.message; }
    }
    c.sources = sources;
    if (!sources.length) {
      c.status = c.note ? "error" : "nosource";
      if (!c.note) c.note = c.isbns.length ? "No description found" : "No ISBN, and title search found nothing";
      return;
    }
    c.note = "";
    if (o.sumNoAI) { c.props = { summary: "", source: sources[0].name }; c.status = "review"; c.note = "Source found. Write the summary yourself."; return; }
    const user = recordBlock(c) + "\n\n" + sources.map((s, k) => `SOURCE ${k + 1} — ${s.name}${s.title ? " (describes: " + s.title + ")" : ""}\n${s.text}`).join("\n\n");
    const r = parseJSON(await claude(o, SUMMARY_SYSTEM(o.sumWords), user, 600));
    if (r.skip || !r.summary) { c.status = "skipped"; c.note = r.reason || "AI found no usable description"; c.props = { summary: "", source: sources[0].name }; return; }
    c.props = { summary: String(r.summary).trim(), source: sources.find((s) => s.name === r.source) ? r.source : sources[0].name };
    c.status = "ready";
  }

  async function processSeries(c, o) {
    c.status = "working"; c.note = ""; c.sources = []; c.props = {};
    const stmts = [];
    if (o.serMode === "untraced") {
      for (const s of c.s490) {
        const sp = splitSeries(s.a);
        stmts.push({ name: "Your 490", series: sp.series, volume: cleanEnd(s.v) || sp.volume, url: "" });
      }
    } else {
      if (!c.isbns.length) { c.status = "nosource"; c.note = "No ISBN"; return; }
      for (const isbn of c.isbns.slice(0, 3)) {
        try {
          const r = await olEdition(isbn);
          for (const s of (r && r.ed.series) || []) { const sp = splitSeries(s); stmts.push({ name: "Open Library", ...sp, url: r.url }); }
        } catch (e) { c.note = e.message; }
        try {
          const g = await gbVolume(isbn, o);
          const vs = g && g.vi.seriesInfo && g.vi.seriesInfo.volumeSeries && g.vi.seriesInfo.volumeSeries[0];
          if (vs && vs.seriesId) {
            const title = await gbSeriesTitle(vs.seriesId, o);
            if (title) { const sp = splitSeries(title); stmts.push({ name: "Google Books", series: sp.series, volume: g.vi.seriesInfo.bookDisplayNumber || sp.volume || "", url: g.url }); }
          }
        } catch (e) { c.note = e.message; }
        if (stmts.length) break;
      }
    }
    const uniq = [];
    for (const s of stmts) if (s.series && !uniq.some((u) => norm(u.series) === norm(s.series))) uniq.push(s);
    c.sources = uniq.map((s) => ({ name: s.name, title: "", text: s.series + (s.volume ? " ; " + s.volume : ""), url: s.url }));
    if (!uniq.length) { c.status = c.note ? "error" : "nosource"; if (!c.note) c.note = "No series found in the sources"; return; }
    c.note = "";
    const st = uniq[0];
    const cands = await lcSeries(st.series);
    c.props = { statement: st.series, volume: st.volume || "", candidates: cands, pick: null, add490: o.serMode === "none" && o.serAdd490 };
    if (uniq.length > 1) c.note = "Other series in sources: " + uniq.slice(1).map((u) => u.series).join("; ") + ". ";
    if (!cands.length) { c.status = "nomatch"; c.note += `No LC series authority found for "${st.series}".`; return; }
    const exact = cands.map((k, ix) => (norm(k.label) === norm(st.series) ? ix : -1)).filter((ix) => ix >= 0);
    if (exact.length === 1) { c.props.pick = exact[0]; c.status = "ready"; c.note += "Exact match to an LC authority."; return; }
    if (o.serAI && o.apiKey) {
      const user = recordBlock(c) + `\n\nSERIES STATEMENT: ${st.series}${st.volume ? " ; " + st.volume : ""}\n\nCANDIDATES\n`
        + cands.map((k, ix) => `${ix + 1}. ${k.marcKey || k.label}${k.note ? "  [authority source: " + k.note + "]" : ""}`).join("\n");
      const r = parseJSON(await claude(o, SERIES_SYSTEM, user, 300));
      const p = Number(r.pick);
      if (r.pick !== null && p >= 1 && p <= cands.length) {
        c.props.pick = p - 1;
        if (r.volume && !c.props.volume) c.props.volume = String(r.volume);
        c.status = "ready"; c.note += "AI: " + (r.reason || "chose this authority");
      } else { c.status = "review"; c.note += "AI found no clear match" + (r.reason ? ": " + r.reason : ". Choose one or none."); }
      return;
    }
    c.status = "review"; c.note += "Several possible authorities. Choose one or none.";
  }

  // ---------- awards (586) ----------
  // Winner lists live in data/awards.json, rebuilt yearly by the "Update award data" workflow.
  let awardData = null;
  let awardIndex = { key: "", value: null };

  async function loadAwardData() {
    if (awardData) return awardData;
    let r;
    try { r = await fetch("data/awards.json", { cache: "no-cache" }); }
    catch { throw new Error("Couldn't load the award data. Open the site from GitHub Pages (or any web server), not as a local file."); }
    if (!r.ok) throw new Error("Award data isn't built yet. Run the \"Update award data\" workflow in the repository's Actions tab.");
    awardData = await r.json();
    return awardData;
  }

  async function renderAwardLists() {
    const box = $("#awdList");
    const info = $("#awdInfo");
    try {
      const d = await loadAwardData();
      const off = (store.get("settings", {}) || {}).awdOff || [];
      const counts = d.awards.map((_, ai) => d.winners.filter((w) => w.a === ai).length);
      box.innerHTML = d.awards.map((aw, ai) => `<label class="check"><input type="checkbox" id="awd${ai}" value="${esc(aw.list)}" ${off.includes(aw.list) ? "" : "checked"}>
        <span>${esc(aw.title)} <small class="muted">· ${fmt(counts[ai])} winners · <a href="${esc(aw.url)}" target="_blank" rel="noopener">list</a></small></span></label>`).join("");
      info.textContent = `Winner lists saved ${d.generated} from Wikipedia and Wikidata. They refresh once a year; run the "Update award data" workflow to refresh sooner or after adding a list to data/award-lists.txt.`;
    } catch (e) {
      box.innerHTML = "";
      info.textContent = e.message;
    }
  }

  async function loadAwardIndex(o) {
    const key = o.awdTitles.join("|");
    if (awardIndex.value && awardIndex.key === key) return awardIndex.value;
    const d = await loadAwardData();
    const index = new Map();
    const report = [];
    const addKey = (k, e) => { if (!k) return; const list = index.get(k) || []; if (!list.includes(e)) list.push(e); index.set(k, list); };
    d.awards.forEach((aw, ai) => {
      if (!o.awdTitles.includes(aw.list)) return;
      let n = 0;
      for (const row of d.winners) {
        if (row.a !== ai) continue;
        const w = d.works[row.w];
        if (!w) continue;
        n++;
        const e = { award: aw.title, awardUrl: aw.url, work: w.l, workUrl: "https://www.wikidata.org/wiki/" + row.w,
          year: row.y, pubYear: w.p, start: w.s, end: w.e, directors: w.d || [] };
        for (const name of [w.l, ...(w.alt || [])]) { addKey(norm(name), e); if (name.includes(":")) addKey(norm(name.split(":")[0]), e); }
      }
      report.push(`${aw.title}: ${fmt(n)} winners`);
    });
    awardIndex = { key, value: { index, report } };
    return awardIndex.value;
  }

  function recordTitles(rec) {
    const out = new Set();
    const add = (s) => { const n = norm(String(s).replace(/&/g, " and ")); if (n) out.add(n); };
    for (const f of M.getFields(rec, "245")) {
      const a = M.sub(f, "a")[0] || "";
      add(a); add([a, M.sub(f, "b")[0] || ""].join(" "));
      const skip = parseInt(f.ind2, 10); // nonfiling characters
      if (skip > 0) add(plain(a).slice(skip));
    }
    for (const t of ["130", "240", "246", "730"]) for (const f of M.getFields(rec, t)) add(M.sub(f, "a")[0] || "");
    return [...out];
  }
  function recordPeopleText(rec) {
    const parts = [];
    for (const f of rec.fields) {
      if (/^(100|110|245|508|511|700|710)$/.test(f.tag)) for (const [code, v] of f.subfields || []) if (f.tag !== "245" || code === "c") parts.push(v);
    }
    return " " + norm(parts.join(" ")) + " ";
  }
  function recordYears(rec) {
    const ys = new Set();
    const f008 = M.getFields(rec, "008")[0];
    if (f008) for (const y of [f008.data.substr(7, 4), f008.data.substr(11, 4)]) if (/^(1[89]|20)\d\d$/.test(y)) ys.add(+y);
    for (const f of rec.fields) {
      if (!/^(046|245|250|260|264|500|518)$/.test(f.tag)) continue;
      for (const [, v] of f.subfields || []) for (const m of plain(v).matchAll(/\b(1[89]\d\d|20\d\d)\b/g)) ys.add(+m[1]);
    }
    return [...ys];
  }

  async function processAwards(c, o) {
    c.status = "working"; c.note = ""; c.sources = []; c.props = { matches: [] };
    const { index } = await loadAwardIndex(o);
    const rec = S.src.get(c.i);
    const found = [];
    for (const t of recordTitles(rec)) for (const e of index.get(t) || []) if (!found.includes(e)) found.push(e);
    if (!found.length) { c.status = "nosource"; c.note = "Not a winner in the selected award lists"; return; }
    const people = recordPeopleText(rec);
    const years = recordYears(rec);
    const existing = M.getFields(rec, "586").map((f) => norm(M.sub(f, "a").join(" ")));
    for (const e of found) {
      const dir = e.directors.find((d) => { const last = norm(d).split(" ").pop(); return last.length > 2 && people.includes(" " + last + " "); });
      const isSeries = !!e.start && !e.pubYear;
      // films: the release year (or award year) must fit; series: only the award's own season year counts
      const yr = isSeries
        ? years.find((y) => e.year && Math.abs(y - e.year) <= 1)
        : years.find((y) => (e.pubYear && Math.abs(y - e.pubYear) <= 1) || (e.year && Math.abs(y - e.year) <= 1));
      const inRun = isSeries && years.some((y) => y >= e.start - 1 && y <= (e.end || e.start + 30) + 1);
      const strong = !!(dir || yr);
      const already = existing.some((x) => x.includes(norm(e.award).replace(/^.*? for /, "")) && (!e.year || x.includes(String(e.year))));
      c.props.matches.push({
        ...e, strong, already, checked: strong && !already,
        why: already ? "already in a 586" : dir ? "director " + dir + " matches" : yr ? "year " + yr + " fits"
          : inRun ? `the series won this in ${e.year}; tick it if this set includes that season` : "title only — check it's the same work",
      });
    }
    const works = [];
    for (const m of c.props.matches) if (!works.some((w) => w.workUrl === m.workUrl)) works.push(m);
    c.sources = works.map((w) => ({
      name: "Wikidata", url: w.workUrl,
      title: w.work + (w.pubYear || w.start ? " (" + (w.pubYear || w.start) + (w.end ? "–" + w.end : "") + ")" : ""),
      text: (w.directors.length ? "Directed by " + w.directors.join(", ") + ". " : "")
        + "Won: " + c.props.matches.filter((m) => m.workUrl === w.workUrl).map((m) => m.award + (m.year ? " (" + m.year + ")" : "")).join("; "),
    }));
    const open = c.props.matches.filter((m) => !m.already);
    if (!open.length) { c.status = "skipped"; c.note = "Every matching award is already in a 586"; return; }
    c.status = open.some((m) => m.strong) ? "ready" : "review";
    c.note = c.status === "ready" ? `${open.filter((m) => m.checked).length} award(s) confirmed` : "Title matches only. Tick the awards that belong to this work.";
  }

  const PROCESS = { summary: processSummary, series: processSeries, awards: processAwards };

  // ---------- building new fields ----------
  function endPeriod(s) { s = s.trim(); return /[.!?]["')\]]?$/.test(s) ? s : s + "."; }

  function fieldFromMarcKey(key, label) {
    const m = String(key || "").match(/^(1[0-3]\d)(.)(.)(\$.*)$/);
    if (!m) return { tag: "830", ind1: " ", ind2: "0", subfields: [["a", label]] };
    const subs = m[4].split("$").slice(1).filter(Boolean).map((p) => [p[0], p.slice(1)]);
    return { tag: "8" + m[1].slice(1), ind1: m[2], ind2: m[3], subfields: subs };
  }

  function buildFields(c, task) {
    const o = c.opts || opts();
    const p = c.props || {};
    if (task === "awards") {
      return (p.matches || []).filter((m) => m.checked && !m.already).map((m) => ({
        tag: "586", ind1: " ", ind2: " ",
        subfields: [["a", (o.awdTpl || "{award}, {year}").replace(/\{award\}/g, m.award)
          .replace(m.year ? /\{year\}/g : /[\s,;:–-]*\{year\}/g, m.year ? String(m.year) : "").trim()]],
      }));
    }
    if (task === "summary") {
      const text = (p.summary || "").trim();
      if (!text) return [];
      const f = { tag: "520", ind1: o.sumInd1 || " ", ind2: " ", subfields: [["a", endPeriod(text)]] };
      if (o.sumC) f.subfields.push(["c", o.sumC.replace(/\{source\}/g, p.source || (c.sources[0] && c.sources[0].name) || "web sources")]);
      const out = [f];
      if (o.sumNote) out.push({ tag: "500", ind1: " ", ind2: " ", subfields: [["a", endPeriod(o.sumNote)]] });
      return out;
    }
    const out = [];
    const vol = String(p.volume || "").trim().replace(/\.$/, "");
    const cand = p.pick !== null && p.pick !== undefined ? p.candidates[p.pick] : null;
    if (p.add490 && p.statement) {
      out.push({ tag: "490", ind1: cand ? "1" : "0", ind2: " ", subfields: vol ? [["a", p.statement + " ;"], ["v", vol]] : [["a", p.statement]] });
    }
    if (cand) {
      const f = fieldFromMarcKey(cand.marcKey, cand.label);
      const last = f.subfields[f.subfields.length - 1];
      if (vol) { last[1] = last[1].replace(/[.\s]+$/, "") + " ;"; f.subfields.push(["v", vol + "."]); }
      else if (!/[.?!)\-]$/.test(last[1])) last[1] += ".";
      if (o.serUri && cand.uri) f.subfields.push(["0", cand.uri]);
      out.push(f);
    }
    return out;
  }

  /** Apply approved changes to a cloned record. Returns notes about edits made. */
  function applyChanges(rec, ch) {
    const notes = [];
    for (const task of ["summary", "series", "awards"]) {
      const c = ch[task];
      if (!c) continue;
      const fields = buildFields(c, task);
      if (task === "summary" && M.getFields(rec, "520").length) { notes.push("already had a 520; not added"); continue; }
      for (const f of fields) M.insertField(rec, f);
      if (task === "series" && fields.some((f) => /^8/.test(f.tag)) && !c.props.add490) {
        for (const f of M.getFields(rec, "490")) if (f.ind1 === "0" && norm(splitSeries(M.sub(f, "a").join(" ")).series) === norm(c.props.statement)) { f.ind1 = "1"; notes.push("490 first indicator set to 1"); }
      }
    }
    return notes;
  }

  // ---------- review ----------
  const STATUS = {
    queued: "Queued", working: "Working", ready: "Ready", review: "Needs choice", approved: "Approved", rejected: "Rejected",
    nosource: "No source", nomatch: "No LC match", skipped: "Skipped", error: "Error",
  };
  const statusLabel = (s) => STATUS[s] || s;
  function countStatuses() {
    const c = {};
    for (const x of S.found) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }
  const FILTERS = [
    ["review", "To review", (x) => x.status === "ready" || x.status === "review" || (x.status === "nomatch" && x.props.add490)],
    ["approved", "Approved", (x) => x.status === "approved"],
    ["rejected", "Rejected", (x) => x.status === "rejected"],
    ["nosource", "No source / match", (x) => x.status === "nosource" || (x.status === "nomatch" && !x.props.add490)],
    ["skipped", "Skipped by AI", (x) => x.status === "skipped"],
    ["error", "Errors", (x) => x.status === "error"],
    ["pending", "Not run yet", (x) => x.status === "queued" || x.status === "working"],
    ["all", "All", () => true],
  ];

  let reviewTimer = 0;
  function scheduleReviewRender() {
    renderReviewCounts();
    if ($("#p-review").hidden) return;
    clearTimeout(reviewTimer);
    reviewTimer = setTimeout(() => {
      const a = document.activeElement;
      if (a && $("#cards").contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) return; // don't disrupt typing
      renderReview();
    }, 600);
  }

  function renderReviewCounts() {
    const n = S.found.filter(FILTERS[0][2]).length;
    const rc = $("#reviewCount");
    rc.hidden = !n; rc.textContent = fmt(n);
    const ec = $("#exportCount");
    ec.hidden = !S.changes.size; ec.textContent = fmt(S.changes.size);
  }

  function hiLine(line, isNew) {
    const tag = line.slice(1, 4);
    const rest = line.slice(4);
    const escs = (s) => s.replace(/\{(dollar|lcub|rcub|0x[0-9A-F]{2})\}/g, '<span class="m-esc">{$1}</span>');
    let out = `<span class="m-tag">=${esc(tag)}</span>`;
    if (tag === "LDR" || M.isControlTag(tag)) out += escs(esc(rest));
    else {
      out += rest.slice(0, 2) + `<span class="m-ind">${esc(rest.slice(2, 4))}</span>`
        + escs(esc(rest.slice(4))).replace(/\$(.)/g, (m, c) => `<span class="m-code">$${c}</span>`);
    }
    return isNew ? `<span class="m-new">${out}</span>` : out;
  }
  const hiFields = (fields) => fields.map((f) => hiLine(M.fieldToMnemonic(f), true)).join("\n");

  function cardHTML(c, k) {
    const task = S.foundTask;
    const p = c.props || {};
    const head = `<div class="card-head"><span class="t">${esc(c.title)}${c.author ? ` <span class="muted" style="font-weight:400">— ${esc(c.author)}</span>` : ""}</span>
      <span class="meta">#${c.i + 1}${c.id ? " · 001 " + esc(c.id) : ""}${c.isbns[0] ? " · " + esc(c.isbns[0]) : ""}</span>
      <span class="pill ${esc(c.status)}">${esc(statusLabel(c.status))}</span></div>`;
    const srcs = c.sources.length
      ? c.sources.map((s) => `<div class="src-item"><b>${esc(s.name)}</b>${s.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noopener">open</a>` : ""}${s.title ? `<div class="muted" style="font-size:.8rem">${esc(s.title)}</div>` : ""}<div>${esc(s.text)}</div></div>`).join("")
      : `<div class="src-item muted">${c.status === "queued" ? "Not looked up yet." : "No source text."}</div>`;
    let prop = "";
    if (task === "summary") {
      if (c.sources.length) {
        prop = `<label class="fld"><span>520 $a summary</span><textarea data-k="${k}" data-edit="summary" rows="4">${esc(p.summary || "")}</textarea>
          <small class="muted" data-wc="${k}">${wordCount(p.summary)} words</small></label>`;
      }
    } else if (task === "awards") {
      if ((p.matches || []).length) {
        prop = `<div class="cands">${p.matches.map((m, ix) => `<label class="cand"><input type="checkbox" data-k="${k}" data-award="${ix}" ${m.checked ? "checked" : ""} ${m.already ? "disabled" : ""}>
          <span>${esc(m.award)}${m.year ? ", " + m.year : ""} <span class="muted">— ${esc(m.work)}</span></span>
          <small class="muted">${m.strong ? "Confirmed: " : ""}${esc(m.why)} · <a href="${esc(m.awardUrl)}" target="_blank" rel="noopener">winner list</a></small></label>`).join("")}</div>`;
      }
    } else if (p.statement !== undefined) {
      const cands = (p.candidates || []).map((x, ix) => `<label class="cand"><input type="radio" name="pick-${k}" data-k="${k}" data-pick="${ix}" ${p.pick === ix ? "checked" : ""}>
          <span class="mono">${esc(x.marcKey || x.label)}</span><small class="muted">${esc(x.note)}${x.uri ? ` · <a href="${esc(x.uri.replace(/^http:/, "https:"))}" target="_blank" rel="noopener">id.loc.gov</a>` : ""}</small></label>`).join("");
      prop = `<div class="form" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:8px">
          <label class="fld"><span>Series statement</span><input type="text" data-k="${k}" data-edit="statement" value="${esc(p.statement)}"></label>
          <label class="fld"><span>Volume</span><input type="text" data-k="${k}" data-edit="volume" value="${esc(p.volume)}"></label></div>
        <div class="cands">${cands}<label class="cand"><input type="radio" name="pick-${k}" data-k="${k}" data-pick="-1" ${p.pick === null ? "checked" : ""}><span>None of these${p.add490 ? " — add the 490 only (untraced)" : ""}</span></label></div>`;
    }
    const fields = c.sources.length || p.statement || (p.matches && p.matches.length) ? buildFields(c, task) : [];
    const preview = fields.length ? `<pre class="mrk wrap-lines" data-prev="${k}">${hiFields(fields)}</pre>` : `<pre class="mrk wrap-lines" data-prev="${k}"><span class="muted">Nothing to add.</span></pre>`;
    const canApprove = fields.length > 0;
    const foot = `<div class="card-foot"><span class="why">${esc(c.note)}</span><div class="btnrow">
        ${c.status === "approved" ? `<button class="btn small" data-act="unapprove" data-k="${k}">Undo approval</button>` : `<button class="btn small ok" data-act="approve" data-k="${k}" ${canApprove ? "" : "disabled"}>Approve</button>`}
        ${c.status === "rejected" ? `<button class="btn small" data-act="unreject" data-k="${k}">Undo</button>` : `<button class="btn small bad" data-act="reject" data-k="${k}">Reject</button>`}
        ${["error", "nosource", "skipped", "nomatch"].includes(c.status) ? `<button class="btn small" data-act="retry" data-k="${k}">Retry</button>` : ""}
      </div></div>`;
    return `<article class="card ${c.status === "approved" ? "approved" : ""}" data-card="${k}">${head}<div class="card-body"><div class="src">${srcs}</div><div class="prop">${prop}${preview}</div></div>${foot}</article>`;
  }
  const wordCount = (s) => (String(s || "").trim().match(/\S+/g) || []).length;

  function renderReview() {
    renderReviewCounts();
    const filt = $("#filters");
    filt.innerHTML = FILTERS.map(([key, label, fn]) => {
      const n = S.found.filter(fn).length;
      return `<button class="filter" data-filter="${key}" aria-pressed="${S.filter === key}">${esc(label)} ${fmt(n)}</button>`;
    }).join("");
    const cards = $("#cards");
    if (!S.found.length) {
      cards.innerHTML = `<div class="empty">Nothing to review yet. Pick a task in step 2, then <strong>Find records</strong> and <strong>Run lookups</strong>.</div>`;
      $("#moreCards").hidden = true;
      return;
    }
    const fn = FILTERS.find((f) => f[0] === S.filter)[2];
    const list = [];
    S.found.forEach((c, k) => { if (fn(c)) list.push([c, k]); });
    if (!list.length) { cards.innerHTML = `<div class="empty">No records in this view.</div>`; $("#moreCards").hidden = true; return; }
    cards.innerHTML = list.slice(0, S.shown).map(([c, k]) => cardHTML(c, k)).join("");
    $("#moreCards").hidden = list.length <= S.shown;
    $("#moreCards").textContent = `Show more (${fmt(list.length - S.shown)} left)`;
  }

  function refreshCard(k) {
    const c = S.found[k];
    const pre = $(`[data-prev="${k}"]`);
    if (pre) {
      const fields = buildFields(c, S.foundTask);
      pre.innerHTML = fields.length ? hiFields(fields) : '<span class="muted">Nothing to add.</span>';
      const ab = $(`[data-act="approve"][data-k="${k}"]`);
      if (ab) ab.disabled = !fields.length;
    }
    const wc = $(`[data-wc="${k}"]`);
    if (wc) wc.textContent = wordCount(c.props.summary) + " words";
  }

  function setApproved(c, on) {
    const task = S.foundTask;
    const ch = S.changes.get(c.i) || {};
    if (on) { ch[task] = c; S.changes.set(c.i, ch); c.status = "approved"; }
    else { delete ch[task]; if (Object.keys(ch).length) S.changes.set(c.i, ch); else S.changes.delete(c.i); }
    S.exported = false;
  }

  async function retry(c) {
    if (S.run.active) return toast("Wait for the current run to finish.");
    const o = opts();
    c.opts = o; c.status = "working"; renderReview();
    try { await PROCESS[S.foundTask](c, o); }
    catch (e) { c.status = "error"; c.note = e.message; }
    renderReview();
  }

  // ---------- record viewer ----------
  function renderViewer() {
    const src = S.src;
    const pre = $("#mrkView");
    if (!src) { pre.innerHTML = '<span class="muted">Load a file to see its records here.</span>'; $("#recOf").textContent = "of 0"; return; }
    S.view = Math.min(Math.max(0, S.view), src.count - 1);
    $("#recNo").value = S.view + 1; $("#recNo").max = src.count;
    $("#recOf").textContent = "of " + fmt(src.count);
    try {
      const rec = src.get(S.view);
      $("#viewEnc").textContent = M.recordEncoding(rec.leader) === "utf8" ? "UTF-8" : "MARC-8";
      const ch = S.changes.get(S.view);
      let html = M.toMnemonic(rec).split("\n").map((l) => hiLine(l, false)).join("\n");
      if (ch) {
        const extra = [];
        for (const t of ["summary", "series", "awards"]) if (ch[t]) extra.push(...buildFields(ch[t], t));
        if (extra.length) html += "\n" + hiFields(extra);
      }
      pre.innerHTML = html;
    } catch (e) {
      pre.innerHTML = `<span class="m-esc">This record could not be read: ${esc(e.message)}</span>`;
    }
  }

  function renderTagTable() {
    const body = $("#tagTable tbody");
    if (!S.src) { body.innerHTML = ""; return; }
    const total = S.src.count;
    const rows = [...S.tagCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    body.innerHTML = rows.map(([t, n]) => `<tr><td class="tag">${esc(t)}</td><td>${esc(tagName(t))}<div class="bar"><i style="width:${(100 * n) / total}%"></i></div></td>
      <td class="num">${fmt(n)}<br><small>${Math.round((100 * n) / total)}%</small></td>
      <td>${n < total && !M.isControlTag(t) ? `<button class="linkbtn" data-missing="${esc(t)}">Find missing</button>` : ""}</td></tr>`).join("");
  }

  function renderFile() {
    const src = S.src;
    if (!src) return;
    $("#fileName").textContent = src.sample ? "Sample records" : src.name;
    $("#fileHint").textContent = src.sample ? "Example books and DVDs, not your data. Choose a file to work on your own records." : `${(src.size / 1048576).toFixed(src.size < 1048576 ? 2 : 1)} MB · ${src.kind === "mrc" ? "binary MARC" : "MarcEdit mnemonic text"}`;
    const missing520 = src.count - (S.tagCounts.get("520") || 0);
    const chips = [
      src.sample ? `<span class="chip sample">Sample</span>` : "",
      `<span class="chip">${fmt(src.count)} records</span>`,
      S.encCounts.utf8 ? `<span class="chip">${fmt(S.encCounts.utf8)} UTF-8</span>` : "",
      S.encCounts.marc8 ? `<span class="chip">${fmt(S.encCounts.marc8)} MARC-8</span>` : "",
      `<span class="chip">${fmt(missing520)} without 520</span>`,
      S.bad.length ? `<span class="chip" style="color:var(--bad)">${fmt(S.bad.length)} unreadable</span>` : "",
    ];
    $("#fileChips").innerHTML = chips.join("");
    const keyRec = (() => { try { return recId(src.get(0)); } catch { return ""; } })();
    $("#keyHint").textContent = keyRec ? `001 (for example ${keyRec})` : "001";
  }

  function renderAll() {
    renderFile(); renderTagTable(); renderViewer(); renderReview(); renderExport();
  }

  // ---------- export ----------
  function renderExport() {
    const by = { summary: 0, series: 0, awards: 0 };
    for (const ch of S.changes.values()) for (const t of Object.keys(ch)) by[t]++;
    $("#exportSummary").innerHTML = S.changes.size
      ? `<span><strong>${fmt(S.changes.size)}</strong> records changed</span><span>${fmt(by.summary)} summaries</span><span>${fmt(by.series)} series</span><span>${fmt(by.awards)} awards</span>`
      : `<span>No approved changes yet. You can still export the whole file below.</span>`;
    renderReviewCounts();
  }

  function baseName() { return (S.src && !S.src.sample ? S.src.name : "sample").replace(/\.[^.]+$/, ""); }

  function download(name, parts, type) {
    const blob = new Blob(parts, { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  }

  /** Write records (indexes) as mrc or mrk, applying approved changes. */
  async function writeRecords(indexes, format, withChanges, statusEl) {
    const parts = [];
    const problems = [];
    let folded = 0;
    for (let n = 0; n < indexes.length; n++) {
      const i = indexes[n];
      try {
        const ch = withChanges && S.changes.get(i);
        if (format === "mrc" && !ch && S.src.raw(i)) { parts.push(S.src.raw(i).slice()); continue; }
        let rec = S.src.get(i);
        if (ch) {
          rec = M.cloneRecord(rec);
          for (const note of applyChanges(rec, ch)) problems.push(`Record ${i + 1}: ${note}`);
        }
        if (format === "mrc") { const b = M.buildRecord(rec); folded += b.folded; parts.push(b.bytes); }
        else parts.push(M.toMnemonic(rec) + "\n\n");
      } catch (e) { problems.push(`Record ${i + 1}: ${e.message} (left out)`); }
      if (n % 2000 === 1999) { if (statusEl) statusEl.textContent = `Writing ${fmt(n + 1)} of ${fmt(indexes.length)}…`; await tick(); }
    }
    if (folded) problems.unshift(`${fmt(folded)} characters in new text were simplified to plain ASCII because their records are MARC-8.`);
    return { parts, problems };
  }

  const range = (n) => Array.from({ length: n }, (_, i) => i);

  async function exportRecords(format) {
    if (!S.src) return toast("Load a file first.");
    const scope = $("input[name=expScope]:checked").value;
    const idx = scope === "changed" ? [...S.changes.keys()].sort((a, b) => a - b) : range(S.src.count);
    if (!idx.length) return toast("No approved changes yet. Choose 'The whole file' to export everything.");
    const lg = $("#expLog");
    const { parts, problems } = await writeRecords(idx, format, true, lg);
    lg.hidden = !problems.length;
    lg.textContent = problems.join("\n");
    download(`${baseName()}-${scope === "changed" ? "changed" : "enriched"}.${format}`, parts, format === "mrc" ? "application/marc" : "text/plain;charset=utf-8");
    S.exported = true;
    toast(`Exported ${fmt(idx.length)} records.`);
  }

  function csvCell(v) { const s = plain(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  function exportReport() {
    const rows = [["record", "001", "isbn", "title", "author", "task", "status", "source", "fields_added", "note"]];
    const seen = new Set();
    const add = (c, task) => {
      if (seen.has(c)) return; seen.add(c);
      const fields = c.status === "approved" || c.status === "ready" || c.status === "review" ? buildFields(c, task) : [];
      rows.push([c.i + 1, c.id, c.isbns.join(" "), c.title, c.author, task, statusLabel(c.status),
        c.sources.map((s) => s.name + (s.url ? " " + s.url : "")).join(" | "), fields.map((f) => M.fieldToMnemonic(f)).join(" | "), c.note]);
    };
    for (const c of S.found) add(c, S.foundTask);
    for (const ch of S.changes.values()) for (const t of Object.keys(ch)) add(ch[t], t);
    if (rows.length === 1) return toast("Nothing to report yet.");
    download(`${baseName()}-report.csv`, ["﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], "text/csv;charset=utf-8");
  }

  async function findExport(kind) {
    const hits = S.findHits;
    if (kind === "view") { S.view = hits[0]; selectTab("records"); renderViewer(); return; }
    if (kind === "csv") {
      const rows = [["record", "001", "isbn", "title", "author"]];
      for (let n = 0; n < hits.length; n++) {
        try { const rec = S.src.get(hits[n]); rows.push([hits[n] + 1, recId(rec), recIsbns(rec).join(" "), recTitle(rec), recAuthor(rec)]); } catch { /* skip */ }
        if (n % 3000 === 2999) await tick();
      }
      download(`${baseName()}-matches.csv`, ["﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], "text/csv;charset=utf-8");
      return;
    }
    const { parts } = await writeRecords(hits, kind, false, null);
    download(`${baseName()}-matches.${kind}`, parts, kind === "mrc" ? "application/marc" : "text/plain;charset=utf-8");
  }

  // ---------- tabs ----------
  function selectTab(name) {
    for (const t of $$(".step")) t.setAttribute("aria-selected", String(t.id === "tab-" + name));
    for (const p of $$(".panel")) p.hidden = p.id !== "p-" + name;
    if (name === "review") renderReview();
    if (name === "export") renderExport();
    if (name === "records") renderViewer();
  }

  function showTaskOpts() {
    for (const b of $$("[data-opts]")) b.hidden = b.dataset.opts !== S.task;
    $("#aiBox").hidden = S.task === "find" || S.task === "awards";
    $("#runBtn").hidden = S.task === "find";
    $("#runBtn").disabled = !(S.foundTask === S.task && S.found.some((c) => c.status === "queued" || c.status === "error"));
  }

  // ---------- events ----------
  function wire() {
    $$(".step").forEach((t) => t.addEventListener("click", () => selectTab(t.id.slice(4))));
    $("#chooseBtn").addEventListener("click", () => $("#fileInput").click());
    $("#fileInput").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ""; });
    const drop = $("#drop");
    ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) drop.classList.remove("over"); }));
    document.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });
    $("#sampleBtn").addEventListener("click", () => loadSample());

    $("#prevRec").addEventListener("click", () => { S.view--; renderViewer(); });
    $("#nextRec").addEventListener("click", () => { S.view++; renderViewer(); });
    $("#recNo").addEventListener("change", (e) => { S.view = (+e.target.value || 1) - 1; renderViewer(); });
    $("#wrapLines").addEventListener("change", (e) => $("#mrkView").classList.toggle("wrap-lines", e.target.checked));
    $("#dlMrk").addEventListener("click", async () => {
      if (!S.src) return toast("Load a file first.");
      const { parts, problems } = await writeRecords(range(S.src.count), "mrk", false, $("#convertMsg"));
      $("#convertMsg").textContent = problems.length ? `${problems.length} records could not be converted.` : "";
      download(baseName() + ".mrk", parts, "text/plain;charset=utf-8");
    });
    $("#dlMrc").addEventListener("click", async () => {
      if (!S.src) return toast("Load a file first.");
      const { parts, problems } = await writeRecords(range(S.src.count), "mrc", false, $("#convertMsg"));
      $("#convertMsg").textContent = problems.length ? `${problems.length} records could not be built — see the list below.` : "";
      if (problems.length) { $("#loadLog").hidden = false; $("#loadLog").textContent = problems.join("\n"); }
      download(baseName() + ".mrc", parts, "application/marc");
    });
    $("#tagTable").addEventListener("click", (e) => {
      const t = e.target.closest("[data-missing]");
      if (!t) return;
      $(`input[name=task][value=find]`).checked = true; S.task = "find";
      $("#findTags").value = t.dataset.missing; $("#findCond").value = "missingAll"; $("#findType").value = "all";
      showTaskOpts(); selectTab("task"); findRecords();
    });

    $$("input[name=task]").forEach((r) => r.addEventListener("change", () => { S.task = r.value; showTaskOpts(); saveSettings(); }));
    $("#p-task").addEventListener("change", (e) => { if (e.target.matches("input,select")) saveSettings(); });
    $("#findBtn").addEventListener("click", findRecords);
    $("#runBtn").addEventListener("click", runLookups);
    $("#pauseBtn").addEventListener("click", () => { S.run.paused = !S.run.paused; $("#pauseBtn").textContent = S.run.paused ? "Resume" : "Pause"; log(S.run.paused ? "Paused." : "Resumed."); });
    $("#stopBtn").addEventListener("click", () => { S.run.stop = true; S.run.paused = false; log("Stopping after the records in progress…"); });
    $("#findResult").addEventListener("click", (e) => { const b = e.target.closest("[data-find]"); if (b) findExport(b.dataset.find); });

    $("#filters").addEventListener("click", (e) => { const b = e.target.closest("[data-filter]"); if (!b) return; S.filter = b.dataset.filter; S.shown = 50; renderReview(); });
    $("#moreCards").addEventListener("click", () => { S.shown += 50; renderReview(); });
    $("#approveAll").addEventListener("click", () => {
      let n = 0;
      for (const c of S.found) if (c.status === "ready" && buildFields(c, S.foundTask).length) { setApproved(c, true); n++; }
      renderReview(); toast(n ? `Approved ${fmt(n)} records.` : "No ready records to approve.");
    });
    const cards = $("#cards");
    cards.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const c = S.found[+b.dataset.k];
      const act = b.dataset.act;
      if (act === "approve") setApproved(c, true);
      else if (act === "unapprove") { setApproved(c, false); c.status = "ready"; }
      else if (act === "reject") { if (c.status === "approved") setApproved(c, false); c.prevStatus = c.status; c.status = "rejected"; }
      else if (act === "unreject") c.status = c.prevStatus && c.prevStatus !== "approved" ? c.prevStatus : "ready";
      else if (act === "retry") return retry(c);
      renderReview();
    });
    cards.addEventListener("input", (e) => {
      const t = e.target;
      if (!t.dataset.edit) return;
      const k = +t.dataset.k;
      S.found[k].props[t.dataset.edit] = t.value;
      if (S.found[k].status === "approved") S.exported = false;
      refreshCard(k);
    });
    cards.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.award !== undefined) {
        const c = S.found[+t.dataset.k];
        c.props.matches[+t.dataset.award].checked = t.checked;
        if (c.status === "review" && buildFields(c, "awards").length) c.status = "ready";
        if (c.status === "approved") S.exported = false;
        refreshCard(+t.dataset.k);
        return;
      }
      if (t.dataset.pick === undefined) return;
      const c = S.found[+t.dataset.k];
      const v = +t.dataset.pick;
      c.props.pick = v < 0 ? null : v;
      if (c.status === "review" || c.status === "nomatch") c.status = "ready";
      if (c.status === "approved") S.exported = false;
      refreshCard(+t.dataset.k);
    });

    $("#expMrc").addEventListener("click", () => exportRecords("mrc"));
    $("#expMrk").addEventListener("click", () => exportRecords("mrk"));
    $("#expCsv").addEventListener("click", exportReport);

    ["apiKey", "gbKey", "rememberKey"].forEach((id) => $("#" + id).addEventListener("change", saveSettings));
    window.addEventListener("beforeunload", (e) => { if (S.changes.size && !S.exported) { e.preventDefault(); e.returnValue = ""; } });
  }

  async function openFile(f) {
    const hint = $("#fileHint");
    $("#fileName").textContent = f.name;
    hint.textContent = "Reading…";
    try {
      const u8 = new Uint8Array(await f.arrayBuffer());
      await loadBytes(f.name, u8, false);
      selectTab("records");
      toast(`Loaded ${fmt(S.src.count)} records.`);
    } catch (e) {
      hint.textContent = e.message;
      toast(e.message);
    }
  }
  async function loadSample() {
    await loadBytes("sample.mrk", new TextEncoder().encode(SAMPLE), true);
  }

  // ---------- start ----------
  loadSettings();
  renderAwardLists();
  wire();
  showTaskOpts();
  loadSample().then(() => selectTab("records"));

  // exposed for tests
  window.MarcEnrichTest = { splitSeries, fieldFromMarcKey, buildFields, norm, cleanDesc, applyChanges, recordTitles, recordYears, S };
})();
