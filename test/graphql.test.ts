import { describe, expect, it } from "vitest";
import { buildContext } from "../src/analyzers/context.js";
import { analyzeGraphQL, isGraphQLRequest } from "../src/analyzers/graphql/index.js";
import { analyzeRest } from "../src/analyzers/rest/index.js";
import { capture, jsonReq, PRODUCTS, VISIBLE_PRODUCTS_TEXT } from "./helpers.js";

const QUERY = `query ProductList($first: Int!, $after: String, $token: String) {
  products(first: $first, after: $after) { edges { cursor node { id title price } } pageInfo { hasNextPage endCursor } }
}`;

const response = {
  data: {
    products: {
      edges: PRODUCTS.map((p) => ({ cursor: `c${p.id}`, node: { __typename: "Product", ...p } })),
      pageInfo: { hasNextPage: true, endCursor: "c12" },
    },
  },
};

const gqlRequest = jsonReq("https://shop.test/graphql", response, {
  method: "POST",
  postData: JSON.stringify({ operationName: "ProductList", query: QUERY, variables: { first: 12, after: null, token: "[REDACTED]" } }),
});

describe("GraphQL detection", () => {
  it("detects operations from POST bodies", () => {
    expect(isGraphQLRequest(gqlRequest)).toBe(true);
    const [op] = analyzeGraphQL(buildContext(capture({ requests: [gqlRequest], renderedText: VISIBLE_PRODUCTS_TEXT })));
    expect(op).toMatchObject({
      endpoint: "https://shop.test/graphql",
      operationName: "ProductList",
      operationType: "query",
      entityType: "Product",
    });
    expect(op?.variables).toMatchObject({ first: 12, after: null });
    expect(op?.paginationFields).toEqual(
      expect.arrayContaining(["variables.first", "variables.after", "data.products.pageInfo.endCursor"]),
    );
    expect(op?.assessment.recordSet?.path).toBe("data.products.edges[].node");
    expect(op?.score).toBeGreaterThanOrEqual(80);
  });

  it("is not double-counted as a REST endpoint", () => {
    expect(analyzeRest(buildContext(capture({ requests: [gqlRequest] })))).toHaveLength(0);
  });

  it("detects persisted GET queries and batched requests", () => {
    const persisted = jsonReq(
      `https://shop.test/api?operationName=Feed&variables=${encodeURIComponent('{"page":2}')}&extensions=${encodeURIComponent(
        '{"persistedQuery":{"version":1,"sha256Hash":"abc123"}}',
      )}`,
      { data: { feed: PRODUCTS } },
    );
    const batched = jsonReq("https://shop.test/gql", [{ data: { a: 1 } }, { data: { feed: PRODUCTS } }], {
      method: "POST",
      postData: JSON.stringify([
        { operationName: "A", query: "query A { a }" },
        { operationName: "B", query: "query B { feed { id title } }" },
      ]),
    });
    const ops = analyzeGraphQL(buildContext(capture({ requests: [persisted, batched], renderedText: VISIBLE_PRODUCTS_TEXT })));
    const feed = ops.find((o) => o.operationName === "Feed");
    expect(feed?.persistedQueryHash).toBe("abc123");
    expect(feed?.reasons.join(" ")).toMatch(/persisted query/);
    expect(ops.map((o) => o.operationName)).toEqual(expect.arrayContaining(["A", "B"]));
  });

  it("recognizes GraphQL by response shape on a /graphql path", () => {
    const r = jsonReq("https://shop.test/graphql", { data: { viewer: null } });
    expect(isGraphQLRequest(r)).toBe(true);
    expect(isGraphQLRequest(jsonReq("https://shop.test/api/items", { data: [] }))).toBe(false);
  });

  it("marks mutations as poor data sources", () => {
    const mutation = jsonReq("https://shop.test/graphql", { data: { addToCart: { id: 1, title: "x" } } }, {
      method: "POST",
      postData: JSON.stringify({ query: "mutation AddToCart($id: ID!) { addToCart(id: $id) { id } }", variables: { id: 1 } }),
    });
    const [op] = analyzeGraphQL(buildContext(capture({ requests: [mutation] })));
    expect(op?.operationType).toBe("mutation");
    expect(op?.operationName).toBe("AddToCart");
    expect(op?.score).toBeLessThan(30);
  });
});
