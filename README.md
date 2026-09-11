# Tender Spec Bot

Telegram bot that reads tender/procurement spec sheets (DOCX) and finds matching real products on the Armenian and global market using SerpApi's Google AI Mode API (`engine: google_ai_mode`).

---

## Architecture & Technology Stack

- **Runtime**: Node.js (v18+)
- **Search Provider**: [SerpApi](https://serpapi.com/) Google AI Mode (`google_ai_mode` engine)
- **Document Parsing**: [Mammoth](https://github.com/mwilliamson/mammoth.js) + [Cheerio](https://cheerio.js.org/) for Word DOCX tables
- **Bot Framework**: [Telegraf](https://telegraf.js.org/)
- **Logging**: [Winston](https://github.com/winstonjs/winston)
- **Configuration**: `dotenv`
- **Testing**: Built-in Node test runner (`node:test`)

---

## Directory Structure

```
├── .env.example                     # Environment configuration template
├── package.json                     # Dependencies and test/run scripts
├── README.md                        # Documentation and setup instructions
├── scripts/
│   └── testLocal.js                 # CLI testing tool for local DOCX tender files
├── src/
│   ├── bot.js                       # Telegram bot entry point and file handler
│   ├── config.js                    # Environment configuration loader
│   ├── format/
│   │   └── telegramFormatter.js     # Telegram MarkdownV2 message formatter
│   ├── logger.js                    # Winston logger setup
│   ├── parsers/
│   │   └── docxParser.js            # DOCX table extractor
│   ├── pipeline.js                  # End-to-end processing pipeline
│   ├── search/
│   │   ├── MarketSource.js          # Base interface for search sources
│   │   ├── googleAiModeSource.js    # SerpApi Google AI Mode search client
│   │   └── index.js                 # Search orchestrator
│   └── verify/
│       └── matchVerifier.js         # Candidate attribute matching & scoring
└── tests/
    ├── fixtures/
    │   └── sample-tender.docx       # Sample tender document fixture
    ├── googleAiModeSource.test.js   # Unit tests for SerpApi transformer
    └── telegramFormatter.test.js    # Unit tests for MarkdownV2 formatting
```

---

## Getting Started

### 1. Prerequisites
- Node.js 18.0.0 or higher
- npm 9.0.0 or higher
- SerpApi API Key (from [serpapi.com](https://serpapi.com/))
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

### 2. Installation

```bash
npm install
```

### 3. Environment Configuration

Copy the sample environment file:

```bash
cp .env.example .env
```

Set the required keys in `.env`:
```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
SERPAPI_API_KEY=your_serpapi_api_key_here
```

### 4. Running the Bot

```bash
npm start
```

### 5. Running Tests

```bash
npm test
```

To test a local DOCX file without launching the bot:

```bash
npm run test:local
```

