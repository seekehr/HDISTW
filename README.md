# hdistw

HowDoIScrapeThisWebsite. Point it at a URL and it tells you where the page gets its data (REST, GraphQL, Next.js, embedded JSON, plain HTML) and the cheapest way to scrape it.

## Setup

Needs Node 20+.

```
npm install
npx playwright install chromium
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

It loads the page in a hidden browser first. If that hits a login page or a bot check (like Cloudflare's "Just a moment..."), a browser window opens. Log in or pass the check there, then press Enter in the terminal and it captures the page with your session.

Your login is saved in a browser profile (`~/.hdistw/profile` by default), so next time it usually works without the window. That folder holds your login cookies, so keep it private.

Some pages load fine logged out but show more when you're logged in. Use `--login` to always log in first.

If it still only gets a bot check, the report says so and gives no recommendation. It won't try to get around bot checks itself.

## Notes

Cookies, tokens and auth headers are redacted before anything is saved or sent to Gemini. It won't bypass CAPTCHAs or bot protection.

## Dev

```
npm test
npm run typecheck
```
