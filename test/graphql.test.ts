import { describe, expect, it } from "vitest";
import { buildContext } from "../src/analyzers/context.js";
import { analyzeGraphQL, graphqlOperations, isGraphQLRequest } from "../src/analyzers/graphql/index.js";
import { site } from "./sites.js";

const gql = (name: Parameters<typeof site>[0]) => analyzeGraphQL(buildContext(site(name)));

describe("GraphQL detection (real sites)", () => {
  it("HackerOne: detects the operation from its POST body, with query text", () => {
    const [op] = gql("hackerone");
    expect(op).toMatchObject({
      endpoint: "https://hackerone.com/graphql",
      method: "POST",
      operationName: "HacktivitySearchQuery",
      operationType: "query",
    });
    expect(op?.query).toMatch(/^\s*query HacktivitySearchQuery/);
    expect(op?.assessment.recordSet).toMatchObject({ path: "data.search.nodes", count: 25 });
    expect(op?.assessment.visibleOverlap).toBe(1);
    expect(op?.paginationFields).toEqual(expect.arrayContaining(["variables.size", "variables.from"]));
    expect(op?.score).toBeGreaterThanOrEqual(80);
  });

  it("HackerOne: Relay pageInfo shows up as pagination fields", () => {
    const teams = gql("hackerone").find((o) => o.operationName === "GetTeamsQuery");
    expect(teams?.paginationFields).toEqual(expect.arrayContaining(["data.teams.pageInfo.endCursor", "data.teams.pageInfo.hasNextPage"]));
  });

  it("Coursera: the search operation carries the visible results", () => {
    const [op] = gql("coursera");
    expect(op).toMatchObject({ operationName: "Search", operationType: "query", endpoint: "https://www.coursera.org/graphql-gateway" });
    expect(op?.assessment.recordSet?.path).toBe("data.SearchResult.search[].elements");
    expect(op?.assessment.visibleOverlap).toBeGreaterThan(0.5);
  });

  it("Airbnb: detects persisted queries sent as GET parameters", () => {
    const ops = gql("airbnb");
    const suggestions = ops.find((o) => o.operationName === "AutoSuggestionsQuery");
    expect(suggestions).toMatchObject({ method: "GET", query: undefined });
    expect(suggestions?.persistedQueryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(suggestions?.reasons).toContain("persisted query (hash may change between deploys)");
  });

  it("Twitch: splits a batched request into its operations", () => {
    const batch = site("twitch").requests.find((r) => r.url === "https://gql.twitch.tv/gql" && r.postData?.startsWith("["));
    expect(batch).toBeDefined();
    expect(isGraphQLRequest(batch!)).toBe(true);
    expect(graphqlOperations(batch!).length).toBeGreaterThan(1);
    const names = gql("twitch").map((o) => o.operationName);
    expect(names).toEqual(expect.arrayContaining(["BrowsePage_AllDirectories", "SideNav"]));
  });

  it("Twitch: tracking mutations are scored as useless", () => {
    const send = gql("twitch").find((o) => o.operationName === "SendEvents");
    expect(send?.operationType).toBe("mutation");
    expect(send?.score).toBeLessThan(30);
  });

  // Known gap: Twitch's edges carry an extra `trackingID` key, so edges[].node is
  // not unwrapped and the operation loses its record fields (and its rank).
  it.fails("Twitch: unwraps edges[].node even when edges carry extra keys", () => {
    const browse = gql("twitch").find((o) => o.operationName === "BrowsePage_AllDirectories");
    expect(browse?.assessment.recordSet?.path).toBe("data.directoriesWithTags.edges[].node");
  });

  it("finds no GraphQL on sites that don't use it", () => {
    for (const name of ["books-toscrape", "quotes-scroll", "crates", "bbc-news"] as const) expect(gql(name)).toEqual([]);
  });
});
