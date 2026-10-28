# MARC-Enrich

Browser-based MARC enrichment workbench — MarcBreaker-style break and make, missing-520 and missing-series finders, and Open Library, Google Books, id.loc.gov, and Wikidata lookups side by side, with AI-drafted summaries, LC-authority series headings, Oscar, Emmy, and Golden Globe award notes, and a cataloger approval step before anything goes back to the ILS.

Everything runs in the browser. There is no server: the MARC file is read locally, and the only network traffic is the lookups you start.

## What it does

1. **Records** — load a `.mrc` (binary MARC) or `.mrk` (MarcEdit mnemonic) file. See field counts for every tag, page through records in mnemonic form, and convert either way (Break → `.mrk`, Make → `.mrc`).
2. **Task** — pick what to do:
   - **Add summaries (520).** Finds records with no 520, pulls descriptions from Open Library and Google Books by ISBN, and has Claude condense them into a neutral 1–3 sentence note. If no source describes the book, the record is skipped, not guessed at.
   - **Add series (490/830).** Either traces existing 490s that have no 800/810/811/830, or looks up series for records with none. Every 8XX heading comes from the Library of Congress Name Authority File via id.loc.gov, with `$0` URI. AI only chooses among real authorities when several are close; exact matches skip it.
   - **Add awards (586).** Matches video records against saved Oscar, Emmy and Golden Globe winner lists (`data/awards.json`) — no live lookups. A title match is confirmed only when the director's name or the years in the record agree; title-only matches wait for review. For TV series, only the award from the season's own year is pre-ticked.
   - **Find records by field.** List records missing (or having) any tags, e.g. `6XX, 830`. Export the list as CSV or just those records as `.mrc`/`.mrk`.
3. **Review** — each record shows the source text next to the proposed fields. Edit, approve, reject, or retry. Nothing is written without approval.
4. **Export** — changed records only (for an overlay load) or the whole file with changes applied, plus a CSV report of every lookup.

## Publish on GitHub Pages

1. Create a repository and add `index.html`, `app.js`, `marc-core.js`, and this README.
2. Settings → Pages → Deploy from a branch → `main` / root.
3. Open `https://<user>.github.io/<repo>/`.

It also runs by opening `index.html` directly from disk, except the awards task, which needs the page served over the web to read its data file.

## API keys

- **Anthropic API key** is needed for AI summaries and series tie-breaking. It is sent only to the endpoint set in *AI and lookup settings* and is kept in memory unless *Remember* is ticked.
- For shared staff use, point the endpoint at a small proxy (for example a Cloudflare Worker) that adds the key server-side, so nobody pastes a key into a browser.
- **Google Books API key** is optional; it raises Google's daily request limit for large runs.

## Record types

Every task can be limited by Leader/06: books and text (`a`, `t`), audiobooks (`i`), video — DVD and Blu-ray (`g`), all three together, or all record types.

## Award data

Winner lists are saved in `data/awards.json` so the page never waits on Wikidata. The **Update award data** workflow rebuilds the file from Wikipedia and Wikidata every October 1 (after the Golden Globes, Oscars and Emmys) and redeploys the site. Run it any time from the Actions tab with **Run workflow**. If one award fails to load, last year's winners for that award are kept.

To add a list (BAFTA, Independent Spirit, etc.), add its English Wikipedia article title to `data/award-lists.txt` and run the workflow.

Winners come from each award's Wikipedia winner table (ceremony years), with Wikidata adding dated wins the table lacks; only films and series are kept. To fix a wrong or missing win by hand, add a line to `data/award-corrections.txt` (`remove` or `add`, the award, the work's Wikidata ID, the year). Corrections are re-applied on every build, so they survive the yearly refresh.

## Checking the award data

Every win the awards task uses is public, with its source:

- **[Award data page](https://systemslibrarian.github.io/marc-enrich/awards.html)**: browse by award, search titles or directors, filter by source, and open each win's Wikipedia winner list and Wikidata record.
- **[`data/awards.csv`](data/awards.csv)**: the same list as a spreadsheet, one row per win (GitHub shows it as a searchable table).
- **[`data/award-corrections.txt`](data/award-corrections.txt)**: hand fixes applied on top of the sources.

Each row is marked with its source: *Wikipedia winner table* (most wins), *Wikidata* (dated wins the table lacked), or *Manual correction*.

## Award lists included

Academy Award for Best Picture; Academy Award for Best Original Screenplay; Primetime Emmy Awards for Outstanding Comedy Series, Drama Series, and Limited or Anthology Series; Golden Globe Awards for Best Motion Picture – Drama, Musical or Comedy, and Non-English Language; Best Animated Feature Film; Best Screenplay; Best Television Series – Drama and Musical or Comedy; and Best Limited or Anthology Series or Television Film. 586 text defaults to `{award}, {year}`, using the award's current Wikipedia title.

## Cataloging rules built in

- Summaries go in **520**, not 500. `$c` records the source (template: `AI-assisted summary from {source}`); an extra 500 note is optional.
- The AI prompt forbids facts not in the sources, marketing language, spoilers, and copying runs of more than five words. Source descriptions are never pasted in verbatim.
- Series headings are taken from LC `marcKeys` (e.g. `130 0$aPenguin classics` → `830 \0$aPenguin classics.`), with `$v` and `$0` added. When an 8XX is added for a `490 0`, the 490's first indicator is set to `1`.
- Start with a sample (the default limit is 200 records) and check accuracy by hand before running a whole catalog.

## Encoding

- UTF-8 records (Leader/09 = `a`) are read and written as UTF-8.
- MARC-8 records are preserved byte-for-byte. Non-ASCII bytes show as `{0xHH}` in the mnemonic view and round-trip unchanged. New text added to a MARC-8 record is folded to plain ASCII (é → e, curly quotes → straight), and the export log says how many characters were affected. Exporting records from your ILS as UTF-8 avoids this.
- Mnemonic escapes follow MarcEdit: blanks as `\`, `{dollar}`, `{lcub}`, `{rcub}`.

## Loading back into Symphony (or any ILS)

Export **changed records only** and load with an overlay profile that matches on your record key (usually 001). Protect local 520/490/830 fields in later OCLC overlays. You can open the `.mrk` in MarcEdit and run Validate as a second check.

## Limits

- **Recommended: up to 250,000 records per file.** Loading, Find, Awards and Break/Make handle a file that size in seconds (measured in Chrome: 300,000 records load in about 3 s and search in about 2 s; 600,000 load in 5 s and use about 1 GB of browser memory). The page warns above 250,000 records or 200 MB; split larger exports.
- **Summaries and series** call web services for every record, at roughly 60 records a minute, so each run is capped at 2,000 records (about 30–40 minutes). Find records again for the next batch; records already looked up are skipped.
- Open Library and Google Books coverage varies. Expect many records — especially local, older, and non-book materials — to come back with no source.

## Files

- `index.html` — page and styles
- `app.js` — tasks, lookups, review, export
- `marc-core.js` — ISO 2709 parse/build and mnemonic break/make (no dependencies; also works in Node via `require`)
