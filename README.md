# Tender Spec Bot

A Telegram bot that reads a procurement/tender spec sheet (DOCX for now)
and, for every product line item, tries to find a real, currently-listed
matching product — Armenian market first, global market as a fallback —
along with a confidence score for how well the listing actually satisfies
the required specs.

Verified against the sample tender file you provided
(`tests/fixtures/sample-tender.docx`) — table detection, column mapping,
per-line spec parsing, category classification, and query building all
run correctly against it (see "What's been tested" below).

## How it works

```
DOCX upload
   │
   ▼
docxParser        → finds the header row by meaning (not fixed column
                     index), extracts one product row per data row
   │
   ▼
extraction/index.js → tries AI-based extraction first (Gemini); if no
                     API key is set or the call fails, falls back to
                     the rule-based extractor automatically. Either
                     path produces the same output shape, so nothing
                     downstream needs to know which one ran.
   │
   ▼
search/index.js    → Armenian store domains (Tavily) → broader Armenian
                     market (Tavily) → global (Tavily), stopping at the
                     first stage with a confidence above the threshold
   │
   ▼
matchVerifier      → scores each candidate listing against the required
                     specs (matched / mismatched / unchecked), ranks them
   │
   ▼
telegramFormatter  → one MarkdownV2 message per product: name, brand,
                     model, description, price, store, URL, confidence
```

Every module in the chain is independent and swappable — see "Extending
it" below.

## Spec extraction: AI-based (primary) vs. rule-based (fallback)

The original version of this bot extracted specs with hand-written
rules: a fixed keyword list decided the product category, and a fixed
per-category field dictionary decided which lines mattered. That works
fine for the categories I anticipated, but a genuinely new kind of
product falls through as "unknown" with no real field recognition.

Extraction now goes through **Gemini (`gemini-3-flash`)** first
(`src/extraction/aiSpecExtractor.js`): it's given the raw spec text —
in whatever mix of Armenian, Russian, and English it happens to be
written in — and asked to decide for itself, from context, which
details actually matter for finding a real product, with no
predefined field list or category list. It returns:

```json
{
  "productType": "2-in-1 detachable tablet-laptop",
  "characteristics": [
    { "label": "Screen", "value": "13-inch touchscreen, 2880x1920, 3:2" },
    { "label": "CPU", "value": "Qualcomm Snapdragon X Plus or Intel Core Ultra 7" }
  ],
  "searchQuery": "13 inch 2-in-1 detachable tablet laptop touchscreen ..."
}
```

**If `GEMINI_API_KEY` isn't set, or a call fails for any reason** (rate
limit, network blip, malformed response), extraction transparently
falls back to the original rule-based chain
(`categoryClassifier.js` → `specNormalizer.js` → `queryBuilder.js`,
still there, unchanged) so the bot keeps working — just with the old,
narrower extraction quality on whichever product hit the fallback.
`src/extraction/index.js` is the one place that decides which path ran;
everything downstream (search, verification, formatting) is completely
unaware of which one produced its input, because both paths return the
same `{ attributes, rawLines, category }` shape.

**Why Gemini specifically**: a dedicated Armenian-language LLM
benchmark (ArmBench-LLM 1.0, Metric AI Lab) rates Gemini 3 Flash as the
best overall value for Armenian-language tasks among tested models.
It also has a genuinely permanent free tier (not a burn-down trial —
usable indefinitely for dev/test with no card on file), a straightforward
upgrade path (enable billing on the same project for higher throughput),
and structured JSON-schema output so responses parse reliably.
`GEMINI_MODEL` in `.env` lets you swap to `gemini-3.1-flash-lite`
(cheaper/faster, slightly lower quality) if you hit free-tier rate
limits often.

**What I could and couldn't verify here**: I don't have a live
`GEMINI_API_KEY` in this sandbox (its network access is limited to
package registries), so I could not run a real extraction call. What I
did verify:
- The rule-based fallback path runs correctly end-to-end against your
  actual sample file (`npm run test:local` with no `GEMINI_API_KEY` set).
- The AI-success path's output shape is fully compatible with
  everything downstream — I mocked `extractSpecWithAI`'s return value
  and ran it through `extraction/index.js` → `matchVerifier.js`, which
  consumed it with zero errors, exactly as it would a real response.
- The Gemini SDK call itself (model name, `responseSchema` structure,
  `@google/genai` API surface) matches the current official SDK
  (v2.21.0) — but do run one real product through `npm run test:local`
  with your API key before trusting it on a full batch, the way you
  would with any new integration.

## Important: what this bot can and can't promise

Tender spec sheets like your sample describe a **capability envelope**
("CPU: Snapdragon X Plus *or* Intel Core Ultra 7, RAM: at least 16GB..."),
not a specific branded model. So:

- The bot does **not** claim to find "the" exact product — it finds the
  best real, verifiable listing it can that satisfies as many of the
  required specs as possible, and says so with a confidence score.
- It **never invents** a product, price, store, or URL. If nothing
  reliable turns up, it says exactly that instead of guessing.
- The confidence score is a simple, transparent match check (does the
  listing's text contain/satisfy each required spec), not a certified
  equivalence — treat "High" as "worth a human's second look before
  ordering," not as a guarantee.

## Setup

```bash
npm install
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN and TAVILY_API_KEY in .env
npm start
```

- **TELEGRAM_BOT_TOKEN** — from [@BotFather](https://t.me/BotFather).
- **TAVILY_API_KEY** — from [tavily.com](https://tavily.com). Tavily is
  an AI-oriented web search API well-suited to this ("search the
  Armenian market, then fall back to global" is exactly its use case).
  *(You wrote "Tawily" in the brief — I've assumed you meant Tavily.
  If you actually meant a different service, the whole search layer is
  one file to swap — see `src/search/tavilySource.js`.)*
- **GEMINI_API_KEY** — from [aistudio.google.com/apikey](https://aistudio.google.com/apikey),
  free, no credit card. Powers the AI-based spec extraction described
  above. Optional — leave blank to run on the rule-based extractor only.

### Testing without Telegram

```bash
npm run test:local
# or: node scripts/testLocal.js path/to/other-tender.docx
```

This runs the parser → classifier → normalizer → query-builder stages
against a local file and prints the result. If `TAVILY_API_KEY` is set
it also runs the live search; if not, it stops after printing the built
query so you can sanity-check extraction without spending API credits.

## What's been tested here / what hasn't

I don't have a Telegram bot token or a Tavily API key in this sandbox
(its network access is limited to package registries), so I could not
run the bot live end-to-end. What I *did* verify directly against your
sample file:

- Table/header detection and column mapping (works even though the
  sample's title row is one merged cell spanning all 8 columns)
- Per-line spec parsing into structured attributes — including the
  tricky "header line, then one-or-more value lines with no separator"
  pattern your sheet uses for CPU/RAM/connectivity/etc.
- Category classification (correctly identified as `laptop_tablet`)
- Search query construction

Before your first real run, sanity-check `npm run test:local` output
against a couple of your own files, and do a small live test (one
product) before pointing it at a big batch.

## Extending it

- **New product category**: add a file under `src/extraction/categories/`
  with `{ categoryId, classifierKeywords, fieldAliases }` and register it
  in `src/extraction/categories/index.js`. Nothing else changes.
- **New Armenian store**, generic search: just add its domain to
  `ARMENIAN_STORE_DOMAINS` in `.env` — no code change.
- **New Armenian store with a dedicated scraper** (the way your
  MonitoringBot project has per-retailer matchers): implement a
  `directScraper(query)` function and register it on that store's entry
  in `src/search/armenianStores.js`. The orchestrator tries any
  registered direct scrapers before falling back to Tavily.
- **XLSX / PDF support**: `src/parsers/docxParser.js` is the only format
  parser right now; add `xlsxParser.js` / `pdfParser.js` next to it and
  dispatch on file extension in `src/bot.js`. The rest of the pipeline
  (everything downstream of `parseDocx`) is format-agnostic already —
  it just needs the same `{name, techSpecLines, unit, quantity, ...}`
  shape back.

## Known limitations to be aware of

- `specNormalizer.js` uses a "no digits = section header" heuristic to
  tell header lines from value lines, which fits your sample well but
  won't be perfect on every tender template — the full raw spec text is
  always preserved (`rawLines`) as a fallback for query building and
  verification, so nothing is silently lost even when the structured
  parse misses an attribute.
- `matchVerifier.js` does substring/numeric matching against listing
  text, not true semantic comparison — good for ranking and flagging
  obvious mismatches, not a certified spec-compliance check.
- Only one document format (DOCX) is wired up, per your current request.
