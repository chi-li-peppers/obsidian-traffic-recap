"use strict";

const obsidian = require("obsidian");
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  SuggestModal,
  MarkdownRenderer,
  MarkdownRenderChild,
  TFile,
  requestUrl,
} = obsidian;

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  maxRows: 10,
  compare: true,
  heading: "## Traffic",
  autoDailyNote: false,
  writeProperties: true,
  demoMode: false,

  // Shared Google OAuth (GA4 + Search Console)
  googleClientId: "",
  googleClientSecret: "",
  googleClientSecretSecret: "",
  googleRefreshToken: "",
  googleRefreshTokenSecret: "",

  ga4Enabled: false,
  ga4PropertyId: "",

  gscEnabled: false,
  gscSiteUrl: "",
  gscLagDays: 0,

  plausibleEnabled: false,
  plausibleBaseUrl: "https://plausible.io",
  plausibleSiteId: "",
  plausibleApiKey: "",
  plausibleApiKeySecret: "",

  posthogEnabled: false,
  posthogHost: "https://us.posthog.com",
  posthogProjectId: "",
  posthogApiKey: "",
  posthogApiKeySecret: "",
};

const RANGE_CHOICES = [
  { id: "yesterday", label: "Yesterday" },
  { id: "today", label: "Today so far" },
  { id: "last_7d", label: "Last 7 days" },
  { id: "last_14d", label: "Last 14 days" },
  { id: "last_30d", label: "Last 30 days" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
];

const REPORT_CACHE_TTL_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}
function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function daysBetween(a, b) {
  return Math.round((addDays(b, 0) - addDays(a, 0)) / 86400000);
}
function prettyDate(d) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function shiftRange(range, offsetDays) {
  if (!offsetDays) return range;
  const s = addDays(parseYmd(range.since), offsetDays);
  const u = addDays(parseYmd(range.until), offsetDays);
  const label = ymd(s) === ymd(u) ? prettyDate(s) : `${prettyDate(s)} – ${prettyDate(u)}`;
  return { since: ymd(s), until: ymd(u), label, days: range.days };
}

function resolveRange(spec, anchor) {
  const today = addDays(anchor || new Date(), 0);
  const s = String(spec || "yesterday").trim().toLowerCase();
  let since;
  let until;

  if (s === "today") {
    since = until = today;
  } else if (s === "yesterday") {
    since = until = addDays(today, -1);
  } else if (/^last_(\d+)d$/.test(s)) {
    const n = Number(/^last_(\d+)d$/.exec(s)[1]);
    if (n < 1 || n > 366) throw new Error(`Unsupported range "${spec}"`);
    until = addDays(today, -1);
    since = addDays(today, -n);
  } else if (s === "this_month") {
    since = new Date(today.getFullYear(), today.getMonth(), 1);
    until = today;
  } else if (s === "last_month") {
    since = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    until = new Date(today.getFullYear(), today.getMonth(), 0);
  } else if (s.includes("..")) {
    const [a, b] = s.split("..");
    since = parseYmd(a);
    until = parseYmd(b);
  } else {
    since = until = parseYmd(s);
  }

  if (!since || !until) throw new Error(`Unrecognised range "${spec}"`);
  if (since > until) [since, until] = [until, since];

  const label =
    ymd(since) === ymd(until) ? prettyDate(since) : `${prettyDate(since)} – ${prettyDate(until)}`;
  return { since: ymd(since), until: ymd(until), label, days: daysBetween(since, until) + 1 };
}

function previousRange(range) {
  const since = parseYmd(range.since);
  const prevUntil = addDays(since, -1);
  const prevSince = addDays(prevUntil, -(range.days - 1));
  return {
    since: ymd(prevSince),
    until: ymd(prevUntil),
    label: "previous period",
    days: range.days,
  };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function num(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return isFinite(n) ? n : 0;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}
function escapeCell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const INT_FMT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const DEC1_FMT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const DEC2_FMT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtInt(v) {
  return v === null || v === undefined ? "—" : INT_FMT.format(v);
}
function fmtPct(ratio) {
  return ratio === null || ratio === undefined ? "—" : `${DEC1_FMT.format(ratio * 100)}%`;
}
function fmtPos(v) {
  return v === null || v === undefined ? "—" : DEC1_FMT.format(v);
}
function fmtDuration(sec) {
  if (sec === null || sec === undefined || !isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${pad(r)}s` : `${r}s`;
}

function delta(cur, prev) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return "";
  if (prev === 0) return cur === 0 ? "" : " (new)";
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return " (±0%)";
  const arrow = d > 0 ? "▲" : "▼";
  return ` (${arrow}${Math.abs(d * 100).toFixed(0)}%)`;
}

/** Position delta: lower rank number is an improvement (e.g. 8.0 -> 5.5 is ▲2.5). */
function posDelta(cur, prev) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return "";
  const diff = prev - cur; // positive = improved
  if (Math.abs(diff) < 0.05) return " (±0.0)";
  const arrow = diff > 0 ? "▲" : "▼";
  return ` (${arrow}${DEC1_FMT.format(Math.abs(diff))})`;
}

function normalizeHttpsUrl(raw, fallback, label) {
  const s = String(raw || "").trim() || fallback;
  if (!/^https:\/\//i.test(s)) throw new Error(`${label}: URL must start with https://`);
  return s.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ */
/* HTTP & Google OAuth                                                 */
/* ------------------------------------------------------------------ */

async function http(opts) {
  const res = await requestUrl({ throw: false, ...opts });
  let json = null;
  try {
    json = res.json;
  } catch (e) {
    json = null;
  }
  return { status: res.status, json, text: res.text };
}

function apiError(platform, res) {
  const j = res.json || {};
  const msg =
    j?.error?.message ||
    j?.error_description ||
    j?.detail ||
    (typeof j?.error === "string" ? j.error : "") ||
    (res.text || "").slice(0, 200);
  return new Error(`${platform}: ${msg || "HTTP " + res.status}`);
}

class GoogleOAuth {
  constructor(plugin) {
    this.plugin = plugin;
    this.token = null;
    this.expires = 0;
  }
  reset() {
    this.token = null;
    this.expires = 0;
  }
  secret(secretKey, plainKey) {
    if (typeof this.plugin.getSecretValue === "function") {
      return this.plugin.getSecretValue(secretKey, plainKey);
    }
    return String(this.plugin.settings[plainKey] || "");
  }
  async accessToken() {
    if (this.token && Date.now() < this.expires - 60000) return this.token;
    const clientId = String(this.plugin.settings.googleClientId || "").trim();
    const clientSecret = this.secret("googleClientSecretSecret", "googleClientSecret").trim();
    const refreshToken = this.secret("googleRefreshTokenSecret", "googleRefreshToken").trim();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("Google OAuth: client ID, client secret and refresh token are required");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString();
    const res = await http({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body,
    });
    if (res.status !== 200 || !res.json?.access_token) throw apiError("Google OAuth", res);
    this.token = res.json.access_token;
    this.expires = Date.now() + num(res.json.expires_in || 3600) * 1000;
    return this.token;
  }
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

class GA4Source {
  constructor(plugin, oauth) {
    this.plugin = plugin;
    this.oauth = oauth;
  }
  get s() {
    return this.plugin.settings;
  }
  get name() {
    return "Google Analytics 4";
  }
  get key() {
    return "ga4";
  }
  get kind() {
    return "web";
  }

  async fetch(range, opts = {}) {
    const prop = String(this.s.ga4PropertyId || "").trim().replace(/^properties\//i, "").replace(/\D/g, "");
    if (!prop) throw new Error("GA4: property ID is required (numbers only)");
    const token = await this.oauth.accessToken();
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`;
    const headers = { Authorization: `Bearer ${token}` };

    const summaryRes = await http({
      url,
      method: "POST",
      headers,
      contentType: "application/json",
      body: JSON.stringify({
        dateRanges: [{ startDate: range.since, endDate: range.until }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
          { name: "screenPageViews" },
          { name: "bounceRate" },
          { name: "keyEvents" },
        ],
      }),
    });
    if (summaryRes.status !== 200) throw apiError("GA4", summaryRes);
    const vals = summaryRes.json?.rows?.[0]?.metricValues || [];
    const visitors = num(vals[0]?.value);
    const sessions = num(vals[1]?.value);
    const pageviews = num(vals[2]?.value);
    const bounceRate = vals[3]?.value !== undefined ? num(vals[3].value) : null;
    const conversions = num(vals[4]?.value);

    let rows = [];
    if (!opts.summaryOnly) {
      const limit = Math.max(10, Math.min(100, Math.floor(num(opts.limit || this.s.maxRows || 10)) * 3));
      const pagesRes = await http({
        url,
        method: "POST",
        headers,
        contentType: "application/json",
        body: JSON.stringify({
          dateRanges: [{ startDate: range.since, endDate: range.until }],
          dimensions: [{ name: "pagePath" }],
          metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }, { name: "sessions" }],
          orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
          limit,
        }),
      });
      if (pagesRes.status !== 200) throw apiError("GA4 pages", pagesRes);
      rows = (pagesRes.json?.rows || []).map((r) => ({
        label: r.dimensionValues?.[0]?.value || "/",
        pageviews: num(r.metricValues?.[0]?.value),
        visitors: num(r.metricValues?.[1]?.value),
        sessions: num(r.metricValues?.[2]?.value),
      }));
    }

    return {
      kind: "web",
      visitors,
      sessions,
      pageviews,
      bounceRate,
      visitDuration: null,
      conversions,
      rows,
    };
  }
}

class GSCSource {
  constructor(plugin, oauth) {
    this.plugin = plugin;
    this.oauth = oauth;
  }
  get s() {
    return this.plugin.settings;
  }
  get name() {
    return "Google Search Console";
  }
  get key() {
    return "gsc";
  }
  get kind() {
    return "search";
  }

  async fetch(range, opts = {}) {
    const site = String(this.s.gscSiteUrl || "").trim();
    if (!site) throw new Error("Search Console: site URL is required (e.g. https://example.com/ or sc-domain:example.com)");
    const lag = Math.max(0, Math.floor(num(this.s.gscLagDays)));
    const effRange = lag > 0 && opts.applyLag ? shiftRange(range, -lag) : range;
    const token = await this.oauth.accessToken();
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
    const headers = { Authorization: `Bearer ${token}` };

    const sumRes = await http({
      url,
      method: "POST",
      headers,
      contentType: "application/json",
      body: JSON.stringify({
        startDate: effRange.since,
        endDate: effRange.until,
      }),
    });
    if (sumRes.status !== 200) throw apiError("Search Console", sumRes);
    const sumRow = sumRes.json?.rows?.[0] || {};
    const clicks = num(sumRow.clicks);
    const impressions = num(sumRow.impressions);
    const ctr = impressions > 0 ? (sumRow.ctr !== undefined ? num(sumRow.ctr) : clicks / impressions) : null;
    const position = sumRow.position !== undefined ? num(sumRow.position) : null;

    let rows = [];
    if (!opts.summaryOnly) {
      const limit = Math.max(10, Math.min(100, Math.floor(num(opts.limit || this.s.maxRows || 10)) * 3));
      const qRes = await http({
        url,
        method: "POST",
        headers,
        contentType: "application/json",
        body: JSON.stringify({
          startDate: effRange.since,
          endDate: effRange.until,
          dimensions: ["query"],
          rowLimit: limit,
        }),
      });
      if (qRes.status !== 200) throw apiError("Search Console queries", qRes);
      rows = (qRes.json?.rows || []).map((r) => ({
        label: r.keys?.[0] || "(query)",
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: r.ctr !== undefined ? num(r.ctr) : num(r.impressions) > 0 ? num(r.clicks) / num(r.impressions) : null,
        position: r.position !== undefined ? num(r.position) : null,
      }));
    }

    return {
      kind: "search",
      clicks,
      impressions,
      ctr,
      position,
      effectiveRange: effRange,
      rows,
    };
  }
}

class PlausibleSource {
  constructor(plugin) {
    this.plugin = plugin;
  }
  get s() {
    return this.plugin.settings;
  }
  get name() {
    return "Plausible";
  }
  get key() {
    return "plausible";
  }
  get kind() {
    return "web";
  }
  secret(secretKey, plainKey) {
    if (typeof this.plugin.getSecretValue === "function") {
      return this.plugin.getSecretValue(secretKey, plainKey);
    }
    return String(this.s[plainKey] || "");
  }

  async fetch(range, opts = {}) {
    const siteId = String(this.s.plausibleSiteId || "").trim();
    if (!siteId) throw new Error("Plausible: site domain is required");
    const token = this.secret("plausibleApiKeySecret", "plausibleApiKey").trim();
    if (!token) throw new Error("Plausible: API key is required");
    const base = normalizeHttpsUrl(this.s.plausibleBaseUrl, "https://plausible.io", "Plausible");
    const url = `${base}/api/v2/query`;
    const headers = { Authorization: `Bearer ${token}` };

    const sumRes = await http({
      url,
      method: "POST",
      headers,
      contentType: "application/json",
      body: JSON.stringify({
        site_id: siteId,
        metrics: ["visitors", "pageviews", "bounce_rate", "visit_duration"],
        date_range: [range.since, range.until],
      }),
    });
    if (sumRes.status !== 200) throw apiError("Plausible", sumRes);
    const m = sumRes.json?.results?.[0]?.metrics || [];
    const visitors = num(m[0]);
    const pageviews = num(m[1]);
    // Plausible v2 bounce_rate is 0..100 -> convert to 0..1 ratio
    const bounceRate = m[2] !== undefined && m[2] !== null ? num(m[2]) / 100 : null;
    const visitDuration = m[3] !== undefined && m[3] !== null ? num(m[3]) : null;

    let rows = [];
    if (!opts.summaryOnly) {
      const limit = Math.max(10, Math.min(100, Math.floor(num(opts.limit || this.s.maxRows || 10)) * 3));
      const pagesRes = await http({
        url,
        method: "POST",
        headers,
        contentType: "application/json",
        body: JSON.stringify({
          site_id: siteId,
          metrics: ["pageviews", "visitors"],
          date_range: [range.since, range.until],
          dimensions: ["event:page"],
          order_by: [["pageviews", "desc"]],
          pagination: { limit },
        }),
      });
      if (pagesRes.status !== 200) throw apiError("Plausible pages", pagesRes);
      rows = (pagesRes.json?.results || []).map((r) => ({
        label: r.dimensions?.[0] || "/",
        pageviews: num(r.metrics?.[0]),
        visitors: num(r.metrics?.[1]),
        sessions: null,
      }));
    }

    return {
      kind: "web",
      visitors,
      sessions: null,
      pageviews,
      bounceRate,
      visitDuration,
      conversions: 0,
      rows,
    };
  }
}

class PostHogSource {
  constructor(plugin) {
    this.plugin = plugin;
  }
  get s() {
    return this.plugin.settings;
  }
  get name() {
    return "PostHog";
  }
  get key() {
    return "posthog";
  }
  get kind() {
    return "web";
  }
  secret(secretKey, plainKey) {
    if (typeof this.plugin.getSecretValue === "function") {
      return this.plugin.getSecretValue(secretKey, plainKey);
    }
    return String(this.s[plainKey] || "");
  }

  async runHogQL(host, projectId, token, query) {
    const res = await http({
      url: `${host}/api/projects/${encodeURIComponent(projectId)}/query/`,
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    });
    if (res.status !== 200) throw apiError("PostHog", res);
    return res.json?.results || [];
  }

  async fetch(range, opts = {}) {
    const projectId = String(this.s.posthogProjectId || "").trim();
    if (!projectId) throw new Error("PostHog: project ID is required");
    const token = this.secret("posthogApiKeySecret", "posthogApiKey").trim();
    if (!token) throw new Error("PostHog: Personal API key is required");
    const host = normalizeHttpsUrl(this.s.posthogHost, "https://us.posthog.com", "PostHog");

    const where =
      `event = '$pageview' AND timestamp >= toDateTime('${range.since} 00:00:00') ` +
      `AND timestamp <= toDateTime('${range.until} 23:59:59')`;
    const sumRows = await this.runHogQL(
      host,
      projectId,
      token,
      `SELECT count(DISTINCT person_id), count(DISTINCT properties.$session_id), count() FROM events WHERE ${where}`
    );
    const first = sumRows[0] || [0, 0, 0];
    const visitors = num(first[0]);
    const sessions = num(first[1]);
    const pageviews = num(first[2]);

    let rows = [];
    if (!opts.summaryOnly) {
      const limit = Math.max(10, Math.min(100, Math.floor(num(opts.limit || this.s.maxRows || 10)) * 3));
      const pageRows = await this.runHogQL(
        host,
        projectId,
        token,
        `SELECT coalesce(properties.$pathname, '/') AS path, count() AS views, count(DISTINCT person_id) AS users ` +
          `FROM events WHERE ${where} GROUP BY path ORDER BY views DESC LIMIT ${limit}`
      );
      rows = pageRows.map((r) => ({
        label: String(r[0] || "/"),
        pageviews: num(r[1]),
        visitors: num(r[2]),
        sessions: null,
      }));
    }

    return {
      kind: "web",
      visitors,
      sessions,
      pageviews,
      bounceRate: null,
      visitDuration: null,
      conversions: 0,
      rows,
    };
  }
}

class DemoSource {
  constructor(name, key, kind) {
    this.name = name;
    this.key = key;
    this.kind = kind;
  }
  async fetch(range) {
    let h = 0;
    for (const ch of range.since + range.until + this.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => {
      h = (h * 1664525 + 1013904223) >>> 0;
      return h / 4294967296;
    };
    if (this.kind === "search") {
      const queries = ["obsidian plugins", "google ads dashboard", "marketing notes template", "meta ads roas calculator", "daily note automation"];
      const rows = queries.map((q, i) => {
        const impressions = Math.round((400 + rnd() * 2000) * range.days / (i + 1));
        const ctr = 0.02 + rnd() * 0.08;
        const clicks = Math.round(impressions * ctr);
        const position = round2(2.5 + i * 2.1 + rnd() * 3);
        return { label: q, clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
      });
      const clicks = rows.reduce((a, b) => a + b.clicks, 0);
      const impressions = rows.reduce((a, b) => a + b.impressions, 0);
      const pos = rows.reduce((a, b) => a + b.position, 0) / rows.length;
      return { kind: "search", clicks, impressions, ctr: impressions > 0 ? clicks / impressions : null, position: pos, effectiveRange: range, rows };
    }
    const pages = ["/", "/pricing", "/blog/obsidian-workflow", "/docs/getting-started", "/changelog"];
    const rows = pages.map((p, i) => {
      const pageviews = Math.round((150 + rnd() * 900) * range.days / (i + 1));
      const visitors = Math.round(pageviews * (0.55 + rnd() * 0.25));
      const sessions = Math.round(visitors * 1.15);
      return { label: p, pageviews, visitors, sessions };
    });
    const pageviews = rows.reduce((a, b) => a + b.pageviews, 0);
    const visitors = Math.round(rows.reduce((a, b) => a + b.visitors, 0) * 0.78);
    const sessions = Math.round(visitors * 1.18);
    return {
      kind: "web",
      visitors,
      sessions,
      pageviews,
      bounceRate: 0.35 + rnd() * 0.2,
      visitDuration: Math.round(70 + rnd() * 140),
      conversions: Math.round(visitors * 0.03),
      rows,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function buildReport(results, range, settings, opts = {}) {
  const maxRows = Math.max(1, Math.floor(num(opts.limit !== undefined ? opts.limit : settings.maxRows)) || 10);
  const filter = String(opts.filter || "").trim().toLowerCase();
  const subPrefix = "#".repeat(Math.min(6, Math.max(2, (opts.headingLevel || 2) + 1)));

  const ok = results.filter((r) => !r.error);
  const errored = results.filter((r) => r.error);
  const partial = ok.length > 0 && errored.length > 0;

  const webResults = ok.filter((r) => r.data.kind === "web");
  const gscResult = ok.find((r) => r.data.kind === "search");

  // Primary web summary uses the first enabled web source (avoids double-counting GA4 + Plausible on the same site)
  const primaryWeb = webResults[0] || null;
  const totals = {
    visitors: primaryWeb ? primaryWeb.data.visitors : null,
    sessions: primaryWeb ? primaryWeb.data.sessions : null,
    pageviews: primaryWeb ? primaryWeb.data.pageviews : null,
    bounceRate: primaryWeb ? primaryWeb.data.bounceRate : null,
    gscClicks: gscResult ? gscResult.data.clicks : null,
    gscImpressions: gscResult ? gscResult.data.impressions : null,
    gscCtr: gscResult ? gscResult.data.ctr : null,
    gscPosition: gscResult ? gscResult.data.position : null,
  };

  const out = [];
  if (settings.demoMode) {
    out.push("> [!info] Demo data");
    out.push("> These numbers are generated samples. Turn off demo mode in Traffic Recap settings to see your accounts.");
    out.push("");
  }

  const summary = [];
  if (primaryWeb) {
    const d = primaryWeb.data;
    const p = primaryWeb.prev;
    summary.push(`Visitors **${fmtInt(d.visitors)}**${p ? delta(d.visitors, p.visitors) : ""}`);
    summary.push(`Pageviews ${fmtInt(d.pageviews)}${p ? delta(d.pageviews, p.pageviews) : ""}`);
    if (d.sessions !== null) summary.push(`Sessions ${fmtInt(d.sessions)}${p ? delta(d.sessions, p.sessions) : ""}`);
    if (d.bounceRate !== null) summary.push(`Bounce ${fmtPct(d.bounceRate)}`);
  }
  if (gscResult) {
    const d = gscResult.data;
    const p = gscResult.prev;
    summary.push(`Search Clicks **${fmtInt(d.clicks)}**${p ? delta(d.clicks, p.clicks) : ""}`);
    summary.push(`Impr. ${fmtInt(d.impressions)}${p ? delta(d.impressions, p.impressions) : ""}`);
    if (d.position !== null) summary.push(`Avg Pos. ${fmtPos(d.position)}${p ? posDelta(d.position, p.position) : ""}`);
  }

  out.push(`*${range.label}${partial ? " · partial" : ""}*  `);
  if (summary.length) out.push(summary.join(" · "));
  out.push("");

  for (const res of results) {
    out.push(`${subPrefix} ${res.name}`);
    if (res.error) {
      out.push(`> [!warning] ${res.error}`);
      out.push("");
      continue;
    }
    const d = res.data;
    const p = res.prev;
    const filtered = filter
      ? (d.rows || []).filter((r) => String(r.label || "").toLowerCase().includes(filter))
      : d.rows || [];

    if (d.kind === "search") {
      const noteLag =
        d.effectiveRange && (d.effectiveRange.since !== range.since || d.effectiveRange.until !== range.until)
          ? ` *(${d.effectiveRange.label})*`
          : "";
      out.push(
        `Clicks **${fmtInt(d.clicks)}**${p ? delta(d.clicks, p.clicks) : ""} · ` +
          `Impr. ${fmtInt(d.impressions)}${p ? delta(d.impressions, p.impressions) : ""} · ` +
          `CTR ${fmtPct(d.ctr)} · Avg Pos. ${fmtPos(d.position)}${p ? posDelta(d.position, p.position) : ""}${noteLag}`
      );
      out.push("");
      if (!filtered.length) {
        out.push(filter ? `_No queries matching "${escapeCell(opts.filter)}" in this period._` : "_No search data in this period._");
        out.push("");
        continue;
      }
      out.push("| Query | Clicks | Impr. | CTR | Pos. |");
      out.push("| --- | ---: | ---: | ---: | ---: |");
      for (const r of filtered.slice(0, maxRows)) {
        out.push(`| ${escapeCell(r.label)} | ${fmtInt(r.clicks)} | ${fmtInt(r.impressions)} | ${fmtPct(r.ctr)} | ${fmtPos(r.position)} |`);
      }
      out.push("");
    } else {
      const lineParts = [
        `Visitors **${fmtInt(d.visitors)}**${p ? delta(d.visitors, p.visitors) : ""}`,
        `Pageviews ${fmtInt(d.pageviews)}${p ? delta(d.pageviews, p.pageviews) : ""}`,
      ];
      if (d.sessions !== null) lineParts.push(`Sessions ${fmtInt(d.sessions)}${p ? delta(d.sessions, p.sessions) : ""}`);
      if (d.bounceRate !== null) lineParts.push(`Bounce ${fmtPct(d.bounceRate)}`);
      if (d.visitDuration !== null) lineParts.push(`Avg Time ${fmtDuration(d.visitDuration)}`);
      if (d.conversions > 0) lineParts.push(`Key Events ${fmtInt(d.conversions)}`);
      out.push(lineParts.join(" · "));
      out.push("");
      if (!filtered.length) {
        out.push(filter ? `_No pages matching "${escapeCell(opts.filter)}" in this period._` : "_No pageviews in this period._");
        out.push("");
        continue;
      }
      const hasSessions = filtered.some((r) => r.sessions !== null && r.sessions !== undefined);
      const head = hasSessions ? ["Page", "Pageviews", "Visitors", "Sessions"] : ["Page", "Pageviews", "Visitors"];
      out.push(`| ${head.join(" | ")} |`);
      out.push(`|${head.map((_, i) => (i === 0 ? " --- " : " ---: ")).join("|")}|`);
      for (const r of filtered.slice(0, maxRows)) {
        const cells = [escapeCell(r.label), fmtInt(r.pageviews), fmtInt(r.visitors)];
        if (hasSessions) cells.push(fmtInt(r.sessions));
        out.push(`| ${cells.join(" | ")} |`);
      }
      out.push("");
    }
  }

  return { markdown: out.join("\n").trim() + "\n", totals, partial };
}

/* ------------------------------------------------------------------ */
/* Daily Note & Frontmatter helpers                                    */
/* ------------------------------------------------------------------ */

function applyFrontMatter(fm, rep) {
  const t = rep.totals;
  if (t.visitors !== null) fm.traffic_visitors = t.visitors;
  if (t.sessions !== null) fm.traffic_sessions = t.sessions;
  if (t.pageviews !== null) fm.traffic_pageviews = t.pageviews;
  if (t.bounceRate !== null) fm.traffic_bounce_rate = round2(t.bounceRate * 100);
  if (t.gscClicks !== null) fm.traffic_gsc_clicks = t.gscClicks;
  if (t.gscImpressions !== null) fm.traffic_gsc_impressions = t.gscImpressions;
  if (t.gscCtr !== null) fm.traffic_gsc_ctr = round2(t.gscCtr * 100);
  if (t.gscPosition !== null) fm.traffic_gsc_position = round2(t.gscPosition);
}

function toBool(v, fallback) {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  return fallback;
}
function headingLevel(heading) {
  const m = /^(#+)\s/.exec(String(heading || "").trim());
  return m ? m[1].length : 2;
}
function isFenceLine(line) {
  return /^\s*(?:```|~~~)/.test(line);
}

function sectionHasContent(data, heading) {
  if (/<!--\s*traffic-recap:start\s*-->/.test(data)) return true;
  const level = headingLevel(heading);
  const lines = String(data || "").split("\n");
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && lines[i].trim() === heading) {
      start = i;
      break;
    }
  }
  if (start === -1) return false;
  for (let i = start + 1; i < lines.length; i++) {
    if (isFenceLine(lines[i])) inFence = !inFence;
    if (!inFence) {
      const m = /^(#+)\s/.exec(lines[i]);
      if (m && m[1].length <= level) break;
    }
    if (lines[i].trim() !== "") return true;
  }
  return false;
}

function replaceSection(data, heading, block) {
  const markerRe = /<!--\s*traffic-recap:start\s*-->[\s\S]*?<!--\s*traffic-recap:end\s*-->/;
  if (markerRe.test(data)) {
    const cleanBlock = block.replace(/\n+$/, "");
    return data.replace(markerRe, `<!-- traffic-recap:start -->\n${cleanBlock}\n<!-- traffic-recap:end -->`);
  }
  const level = headingLevel(heading);
  const lines = data.split("\n");
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && lines[i].trim() === heading) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    const sep = data.length === 0 || data.endsWith("\n\n") ? "" : data.endsWith("\n") ? "\n" : "\n\n";
    return data + sep + block;
  }
  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      const m = /^(#+)\s/.exec(lines[i]);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
  }
  const after = lines.slice(end).join("\n");
  return [...lines.slice(0, start), block.replace(/\n+$/, "")].join("\n") + (after ? "\n\n" + after : "\n");
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class TrafficRecapPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.oauth = new GoogleOAuth(this);
    this.ga4 = new GA4Source(this, this.oauth);
    this.gsc = new GSCSource(this, this.oauth);
    this.plausible = new PlausibleSource(this);
    this.posthog = new PostHogSource(this);
    this.cache = new Map();
    this.blocks = new Set();
    this.testing = false;
    this._saveTimer = null;
    this._dailyTimers = new Set();

    this.addCommand({
      id: "insert-report-yesterday",
      name: "Insert report: yesterday",
      editorCallback: (editor) => this.insertAtCursor(editor, "yesterday"),
    });
    this.addCommand({
      id: "insert-report-last-7-days",
      name: "Insert report: last 7 days",
      editorCallback: (editor) => this.insertAtCursor(editor, "last_7d"),
    });
    this.addCommand({
      id: "insert-report-choose-range",
      name: "Insert report: choose period…",
      editorCallback: (editor) => {
        new RangeModal(this.app, (range) => this.insertAtCursor(editor, range)).open();
      },
    });
    this.addCommand({
      id: "update-current-daily-note",
      name: "Update report in current daily note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const date = file ? this.dailyNoteDate(file) : null;
        if (!date) return false;
        if (!checking) this.updateDailyNote(file, date, true);
        return true;
      },
    });
    this.addCommand({
      id: "insert-live-block",
      name: "Insert live report block",
      editorCallback: (editor) => {
        editor.replaceSelection("```traffic-recap\nrange: last_7d\nsource: all\n```\n");
      },
    });

    this.registerMarkdownCodeBlockProcessor("traffic-recap", (src, el, ctx) => this.renderBlock(src, el, ctx));
    this.addSettingTab(new TrafficRecapSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (!this.settings.autoDailyNote || !(file instanceof TFile) || file.extension !== "md") return;
          const date = this.dailyNoteDate(file);
          if (!date || ymd(date) !== ymd(new Date())) return;
          const timer = window.setTimeout(() => {
            this._dailyTimers.delete(timer);
            if (!this.app.vault.getAbstractFileByPath(file.path)) return;
            this.updateDailyNote(file, date, false);
          }, 2000);
          this._dailyTimers.add(timer);
        })
      );
    });
  }

  onunload() {
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.saveData(this.settings);
    }
    for (const t of this._dailyTimers || []) window.clearTimeout(t);
    this._dailyTimers?.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (typeof v === "boolean") this.settings[k] = toBool(this.settings[k], v);
    }
  }

  async saveSettings() {
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this.saveData(this.settings);
    this.cache?.clear();
    this.oauth?.reset();
    for (const redraw of this.blocks || []) redraw(true);
  }

  scheduleSaveSettings(delayMs = 600) {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => {
      this._saveTimer = null;
      this.saveSettings();
    }, delayMs);
  }

  getSecretValue(secretIdKey, plainKey) {
    const id = String(this.settings[secretIdKey] || "").trim();
    const ss = this.app?.secretStorage;
    if (id && ss) {
      const stored =
        typeof ss.getSecret === "function"
          ? ss.getSecret(id)
          : typeof ss.get === "function"
            ? ss.get(id)
            : null;
      if (stored) return stored;
    }
    return String(this.settings[plainKey] || "");
  }

  sources(filter) {
    const want = String(filter || "all").toLowerCase();
    const list = [];
    if (this.settings.demoMode) {
      if (want === "all" || want === "ga4") list.push(new DemoSource("Google Analytics 4", "ga4", "web"));
      if (want === "all" || want === "gsc") list.push(new DemoSource("Google Search Console", "gsc", "search"));
      if (want === "plausible") list.push(new DemoSource("Plausible", "plausible", "web"));
      if (want === "posthog") list.push(new DemoSource("PostHog", "posthog", "web"));
      return list;
    }
    if (this.settings.ga4Enabled && (want === "all" || want === "ga4")) list.push(this.ga4);
    if (this.settings.plausibleEnabled && (want === "all" || want === "plausible")) list.push(this.plausible);
    if (this.settings.posthogEnabled && (want === "all" || want === "posthog")) list.push(this.posthog);
    if (this.settings.gscEnabled && (want === "all" || want === "gsc")) list.push(this.gsc);
    return list;
  }

  async collect(rangeSpec, opts = {}) {
    const range = resolveRange(rangeSpec, opts.anchor);
    const sources = this.sources(opts.source);
    if (!sources.length) {
      throw new Error("No analytics sources connected. Open Settings → Traffic Recap to connect GA4, Search Console, Plausible or PostHog, or turn on demo mode.");
    }
    const compare = opts.compare ?? this.settings.compare;
    const prev = compare ? previousRange(range) : null;
    const key = JSON.stringify([
      range.since,
      range.until,
      opts.source || "all",
      opts.filter || "",
      opts.limit ?? "",
      opts.headingLevel || 2,
      !!opts.applyLag,
      !!compare,
      !!this.settings.demoMode,
    ]);
    const hit = this.cache.get(key);
    if (hit && !opts.force && Date.now() - hit.at < REPORT_CACHE_TTL_MS) return hit.value;

    const results = await Promise.all(
      sources.map(async (src) => {
        try {
          const data = await src.fetch(range, { limit: opts.limit, applyLag: opts.applyLag, summaryOnly: false });
          const prevRange = prev
            ? src.key === "gsc" && data.effectiveRange
              ? previousRange(data.effectiveRange)
              : prev
            : null;
          const prevData = prevRange ? await src.fetch(prevRange, { summaryOnly: true, applyLag: false }) : null;
          return { name: src.name, key: src.key, data, prev: prevData };
        } catch (e) {
          return { name: src.name, key: src.key, error: e.message || String(e) };
        }
      })
    );
    const value = { range, results, ...buildReport(results, range, this.settings, opts) };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async insertAtCursor(editor, rangeSpec) {
    const notice = new Notice("Traffic Recap: fetching…", 0);
    try {
      const rep = await this.collect(rangeSpec);
      editor.replaceSelection(rep.markdown);
      this.reportErrors(rep.results);
    } catch (e) {
      new Notice(`Traffic Recap: ${e.message || e}`, 8000);
    } finally {
      notice.hide();
    }
  }

  reportErrors(results) {
    const errs = results.filter((r) => r.error);
    if (errs.length) new Notice(`Traffic Recap: ${errs.map((r) => r.error).join("\n")}`, 10000);
  }

  dailyNoteSettings() {
    const dn = this.app?.internalPlugins?.getPluginById?.("daily-notes");
    if (dn && dn.enabled && dn.instance && dn.instance.options) {
      const opts = dn.instance.options;
      return { folder: (opts.folder || "").replace(/^\/+|\/+$/g, ""), format: opts.format || "YYYY-MM-DD" };
    }
    const pn = this.app?.plugins?.getPlugin?.("periodic-notes");
    if (pn && pn.settings && pn.settings.daily && pn.settings.daily.enabled) {
      const opts = pn.settings.daily;
      return { folder: (opts.folder || "").replace(/^\/+|\/+$/g, ""), format: opts.format || "YYYY-MM-DD" };
    }
    return { folder: "", format: "YYYY-MM-DD" };
  }

  dailyNoteDate(file) {
    if (!file || file.extension !== "md") return null;
    const { folder, format } = this.dailyNoteSettings();
    if (folder && !file.path.startsWith(folder + "/")) return null;
    const rel = folder ? file.path.slice(folder.length + 1, -3) : file.path.slice(0, -3);
    const m = obsidian.moment(rel, format, true);
    if (m.isValid()) return m.toDate();
    const m2 = obsidian.moment(file.basename, format, true);
    return m2.isValid() ? m2.toDate() : null;
  }

  async updateDailyNote(file, date, interactive) {
    const notice = interactive ? new Notice("Traffic Recap: fetching…", 0) : null;
    try {
      const heading = (this.settings.heading || "## Traffic").trim();
      if (!interactive) {
        const existing = await this.app.vault.read(file);
        if (sectionHasContent(existing, heading)) return;
      }
      const day = ymd(addDays(date, -1));
      const rep = await this.collect(day, { force: interactive, headingLevel: headingLevel(heading), applyLag: true });
      const block = `${heading}\n${rep.markdown}`;
      await this.app.vault.process(file, (data) => replaceSection(data, heading, block));
      if (this.settings.writeProperties && !this.settings.demoMode && rep.results.some((r) => !r.error)) {
        if (rep.partial) {
          new Notice("Traffic Recap: skipped updating note properties because one source failed (partial data).", 8000);
        } else {
          await this.app.fileManager.processFrontMatter(file, (fm) => applyFrontMatter(fm, rep));
        }
      }
      this.reportErrors(rep.results);
      if (interactive) new Notice("Traffic Recap: daily note updated");
    } catch (e) {
      new Notice(`Traffic Recap: ${e.message || e}`, 8000);
    } finally {
      if (notice) notice.hide();
    }
  }

  async renderBlock(src, el, ctx) {
    const opts = {};
    for (const line of src.split("\n")) {
      const m = /^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
      if (m) opts[m[1].toLowerCase()] = m[2];
    }
    const child = new MarkdownRenderChild(el);
    ctx.addChild(child);
    el.addClass("traffic-recap-block");

    let seq = 0;
    let unloaded = false;
    let lastMarkdown = "";

    const draw = async (force) => {
      if (unloaded) return;
      const mySeq = ++seq;
      el.empty();
      const bar = el.createDiv({ cls: "traffic-recap-bar" });
      bar.createSpan({ cls: "traffic-recap-title", text: "Traffic Recap" });
      const actions = bar.createDiv({ cls: "traffic-recap-actions" });
      const copyBtn = actions.createEl("button", { cls: "traffic-recap-copy", text: "Copy" });
      copyBtn.disabled = true;
      copyBtn.addEventListener("click", async () => {
        if (!lastMarkdown) return;
        try {
          await navigator.clipboard.writeText(lastMarkdown);
          new Notice("Traffic Recap: report copied to clipboard");
        } catch (e) {
          new Notice("Traffic Recap: could not copy to clipboard");
        }
      });
      const btn = actions.createEl("button", { cls: "traffic-recap-refresh", text: "Refresh" });
      btn.addEventListener("click", () => draw(true));
      const body = el.createDiv({ cls: "traffic-recap-body" });
      body.createDiv({ cls: "traffic-recap-loading", text: "Loading…" });
      try {
        const rep = await this.collect(opts.range || "last_7d", {
          source: opts.source || "all",
          filter: opts.filter,
          limit: opts.limit !== undefined ? num(opts.limit) : undefined,
          compare: opts.compare === undefined ? undefined : !/^(false|no|off|0)$/i.test(opts.compare),
          force,
        });
        if (unloaded || mySeq !== seq) return;
        lastMarkdown = rep.markdown;
        copyBtn.disabled = false;
        body.empty();
        await MarkdownRenderer.render(this.app, rep.markdown, body, ctx.sourcePath, child);
      } catch (e) {
        if (unloaded || mySeq !== seq) return;
        body.empty();
        body.createDiv({ cls: "traffic-recap-error", text: e.message || String(e) });
      }
    };
    this.blocks.add(draw);
    child.onunload = () => {
      unloaded = true;
      this.blocks.delete(draw);
    };
    draw(false);
  }

  async testSource(which, button) {
    const map = { ga4: this.ga4, gsc: this.gsc, plausible: this.plausible, posthog: this.posthog };
    const src = map[which];
    if (this.settings.demoMode) {
      new Notice(`Traffic Recap: demo mode is on. Turn it off to test your real ${src.name} account.`, 8000);
      return;
    }
    if (this.testing) return;
    this.testing = true;
    if (button) button.setDisabled(true);
    const notice = new Notice(`Traffic Recap: testing ${src.name}…`, 0);
    try {
      const d = await src.fetch(resolveRange("last_7d"), { summaryOnly: false });
      const detail =
        d.kind === "search"
          ? `${fmtInt(d.clicks)} clicks, ${fmtInt(d.impressions)} impressions`
          : `${fmtInt(d.visitors)} visitors, ${fmtInt(d.pageviews)} pageviews`;
      new Notice(`${src.name}: connected ✓ (${detail} in the last 7 days)`, 8000);
    } catch (e) {
      new Notice(e.message || String(e), 10000);
    } finally {
      notice.hide();
      this.testing = false;
      if (button) button.setDisabled(false);
    }
  }
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

class RangeModal extends SuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Choose a period, or type YYYY-MM-DD..YYYY-MM-DD");
  }
  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    const list = RANGE_CHOICES.filter((r) => !q || r.label.toLowerCase().includes(q) || r.id.includes(q));
    if (q && !list.length) {
      try {
        const r = resolveRange(q);
        return [{ id: q, label: `Custom: ${r.label}` }];
      } catch (e) {
        return [];
      }
    }
    return list;
  }
  renderSuggestion(item, el) {
    el.createDiv({ text: item.label });
  }
  onChooseSuggestion(item) {
    this.onChoose(item.id);
  }
}

class TrafficRecapSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hasSecretStorage() {
    return !!(
      this.app?.secretStorage &&
      obsidian.SecretComponent &&
      typeof Setting.prototype?.addComponent === "function"
    );
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const saveNow = async () => this.plugin.saveSettings();
    const saveDebounced = () => this.plugin.scheduleSaveSettings();
    containerEl.empty();

    const intro = containerEl.createDiv({ cls: "setting-item-description traffic-recap-intro" });
    intro.appendText("⭐ Enjoying Traffic Recap? A star on ");
    intro.createEl("a", { text: "GitHub", href: "https://github.com/chi-li-peppers/obsidian-traffic-recap" });
    intro.appendText(" helps others find it. Found a bug or have an idea? ");
    intro.createEl("a", { text: "Open an issue", href: "https://github.com/chi-li-peppers/obsidian-traffic-recap/issues" });
    intro.appendText(".");

    const text = (setting, key, placeholder, secret) =>
      setting.addText((t) => {
        t.setPlaceholder(placeholder || "").setValue(String(s[key] ?? ""));
        if (secret) t.inputEl.type = "password";
        t.onChange((v) => {
          s[key] = v;
          saveDebounced();
        });
      });

    const secretField = (setting, secretIdKey, plainKey, suggestedId) => {
      const canUseSecrets = this.hasSecretStorage();
      const hasLegacyPlain = !!(s[plainKey] && !s[secretIdKey]);
      if (canUseSecrets && !hasLegacyPlain) {
        setting.addComponent((el) =>
          new obsidian.SecretComponent(this.app, el)
            .setValue(String(s[secretIdKey] || ""))
            .onChange(async (v) => {
              s[secretIdKey] = v;
              if (v) s[plainKey] = "";
              await saveNow();
            })
        );
        return;
      }
      text(setting, plainKey, "", true);
      if (canUseSecrets && hasLegacyPlain && typeof this.app.secretStorage.setSecret === "function") {
        setting.addButton((b) =>
          b.setButtonText("Move to Secrets").onClick(async () => {
            this.app.secretStorage.setSecret(suggestedId, String(s[plainKey]).trim());
            s[secretIdKey] = suggestedId;
            s[plainKey] = "";
            await saveNow();
            new Notice(`Traffic Recap: moved to Obsidian Secret Storage (${suggestedId})`);
            this.display();
          })
        );
      }
    };

    new Setting(containerEl)
      .setName("Demo mode")
      .setDesc("On: reports show generated sample data. Off: reports use your connected sources below.")
      .addToggle((t) =>
        t.setValue(s.demoMode === true).onChange(async (v) => {
          s.demoMode = v === true;
          await saveNow();
          new Notice(`Traffic Recap: demo mode ${s.demoMode ? "on" : "off"}`);
        })
      );

    new Setting(containerEl)
      .setName("Rows per table")
      .setDesc("Maximum top pages or search queries shown per source.")
      .addText((t) =>
        t.setValue(String(s.maxRows)).onChange((v) => {
          s.maxRows = Math.max(1, Math.floor(num(v)) || 10);
          saveDebounced();
        })
      );

    new Setting(containerEl)
      .setName("Compare with previous period")
      .setDesc("Show ▲/▼ changes against the period of the same length just before.")
      .addToggle((t) => t.setValue(s.compare).onChange(async (v) => ((s.compare = v), await saveNow())));

    new Setting(containerEl).setName("Daily notes").setHeading();

    new Setting(containerEl)
      .setName("Add report to new daily notes")
      .setDesc("When today's daily note is created, add yesterday's traffic automatically. Works with core Daily notes and Periodic Notes.")
      .addToggle((t) => t.setValue(s.autoDailyNote).onChange(async (v) => ((s.autoDailyNote = v), await saveNow())));

    text(new Setting(containerEl).setName("Section heading").setDesc("The report goes under this heading. If it already exists, it is replaced."), "heading", "## Traffic");

    new Setting(containerEl)
      .setName("Save totals as note properties")
      .setDesc("Writes traffic_visitors, traffic_sessions, traffic_pageviews, traffic_bounce_rate, traffic_gsc_clicks, traffic_gsc_impressions, traffic_gsc_ctr and traffic_gsc_position.")
      .addToggle((t) => t.setValue(s.writeProperties).onChange(async (v) => ((s.writeProperties = v), await saveNow())));

    /* Google OAuth shared section */
    new Setting(containerEl).setName("Google Analytics 4 & Search Console").setHeading();

    new Setting(containerEl).setName("Enable Google Analytics 4").addToggle((t) =>
      t.setValue(s.ga4Enabled).onChange(async (v) => {
        s.ga4Enabled = v;
        await saveNow();
        this.display();
      })
    );
    if (s.ga4Enabled) {
      text(new Setting(containerEl).setName("GA4 property ID").setDesc("Numeric property ID from GA4 Admin → Property settings."), "ga4PropertyId", "123456789");
      new Setting(containerEl).addButton((b) => b.setButtonText("Test GA4").onClick(() => this.plugin.testSource("ga4", b)));
    }

    new Setting(containerEl).setName("Enable Google Search Console").addToggle((t) =>
      t.setValue(s.gscEnabled).onChange(async (v) => {
        s.gscEnabled = v;
        await saveNow();
        this.display();
      })
    );
    if (s.gscEnabled) {
      text(new Setting(containerEl).setName("Site URL").setDesc("Exact property URL in Search Console, e.g. https://example.com/ or sc-domain:example.com."), "gscSiteUrl", "sc-domain:example.com");
      new Setting(containerEl)
        .setName("Search Console lag days")
        .setDesc("Optional offset for daily notes (Search Console data can lag 1–2 days). Leave 0 to use yesterday.")
        .addText((t) =>
          t.setValue(String(s.gscLagDays || 0)).onChange((v) => {
            s.gscLagDays = Math.max(0, Math.floor(num(v)));
            saveDebounced();
          })
        );
      new Setting(containerEl).addButton((b) => b.setButtonText("Test Search Console").onClick(() => this.plugin.testSource("gsc", b)));
    }

    if (s.ga4Enabled || s.gscEnabled) {
      text(new Setting(containerEl).setName("Google OAuth client ID").setDesc("Desktop app OAuth client from Google Cloud Console."), "googleClientId", "….apps.googleusercontent.com");
      secretField(new Setting(containerEl).setName("Google OAuth client secret"), "googleClientSecretSecret", "googleClientSecret", "traffic-recap-google-secret");
      secretField(
        new Setting(containerEl).setName("Google OAuth refresh token").setDesc("Authorise analytics.readonly and/or webmasters.readonly scopes."),
        "googleRefreshTokenSecret",
        "googleRefreshToken",
        "traffic-recap-google-refresh"
      );
    }

    /* Plausible */
    new Setting(containerEl).setName("Plausible Analytics").setHeading();
    new Setting(containerEl).setName("Enable Plausible").addToggle((t) =>
      t.setValue(s.plausibleEnabled).onChange(async (v) => {
        s.plausibleEnabled = v;
        await saveNow();
        this.display();
      })
    );
    if (s.plausibleEnabled) {
      text(new Setting(containerEl).setName("Site domain"), "plausibleSiteId", "example.com");
      secretField(new Setting(containerEl).setName("Stats API key"), "plausibleApiKeySecret", "plausibleApiKey", "traffic-recap-plausible-key");
      text(new Setting(containerEl).setName("Base URL").setDesc("Default https://plausible.io, or your self-hosted https:// URL."), "plausibleBaseUrl", "https://plausible.io");
      new Setting(containerEl).addButton((b) => b.setButtonText("Test Plausible").onClick(() => this.plugin.testSource("plausible", b)));
    }

    /* PostHog */
    new Setting(containerEl).setName("PostHog").setHeading();
    new Setting(containerEl).setName("Enable PostHog").addToggle((t) =>
      t.setValue(s.posthogEnabled).onChange(async (v) => {
        s.posthogEnabled = v;
        await saveNow();
        this.display();
      })
    );
    if (s.posthogEnabled) {
      text(new Setting(containerEl).setName("Project ID"), "posthogProjectId", "12345");
      secretField(new Setting(containerEl).setName("Personal API key").setDesc("Needs query:read scope."), "posthogApiKeySecret", "posthogApiKey", "traffic-recap-posthog-key");
      text(new Setting(containerEl).setName("Host").setDesc("https://us.posthog.com, https://eu.posthog.com or self-hosted https:// URL."), "posthogHost", "https://us.posthog.com");
      new Setting(containerEl).addButton((b) => b.setButtonText("Test PostHog").onClick(() => this.plugin.testSource("posthog", b)));
    }

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: this.hasSecretStorage()
        ? "API keys stored in Obsidian Secret Storage are kept out of data.json so they are not synced with your vault files."
        : "API keys are stored in this vault's plugin data file. If your vault is synced or shared, the keys go with it.",
    });
  }
}

module.exports = TrafficRecapPlugin;
module.exports.default = TrafficRecapPlugin;
module.exports._internals = {
  toBool,
  resolveRange,
  previousRange,
  shiftRange,
  posDelta,
  fmtDuration,
  buildReport,
  replaceSection,
  sectionHasContent,
  applyFrontMatter,
  GoogleOAuth,
  GA4Source,
  GSCSource,
  PlausibleSource,
  PostHogSource,
  DemoSource,
};
