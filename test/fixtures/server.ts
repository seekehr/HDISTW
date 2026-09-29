import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A tiny local site exercising the data-loading patterns hdistw detects. */

const products = (page: number) =>
  Array.from({ length: 10 }, (_, i) => {
    const id = (page - 1) * 10 + i + 1;
    return { id, title: `Fixture Lamp ${id}`, price: 20 + id, image: `/img/${id}.jpg` };
  });

const layout = (body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>${head}</head><body>${body}</body></html>`;

const SPA = layout(
  `<div id="app">Loading…</div><button id="more">Load more</button>
<script>
  let cursor = null;
  async function load() {
    const url = new URL("/api/products", location.origin);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url);
    const data = await res.json();
    const app = document.getElementById("app");
    if (!cursor) app.textContent = "";
    for (const p of data.items) {
      const el = document.createElement("div");
      el.textContent = p.title + " — $" + p.price;
      app.appendChild(el);
    }
    cursor = data.meta.nextCursor;
  }
  document.getElementById("more").onclick = load;
  load();
</script>`,
);

const SSR = (page: number) =>
  layout(
    `<h1>Lamps</h1><ul>${products(page)
      .map((p) => `<li><a href="/lamps/${p.id}">${p.title}</a> <span>$${p.price}</span></li>`)
      .join("")}</ul><a rel="next" href="/ssr?page=${page + 1}">Next</a>`,
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: products(page).map((p, i) => ({ "@type": "ListItem", position: i + 1, name: p.title })),
    })}</script>`,
  );

const NEXT = () => {
  const pageProps = { products: products(1), pagination: { page: 1, totalPages: 5 } };
  return layout(
    `<div id="__next">${pageProps.products.map((p) => `<div class="card"><h2>${p.title}</h2><p>$${p.price}</p></div>`).join("")}</div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps },
      page: "/shop",
      query: {},
      buildId: "fixture-build-123",
      gssp: true,
    })}</script>`,
    `<script src="/_next/static/chunks/main.js" defer></script>`,
  );
};

const GRAPHQL_PAGE = layout(
  `<div id="app"></div>
<script>
  fetch("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationName: "SearchLamps",
      query: "query SearchLamps($first: Int, $after: String) { lamps(first: $first, after: $after) { edges { node { id title price } } pageInfo { hasNextPage endCursor } } }",
      variables: { first: 10, after: null },
    }),
  })
    .then((r) => r.json())
    .then(({ data }) => {
      document.getElementById("app").innerHTML = data.lamps.edges.map((e) => "<p>" + e.node.title + "</p>").join("");
    });
</script>`,
);

const EMBEDDED = layout(
  `<div id="root"></div>
<script>window.__INITIAL_STATE__ = ${JSON.stringify({ catalog: { items: products(1) } })};</script>
<script>
  document.getElementById("root").innerHTML = window.__INITIAL_STATE__.catalog.items.map((p) => "<p>" + p.title + "</p>").join("");
</script>`,
);

export async function startFixtureServer(): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    const html = (body: string) => send(200, "text/html; charset=utf-8", body);

    switch (url.pathname) {
      case "/spa":
        return html(SPA);
      case "/api/products": {
        const cursor = url.searchParams.get("cursor");
        const page = cursor ? Number(Buffer.from(cursor, "base64").toString()) : 1;
        return send(200, "application/json", JSON.stringify({
          items: products(page),
          meta: { nextCursor: page < 3 ? Buffer.from(String(page + 1)).toString("base64") : null, hasMore: page < 3 },
        }));
      }
      case "/ssr":
        return html(SSR(Number(url.searchParams.get("page") ?? 1)));
      case "/next":
        return html(NEXT());
      case "/_next/static/chunks/main.js":
        return send(200, "application/javascript", "/* next */");
      case "/graphql-page":
        return html(GRAPHQL_PAGE);
      case "/graphql":
        return send(200, "application/json", JSON.stringify({
          data: {
            lamps: {
              edges: products(1).map((p) => ({ cursor: `c${p.id}`, node: { __typename: "Lamp", ...p } })),
              pageInfo: { hasNextPage: true, endCursor: "c10" },
            },
          },
        }));
      case "/embedded":
        return html(EMBEDDED);
      case "/account":
        res.writeHead(302, { location: "/login?next=/account" });
        return res.end();
      case "/login":
        return html(layout(`<form><input name="email"><input type="password" name="password"><button>Sign in</button></form>`));
      default:
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
