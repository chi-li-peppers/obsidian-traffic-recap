// Unit tests for Traffic Recap. Run with: node tests/run.js
const Module = require("module");
const assert = require("assert");
const calls = [];
let responder = () => ({ status: 404, json: null, text: "" });

const fake = {
  Plugin: class { async saveData() {} async loadData() { return {}; } },
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class { hide() {} },
  SuggestModal: class {},
  MarkdownRenderer: { async render() {} },
  MarkdownRenderChild: class {},
  TFile: class {},
  moment: null,
  requestUrl: async (o) => {
    calls.push(o);
    const r = responder(o);
    return { status: r.status, json: r.json, text: r.text ?? JSON.stringify(r.json) };
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === "obsidian" ? fake : origLoad.call(this, req, ...rest);
};

const P = require(require("path").join(__dirname, "..", "main.js"));
const I = P._internals;

async function main() {
  const anchor = new Date(2026, 10, 24);
  const range = I.resolveRange("yesterday", anchor);
  assert.deepStrictEqual([range.since, range.until], ["2026-11-23", "2026-11-23"]);
  const shifted = I.shiftRange(range, -2);
  assert.deepStrictEqual([shifted.since, shifted.until], ["2026-11-21", "2026-11-21"]);
  assert.strictEqual(I.posDelta(5.5, 8.0), " (▲2.5)");
  assert.strictEqual(I.posDelta(10.0, 8.0), " (▼2.0)");
  assert.strictEqual(I.fmtDuration(125), "2m 05s");
  console.log("ranges & format ok");

  const settings = {
    maxRows: 10, compare: true,
    googleClientId: "cid", googleClientSecret: "sec", googleRefreshToken: "rt",
    ga4PropertyId: "properties/123456",
    gscSiteUrl: "sc-domain:example.com", gscLagDays: 2,
    plausibleBaseUrl: "https://analytics.example.com", plausibleSiteId: "example.com", plausibleApiKey: "pk_123",
    posthogHost: "https://us.posthog.com", posthogProjectId: "42", posthogApiKey: "phx_123",
  };
  const plugin = { settings };
  const oauth = new I.GoogleOAuth(plugin);

  responder = (o) => {
    if (o.url.includes("oauth2.googleapis.com")) {
      return { status: 200, json: { access_token: "GAT", expires_in: 3600 } };
    }
    if (o.url.includes("analyticsdata.googleapis.com")) {
      const b = JSON.parse(o.body);
      if (b.dimensions) {
        return {
          status: 200,
          json: {
            rows: [
              { dimensionValues: [{ value: "/pricing" }], metricValues: [{ value: "400" }, { value: "250" }, { value: "280" }] },
              { dimensionValues: [{ value: "/blog" }], metricValues: [{ value: "120" }, { value: "90" }, { value: "95" }] },
            ],
          },
        };
      }
      return {
        status: 200,
        json: { rows: [{ metricValues: [{ value: "300" }, { value: "350" }, { value: "520" }, { value: "0.42" }, { value: "14" }] }] },
      };
    }
    if (o.url.includes("webmasters/v3/sites/")) {
      const b = JSON.parse(o.body);
      if (b.dimensions) {
        return {
          status: 200,
          json: { rows: [{ keys: ["obsidian analytics"], clicks: 45, impressions: 900, ctr: 0.05, position: 4.2 }] },
        };
      }
      return { status: 200, json: { rows: [{ clicks: 120, impressions: 3000, ctr: 0.04, position: 6.5 }] } };
    }
    if (o.url.includes("analytics.example.com/api/v2/query")) {
      const b = JSON.parse(o.body);
      if (b.dimensions) {
        return { status: 200, json: { results: [{ dimensions: ["/"], metrics: [600, 410] }] } };
      }
      return { status: 200, json: { results: [{ metrics: [450, 900, 38.5, 145] }] } };
    }
    if (o.url.includes("us.posthog.com/api/projects/42/query/")) {
      const b = JSON.parse(o.body);
      if (b.query.query.includes("GROUP BY")) {
        return { status: 200, json: { results: [["/app", 700, 320]] } };
      }
      return { status: 200, json: { results: [[380, 420, 890]] } };
    }
    return { status: 404, json: { error: { message: "nope" } } };
  };

  const ga4 = new I.GA4Source(plugin, oauth);
  const g4 = await ga4.fetch(range);
  assert.strictEqual(g4.visitors, 300);
  assert.strictEqual(g4.pageviews, 520);
  assert.strictEqual(g4.rows.length, 2);
  console.log("ga4 ok");

  const gsc = new I.GSCSource(plugin, oauth);
  const gs = await gsc.fetch(range, { applyLag: true });
  assert.strictEqual(gs.clicks, 120);
  assert.strictEqual(gs.effectiveRange.since, "2026-11-21");
  const gscCall = calls.find((c) => c.url.includes("webmasters/v3"));
  assert.ok(gscCall.url.includes("sc-domain%3Aexample.com"));
  console.log("gsc ok");

  const pl = new I.PlausibleSource(plugin);
  const pd = await pl.fetch(range);
  assert.strictEqual(pd.visitors, 450);
  assert.strictEqual(pd.bounceRate, 0.385);
  assert.strictEqual(pd.visitDuration, 145);
  console.log("plausible ok");

  const ph = new I.PostHogSource(plugin);
  const phd = await ph.fetch(range);
  assert.strictEqual(phd.visitors, 380);
  assert.strictEqual(phd.pageviews, 890);
  assert.strictEqual(phd.rows[0].label, "/app");
  console.log("posthog ok");

  // Report + filter + frontmatter
  const rep = I.buildReport(
    [
      { name: "Google Analytics 4", key: "ga4", data: g4, prev: { kind: "web", visitors: 250, sessions: 300, pageviews: 450 } },
      { name: "Google Search Console", key: "gsc", data: gs, prev: { kind: "search", clicks: 100, impressions: 2500, position: 8.0 } },
    ],
    range,
    settings,
    { headingLevel: 3, filter: "pricing" }
  );
  assert.ok(rep.markdown.includes("#### Google Analytics 4"));
  assert.ok(rep.markdown.includes("| /pricing |"));
  assert.ok(!rep.markdown.includes("| /blog |"));
  assert.ok(rep.markdown.includes("Avg Pos. 6.5 (▲1.5)"));

  const fm = {};
  I.applyFrontMatter(fm, rep);
  assert.strictEqual(fm.traffic_visitors, 300);
  assert.strictEqual(fm.traffic_bounce_rate, 42);
  assert.strictEqual(fm.traffic_gsc_clicks, 120);
  assert.strictEqual(fm.traffic_gsc_position, 6.5);

  // OAuth reset & SecretStorage
  oauth.reset();
  assert.strictEqual(oauth.token, null);

  const plug = new P();
  plug.app = {
    secretStorage: { getSecret: (id) => (id === "pk" ? "SECRET_PK" : null) },
    internalPlugins: { getPluginById: () => null },
    plugins: { getPlugin: (id) => (id === "periodic-notes" ? { settings: { daily: { enabled: true, folder: "Daily", format: "YYYY-MM-DD" } } } : null) },
  };
  plug.settings = { plausibleApiKeySecret: "pk", plausibleApiKey: "OLD" };
  assert.strictEqual(plug.getSecretValue("plausibleApiKeySecret", "plausibleApiKey"), "SECRET_PK");
  assert.deepStrictEqual(plug.dailyNoteSettings(), { folder: "Daily", format: "YYYY-MM-DD" });

  // Demo mode
  const demo = new I.DemoSource("Google Search Console", "gsc", "search");
  const dd = await demo.fetch(range);
  assert.ok(dd.clicks > 0 && dd.rows.length > 0);
  console.log("all tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
