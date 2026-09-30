# hdistw

HowDoIScrapeThisWebsite. Point it at a URL and it tells you where the page gets its data (REST, GraphQL, Next.js, embedded JSON, plain HTML) and the cheapest way to scrape it.

## Setup

Needs Node 20+ and Google Chrome installed.

```
npm install
npx playwright install chrome
npm run build
npm link
```

`npm link` puts the `hdistw` command on your PATH. Skip it if you'd rather run `node dist/cli/index.js` instead.

For the Gemini write-up, copy `.env.example` to `.env` and fill in `GEMINI_API_KEY`. It works without it.

## Usage

```
hdistw inspect https://example.com/products
```

Reports go to `reports/<host>/report.md` and `report.json`.

Other flags: `--no-ai`, `--out <dir>`, `--timeout <ms>`, `--model <name>`, `--profile <dir>`, `--login`.

### Logins and bot checks

It uses your installed Chrome binary (not Playwright's Chromium), so Cloudflare and other bot checks see a real browser. It keeps its own profile at `~/.hdistw/profile`.

It loads the page in a hidden Chrome first. If that hits a login page or a bot check, a Chrome window opens. Log in or pass the check there, then press Enter in the terminal and it captures the page with your session.

Some pages load fine logged out but show more when you're logged in. Use `--login` to always log in first.

If it still only gets a bot check, the report says so and gives no recommendation. It won't try to get around bot checks itself.

## Notes

Cookies, tokens and auth headers are redacted before anything is saved or sent to Gemini. It won't bypass CAPTCHAs or bot protection.

## Dev

```
npm test
npm run typecheck
```
