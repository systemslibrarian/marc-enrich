/*
 * marc-core.js — MARC 21 (ISO 2709) parsing, building, and MarcEdit-style
 * mnemonic ("break"/"make") conversion. No dependencies. Works in the browser
 * (window.MarcCore) and in Node (require).
 *
 * Encoding model
 *  - Leader/09 = "a"  -> record is UTF-8; text is decoded normally.
 *  - Anything else    -> record is treated as MARC-8. Printable ASCII is
 *    decoded as text; every other byte is kept as-is and shown in mnemonic
 *    form as {0xHH}. Untouched fields therefore round-trip byte-for-byte.
 *  - Internally a raw byte b is held as the private-use character U+F700+b.
 *  - Text added to a MARC-8 record (e.g. an AI summary) is folded to ASCII.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MarcCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const RT = 0x1d; // record terminator
  const FT = 0x1e; // field terminator
  const SF = 0x1f; // subfield delimiter
  const RAW_BASE = 0xf700;

  const utf8Strict = new TextDecoder("utf-8", { fatal: true });
  const utf8Enc = new TextEncoder();

  const DEFAULT_LEADER = "00000nam a2200000 i 4500";

  function isControlTag(tag) {
    return /^00[0-9]$/.test(tag);
  }

  function latin1(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function rawChar(b) {
    return String.fromCharCode(RAW_BASE + b);
  }

  // Bytes -> internal string
  function decodeBytes(bytes, enc) {
    if (enc === "utf8") {
      let s;
      try {
        s = utf8Strict.decode(bytes);
      } catch (e) {
        return decodeBytes(bytes, "marc8"); // invalid UTF-8: keep raw bytes
      }
      // keep C0 control characters as raw bytes so they stay visible
      return s.replace(/[\u0000-\u001f\u007f]/g, (c) => rawChar(c.charCodeAt(0)));
    }
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : rawChar(b);
    }
    return s;
  }

  const ASCII_FOLD = {
    "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"',
    "„": '"', "–": "-", "—": "--", "…": "...", " ": " ",
    "ß": "ss", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE",
    "ø": "o", "Ø": "O", "ł": "l", "Ł": "L",
  };

  // Internal string -> bytes. Returns { bytes, folded } where folded counts
  // characters that had to be simplified for a MARC-8 record.
  function encodeString(str, enc) {
    const out = [];
    let folded = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp >= RAW_BASE && cp <= RAW_BASE + 0xff) {
        out.push(cp - RAW_BASE);
      } else if (enc === "utf8") {
        const b = utf8Enc.encode(ch);
        for (let i = 0; i < b.length; i++) out.push(b[i]);
      } else if (cp < 0x80) {
        out.push(cp);
      } else {
        folded++;
        let s = ASCII_FOLD[ch];
        if (s === undefined) s = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
        for (const c of s) out.push(c.charCodeAt(0) < 0x80 ? c.charCodeAt(0) : 0x3f);
      }
    }
    return { bytes: out, folded };
  }

  function recordEncoding(leader) {
    return leader && leader[9] === "a" ? "utf8" : "marc8";
  }

  /** Find record boundaries in a binary MARC file. Returns [[start,end],...]. */
  function indexRecords(u8) {
    const out = [];
    let pos = 0;
    const n = u8.length;
    while (pos < n) {
      // skip stray whitespace / line breaks between records
      while (pos < n && (u8[pos] === 0x0a || u8[pos] === 0x0d || u8[pos] === 0x20 || u8[pos] === 0x1a)) pos++;
      if (pos >= n) break;
      let end = u8.indexOf(RT, pos);
      if (end === -1) end = n - 1;
      out.push([pos, end + 1]);
      pos = end + 1;
    }
    return out;
  }

  function looksLikeBinaryMarc(u8) {
    let i = 0;
    while (i < u8.length && (u8[i] === 0xef || u8[i] === 0xbb || u8[i] === 0xbf)) i++;
    for (let k = 0; k < 5; k++) {
      const b = u8[i + k];
      if (b === undefined || b < 0x30 || b > 0x39) return false;
    }
    return u8.indexOf(FT) !== -1;
  }

  /** Parse one binary record (Uint8Array, terminator optional). */
  function parseRecord(buf) {
    if (buf.length < 25) throw new Error("Record is shorter than a leader");
    const leader = latin1(buf.subarray(0, 24));
    const enc = recordEncoding(leader);
    const base = parseInt(leader.substr(12, 5), 10);
    if (!(base > 24) || base > buf.length) throw new Error("Bad base address in leader: " + leader.substr(12, 5));
    const fields = [];
    let p = 24;
    while (p + 12 <= base - 1 && buf[p] !== FT) {
      const tag = latin1(buf.subarray(p, p + 3));
      const len = parseInt(latin1(buf.subarray(p + 3, p + 7)), 10);
      const start = parseInt(latin1(buf.subarray(p + 7, p + 12)), 10);
      p += 12;
      if (isNaN(len) || isNaN(start)) throw new Error("Bad directory entry for tag " + tag);
      let fb = buf.subarray(base + start, base + start + len);
      if (fb.length && fb[fb.length - 1] === FT) fb = fb.subarray(0, fb.length - 1);
      if (isControlTag(tag)) {
        fields.push({ tag, data: decodeBytes(fb, enc) });
        continue;
      }
      let ind1 = " ", ind2 = " ", q = 0;
      if (fb.length > 0 && fb[0] !== SF) { ind1 = decodeBytes(fb.subarray(0, 1), "marc8"); q = 1; }
      if (fb.length > 1 && fb[1] !== SF && q === 1) { ind2 = decodeBytes(fb.subarray(1, 2), "marc8"); q = 2; }
      const subfields = [];
      let s = fb.indexOf(SF, q);
      while (s !== -1) {
        let e = fb.indexOf(SF, s + 1);
        if (e === -1) e = fb.length;
        const piece = fb.subarray(s + 1, e);
        if (piece.length) {
          subfields.push([decodeBytes(piece.subarray(0, 1), "marc8"), decodeBytes(piece.subarray(1), enc)]);
        }
        s = e < fb.length ? e : -1;
      }
      fields.push({ tag, ind1, ind2, subfields });
    }
    return { leader, fields };
  }

  /** Read only the tags from a record's directory (fast scan for statistics). */
  function scanTags(buf) {
    const base = parseInt(latin1(buf.subarray(12, 17)), 10);
    const tags = [];
    if (!(base > 24)) return tags;
    for (let p = 24; p + 12 <= base - 1 && buf[p] !== FT; p += 12) tags.push(latin1(buf.subarray(p, p + 3)));
    return tags;
  }

  function pad(n, w) {
    const s = String(n);
    return s.length >= w ? s : "0".repeat(w - s.length) + s;
  }

  /** Build one binary record. Returns { bytes: Uint8Array, folded } or throws. */
  function buildRecord(rec) {
    let leader = (rec.leader || DEFAULT_LEADER).padEnd(24, " ").slice(0, 24);
    const enc = recordEncoding(leader);
    const dir = [];
    const body = [];
    let offset = 0, folded = 0;
    for (const f of rec.fields) {
      const tag = String(f.tag).padStart(3, "0").slice(0, 3);
      const fb = [];
      if (f.data !== undefined) {
        const r = encodeString(f.data, enc);
        folded += r.folded;
        fb.push(...r.bytes);
      } else {
        const i1 = encodeString((f.ind1 || " ").slice(0, 1) || " ", "marc8").bytes;
        const i2 = encodeString((f.ind2 || " ").slice(0, 1) || " ", "marc8").bytes;
        fb.push(i1[0] === undefined ? 0x20 : i1[0], i2[0] === undefined ? 0x20 : i2[0]);
        for (const [code, value] of f.subfields || []) {
          fb.push(SF);
          fb.push(...encodeString(code || " ", "marc8").bytes.slice(0, 1));
          const r = encodeString(value || "", enc);
          folded += r.folded;
          fb.push(...r.bytes);
        }
      }
      fb.push(FT);
      if (fb.length > 9999) throw new Error("Field " + tag + " is longer than 9,999 bytes");
      dir.push(tag + pad(fb.length, 4) + pad(offset, 5));
      body.push(fb);
      offset += fb.length;
    }
    const base = 24 + dir.length * 12 + 1;
    const total = base + offset + 1;
    if (total > 99999) throw new Error("Record is longer than 99,999 bytes");
    leader = pad(total, 5) + leader.substr(5, 5) + "22" + pad(base, 5) + leader.substr(17, 3) + "4500";
    const out = new Uint8Array(total);
    let w = 0;
    for (let i = 0; i < 24; i++) out[w++] = leader.charCodeAt(i) & 0xff;
    for (const d of dir) for (let i = 0; i < 12; i++) out[w++] = d.charCodeAt(i) & 0xff;
    out[w++] = FT;
    for (const fb of body) for (const b of fb) out[w++] = b;
    out[w++] = RT;
    return { bytes: out, folded };
  }

  // ---------- Mnemonic (MarcBreaker / MarcMaker style) ----------

  function mnEscape(s) {
    let out = "";
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (ch === "$") out += "{dollar}";
      else if (ch === "{") out += "{lcub}";
      else if (ch === "}") out += "{rcub}";
      else if (cp >= RAW_BASE && cp <= RAW_BASE + 0xff) out += "{0x" + (cp - RAW_BASE).toString(16).toUpperCase().padStart(2, "0") + "}";
      else out += ch;
    }
    return out;
  }

  function mnUnescape(s) {
    return s.replace(/\{(dollar|lcub|rcub|0x[0-9A-Fa-f]{2})\}/g, (m, k) => {
      if (k === "dollar") return "$";
      if (k === "lcub") return "{";
      if (k === "rcub") return "}";
      return rawChar(parseInt(k.slice(2), 16));
    });
  }

  const blank = (c) => (c === " " || c === undefined || c === "" ? "\\" : mnEscape(c));

  function fieldToMnemonic(f) {
    if (f.data !== undefined) return "=" + f.tag + "  " + mnEscape(f.data).replace(/ /g, "\\");
    return "=" + f.tag + "  " + blank(f.ind1) + blank(f.ind2) +
      (f.subfields || []).map(([c, v]) => "$" + c + mnEscape(v)).join("");
  }

  function toMnemonic(rec) {
    const lines = ["=LDR  " + rec.leader.replace(/ /g, "\\")];
    for (const f of rec.fields) lines.push(fieldToMnemonic(f));
    return lines.join("\n");
  }

  function parseMnemonicLine(line) {
    const tag = line.substr(1, 3);
    const rest = line.substr(4).replace(/^ {1,2}/, "");
    if (tag === "LDR") return { leader: rest.replace(/\\/g, " ").padEnd(24, " ").slice(0, 24) };
    if (isControlTag(tag)) return { tag, data: mnUnescape(rest.replace(/\\/g, " ")) };
    const ind = (c) => (c === "\\" || c === undefined || c === "" ? " " : c);
    const ind1 = ind(rest[0]), ind2 = ind(rest[1]);
    const pieces = rest.slice(2).split("$");
    const subfields = [];
    for (let k = 1; k < pieces.length; k++) {
      if (!pieces[k].length) continue;
      subfields.push([pieces[k][0], mnUnescape(pieces[k].slice(1))]);
    }
    return { tag, ind1, ind2, subfields, stray: pieces[0] };
  }

  /** Parse mnemonic text into records. Returns { records, warnings }. */
  function parseMnemonic(text) {
    text = text.replace(/^﻿/, "");
    const records = [];
    const warnings = [];
    let cur = null;
    const lines = text.split(/\r?\n/);
    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln];
      if (!line.trim()) { if (cur) records.push(cur); cur = null; continue; }
      if (line[0] !== "=") {
        warnings.push("Line " + (ln + 1) + ": does not start with '=' and was skipped");
        continue;
      }
      const parsed = parseMnemonicLine(line);
      if (parsed.leader !== undefined) {
        if (cur) records.push(cur);
        cur = { leader: parsed.leader, fields: [] };
        continue;
      }
      if (!cur) {
        cur = { leader: DEFAULT_LEADER, fields: [] };
        warnings.push("Line " + (ln + 1) + ": record has no =LDR line; a default leader was used");
      }
      if (parsed.stray) warnings.push("Line " + (ln + 1) + ": text before the first $ in " + parsed.tag + " was dropped");
      delete parsed.stray;
      cur.fields.push(parsed);
    }
    if (cur) records.push(cur);
    return { records, warnings };
  }

  // ---------- Field helpers ----------

  function getFields(rec, tagOrRegex) {
    const test = typeof tagOrRegex === "string" ? (t) => t === tagOrRegex : (t) => tagOrRegex.test(t);
    return rec.fields.filter((f) => test(f.tag));
  }

  function sub(f, code) {
    if (!f || !f.subfields) return [];
    return f.subfields.filter(([c]) => c === code).map(([, v]) => v);
  }

  function firstSub(rec, tag, code) {
    for (const f of getFields(rec, tag)) {
      const v = sub(f, code)[0];
      if (v) return v;
    }
    return "";
  }

  /** Insert a field in tag order (after any existing fields with the same tag). */
  function insertField(rec, field) {
    const idx = rec.fields.findIndex((f) => f.tag > field.tag);
    if (idx === -1) rec.fields.push(field);
    else rec.fields.splice(idx, 0, field);
  }

  function cloneRecord(rec) {
    return {
      leader: rec.leader,
      fields: rec.fields.map((f) =>
        f.data !== undefined ? { tag: f.tag, data: f.data }
          : { tag: f.tag, ind1: f.ind1, ind2: f.ind2, subfields: f.subfields.map((s) => [s[0], s[1]]) }),
    };
  }

  /** Strip internal raw-byte characters for display or for sending to an API. */
  function plain(s) {
    return String(s || "").replace(/[-]/g, "");
  }

  return {
    RT, FT, SF, DEFAULT_LEADER,
    isControlTag, indexRecords, looksLikeBinaryMarc, parseRecord, scanTags, buildRecord,
    toMnemonic, fieldToMnemonic, parseMnemonic, parseMnemonicLine, mnEscape, mnUnescape,
    getFields, sub, firstSub, insertField, cloneRecord, plain, recordEncoding, encodeString, decodeBytes,
  };
});
