// ── ghtrack — Core Application Logic ────────────────────────────────────
// Numbers: one GitHub count search each (exact, ~1-2s for any account size).
// List: the person's whole history is loaded 100 items per request, split into
// 5 non-overlapping relationship buckets, and saved in IndexedDB — so filters
// and pages are instant and revisits only fetch what changed. No token, no login.
(() => {
  "use strict";

  const IS_LOCAL = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const GITHUB_API = "https://api.github.com";
  const API_PER_PAGE = 100;       // GitHub maximum per search request
  const FEED_PAGE_SIZE = 50;      // rows per visible page
  const SEARCH_WINDOW = 1000;     // GitHub returns at most 1,000 results per query
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const HARVEST_CAP = 5000;       // max items pulled in the background for charts
  const DAY_MS = 24 * 60 * 60 * 1000;

  let apiBase = GITHUB_API;       // switches to /api/gh when served by server.js
  let localProxy = false;

  // ── Response cache (memory + IndexedDB, 10 minutes) ─────────────────
  const DB_NAME = "ghtrack_cache_db";
  const DB_VERSION = 6;           // v6: response cache + saved lifetime list per person
  const STORE = "responses";
  const SNAP_STORE = "snapshots";
  let dbPromise = null;
  const memCache = new Map();

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
            db.createObjectStore(STORE, { keyPath: "key" });
            db.createObjectStore(SNAP_STORE, { keyPath: "login" });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return dbPromise;
  }

  async function cacheGet(key) {
    const hit = memCache.get(key);
    if (hit) return Date.now() - hit.savedAt < CACHE_TTL_MS ? hit.data : null;
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
        req.onsuccess = () => {
          const rec = req.result;
          if (rec && Date.now() - rec.savedAt < CACHE_TTL_MS) {
            memCache.set(key, rec);
            resolve(rec.data);
          } else resolve(null);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function cacheSet(key, data) {
    const rec = { key, data, savedAt: Date.now() };
    memCache.set(key, rec);
    const db = await openDB();
    if (!db) return;
    try {
      db.transaction(STORE, "readwrite").objectStore(STORE).put(rec);
    } catch {
      /* storage full or unavailable: memory cache still works */
    }
  }

  async function cacheClear() {
    memCache.clear();
    const db = await openDB();
    if (!db) return;
    try {
      db.transaction(STORE, "readwrite").objectStore(STORE).clear();
      db.transaction(SNAP_STORE, "readwrite").objectStore(SNAP_STORE).clear();
    } catch {
      /* ignore */
    }
  }

  async function cachePrune() {
    const db = await openDB();
    if (!db) return;
    try {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (Date.now() - cursor.value.savedAt > CACHE_TTL_MS) cursor.delete();
        cursor.continue();
      };
    } catch {
      /* ignore */
    }
  }

  // ── Request scheduler: respects GitHub's limits exactly ─────────────
  // search: 10/min without login (30/min via local proxy). core: 60/hour.
  // Priority 0 = what the user is looking at, 1 = numbers, 2 = background charts.
  const limits = {
    search: { remaining: null, reset: 0, active: 0, max: 4, queue: [], timer: null },
    core: { remaining: null, reset: 0, active: 0, max: 4, queue: [], timer: null },
  };
  const inflight = new Map();
  let jobSeq = 0;

  class ApiError extends Error {
    constructor(message, status, extra = {}) {
      super(message);
      this.status = status;
      Object.assign(this, extra);
    }
  }

  function apiGet(path, opts = {}) {
    const { bucket = "search", priority = 1, html = false, isStale = null } = opts;
    const key = `${html ? "h:" : ""}${path}`;
    const existing = inflight.get(key);
    if (existing) {
      // Same request already queued: raise its priority if this caller is more urgent
      const queued = limits[bucket].queue.find((j) => j.key === key);
      if (queued && priority < queued.priority) {
        queued.priority = priority;
        queued.isStale = isStale;
      }
      return existing;
    }
    const promise = (async () => {
      const cached = await cacheGet(key);
      if (cached) return cached;
      return new Promise((resolve, reject) => {
        limits[bucket].queue.push({ path, key, html, priority, isStale, resolve, reject, bucket, seq: ++jobSeq });
        pump(bucket);
      });
    })();
    inflight.set(key, promise);
    promise.then(
      () => inflight.delete(key),
      () => inflight.delete(key)
    );
    return promise;
  }

  function isBlocked(L, job, now) {
    if (L.remaining === null || now >= L.reset) {
      // Unknown budget: let background work wait until a response tells us
      return job.priority >= 2 && L.active > 0;
    }
    return L.remaining <= 0; // filters run in the browser, so the whole budget can load data
  }

  function pump(bucket) {
    const L = limits[bucket];
    L.queue = L.queue.filter((j) => {
      if (j.isStale && j.isStale()) {
        j.reject(new ApiError("cancelled", 0, { cancelled: true }));
        return false;
      }
      return true;
    });
    L.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);

    while (L.active < L.max && L.queue.length) {
      const now = Date.now();
      if (L.remaining !== null && now >= L.reset) L.remaining = null; // window refreshed
      const job = L.queue[0];
      if (isBlocked(L, job, now)) {
        if (bucket === "core") {
          // core limit is per hour: fail fast instead of waiting
          for (const j of L.queue.splice(0)) {
            j.reject(new ApiError("rate limited", 403, { rateLimited: true, resetAt: L.reset }));
          }
          break;
        }
        if (L.remaining === null || now >= L.reset) break; // resumes when the active request finishes
        if (!L.timer) {
          L.timer = setTimeout(() => {
            L.timer = null;
            pump(bucket);
          }, Math.max(250, L.reset - now + 300));
        }
        break;
      }
      L.queue.shift();
      if (L.remaining !== null) L.remaining--;
      L.active++;
      runJob(job);
    }
  }

  function isRateLimitedResponse(res, data) {
    if (res.status === 429) return true;
    if (res.status !== 403) return false;
    return res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(data?.message || "");
  }

  async function runJob(job) {
    const L = limits[job.bucket];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(apiBase + job.path, {
        headers: { Accept: job.html ? "application/vnd.github.html+json" : "application/vnd.github+json" },
        signal: controller.signal,
      });
      const rem = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      if (rem !== null && reset) {
        const resetMs = Number(reset) * 1000;
        // Responses arrive out of order: within one window, trust the lowest count
        if (resetMs === L.reset && L.remaining !== null) L.remaining = Math.min(L.remaining, Number(rem));
        else if (resetMs >= L.reset) {
          L.remaining = Number(rem);
          L.reset = resetMs;
        }
      }
      const data = await res.json().catch(() => null);

      if (res.ok) {
        cacheSet(job.key, data);
        job.resolve(data);
      } else if (isRateLimitedResponse(res, data)) {
        L.remaining = 0;
        const retryAfter = Number(res.headers.get("retry-after"));
        if (retryAfter > 0) L.reset = Math.max(L.reset, Date.now() + retryAfter * 1000);
        if (!L.reset || L.reset < Date.now()) L.reset = Date.now() + 60 * 1000;
        if (job.bucket === "core") {
          job.reject(new ApiError("rate limited", res.status, { rateLimited: true, resetAt: L.reset }));
        } else {
          L.queue.push(job); // retried automatically once the window resets
        }
      } else if (res.status >= 500 && (job.attempts || 0) < 2) {
        // GitHub search occasionally times out on very large accounts: retry
        job.attempts = (job.attempts || 0) + 1;
        setTimeout(() => {
          L.queue.push(job);
          pump(job.bucket);
        }, 800 * job.attempts);
      } else {
        job.reject(new ApiError(data?.message || `GitHub error ${res.status}`, res.status, { errors: data?.errors }));
      }
    } catch {
      if ((job.attempts || 0) < 2 && navigator.onLine !== false) {
        job.attempts = (job.attempts || 0) + 1;
        setTimeout(() => {
          L.queue.push(job);
          pump(job.bucket);
        }, 800 * job.attempts);
      } else {
        job.reject(new ApiError(navigator.onLine === false ? "You appear to be offline" : "Could not reach GitHub", 0));
      }
    } finally {
      clearTimeout(timeout);
      L.active--;
      pump(job.bucket);
    }
  }

  // ── Search query builder ────────────────────────────────────────────
  // Every item belongs to exactly ONE relationship bucket: its strongest link.
  const REL_ORDER = ["created", "assigned", "reviewed", "commented", "other"];
  const REL_LABEL = {
    created: "Created",
    assigned: "Assigned",
    reviewed: "Reviewed",
    commented: "Commented",
    other: "Mentioned & other",
    mentioned: "Mentioned",
  };
  const REL_HINT = {
    created: "Opened by them",
    assigned: "Assigned to them (opened by someone else)",
    reviewed: "Pull requests they reviewed",
    commented: "Threads they commented on",
    other: "Only @-mentioned or linked some other way — no direct work",
    mentioned: "@-mentioned in it",
  };
  const ROLE_QUAL = { created: "author", assigned: "assignee", reviewed: "reviewed-by", commented: "commenter" };
  const WORK_SET = ["created", "assigned", "reviewed", "commented"];

  function bucketExpr(rel, u) {
    const stronger = REL_ORDER.slice(0, REL_ORDER.indexOf(rel))
      .filter((r) => ROLE_QUAL[r])
      .map((r) => `-${ROLE_QUAL[r]}:${u}`);
    const base = rel === "other" ? `involves:${u}` : `${ROLE_QUAL[rel]}:${u}`;
    return [base, ...stronger].join(" ");
  }

  function relSetExpr(set, u) {
    const sel = REL_ORDER.filter((r) => set.has(r));
    if (sel.length === REL_ORDER.length) return `involves:${u}`;
    // A prefix of the strength order (e.g. "My work") is simply "has any of these roles"
    const isPrefix = !sel.includes("other") && sel.every((r, i) => r === REL_ORDER[i]);
    if (isPrefix) {
      return sel.length === 1 ? `${ROLE_QUAL[sel[0]]}:${u}` : `(${sel.map((r) => `${ROLE_QUAL[r]}:${u}`).join(" OR ")})`;
    }
    if (sel.length === 1) return `(${bucketExpr(sel[0], u)})`;
    return `(${sel.map((r) => `(${bucketExpr(r, u)})`).join(" OR ")})`;
  }

  function isoDay(d) {
    return d.toISOString().slice(0, 10);
  }

  function timeQualifier(time) {
    if (!time || time === "all") return "";
    const m = /^(\d+)d$/.exec(time);
    if (m) return `created:>=${isoDay(new Date(Date.now() - Number(m[1]) * DAY_MS))}`;
    const y = /^y(\d{4})$/.exec(time);
    if (y) return `created:${y[1]}-01-01..${y[1]}-12-31`;
    return "";
  }

  function typeQualifier(type) {
    return type === "pr" ? "is:pr" : type === "issue" ? "is:issue" : "";
  }

  function stateQualifier(type, st) {
    switch (st) {
      case "open":
        return "is:open";
      case "draft":
        return "is:pr is:open draft:true";
      case "merged":
        return "is:pr is:merged";
      case "not_planned":
        return 'is:issue reason:"not planned"';
      case "closed":
        // "-is:merged" silently drops issues, so build the query per type
        if (type === "pr") return "is:pr is:closed -is:merged";
        if (type === "issue") return "is:issue is:closed";
        return "((is:issue is:closed) OR (is:pr is:closed -is:merged))";
      default:
        return "";
    }
  }

  function cleanText(text) {
    return (text || "").replace(/[()"]/g, " ").replace(/#(\d+)/g, "$1").replace(/\s+/g, " ").trim();
  }

  function buildQuery(f, u, overrides = {}) {
    const o = { ...f, ...overrides };
    return [
      relSetExpr(o.rel, u),
      typeQualifier(o.type),
      stateQualifier(o.type, o.state),
      o.useTime === false ? "" : timeQualifier(o.time),
      o.repo && o.repo !== "all" ? `repo:${o.repo}` : "",
      cleanText(o.text),
    ]
      .filter(Boolean)
      .join(" ");
  }

  function searchPath(q, { perPage = API_PER_PAGE, page = 1, order = "desc" } = {}) {
    return `/search/issues?q=${encodeURIComponent(q)}&advanced_search=true&sort=updated&order=${order}&per_page=${perPage}&page=${page}`;
  }

  function countQuery(q, priority, isStale) {
    return apiGet(searchPath(q, { perPage: 1 }), { priority, isStale }).then((d) => d.total_count || 0);
  }

  // ── Normalization ───────────────────────────────────────────────────
  function normalize(raw) {
    if (!raw || !raw.html_url) return null;
    const isPR = Boolean(raw.pull_request);
    const m = raw.html_url.match(/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\//);
    const repo = m ? m[1] : (raw.repository_url || "").split("/repos/")[1] || "unknown/repo";

    let status = "open";
    let statusLabel = "Open";
    if (isPR) {
      if (raw.pull_request.merged_at) [status, statusLabel] = ["merged", "Merged"];
      else if (raw.state === "closed") [status, statusLabel] = ["closed", "Closed"];
      else if (raw.draft) [status, statusLabel] = ["draft", "Draft"];
    } else if (raw.state === "closed") {
      if (raw.state_reason === "not_planned") [status, statusLabel] = ["not-planned", "Not planned"];
      else if (raw.state_reason === "duplicate") [status, statusLabel] = ["not-planned", "Duplicate"];
      else [status, statusLabel] = ["closed", "Closed"];
    }

    return {
      id: raw.html_url,
      kind: isPR ? "pr" : "issue",
      number: raw.number,
      title: (raw.title || "").trim(),
      url: raw.html_url,
      repo,
      author: raw.user?.login || "ghost",
      authorAvatar: raw.user?.avatar_url || "",
      assignees: (raw.assignees || []).map((a) => (a.login || "").toLowerCase()),
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      closedAt: raw.closed_at,
      mergedAt: raw.pull_request?.merged_at || null,
      status,
      statusLabel,
      commentsCount: raw.comments || 0,
      reactions: raw.reactions?.total_count || 0,
      labels: (raw.labels || []).map((l) => ({ name: l.name, color: l.color })),
      body: (raw.body || "").slice(0, 20000),
    };
  }

  // ── Saved lifetime list per person (IndexedDB) ──────────────────────
  // Revisits show the saved list instantly; only new activity is fetched.
  async function loadSnapshot(login) {
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(SNAP_STORE, "readonly").objectStore(SNAP_STORE).get(login.toLowerCase());
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function saveSnapshot() {
    if (!state.login || !state.itemsMap.size) return;
    const db = await openDB();
    if (!db) return;
    const items = Array.from(state.itemsMap.values()).map(({ body, ...rest }) => rest);
    const rec = { login: state.login.toLowerCase(), items, syncedAt: state.syncStartedAt, savedAt: Date.now(), scopes: state.scopes || null };
    try {
      db.transaction(SNAP_STORE, "readwrite").objectStore(SNAP_STORE).put(rec);
    } catch {
      /* storage full: the list still works for this visit */
    }
  }

  let snapshotTimer = null;
  function scheduleSnapshot() {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(saveSnapshot, 2000);
  }

  // ── Bucket harvester: one GitHub search per 100 items ───────────────
  // The 5 relationship buckets split a person's involvement with no overlap,
  // so loading them gives every item exactly once, already labelled.
  // "Created" is loaded as two lists (PRs, issues) so both totals come free
  // scopes = [null] normally; for accounts hidden from GitHub search it is a
  // list of repository groups, and every bucket query runs inside each group.
  function makeHarvesters(login, scopes = [null]) {
    const list = [];
    for (const [order, make] of [
      [0, (pre, set) => new BucketHarvester("created", `${pre}author:${login} is:pr`, "pr", set)],
      [1, (pre, set) => new BucketHarvester("created", `${pre}author:${login} is:issue`, "issue", set)],
      ...REL_ORDER.slice(1).map((b, i) => [i + 2, (pre, set) => new BucketHarvester(b, `${pre}${bucketExpr(b, login)}`, null, set)]),
    ]) {
      void order;
      for (const scope of scopes) {
        const pre = scope ? `(${scope.map((r) => `repo:${r}`).join(" OR ")}) ` : "";
        list.push(make(pre, scope ? new Set(scope.map((r) => r.toLowerCase())) : null));
      }
    }
    return list;
  }

  class BucketHarvester {
    constructor(bucket, q, kind = null, scope = null) {
      this.bucket = bucket;
      this.kind = kind;
      this.scope = scope;
      this.q = q;
      this.extra = "";
      this.page = 0;
      this.total = null;
      this.done = false;
      this.lastBoundary = null;
    }

    async next(priority, isStale) {
      const page = this.page + 1;
      const q = this.extra ? `${this.q} ${this.extra}` : this.q;
      const data = await apiGet(searchPath(q, { page }), { priority, isStale });
      if (!this.extra && page === 1) this.total = data.total_count || 0;
      const raw = data.items || [];
      const items = raw.map(normalize).filter(Boolean);
      if (raw.length < API_PER_PAGE) {
        this.done = true;
      } else if (page * API_PER_PAGE >= SEARCH_WINDOW) {
        // GitHub stops at 1,000 results per query: continue from the oldest timestamp
        const boundary = raw[raw.length - 1].updated_at;
        if (boundary === this.lastBoundary) this.done = true;
        this.lastBoundary = boundary;
        this.extra = `updated:<=${boundary}`;
        this.page = 0;
      } else {
        this.page = page;
      }
      return items;
    }

    resumeBefore(updatedAt) {
      this.extra = `updated:<=${updatedAt}`;
      this.page = 0;
      this.lastBoundary = updatedAt;
    }
  }

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    login: "",
    profile: null,
    gen: 0,
    startedAt: 0,
    syncStartedAt: 0,
    itemsMap: new Map(),       // id -> item (item.bucket = how the person is linked)
    harvesters: [],
    counts: {},                // exact numbers from GitHub
    listReady: false,
    harvestDone: false,
    fromSnapshot: false,
    currentPage: 1,
    pageSize: (() => { try { return Math.min(1000, Math.max(5, Number(localStorage.getItem("ghtrack_pagesize")) || FEED_PAGE_SIZE)); } catch { return FEED_PAGE_SIZE; } })(),
    viewMode: "feed",
    dateRange: "30d",          // all | 1d | 7d | 30d | 90d | 1y | y2024 … (30 days loads first)
    heatYear: "recent",        // recent | 2024 …
    filters: { kind: "all", status: "all", role: "all", repo: "all", text: "" },
    expandedPreviews: new Set(),
    linkCache: new Map(),
    fatal: false,
  };

  // ── DOM References ──────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const dom = {
    searchForm: $("search-form"),
    searchInput: $("search-input"),
    inputClear: $("input-clear"),
    btnSearch: $("btn-search"),
    headerForm: $("header-search-form"),
    headerInput: $("header-search-input"),
    landing: $("landing"),

    profileAvatar: $("profile-avatar"),
    profileName: $("profile-name"),
    profileLogin: $("profile-login"),
    profileMeta: $("profile-meta"),
    sync: $("sync"),
    streamText: $("stream-text"),
    streamProgressFill: $("stream-progress-fill"),

    telemetryBar: $("telemetry-bar"),
    statTotal: $("stat-total"),
    statTotalSub: $("stat-total-sub"),
    ddPageSize: $("dd-pagesize"),
    statPrs: $("stat-prs"),
    statPrsSub: $("stat-prs-sub"),
    statIssues: $("stat-issues"),
    statIssuesSub: $("stat-issues-sub"),
    statReviews: $("stat-reviews"),
    statComments: $("stat-comments"),

    mainContent: $("main-content"),
    tabBtnFeed: $("tab-btn-feed"),
    tabBtnAnalytics: $("tab-btn-analytics"),
    feedView: $("feed-view"),
    analyticsView: $("analytics-view"),
    timeframeSeg: $("timeframe-seg"),
    timeframeSelect: $("timeframe-select"),
    yearSelect: $("year-select"),
    rangeNote: $("range-note"),

    ddKind: $("dd-kind"),
    ddStatus: $("dd-status"),
    ddRole: $("dd-role"),
    ddRepo: $("dd-repo"),
    filterText: $("filter-text"),
    clearFilters: $("clear-filters"),

    pagerCount: $("pager-count"),
    pagerPrev: $("pager-prev"),
    pagerNext: $("pager-next"),
    pageButtons: $("page-buttons"),
    bottomSummary: $("bottom-summary"),
    listContainer: $("list-container"),
    listEmpty: $("list-empty"),
    listLoading: $("list-loading"),

    anNote: $("an-note"),
    tiles: $("insight-tiles"),
    heatmapCalendar: $("heatmap-calendar"),
    heatmapSub: $("heatmap-sub"),
    heatmapYear: $("heatmap-year"),
    heatmapCountLabel: $("heatmap-count-label"),

  };

  // Small per-viewer preferences (chart types, theme). Never required.
  function prefGet(key, fallback) {
    try {
      const v = localStorage.getItem(`ghtrack_${key}`);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }
  function prefSet(key, value) {
    try {
      localStorage.setItem(`ghtrack_${key}`, value);
    } catch {
      /* private mode */
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────
  function fmt(n) {
    return typeof n === "number" ? n.toLocaleString("en-US") : "…";
  }

  function timeAgo(dateString) {
    if (!dateString) return "";
    const seconds = Math.floor((Date.now() - new Date(dateString)) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // GitHub's rendered HTML is already sanitized; this is defence in depth.
  function sanitizeHtml(html) {
    if (!html) return "";
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const root = doc.body.firstElementChild;
    if (!root) return "";
    root
      .querySelectorAll("script,style,iframe,frame,object,embed,form,button,textarea,select,link,meta,base,foreignObject")
      .forEach((n) => n.remove());
    root.querySelectorAll("input").forEach((n) => {
      if (n.type !== "checkbox") n.remove();
      else n.setAttribute("disabled", "");
    });
    root.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        const isUrlAttr = ["href", "src", "xlink:href", "action", "formaction", "srcset"].includes(name);
        if (name.startsWith("on") || name === "style" || (isUrlAttr && /^(javascript|vbscript|data:text)/.test(val))) {
          el.removeAttribute(attr.name);
        }
      }
      if (el.tagName === "A") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
      if (el.tagName === "IMG") el.setAttribute("loading", "lazy");
    });
    return root.innerHTML;
  }



  function countBy(items, keyFn) {
    const m = new Map();
    for (const i of items) {
      const k = keyFn(i);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  // Accepts "name", "@name", "github.com/name", "https://www.github.com/name/repo?tab=x"
  function parseLogin(text) {
    let t = (text || "").trim().replace(/^@/, "");
    t = t.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
    t = t.split(/[/?#\s]/)[0];
    return /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(t) ? t : "";
  }

  // ── Start tracking a person ─────────────────────────────────────────
  async function startTracking(username) {
    const login = parseLogin(username);
    if (!login) return;
    const gen = ++state.gen;
    const isStale = () => gen !== state.gen;

    for (const L of Object.values(limits)) {
      for (const j of L.queue.splice(0)) j.reject(new ApiError("cancelled", 0, { cancelled: true }));
    }
    flushSnapshotNow();

    Object.assign(state, {
      login,
      profile: null,
      startedAt: performance.now(),
      syncStartedAt: new Date().toISOString(),
      itemsMap: new Map(),
      harvesters: makeHarvesters(login),
      counts: {},
      listReady: false,
      harvestDone: false,
      fromSnapshot: false,
      scopes: null,
      dateRange: "30d",
      syncing: true,
      currentPage: 1,
    });
    state.expandedPreviews.clear();
    state.linkCache.clear();

    state.fatal = false;
    dom.searchInput.value = login;
    dom.headerInput.value = "";
    history.replaceState(null, "", `?name=${encodeURIComponent(login)}`);
    document.body.classList.add("is-tracking");
    window.scrollTo({ top: 0 });
    dom.telemetryBar.style.display = "";
    dom.listEmpty.style.display = "none";
    dom.listContainer.innerHTML = "";
    dom.listContainer.dataset.signature = "";
    dom.listLoading.style.display = "flex";
    dom.btnSearch.disabled = true;
    dom.profileName.textContent = login;
    dom.profileLogin.textContent = `@${login}`;
    dom.profileLogin.href = `https://github.com/${encodeURIComponent(login)}`;
    dom.profileMeta.textContent = "";
    dom.profileAvatar.src = `https://github.com/${encodeURIComponent(login)}.png?size=96`;
    document.title = `@${login} · ghtrack`;
    setBanner(`Fetching @${login} from GitHub…`, 5);
    renderOverview();
    renderAll();

    // Saved copy from an earlier visit: show it instantly, then refresh
    const snap = await loadSnapshot(login);
    if (isStale()) return;
    if (snap && Array.isArray(snap.items) && snap.items.length) {
      for (const it of snap.items) state.itemsMap.set(it.id, it);
      state.fromSnapshot = true;
      state.listReady = true;
      renderAll();
    }

    // Profile check runs alongside the searches (validates the name, gives join year)
    const profileP = apiGet(`/users/${encodeURIComponent(login)}`, { bucket: "core", priority: 0 });
    profileP
      .then((p) => {
        if (isStale()) return;
        if (p.type === "Organization") {
          showFatal(`@${p.login} is an organization. ghtrack tracks people — try one of its members.`);
          state.gen++;
          return;
        }
        state.profile = p;
        renderProfile();
        renderRangeControls();
      })
      .catch((err) => {
        if (isStale() || err.cancelled) return;
        if (err.status === 404) {
          showFatal(`No GitHub user named @${login} was found. Check the spelling.`);
          state.gen++;
        }
      });

    // Accounts hidden from search: reuse the repository groups found last time
    if (snap?.scopes?.length) {
      state.scopes = snap.scopes;
      state.harvesters = makeHarvesters(login, snap.scopes);
    }

    try {
      await runHarvest(gen, snap, isStale);
    } catch (err) {
      if (isStale() || err.cancelled) return;
      const hidden = err.status === 422 && (err.errors || []).some((e) => /cannot be searched/i.test(e.message || ""));
      if (hidden) {
        // GitHub hides this account from search, but repo-scoped searches still work
        const profile = await profileP.catch(() => null);
        if (isStale()) return;
        if (!profile) return showFatal(`No GitHub user named @${login} was found. Check the spelling.`);
        try {
          setBanner("This account is hidden from GitHub search · finding the repositories they work in…", 10);
          const repos = await discoverRepos(profile.login || login, isStale);
          if (isStale()) return;
          if (!repos.length) return showFatal(`GitHub hides @${login} from search and no public activity was found.`);
          state.scopes = chunkRepos(repos);
          state.harvesters = makeHarvesters(login, state.scopes);
          renderProfile();
          await runHarvest(gen, snap, isStale);
        } catch (err2) {
          if (isStale() || err2.cancelled) return;
          showFatal(`Could not load GitHub data: ${err2.message}`);
        }
      } else if (err.status === 422 && !state.itemsMap.size) {
        showFatal(`No GitHub user named @${login} was found. Check the spelling.`);
      } else if (!state.itemsMap.size) {
        showFatal(`Could not load GitHub data: ${err.message}`);
      } else {
        state.harvestError = err.message;
        renderAll();
      }
    } finally {
      if (!isStale()) {
        dom.btnSearch.disabled = false;
        dom.btnSearch.textContent = "Track";
      }
    }
  }

  async function runHarvest(gen, snap, isStale) {
    // 1. First 100 of every bucket: the newest list + exact bucket totals
    state.syncing = true;
    await Promise.all(state.harvesters.map((h) => firstPages(h, snap, isStale)));
    if (isStale()) return;
    state.syncing = false;
    state.listReady = true;
    dom.btnSearch.disabled = false;
    dom.btnSearch.textContent = "Track";
    deriveCreatedCounts();
    loadExtraCounts(gen);
    renderAll();

    // 2. Everything else, 100 at a time, strongest link first
    for (const h of state.harvesters) {
      while (!h.done && bucketLoaded(h) < (h.total || 0)) {
        const items = await h.next(3, isStale);
        if (isStale()) return;
        mergeItems(items, h.bucket);
      }
    }
    state.harvestDone = true;
    deriveCreatedCounts();
    flushSnapshotNow();
    renderAll();
  }

  // Find repositories a search-hidden account works in, from public sources:
  // their activity feed, a plain-text search for their name, their own repos,
  // and the upstream repos of their most recent forks.
  async function discoverRepos(login, isStale) {
    const found = new Map();
    const add = (name, weight) => {
      if (!name || !/^[\w.-]+\/[\w.-]+$/.test(name)) return;
      const k = name.toLowerCase();
      found.set(k, { name, w: (found.get(k)?.w || 0) + weight });
    };
    const u = encodeURIComponent(login);
    const core = (path) => apiGet(path, { bucket: "core", priority: 0 }).catch(() => null);

    const [events1, owned] = await Promise.all([core(`/users/${u}/events/public?per_page=100&page=1`), core(`/users/${u}/repos?type=owner&sort=pushed&per_page=100`)]);
    let events = events1 || [];
    if (events.length === 100) {
      for (const p of [2, 3]) {
        const more = await core(`/users/${u}/events/public?per_page=100&page=${p}`);
        if (!more?.length) break;
        events = events.concat(more);
        if (more.length < 100) break;
      }
    }
    for (const e of events) add(e.repo?.name, 3);
    if (isStale()) return [];

    // Plain-text search (no user qualifier) finds threads that mention them
    for (let page = 1; page <= 3; page++) {
      const data = await apiGet(searchPath(login, { page }), { priority: 0, isStale }).catch(() => null);
      const items = data?.items || [];
      for (const it of items) add((it.repository_url || "").split("/repos/")[1], 1);
      if (items.length < API_PER_PAGE) break;
    }
    if (isStale()) return [];

    const repos = owned || [];
    for (const r of repos) if (!r.fork && (r.open_issues_count > 0 || r.forks_count > 0 || r.stargazers_count > 0)) add(r.full_name, 2);
    const forks = repos.filter((r) => r.fork).slice(0, 10);
    const parents = await Promise.all(forks.map((r) => core(`/repos/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}`)));
    for (const p of parents) add(p?.parent?.full_name, 3);

    return Array.from(found.values())
      .filter((r) => !r.name.toLowerCase().startsWith(`${login.toLowerCase()}/`) || repos.some((o) => !o.fork && o.full_name.toLowerCase() === r.name.toLowerCase()))
      .sort((a, b) => b.w - a.w)
      .slice(0, 160)
      .map((r) => r.name);
  }

  // Groups of repositories that fit in one GitHub query
  function chunkRepos(repos) {
    const chunks = [];
    let cur = [];
    let len = 0;
    for (const r of repos) {
      const add = r.length + 9;
      if (cur.length && (cur.length >= 40 || len + add > 1300)) {
        chunks.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(r);
      len += add;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  async function firstPages(h, snap, isStale) {
    let items = await h.next(0, isStale);
    if (isStale()) return;
    mergeItems(items, h.bucket);
    recomputeCounts();
    renderOverview();
    scheduleRender();
    if (!snap) return;
    // Catch up on everything updated since the saved copy
    while (!h.done && items.length && items[items.length - 1].updatedAt > snap.syncedAt) {
      items = await h.next(1, isStale);
      if (isStale()) return;
      mergeItems(items, h.bucket);
    }
    // Continue the full load from the oldest saved item in this bucket
    if (!h.done) {
      let oldest = null;
      for (const it of state.itemsMap.values()) if (inHarvester(it, h) && (!oldest || it.updatedAt < oldest)) oldest = it.updatedAt;
      if (oldest) h.resumeBefore(oldest);
    }
  }

  function inHarvester(it, h) {
    return it.bucket === h.bucket && (!h.kind || it.kind === h.kind) && (!h.scope || h.scope.has(it.repo.toLowerCase()));
  }

  // Totals = sum over every harvester of the same kind (one per repo group)
  function recomputeCounts() {
    const groups = new Map();
    for (const h of state.harvesters) {
      const key = h.kind === "pr" ? "prs" : h.kind === "issue" ? "issues" : h.bucket;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    }
    for (const [key, hs] of groups) {
      if (hs.every((h) => h.total !== null)) state.counts[key] = hs.reduce((n, h) => n + h.total, 0);
    }
    if (state.counts.prs !== undefined && state.counts.issues !== undefined) state.counts.created = state.counts.prs + state.counts.issues;
  }

  function bucketLoaded(h) {
    let n = 0;
    for (const it of state.itemsMap.values()) if (inHarvester(it, h)) n++;
    return n;
  }

  function mergeItems(items, bucket) {
    for (const it of items) {
      it.bucket = bucket;
      state.itemsMap.set(it.id, it);
    }
    scheduleSnapshot();
    scheduleRender();
  }

  function flushSnapshotNow() {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
      saveSnapshot();
    }
  }

  // When every item they created is loaded, PR/issue numbers need no extra search
  function deriveCreatedCounts() {
    const mine = Array.from(state.itemsMap.values()).filter((i) => i.bucket === "created");
    const allDone = (kind) => state.harvesters.filter((h) => h.kind === kind).every((h) => h.done);
    if (allDone("pr") || mine.filter((i) => i.kind === "pr").length >= (state.counts.prs ?? Infinity)) {
      state.counts.merged = mine.filter((i) => i.kind === "pr" && i.status === "merged").length;
    }
    if (allDone("issue") || mine.filter((i) => i.kind === "issue").length >= (state.counts.issues ?? Infinity)) {
      state.counts.openIssues = mine.filter((i) => i.kind === "issue" && i.status === "open").length;
    }
    renderOverview();
  }

  // Background counts that need their own search
  function loadExtraCounts(gen) {
    const u = state.login;
    const isStale = () => gen !== state.gen;
    const jobs = {};
    if (state.scopes) return; // account hidden from search: numbers come from the loaded list
    if (!state.harvesters[0].done) jobs.merged = [`author:${u} is:pr is:merged`, 2];
    if (!state.harvesters[1].done) jobs.openIssues = [`author:${u} is:issue is:open`, 2];
    for (const [key, [q, priority]] of Object.entries(jobs)) {
      countQuery(q, priority, isStale)
        .then((n) => {
          if (isStale()) return;
          state.counts[key] = n;
          renderOverview();
          renderBanner();
        })
        .catch(() => {});
    }
  }

  function showFatal(message) {
    state.fatal = true;
    setBanner(message, 0, "error");
    switchView("feed");
    dom.listLoading.style.display = "none";
    dom.listContainer.innerHTML = "";
    dom.listEmpty.style.display = "block";
    dom.listEmpty.querySelector("p").textContent = message;
    dom.telemetryBar.style.display = "none";
    dom.btnSearch.disabled = false;
    dom.btnSearch.textContent = "Track";
    updatePagerUI(0);
  }

  function renderProfile() {
    const p = state.profile;
    if (!p) return;
    const since = p.created_at ? new Date(p.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "";
    dom.profileAvatar.src = `${p.avatar_url}${p.avatar_url.includes("?") ? "&" : "?"}s=96`;
    dom.profileName.textContent = p.name || p.login;
    dom.profileLogin.textContent = `@${p.login}`;
    dom.profileLogin.href = p.html_url;
    const meta = [since && `Joined ${since}`, p.company, p.location, p.public_repos !== undefined && `${fmt(p.public_repos)} public repos`].filter(Boolean);
    dom.profileMeta.innerHTML = meta.map((m) => `<span>${escapeHtml(String(m))}</span>`).join("") +
      (state.scopes ? `<span class="hidden-note" title="GitHub hides this account from search, so ghtrack searched inside the ${fmt(state.scopes.flat().length)} repositories they are active in. Activity in other repositories may be missing.">Hidden from GitHub search · ${fmt(state.scopes.flat().length)} repositories scanned</span>` : "");
  }

  // ── Header numbers (exact, from GitHub counts) ──────────────────────
  function bucketTotalsKnown() {
    return REL_ORDER.every((b) => state.counts[b] !== undefined);
  }

  function lifetimeTotal() {
    return bucketTotalsKnown() ? REL_ORDER.reduce((s, b) => s + state.counts[b], 0) : undefined;
  }

  function renderOverview() {
    const range = typeof rangeBounds === "function" ? rangeBounds() : null;
    if (range || state.harvestDone) {
      // Same source as the list, so every number on the page agrees
      const items = getItemsForCurrentDateRange();
      const mine = items.filter((i) => i.bucket === "created");
      const prs = mine.filter((i) => i.kind === "pr");
      const issues = mine.filter((i) => i.kind === "issue");
      const merged = prs.filter((i) => i.status === "merged").length;
      const open = issues.filter((i) => i.status === "open").length;
      const when = range ? (range.year ? ` in ${range.year}` : ` · last ${range.label}`) : "";
      const partial = !loadedEverything() ? " (so far)" : "";
      dom.statTotal.textContent = fmt(items.length);
      dom.statTotalSub.textContent = `PRs & issues touched${when}${partial}`;
      dom.statPrs.textContent = fmt(prs.length);
      dom.statPrsSub.textContent = `${prs.length ? Math.round((merged / prs.length) * 100) : 0}% merged · ${fmt(merged)} merged`;
      dom.statIssues.textContent = fmt(issues.length);
      dom.statIssuesSub.textContent = `${fmt(open)} open · ${fmt(issues.length - open)} closed`;
      dom.statReviews.textContent = fmt(items.filter((i) => i.bucket === "reviewed").length);
      dom.statComments.textContent = fmt(items.filter((i) => i.bucket === "commented").length);
      return;
    }
    const c = state.counts;
    dom.statTotalSub.textContent = "PRs & issues touched";
    dom.statTotal.textContent = fmt(lifetimeTotal());
    dom.statPrs.textContent = fmt(c.prs);
    dom.statPrsSub.textContent = c.prs !== undefined && c.merged !== undefined ? `${c.prs ? Math.round((c.merged / c.prs) * 100) : 0}% merged · ${fmt(c.merged)} merged` : " ";
    const issues = c.issues;
    dom.statIssues.textContent = fmt(issues);
    dom.statIssuesSub.textContent = issues !== undefined && c.openIssues !== undefined ? `${fmt(c.openIssues)} open · ${fmt(issues - c.openIssues)} closed` : " ";
    dom.statReviews.textContent = fmt(c.reviewed);
    dom.statComments.textContent = fmt(c.commented);
  }

  // ── Status banner (no countdowns, no rate-limit talk) ───────────────
  function setBanner(text, pct, mode = "") {
    dom.streamText.textContent = text;
    dom.streamProgressFill.style.width = `${pct}%`;
    dom.sync.classList.toggle("done", mode === "done");
    dom.sync.classList.toggle("error", mode === "error");
  }

  function renderBanner() {
    if (!state.login || state.fatal) return;
    const total = lifetimeTotal();
    const loaded = state.itemsMap.size;
    if (state.syncing && state.fromSnapshot) return setBanner(`Saved copy · checking GitHub for updates (${fmt(loaded)} items ready to browse)`, 60);
    if (!state.listReady && loaded && !state.fromSnapshot) return setBanner(`Loading · ${fmt(loaded)} items so far`, 30);
    if (!state.listReady) return setBanner(state.fromSnapshot ? "Showing saved copy · checking GitHub for updates…" : `Fetching @${state.login} from GitHub…`, state.fromSnapshot ? 60 : 5);
    if (state.harvestDone || (total !== undefined && loaded >= total)) {
      return setBanner(`Up to date · ${fmt(loaded)} items`, 100, "done");
    }
    const pct = total ? Math.max(5, Math.min(99, Math.round((loaded / total) * 100))) : 10;
    setBanner(`Loading history · ${fmt(loaded)} of ${fmt(total)}`, pct);
  }

  // ── Time range ──────────────────────────────────────────────────────
  const RANGES = [
    ["all", "All time"],
    ["1d", "24 hours"],
    ["7d", "7 days"],
    ["30d", "30 days"],
    ["90d", "90 days"],
    ["1y", "12 months"],
  ];
  const RANGE_DAYS = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

  function rangeBounds() {
    const r = state.dateRange;
    if (RANGE_DAYS[r]) return { from: new Date(Date.now() - RANGE_DAYS[r] * DAY_MS), to: new Date(), label: RANGES.find((x) => x[0] === r)[1].toLowerCase() };
    const y = /^y(\d{4})$/.exec(r);
    if (y) return { from: new Date(Number(y[1]), 0, 1), to: new Date(Number(y[1]) + 1, 0, 1), year: Number(y[1]), label: y[1] };
    return null;
  }

  // An item is in range if it was opened or updated in that period
  function getItemsForCurrentDateRange() {
    const all = Array.from(state.itemsMap.values());
    const b = rangeBounds();
    if (!b) return all;
    const from = b.from.toISOString();
    const to = b.to.toISOString();
    return all.filter((i) => (i.createdAt >= from && i.createdAt < to) || (i.updatedAt >= from && i.updatedAt < to));
  }

  function yearsAvailable() {
    const nowYear = new Date().getFullYear();
    let from = state.profile?.created_at ? new Date(state.profile.created_at).getFullYear() : nowYear;
    for (const it of state.itemsMap.values()) {
      const y = Number(actAt(it).slice(0, 4));
      if (y && y < from) from = y;
    }
    const out = [];
    for (let y = nowYear; y >= from; y--) out.push(y);
    return out;
  }

  function setRange(value) {
    state.dateRange = value;
    onFiltersChanged();
  }

  function renderRangeControls() {
    const r = state.dateRange;
    dom.timeframeSeg.innerHTML = RANGES.map(([v, l]) => `<button type="button" data-range="${v}" aria-pressed="${r === v}">${l}</button>`).join("");
    const years = yearsAvailable();
    const isYear = /^y\d{4}$/.test(r);
    yearDd.set({
      options: years.map((y) => ({ value: `y${y}`, label: String(y) })),
      value: isYear ? r : null,
      placeholder: "Year",
    });
    rangeDd.set({
      options: [...RANGES.map(([v, l]) => ({ value: v, label: l })), { sep: true }, ...years.map((y) => ({ value: `y${y}`, label: String(y) }))],
      value: r,
    });
    const b = rangeBounds();
    dom.rangeNote.textContent = b ? `Showing items opened or updated in ${b.year ? b.year : `the last ${b.label}`}` : "";
  }

  dom.timeframeSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-range]");
    if (btn) setRange(btn.dataset.range);
  });

  // ── Dropdown component (accessible, keyboard friendly, searchable) ──
  const ICON_CHEVRON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>`;
  const ICON_CHECK = `<svg class="dd-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>`;
  const openDropdowns = new Set();

  function createDropdown(host, { label = "", searchable = false, alignRight = false, custom = null, onChange }) {
    const root = document.createElement("div");
    root.className = `dd${alignRight ? " align-right" : ""}${host.className ? ` ${host.className}` : ""}`;
    root.innerHTML = `<button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false">
        ${label ? `<span class="dd-k">${escapeHtml(label)}</span>` : ""}<span class="dd-v"></span>${ICON_CHEVRON}</button>
      <div class="dd-menu" role="listbox">${searchable ? `<input class="dd-search" type="text" placeholder="Search…" aria-label="Filter options" />` : ""}<div class="dd-list"></div>${custom ? `<form class="dd-custom"><input type="number" inputmode="numeric" min="${custom.min}" max="${custom.max}" placeholder="${escapeHtml(custom.placeholder)}" aria-label="${escapeHtml(custom.placeholder)}" /><button type="submit" class="btn btn-sm">Apply</button></form>` : ""}</div>`;
    host.replaceWith(root);
    root.id = host.id;
    const btn = root.querySelector(".dd-btn");
    const valEl = root.querySelector(".dd-v");
    const list = root.querySelector(".dd-list");
    const search = root.querySelector(".dd-search");
    let cfg = { options: [], value: null, placeholder: "", defaultValue: null };
    let kb = -1;

    function visibleOptions() {
      const q = (search?.value || "").toLowerCase().trim();
      return cfg.options.filter((o) => o.sep ? !q : !q || o.label.toLowerCase().includes(q));
    }
    function paintList() {
      const opts = visibleOptions();
      if (!opts.some((o) => !o.sep)) {
        list.innerHTML = `<div class="dd-empty">No matches</div>`;
        return;
      }
      list.innerHTML = opts
        .map((o, i) =>
          o.sep
            ? `<div class="dd-sep"></div>`
            : `<button type="button" class="dd-opt ${i === kb ? "kb" : ""}" role="option" data-i="${i}" aria-selected="${o.value === cfg.value}">
                ${ICON_CHECK}${o.dot ? `<span class="dd-dot" style="background:${o.dot}"></span>` : ""}<span class="dd-l">${escapeHtml(o.label)}</span>${o.count !== undefined ? `<span class="dd-c">${fmt(o.count)}</span>` : ""}</button>`
        )
        .join("");
    }
    function paintButton() {
      const cur = cfg.options.find((o) => !o.sep && o.value === cfg.value);
      valEl.textContent = cur ? cur.short || cur.label : cfg.placeholder || "Select";
      root.classList.toggle("active", cfg.defaultValue !== null && cfg.value !== cfg.defaultValue && cfg.value !== null);
    }
    function open() {
      for (const d of openDropdowns) d.close();
      root.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      openDropdowns.add(api);
      kb = -1;
      if (search) {
        search.value = "";
        setTimeout(() => search.focus(), 0);
      }
      paintList();
      const sel = list.querySelector('[aria-selected="true"]');
      if (sel) sel.scrollIntoView({ block: "nearest" });
    }
    function close() {
      root.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      openDropdowns.delete(api);
    }
    function choose(o) {
      close();
      btn.focus();
      if (o.value === cfg.value) return;
      cfg.value = o.value;
      paintButton();
      onChange(o.value);
    }
    btn.addEventListener("click", () => (root.classList.contains("open") ? close() : open()));
    list.addEventListener("click", (e) => {
      const el = e.target.closest(".dd-opt");
      if (el) choose(visibleOptions()[Number(el.dataset.i)]);
    });
    root.querySelector(".dd-custom")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = e.currentTarget.querySelector("input");
      const n = Math.round(Number(input.value));
      if (!n || n < custom.min || n > custom.max) {
        input.focus();
        return;
      }
      input.value = "";
      close();
      btn.focus();
      if (n === cfg.value) return;
      cfg.value = n;
      paintButton();
      onChange(n);
    });
    search?.addEventListener("input", () => {
      kb = -1;
      paintList();
    });
    root.addEventListener("keydown", (e) => {
      if (e.target.closest(".dd-custom") && e.key !== "Escape") return;
      if (!root.classList.contains("open")) {
        if (e.key === "ArrowDown" && e.target === btn) {
          e.preventDefault();
          open();
        }
        return;
      }
      const opts = visibleOptions();
      const step = (d) => {
        let i = kb;
        do i = (i + d + opts.length) % opts.length;
        while (opts[i].sep);
        kb = i;
        paintList();
        list.querySelector(".kb")?.scrollIntoView({ block: "nearest" });
      };
      if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
      else if (e.key === "Enter" && kb >= 0) { e.preventDefault(); choose(opts[kb]); }
      else if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); }
    });
    const api = {
      root,
      close,
      set(next) {
        cfg = { ...cfg, ...next };
        paintButton();
        if (root.classList.contains("open")) paintList();
      },
    };
    return api;
  }

  document.addEventListener("click", (e) => {
    for (const d of openDropdowns) if (!d.root.contains(e.target)) d.close();
  });

  const yearDd = createDropdown(dom.yearSelect, { onChange: (v) => setRange(v) });
  const rangeDd = createDropdown(dom.timeframeSelect, { label: "Range", onChange: (v) => setRange(v) });
  const kindDd = createDropdown(dom.ddKind, { label: "Type", onChange: (v) => { state.filters.kind = v; onFiltersChanged(); } });
  const statusDd = createDropdown(dom.ddStatus, { label: "Status", onChange: (v) => { state.filters.status = v; onFiltersChanged(); } });
  const roleDd = createDropdown(dom.ddRole, { label: "Role", onChange: (v) => { state.filters.role = v; onFiltersChanged(); } });
  const PAGE_SIZES = [25, 50, 100, 150, 250, 500];
  const pageSizeDd = createDropdown(dom.ddPageSize, {
    label: "Show",
    alignRight: true,
    custom: { placeholder: "Custom (1–1000)", min: 1, max: 1000 },
    onChange: (v) => {
      state.pageSize = Number(v);
      prefSet("pagesize", String(v));
      renderPageSize();
      onFiltersChanged();
    },
  });
  function renderPageSize() {
    const sizes = PAGE_SIZES.includes(state.pageSize) ? PAGE_SIZES : [...PAGE_SIZES, state.pageSize].sort((a, b) => a - b);
    pageSizeDd.set({ options: sizes.map((n) => ({ value: n, label: `${n} per page`, short: String(n) })), value: state.pageSize });
  }
  const repoDd = createDropdown(dom.ddRepo, { label: "Repo", searchable: true, onChange: (v) => { state.filters.repo = v; onFiltersChanged(); } });
  yearDd.root.classList.add("year-dd");

  // ── Filters ─────────────────────────────────────────────────────────
  const ROLE_TEXT = { created: "Created", assigned: "Assigned", reviewed: "Reviewed", commented: "Commented", other: "Mentioned / other" };
  const ROLE_COLOR = { created: "var(--s3)", assigned: "var(--s4)", reviewed: "var(--s7)", commented: "var(--s1)", other: "var(--text-3)" };

  // Each filter's numbers = what you'd get if you picked that option,
  // given the time range and every OTHER active filter (faceted counts).
  function matchesFilters(i, f, skip) {
    if (skip !== "kind" && f.kind !== "all" && i.kind !== f.kind) return false;
    if (skip !== "status" && f.status !== "all" && i.status !== f.status) return false;
    if (skip !== "role" && f.role !== "all" && i.bucket !== f.role) return false;
    if (skip !== "repo" && f.repo !== "all" && i.repo !== f.repo) return false;
    return true;
  }

  function textFiltered(items) {
    const q = state.filters.text.toLowerCase().trim();
    if (!q) return items;
    const num = q.replace(/^#/, "");
    return items.filter((i) => i.title.toLowerCase().includes(q) || i.repo.toLowerCase().includes(q) || String(i.number) === num);
  }

  function renderFilterControls() {
    const f = state.filters;
    const base = textFiltered(getItemsForCurrentDateRange());
    const facet = (skip) => base.filter((i) => matchesFilters(i, f, skip));

    const forKind = facet("kind");
    kindDd.set({
      options: [
        { value: "all", label: "All types", short: "All", count: forKind.length },
        { value: "pr", label: "Pull requests", count: forKind.filter((i) => i.kind === "pr").length },
        { value: "issue", label: "Issues", count: forKind.filter((i) => i.kind === "issue").length },
      ],
      value: f.kind,
      defaultValue: "all",
    });

    // Open/Closed apply to both; Draft/Merged only exist for PRs, Not planned only for issues
    const both = f.kind === "all";
    const statuses = [["all", "Any status", "Any"], ["open", "Open"]];
    if (f.kind !== "issue") statuses.push(["draft", both ? "Draft (PR)" : "Draft", "Draft"], ["merged", both ? "Merged (PR)" : "Merged", "Merged"]);
    statuses.push(["closed", both ? "Closed (PR or issue)" : "Closed", "Closed"]);
    if (f.kind !== "pr") statuses.push(["not-planned", both ? "Not planned (issue)" : "Not planned", "Not planned"]);
    if (!statuses.some(([v]) => v === f.status)) f.status = "all";
    const forStatus = facet("status");
    const sc = countBy(forStatus, (i) => i.status);
    statusDd.set({
      options: statuses.map(([v, l, short]) => ({ value: v, label: l, short: short || l, count: v === "all" ? forStatus.length : sc.get(v) || 0 })),
      value: f.status,
      defaultValue: "all",
    });

    // While the full list is still loading, an unfiltered all-time view shows GitHub's exact totals
    const forRole = facet("role");
    const useGitHub = !loadedEverything() && !rangeBounds() && forRole.length === state.itemsMap.size && bucketTotalsKnown();
    const rc = countBy(forRole, (i) => i.bucket);
    roleDd.set({
      options: [
        { value: "all", label: "Any role", short: "Any", count: useGitHub ? lifetimeTotal() : forRole.length },
        ...REL_ORDER.map((b) => ({ value: b, label: ROLE_TEXT[b], dot: ROLE_COLOR[b], count: useGitHub ? state.counts[b] : rc.get(b) || 0 })),
      ],
      value: f.role,
      defaultValue: "all",
    });

    const forRepo = facet("repo");
    const repos = Array.from(countBy(forRepo, (i) => i.repo).entries()).sort((a, b) => b[1] - a[1]);
    if (f.repo !== "all" && !repos.some(([r]) => r === f.repo)) repos.unshift([f.repo, 0]);
    repoDd.set({
      options: [{ value: "all", label: "All repositories", short: "All", count: forRepo.length }, ...repos.map(([r, n]) => ({ value: r, label: r, short: r.split("/")[1] || r, count: n }))],
      value: f.repo,
      defaultValue: "all",
    });
    dom.clearFilters.hidden = !(f.kind !== "all" || f.status !== "all" || f.role !== "all" || f.repo !== "all" || f.text);
  }

  dom.clearFilters.addEventListener("click", () => {
    Object.assign(state.filters, { kind: "all", status: "all", role: "all", repo: "all", text: "" });
    dom.filterText.value = "";
    onFiltersChanged();
  });

  function getFilteredItems() {
    const f = state.filters;
    let items = getItemsForCurrentDateRange();
    if (f.kind !== "all") items = items.filter((i) => i.kind === f.kind);
    if (f.status !== "all") items = items.filter((i) => i.status === f.status);
    if (f.role !== "all") items = items.filter((i) => i.bucket === f.role);
    if (f.repo !== "all") items = items.filter((i) => i.repo === f.repo);
    const q = f.text.toLowerCase().trim();
    if (q) {
      const num = q.replace(/^#/, "");
      items = items.filter((i) => i.title.toLowerCase().includes(q) || i.repo.toLowerCase().includes(q) || String(i.number) === num);
    }
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return items;
  }

  function onFiltersChanged() {
    state.currentPage = 1;
    renderAll();
  }

  let textTimer = null;
  dom.filterText.addEventListener("input", (e) => {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      state.filters.text = e.target.value;
      onFiltersChanged();
    }, 120);
  });

  // KPI cards act as shortcuts
  dom.telemetryBar.addEventListener("click", (e) => {
    const card = e.target.closest("[data-card]");
    if (!card || !state.login) return;
    const presets = {
      total: { kind: "all", role: "all" },
      prs: { kind: "pr", role: "created" },
      issues: { kind: "issue", role: "created" },
      reviewed: { kind: "pr", role: "reviewed" },
      commented: { kind: "all", role: "commented" },
    };
    Object.assign(state.filters, presets[card.dataset.card], { status: "all", repo: "all" });
    switchView("feed");
    onFiltersChanged();
  });

  // ── Rendering (throttled while data streams in) ─────────────────────
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, 300);
  }

  function renderAll() {
    renderBanner();
    renderOverview();
    renderRangeControls();
    if (state.viewMode === "analytics") renderAnalytics();
    else {
      renderFilterControls();
      renderList();
    }
  }

  function renderList() {
    if (state.fatal) return;
    const filtered = getFilteredItems();
    const total = filtered.length;
    if (!state.listReady && !total) {
      dom.listLoading.style.display = "flex";
      dom.listEmpty.style.display = "none";
      dom.listContainer.innerHTML = "";
      dom.listContainer.dataset.signature = "";
      updatePagerUI(0);
      return;
    }
    dom.listLoading.style.display = "none";
    if (!total) {
      dom.listContainer.innerHTML = "";
      dom.listContainer.dataset.signature = "";
      dom.listEmpty.style.display = "block";
      dom.listEmpty.querySelector("p").textContent = loadedEverything() ? "No matching work for these filters." : "Nothing matches yet — the rest of the history is still loading.";
      updatePagerUI(0);
      return;
    }
    dom.listEmpty.style.display = "none";
    const totalPages = Math.ceil(total / state.pageSize);
    state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
    const start = (state.currentPage - 1) * state.pageSize;
    const pageItems = filtered.slice(start, start + state.pageSize);
    const signature = `${start}:` + pageItems.map((i) => `${i.id}|${i.updatedAt}|${i.bucket}`).join(",");
    if (signature !== dom.listContainer.dataset.signature) {
      dom.listContainer.dataset.signature = signature;
      const frag = document.createDocumentFragment();
      pageItems.forEach((item, k) => frag.appendChild(createItemRow(item, start + k + 1)));
      dom.listContainer.innerHTML = "";
      dom.listContainer.appendChild(frag);
    }
    updatePagerUI(total);
  }

  function loadedEverything() {
    if (state.harvestDone) return true;
    const t = lifetimeTotal();
    return t !== undefined && state.itemsMap.size >= t;
  }

  function updatePagerUI(total) {
    dom.pageButtons.innerHTML = "";
    if (!total) {
      dom.pagerCount.textContent = state.listReady ? "0 items" : "Loading…";
      dom.pagerPrev.disabled = true;
      dom.pagerNext.disabled = true;
      dom.bottomSummary.textContent = "";
      return;
    }
    const totalPages = Math.ceil(total / state.pageSize);
    const start = (state.currentPage - 1) * state.pageSize + 1;
    const end = Math.min(state.currentPage * state.pageSize, total);
    dom.pagerCount.textContent = `${fmt(start)}–${fmt(end)} of ${fmt(total)}${loadedEverything() ? "" : " so far"}`;
    dom.pagerPrev.disabled = state.currentPage <= 1;
    dom.pagerNext.disabled = state.currentPage >= totalPages;
    if (totalPages > 1) {
      const pages = new Set([1, totalPages]);
      for (let p = state.currentPage - 2; p <= state.currentPage + 2; p++) if (p >= 1 && p <= totalPages) pages.add(p);
      let last = 0;
      for (const p of Array.from(pages).sort((a, b) => a - b)) {
        if (p - last > 1) dom.pageButtons.insertAdjacentHTML("beforeend", `<span class="page-gap">…</span>`);
        const b = document.createElement("button");
        b.type = "button";
        b.className = `page-btn${p === state.currentPage ? " active" : ""}`;
        b.textContent = fmt(p);
        b.addEventListener("click", () => goToPage(p));
        dom.pageButtons.appendChild(b);
        last = p;
      }
    }
    dom.bottomSummary.textContent = `${fmt(state.pageSize)} per page · ${fmt(totalPages)} page${totalPages === 1 ? "" : "s"}${loadedEverything() ? "" : ` · loading history (${fmt(state.itemsMap.size)} so far)`}`;
  }

  function goToPage(p) {
    state.currentPage = p;
    renderList();
    const top = dom.listContainer.getBoundingClientRect().top + window.scrollY - 140;
    if (window.scrollY > top) window.scrollTo({ top, behavior: "smooth" });
  }

  dom.pagerPrev.addEventListener("click", () => {
    if (state.currentPage > 1) goToPage(state.currentPage - 1);
  });
  dom.pagerNext.addEventListener("click", () => {
    const totalPages = Math.ceil(getFilteredItems().length / state.pageSize);
    if (state.currentPage < totalPages) goToPage(state.currentPage + 1);
  });

  // ── Row ─────────────────────────────────────────────────────────────
  const ROLE_VERB = { assigned: "assigned", reviewed: "reviewed", commented: "commented", mentioned: "mentioned", other: "mentioned" };
  const LINK_LABEL = { created: "Created", assigned: "Assigned", reviewed: "Reviewed", commented: "Commented", mentioned: "Mentioned" };

  function roleTagHtml(item) {
    if (item.bucket === "created" || !item.bucket) return "";
    const extra = state.linkCache.get(item.id);
    const verbs = [ROLE_VERB[item.bucket]];
    if (extra) for (const r of ["assigned", "reviewed", "commented", "mentioned"]) if (extra.has(r) && !verbs.includes(ROLE_VERB[r])) verbs.push(ROLE_VERB[r]);
    const text = item.bucket === "other" && !extra ? "mentioned" : verbs.join(", ");
    return `<span class="role-note role-${item.bucket}" title="How @${escapeHtml(state.login)} is involved">@${escapeHtml(state.login)} ${escapeHtml(text)}</span>`;
  }

  function refreshRoleTags(items) {
    for (const item of items) {
      const el = dom.listContainer.querySelector(`.item-row[data-id="${CSS.escape(item.id)}"] .role-slot`);
      if (el) el.innerHTML = roleTagHtml(item);
    }
  }

  const ICON_PR = `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.128a2.251 2.251 0 101.5 0V5a2.5 2.5 0 00-2.5-2.5z"/></svg>`;
  const ICON_ISSUE = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/><path fill-rule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/></svg>`;
  const ICON_EXT = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5L8 8M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3"/></svg>`;

  function createItemRow(item, serial) {
    const row = document.createElement("div");
    row.className = "item-row";
    row.dataset.id = item.id;
    const isExpanded = state.expandedPreviews.has(item.id);
    const icon = (item.kind === "pr" ? ICON_PR : ICON_ISSUE).replace("<svg", `<svg class="type-icon ${item.status}" aria-hidden="true"`);
    row.innerHTML = `
      <div class="row-main">
        <span class="row-num" aria-label="Item ${serial}">${fmt(serial)}</span>
        ${icon}
        <div class="row-content">
          <div class="row-title">
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="item-title-link">${escapeHtml(item.title)}</a>
          </div>
          <div class="row-meta">
            <span class="badge ${item.status}">${escapeHtml(item.statusLabel)}</span>
            <span class="repo">${escapeHtml(item.repo)}#${item.number}</span>
            <span>by <span class="author ${item.bucket === "created" ? "is-self" : ""}">${escapeHtml(item.author)}</span></span>
            <span title="Comments">${fmt(item.commentsCount)} comment${item.commentsCount === 1 ? "" : "s"}</span>
            <span class="role-slot">${roleTagHtml(item)}</span>
            ${(item.labels || []).slice(0, 3).map((l) => `<span class="label-pill" style="--l-color:#${escapeHtml(l.color || "888888")}">${escapeHtml(l.name)}</span>`).join("")}
          </div>
        </div>
        <div class="row-right">
          <span class="time-ago" title="Updated ${escapeHtml(new Date(item.updatedAt).toLocaleString())}">${timeAgo(item.updatedAt)}</span>
          <button type="button" class="btn-preview-toggle ${isExpanded ? "expanded" : ""}" aria-expanded="${isExpanded}">Preview ${ICON_CHEVRON}</button>
        </div>
      </div>
      <div class="preview-drawer ${isExpanded ? "open" : ""}">
        <div class="drawer-header">
          <div class="preview-meta"><span class="preview-url">${escapeHtml(item.repo)}#${item.number}</span></div>
          <div class="drawer-actions">
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="btn btn-sm">Open on GitHub ${ICON_EXT}</a>
            <button type="button" class="btn btn-sm btn-ghost btn-close-drawer" aria-label="Close preview">Close</button>
          </div>
        </div>
        <div class="preview-body"></div>
      </div>`;
    const previewBtn = row.querySelector(".btn-preview-toggle");
    const drawer = row.querySelector(".preview-drawer");
    const body = row.querySelector(".preview-body");
    let loaded = false;
    const setOpen = (open) => {
      drawer.classList.toggle("open", open);
      previewBtn.classList.toggle("expanded", open);
      previewBtn.setAttribute("aria-expanded", String(open));
      if (open) {
        state.expandedPreviews.add(item.id);
        if (!loaded) {
          loaded = true;
          mountPreview(item, body);
        }
      } else state.expandedPreviews.delete(item.id);
    };
    previewBtn.addEventListener("click", () => setOpen(!drawer.classList.contains("open")));
    row.querySelector(".btn-close-drawer").addEventListener("click", () => setOpen(false));
    if (isExpanded) {
      loaded = true;
      mountPreview(item, body);
    }
    return row;
  }

  // ── Preview: the whole conversation, inside the row ────────────────
  function mountPreview(item, container) {
    if (localProxy) {
      container.className = "preview-body iframe-container";
      container.innerHTML = `<iframe class="preview-iframe" src="/view?url=${encodeURIComponent(item.url)}" title="GitHub page preview"></iframe>`;
      return;
    }
    container.className = "preview-body conv";
    container.innerHTML = `
      <div class="conv-head">
        <h4 class="conv-title"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a> <span class="conv-num">#${item.number}</span></h4>
        <div class="conv-meta">
          <span class="gh-badge ${item.status}">${item.statusLabel}</span>
          <span><strong>${escapeHtml(item.author)}</strong> opened ${timeAgo(item.createdAt)}</span>
          <span>· updated ${timeAgo(item.updatedAt)}</span>
          <span>· 💬 ${fmt(item.commentsCount)}</span>
        </div>
        <div class="conv-links"></div>
      </div>
      <div class="conv-list">
        <div class="conv-desc">${convEntry(item.author, item.authorAvatar, item.createdAt, plainBody(item.body), "opened this")}</div>
        <div class="conv-timeline"><div class="conv-loading">Loading conversation…</div></div>
      </div>`;
    loadDescription(item, container.querySelector(".conv-desc .conv-body"));
    loadTimeline(item, container.querySelector(".conv-timeline"));
  }

  function plainBody(text) {
    if (text === undefined) return `<p class="conv-empty">Loading description…</p>`;
    if (!text || !text.trim()) return `<p class="conv-empty">No description provided.</p>`;
    return `<div class="md-plain">${escapeHtml(text)}</div>`;
  }

  // Formatted description (markdown rendered by GitHub); plain text stays if this fails
  async function loadDescription(item, el) {
    if (!el || (item.body !== undefined && !item.body.trim())) return;
    const [owner, name] = item.repo.split("/");
    try {
      const issue = await apiGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${item.number}`, {
        bucket: "core",
        priority: 0,
        html: true,
      });
      el.innerHTML = issue?.body_html ? sanitizeHtml(issue.body_html) : `<p class="conv-empty">No description provided.</p>`;
    } catch {
      /* keep plain text */
    }
  }

  function convEntry(login, avatar, when, html, verb = "commented", extraClass = "") {
    return `
      <div class="conv-entry ${extraClass}">
        <img class="conv-avatar" src="${escapeHtml(avatar || `https://github.com/${login}.png`)}${avatar && avatar.includes("?") ? "&" : "?"}s=64" alt="" width="32" height="32" loading="lazy" />
        <div class="conv-box">
          <div class="conv-box-head"><strong>${escapeHtml(login)}</strong> ${verb} <span title="${escapeHtml(new Date(when).toLocaleString())}">${timeAgo(when)}</span></div>
          <div class="conv-body md-body">${html}</div>
        </div>
      </div>`;
  }

  function convEvent(icon, html, when) {
    return `<div class="conv-event"><span class="conv-event-icon">${icon}</span><span>${html}</span>${when ? `<span class="conv-event-time">${timeAgo(when)}</span>` : ""}</div>`;
  }

  async function loadTimeline(item, el) {
    const [owner, name] = item.repo.split("/");
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${item.number}`;
    try {
      const events = await apiGet(`${base}/timeline?per_page=100`, { bucket: "core", priority: 0, html: true });
      let html = renderTimeline(events || []);
      if ((events || []).length >= 100 && item.commentsCount > 30) {
        // Long thread: also show the most recent comments
        const lastPage = Math.ceil(item.commentsCount / 30);
        const latest = await apiGet(`${base}/comments?per_page=30&page=${lastPage}`, { bucket: "core", priority: 0, html: true }).catch(() => []);
        const shownIds = new Set((events || []).map((e) => e.id));
        const fresh = (latest || []).filter((c) => !shownIds.has(c.id));
        if (fresh.length) {
          html += `<div class="conv-gap">… earlier activity hidden — <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">see everything on GitHub</a> …</div>`;
          html += fresh.map((c) => convEntry(c.user?.login || "ghost", c.user?.avatar_url, c.created_at, sanitizeHtml(c.body_html || ""))).join("");
        }
      }
      el.innerHTML = html || `<div class="conv-empty">No comments or activity yet.</div>`;
      noteLinksFromTimeline(item, events || [], el.closest(".preview-body"));
    } catch (err) {
      if (err.rateLimited) {
        const mins = Math.max(1, Math.ceil((err.resetAt - Date.now()) / 60000));
        el.innerHTML = `<div class="conv-empty">GitHub allows 60 conversation previews an hour without login. More available in ~${mins} min — or <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">open it on GitHub</a>.</div>`;
      } else {
        el.innerHTML = `<div class="conv-empty">Couldn't load the conversation (${escapeHtml(err.message)}). <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open on GitHub</a>.</div>`;
      }
    }
  }

  function noteLinksFromTimeline(item, events, container) {
    const u = state.login.toLowerCase();
    const roles = state.linkCache.get(item.id) || new Set();
    state.linkCache.set(item.id, roles);
    if (item.bucket === "created" || item.author.toLowerCase() === u) roles.add("created");
    if ((item.assignees || []).includes(u)) roles.add("assigned");
    const mention = new RegExp(`@${u.replace(/[-]/g, "\\-")}\\b`, "i");
    if (mention.test(item.body || "")) roles.add("mentioned");
    for (const e of events) {
      const actor = (e.actor?.login || e.user?.login || "").toLowerCase();
      if (e.event === "commented" && actor === u) roles.add("commented");
      if (e.event === "reviewed" && (e.user?.login || "").toLowerCase() === u) roles.add("reviewed");
      if (e.event === "assigned" && (e.assignee?.login || "").toLowerCase() === u) roles.add("assigned");
      if (e.event === "mentioned" && actor === u) roles.add("mentioned");
      if (e.event === "commented" && actor !== u && mention.test(e.body_html || "")) roles.add("mentioned");
    }
    refreshRoleTags([item]);
    const links = ["created", "assigned", "reviewed", "commented", "mentioned"].filter((r) => roles.has(r));
    const head = container?.querySelector(".conv-links");
    if (head) {
      head.innerHTML = links.length
        ? `@${escapeHtml(state.login)}'s links here: ${links.map((r) => `<span class="link-chip">${LINK_LABEL[r]}</span>`).join(" ")}`
        : "";
    }
  }

  function who(obj) {
    return `<strong>${escapeHtml(obj?.login || "someone")}</strong>`;
  }

  function renderTimeline(events) {
    const out = [];
    let commits = [];
    const flushCommits = () => {
      if (!commits.length) return;
      const list = commits
        .slice(0, 8)
        .map((c) => `<li><code>${escapeHtml((c.sha || "").slice(0, 7))}</code> ${escapeHtml((c.message || "").split("\n")[0])}</li>`)
        .join("");
      const more = commits.length > 8 ? `<li>…and ${commits.length - 8} more</li>` : "";
      out.push(convEvent("⎇", `${commits.length} commit${commits.length === 1 ? "" : "s"} pushed<ul class="conv-commits">${list}${more}</ul>`, commits[commits.length - 1].author?.date));
      commits = [];
    };

    for (const e of events) {
      if (e.event !== "committed") flushCommits();
      switch (e.event) {
        case "commented":
          out.push(convEntry(e.actor?.login || e.user?.login || "ghost", e.actor?.avatar_url || e.user?.avatar_url, e.created_at, sanitizeHtml(e.body_html || "")));
          break;
        case "reviewed": {
          const verb = { approved: "approved these changes", changes_requested: "requested changes", commented: "reviewed", dismissed: "review dismissed" }[e.state] || "reviewed";
          const cls = e.state === "approved" ? "review-approved" : e.state === "changes_requested" ? "review-changes" : "";
          if (e.body_html) out.push(convEntry(e.user?.login || "ghost", e.user?.avatar_url, e.submitted_at, sanitizeHtml(e.body_html), verb, cls));
          else out.push(convEvent(e.state === "approved" ? "✓" : "◉", `${who(e.user)} ${verb}`, e.submitted_at));
          break;
        }
        case "committed":
          commits.push(e);
          break;
        case "labeled":
        case "unlabeled":
          out.push(convEvent("🏷", `${who(e.actor)} ${e.event === "labeled" ? "added" : "removed"} <span class="label-pill" style="--l-color:#${escapeHtml(e.label?.color || "888888")}">${escapeHtml(e.label?.name || "")}</span>`, e.created_at));
          break;
        case "closed":
          out.push(convEvent("⊘", `${who(e.actor)} closed this${e.state_reason === "not_planned" ? " as not planned" : ""}`, e.created_at));
          break;
        case "reopened":
          out.push(convEvent("↺", `${who(e.actor)} reopened this`, e.created_at));
          break;
        case "merged":
          out.push(convEvent("⛙", `${who(e.actor)} merged this`, e.created_at));
          break;
        case "assigned":
        case "unassigned":
          out.push(convEvent("👤", `${who(e.actor)} ${e.event} ${who(e.assignee)}`, e.created_at));
          break;
        case "review_requested":
          out.push(convEvent("👁", `${who(e.actor)} requested a review from ${e.requested_reviewer ? who(e.requested_reviewer) : `<strong>${escapeHtml(e.requested_team?.name || "a team")}</strong>`}`, e.created_at));
          break;
        case "cross-referenced": {
          const src = e.source?.issue;
          if (src) out.push(convEvent("↗", `${who(e.actor)} mentioned this in <a href="${escapeHtml(src.html_url)}" target="_blank" rel="noopener">${escapeHtml(src.repository?.full_name || "")}#${src.number} ${escapeHtml(src.title || "")}</a>`, e.created_at));
          break;
        }
        case "renamed":
          out.push(convEvent("✎", `${who(e.actor)} changed the title from <em>${escapeHtml(e.rename?.from || "")}</em>`, e.created_at));
          break;
        case "ready_for_review":
          out.push(convEvent("◎", `${who(e.actor)} marked this ready for review`, e.created_at));
          break;
        case "convert_to_draft":
          out.push(convEvent("◌", `${who(e.actor)} converted this to a draft`, e.created_at));
          break;
        case "head_ref_force_pushed":
          out.push(convEvent("⇡", `${who(e.actor)} force-pushed`, e.created_at));
          break;
        case "milestoned":
          out.push(convEvent("⚑", `${who(e.actor)} added this to the <strong>${escapeHtml(e.milestone?.title || "")}</strong> milestone`, e.created_at));
          break;
        default:
          break; // subscribed, mentioned, referenced, etc. are noise in a preview
      }
    }
    flushCommits();
    return out.join("");
  }

  // ── Analytics: chart engine ─────────────────────────────────────────
  // Every chart is SVG drawn to its box (redrawn on resize), single-hue for
  // magnitude, fixed categorical slots for identity, hover tooltip on every mark.
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const SERIES_SLOTS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)"];

  const TYPE_SETS = {
    series: ["bar", "line", "area", "cumulative", "table"],
    bins: ["bar", "line", "area", "table"],
    cat: ["donut", "pie", "bars", "table"],
  };
  const TYPE_LABEL = { bar: "Bar", line: "Line", area: "Area", cumulative: "Cumulative", table: "Table", donut: "Donut", pie: "Pie", bars: "Bars" };
  const S = `viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
  const TYPE_ICON = {
    bar: `<svg ${S}><path d="M3 13.5V8M6.5 13.5V4M10 13.5V9.5M13.5 13.5V6"/></svg>`,
    line: `<svg ${S}><path d="M2 12l3.5-4 3 2.5L14 4"/></svg>`,
    area: `<svg ${S}><path d="M2 13.5V11l3.5-4 3 2.5L14 4v9.5z" fill="currentColor" fill-opacity=".25"/></svg>`,
    cumulative: `<svg ${S}><path d="M2 13.5c3 0 5-1 7-4s3-6 5-7.5"/><path d="M2 13.5h12"/></svg>`,
    table: `<svg ${S}><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6.5h12M2 10h12M6.5 3v10"/></svg>`,
    donut: `<svg ${S}><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.5"/><path d="M8 2.5V5.5"/></svg>`,
    pie: `<svg ${S}><path d="M8 2.5a5.5 5.5 0 105.5 5.5H8z"/><path d="M10 1.8v4.2h4.2A4.2 4.2 0 0010 1.8z"/></svg>`,
    bars: `<svg ${S}><path d="M2.5 4h11M2.5 8h7M2.5 12h4"/></svg>`,
  };

  const chartState = new Map(); // id -> { el, card, spec, data, type, w }

  function niceMax(v) {
    if (v <= 4) return Math.max(1, Math.ceil(v));
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }
  const shortNum = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(Math.round(n)));

  function tipEl(el) {
    let t = el.querySelector(".viz-tip");
    if (!t) {
      t = document.createElement("div");
      t.className = "viz-tip";
      t.hidden = true;
      el.appendChild(t);
    }
    return t;
  }
  function showTip(el, x, y, html) {
    const t = tipEl(el);
    t.innerHTML = html;
    t.hidden = false;
    const w = el.clientWidth;
    const half = (t.offsetWidth || 80) / 2;
    t.style.left = `${Math.min(w - half, Math.max(half, x))}px`;
    t.style.top = `${Math.max(t.offsetHeight + 4, y)}px`;
  }
  function hideTip(el) {
    const t = el.querySelector(".viz-tip");
    if (t) t.hidden = true;
  }

  function emptyChart(el, text) {
    el.innerHTML = `<div class="chart-empty">${escapeHtml(text || (loadedEverything() ? "No data in this period" : "Loading…"))}</div>`;
  }

  function tableView(el, rows, cols) {
    el.innerHTML = `<div class="vtable-wrap"><table class="vtable"><thead><tr>${cols.map((c, i) => `<th class="${i ? "n" : ""}">${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "n" : ""}">${i ? (typeof c === "number" ? fmt(c) : escapeHtml(c)) : escapeHtml(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
  }

  // Time / bin series: bar, line, area, cumulative, table.
  // Bars never get squeezed: when there are more points than fit, the plot
  // scrolls horizontally (hidden scrollbar, drag to pan, ⌘/Ctrl + wheel or
  // the − / + buttons to zoom). The y-axis stays pinned on the left.
  const MIN_STEP = { bar: 14, line: 9, area: 9, cumulative: 9 };
  const MAX_STEP = 96;

  function drawSeries(st) {
    const { el, data, type } = st;
    if (!data.length || data.every((d) => !d.value)) {
      updateZoomButtons(st, false);
      return emptyChart(el);
    }
    if (type === "table") {
      updateZoomButtons(st, false);
      let run = 0;
      return tableView(el, data.map((d) => ((run += d.value), [d.full || d.label, d.value, run])), ["Period", "Count", "Running total"]);
    }
    const W = el.clientWidth;
    const H = el.clientHeight;
    if (!W || !H) return;
    let run = 0;
    const vals = type === "cumulative" ? data.map((d) => (run += d.value)) : data.map((d) => d.value);
    const max = niceMax(Math.max(...vals));
    const axisW = 10 + Math.max(2, shortNum(max).length) * 7;
    const V = W - axisW;
    const n = data.length;
    const fit = V / n;
    const auto = Math.max(fit, MIN_STEP[type] || 9);
    const step = Math.min(MAX_STEP, Math.max(fit, st.step ?? auto));
    const plotW = Math.max(V, n * step);
    const bw = plotW / n;
    const pad = { t: 10, b: 24, r: 6 };
    const ih = H - pad.t - pad.b;
    const cx = (i) => bw * (i + 0.5);
    const y = (v) => pad.t + ih - (v / max) * ih;

    // Pinned y-axis
    let ax = `<svg viewBox="0 0 ${axisW} ${H}">`;
    for (const t of [0, max / 2, max]) ax += `<text class="ax" x="${axisW - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${shortNum(t)}</text>`;
    ax += "</svg>";

    // Scrollable plot
    let svg = `<svg width="${plotW}" viewBox="0 0 ${plotW} ${H}" role="img" aria-label="${escapeHtml(`${st.spec.title}: ${n} points`)}">`;
    for (const t of [0, max / 2, max]) svg += `<line class="${t ? "gl" : "base"}" x1="0" x2="${plotW}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`;
    let lastX = -Infinity;
    data.forEach((d, i) => {
      const text = d.short !== undefined ? d.short : d.label;
      if (!text) return;
      const tw = String(text).length * 6.4 + 12;
      const x = cx(i);
      if (x - lastX < tw || x - tw / 2 < -2 || x + tw / 2 > plotW + 2) return;
      lastX = x;
      svg += `<text class="ax" x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${escapeHtml(text)}</text>`;
    });
    if (type === "bar") {
      const barW = Math.max(1, Math.min(44, bw - Math.max(1.5, Math.min(8, bw * 0.28))));
      vals.forEach((v, i) => {
        if (!v) return;
        const h = Math.max(1.5, ih - (y(v) - pad.t));
        const x0 = cx(i) - barW / 2;
        const r = Math.min(4, barW / 2, h);
        const top = pad.t + ih - h;
        const base = pad.t + ih;
        svg += `<path class="mark-bar" data-i="${i}" d="M${x0.toFixed(1)},${base.toFixed(1)}V${(top + r).toFixed(1)}Q${x0.toFixed(1)},${top.toFixed(1)} ${(x0 + r).toFixed(1)},${top.toFixed(1)}H${(x0 + barW - r).toFixed(1)}Q${(x0 + barW).toFixed(1)},${top.toFixed(1)} ${(x0 + barW).toFixed(1)},${(top + r).toFixed(1)}V${base.toFixed(1)}Z"/>`;
      });
    } else {
      const pts = vals.map((v, i) => [cx(i), y(v)]);
      const line = pts.map(([x, yy], i) => `${i ? "L" : "M"}${x.toFixed(1)},${yy.toFixed(1)}`).join("");
      if (type !== "line") svg += `<path class="mark-area" d="${line}L${pts[n - 1][0].toFixed(1)},${(pad.t + ih).toFixed(1)}L${pts[0][0].toFixed(1)},${(pad.t + ih).toFixed(1)}Z"/>`;
      svg += `<path class="mark-line" d="${line}"/>`;
      svg += `<line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" opacity="0"/><circle class="mark-dot" r="4.5" cx="0" cy="0" opacity="0"/>`;
    }
    svg += `<rect class="hit" x="0" y="0" width="${plotW}" height="${H}"/></svg>`;

    // Keep the same point under the viewport centre (or cursor) across redraws
    const prev = el.querySelector(".chart-scroll");
    const anchorFrac = st.anchorFrac ?? (prev ? (prev.scrollLeft + prev.clientWidth / 2) / prev.scrollWidth : null);
    el.innerHTML = `<div class="chart-y" style="width:${axisW}px">${ax}</div><div class="chart-scroll" style="left:${axisW}px">${svg}</div><div class="chart-fade l" style="left:${axisW}px"></div><div class="chart-fade r"></div>`;
    const sc = el.querySelector(".chart-scroll");
    const s = sc.querySelector("svg");
    const scrollable = plotW > V + 1;
    sc.classList.toggle("can-pan", scrollable);
    if (scrollable) {
      if (anchorFrac === null || st.pinEnd) sc.scrollLeft = sc.scrollWidth; // newest data first, like a trading chart
      else sc.scrollLeft = anchorFrac * sc.scrollWidth - (st.anchorPx ?? sc.clientWidth / 2);
    }
    st.anchorFrac = null;
    st.anchorPx = null;
    const fades = () => {
      el.querySelector(".chart-fade.l").classList.toggle("on", sc.scrollLeft > 2);
      el.querySelector(".chart-fade.r").classList.toggle("on", sc.scrollLeft < sc.scrollWidth - sc.clientWidth - 2);
      st.pinEnd = sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 2;
    };
    sc.addEventListener("scroll", fades, { passive: true });
    fades();
    st.cur = { step, fit, auto };
    updateZoomButtons(st, true);

    // Hover tooltip
    const hit = s.querySelector(".hit");
    let dragging = null;
    const move = (ev) => {
      if (dragging?.moved) return;
      const r = s.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (plotW / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.floor(px / bw)));
      const d = data[i];
      el.classList.add("hovering");
      if (type === "bar") {
        s.querySelectorAll(".mark-bar.on").forEach((b) => b.classList.remove("on"));
        s.querySelector(`.mark-bar[data-i="${i}"]`)?.classList.add("on");
      } else {
        const c = s.querySelector(".cross");
        c.setAttribute("x1", cx(i));
        c.setAttribute("x2", cx(i));
        c.setAttribute("opacity", "1");
        const dot = s.querySelector(".mark-dot");
        dot.setAttribute("cx", cx(i));
        dot.setAttribute("cy", y(vals[i]));
        dot.setAttribute("opacity", "1");
      }
      const val = type === "cumulative" ? `<b>${fmt(vals[i])}</b> total · +${fmt(d.value)}` : `<b>${fmt(d.value)}</b>`;
      showTip(el, axisW + cx(i) - sc.scrollLeft, y(vals[i]), `${escapeHtml(d.full || d.label)} · ${val}`);
    };
    const leave = () => {
      el.classList.remove("hovering");
      hideTip(el);
      if (type !== "bar") {
        s.querySelector(".cross").setAttribute("opacity", "0");
        s.querySelector(".mark-dot").setAttribute("opacity", "0");
      }
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", leave);

    // Drag to pan (mouse / pen); touch scrolls natively
    sc.addEventListener("pointerdown", (ev) => {
      if (!scrollable || ev.pointerType === "touch" || ev.button !== 0) return;
      dragging = { x: ev.clientX, left: sc.scrollLeft, moved: false };
      sc.setPointerCapture(ev.pointerId);
    });
    sc.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - dragging.x;
      if (Math.abs(dx) > 3) {
        dragging.moved = true;
        sc.classList.add("dragging");
        leave();
      }
      sc.scrollLeft = dragging.left - dx;
    });
    const endDrag = () => {
      dragging = null;
      sc.classList.remove("dragging");
    };
    sc.addEventListener("pointerup", endDrag);
    sc.addEventListener("pointercancel", endDrag);

    // Pinch / ⌘-Ctrl + wheel to zoom around the cursor
    sc.addEventListener(
      "wheel",
      (ev) => {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        const r = sc.getBoundingClientRect();
        zoomChart(st, Math.exp(-ev.deltaY * 0.01), ev.clientX - r.left);
      },
      { passive: false }
    );
  }

  function zoomChart(st, factor, atPx) {
    const sc = st.el.querySelector(".chart-scroll");
    if (!sc || !st.cur) return;
    const px = atPx ?? sc.clientWidth / 2;
    st.anchorFrac = (sc.scrollLeft + px) / sc.scrollWidth;
    st.anchorPx = px;
    st.pinEnd = false;
    st.step = Math.min(MAX_STEP, Math.max(st.cur.fit, st.cur.step * factor));
    drawChart(st);
  }

  function updateZoomButtons(st, active) {
    const z = st.card.querySelector(".zoom");
    if (!z) return;
    const c = st.cur;
    const show = active && c && (c.auto > c.fit + 0.5 || c.step > c.fit + 0.5);
    z.hidden = !show;
    if (!show) return;
    z.querySelector('[data-zoom="out"]').disabled = c.step <= c.fit + 0.01;
    z.querySelector('[data-zoom="in"]').disabled = c.step >= MAX_STEP - 0.01;
  }

  // Breakdowns: donut, pie, horizontal bars, table
  function drawCat(el, rows, type, spec) {
    const total = rows.reduce((s, r) => s + r.value, 0);
    if (!total) return emptyChart(el);
    const pct = (v) => `${Math.round((v / total) * 100)}%`;
    const pick = spec.onSelect;
    if (type === "table") {
      tableView(el, rows.map((r) => [r.label, r.value, pct(r.value)]), [spec.colLabel || "Name", "Count", "Share"]);
      return;
    }
    if (type === "bars") {
      const max = Math.max(...rows.map((r) => r.value));
      el.innerHTML = `<div class="hbars">${rows
        .slice(0, 12)
        .map((r) => `<div class="hbar ${pick ? "clickable" : ""}" data-k="${escapeHtml(r.key)}" title="${escapeHtml(`${r.label}: ${fmt(r.value)} (${pct(r.value)})`)}">
          <span class="l">${escapeHtml(r.label)}</span><span class="v">${fmt(r.value)} <span class="muted">· ${pct(r.value)}</span></span>
          <span class="t"><span style="width:${((r.value / max) * 100).toFixed(1)}%;${spec.colored && r.color ? `--hb:${r.color}` : ""}"></span></span></div>`)
        .join("")}</div>`;
      if (pick) el.querySelectorAll(".hbar").forEach((b) => b.addEventListener("click", () => pick(b.dataset.k)));
      return;
    }
    // donut / pie: at most 7 slices + Other, colours in fixed slot order
    let slices = rows.slice(0, 7).map((r, i) => ({ ...r, color: r.color || SERIES_SLOTS[i] }));
    const rest = rows.slice(7).reduce((s, r) => s + r.value, 0);
    if (rest) slices.push({ key: "__other", label: "Other", value: rest, color: "var(--text-3)" });
    const R = 50;
    const r0 = type === "donut" ? 31 : 0;
    let a = -Math.PI / 2;
    const arc = (s) => {
      const frac = s.value / total;
      const a1 = a + frac * Math.PI * 2;
      const large = a1 - a > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${(50 + rad * Math.cos(ang)).toFixed(3)},${(50 + rad * Math.sin(ang)).toFixed(3)}`;
      let d;
      if (frac >= 0.9999) d = r0 ? `M50,0A50,50 0 1 1 49.99,0ZM50,${50 - r0}A${r0},${r0} 0 1 0 50.01,${50 - r0}Z` : `M50,0A50,50 0 1 1 49.99,0Z`;
      else if (r0) d = `M${p(R, a)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a)}Z`;
      else d = `M50,50L${p(R, a)}A${R},${R} 0 ${large} 1 ${p(R, a1)}Z`;
      a = a1;
      return d;
    };
    const paths = slices.map((s, i) => `<path class="slice" data-i="${i}" d="${arc(s)}" style="fill:${s.color}" fill-rule="evenodd"/>`).join("");
    const center = r0 ? `<text class="donut-total" x="50" y="52" text-anchor="middle" font-size="15">${shortNum(total)}</text><text class="donut-cap" x="50" y="64.5" text-anchor="middle" font-size="6.5">total</text>` : "";
    el.classList.add("cat");
    el.innerHTML = `<div class="donut-wrap"><svg viewBox="-2 -2 104 104" role="img" aria-label="${escapeHtml(spec.title)}">${paths}${center}</svg>
      <div class="legend">${slices
        .map((s, i) => `<div class="legend-row ${pick && s.key !== "__other" ? "clickable" : ""}" data-i="${i}"><i style="background:${s.color}"></i><span class="l">${escapeHtml(s.label)}</span><span class="v">${fmt(s.value)}</span><span class="p">${pct(s.value)}</span></div>`)
        .join("")}</div></div>`;
    const svgEl = el.querySelector("svg");
    const focus = (i) => {
      el.classList.toggle("hovering", i !== null);
      el.querySelectorAll(".slice").forEach((p) => p.classList.toggle("on", Number(p.dataset.i) === i));
      el.querySelectorAll(".legend-row").forEach((p) => p.classList.toggle("on", Number(p.dataset.i) === i));
    };
    el.querySelectorAll(".slice, .legend-row").forEach((node) => {
      const i = Number(node.dataset.i);
      node.addEventListener("pointerenter", (ev) => {
        focus(i);
        if (node.classList.contains("slice")) {
          const r = el.getBoundingClientRect();
          showTip(el, ev.clientX - r.left, ev.clientY - r.top, `${escapeHtml(slices[i].label)} · <b>${fmt(slices[i].value)}</b> (${pct(slices[i].value)})`);
        }
      });
      node.addEventListener("pointermove", (ev) => {
        if (!node.classList.contains("slice")) return;
        const r = el.getBoundingClientRect();
        showTip(el, ev.clientX - r.left, ev.clientY - r.top, `${escapeHtml(slices[i].label)} · <b>${fmt(slices[i].value)}</b> (${pct(slices[i].value)})`);
      });
      node.addEventListener("pointerleave", () => {
        focus(null);
        hideTip(el);
      });
      if (pick && slices[i].key !== "__other") node.addEventListener("click", () => pick(slices[i].key));
    });
    void svgEl;
  }

  // ── Chart cards ─────────────────────────────────────────────────────
  function initCharts() {
    for (const card of document.querySelectorAll("[data-chart]")) {
      const id = card.dataset.chart;
      const spec = CHARTS[id];
      if (!spec) continue;
      const types = TYPE_SETS[spec.kind];
      let type = prefGet(`chart_${id}`, spec.def);
      if (!types.includes(type)) type = spec.def;
      card.innerHTML = `<div class="card-head"><div><h3 class="card-title">${escapeHtml(spec.title)}</h3><p class="card-sub"></p></div>
        <div class="card-tools">${spec.kind === "series" ? `<div class="zoom" role="group" aria-label="Zoom" hidden><button type="button" data-zoom="out" title="Zoom out" aria-label="Zoom out"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h9"/></svg></button><button type="button" data-zoom="in" title="Zoom in" aria-label="Zoom in"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h9M8 3.5v9"/></svg></button><button type="button" data-zoom="fit" title="Fit all" aria-label="Fit all"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg></button></div>` : ""}<div class="types" role="group" aria-label="Chart type">${types
          .map((t) => `<button type="button" data-type="${t}" aria-pressed="${t === type}" title="${TYPE_LABEL[t]}" aria-label="${TYPE_LABEL[t]}">${TYPE_ICON[t]}</button>`)
          .join("")}</div></div></div><div class="chart ${spec.tall ? "tall" : ""}"></div>`;
      const st = { card, spec, el: card.querySelector(".chart"), type, data: [], w: 0, step: null, pinEnd: true };
      chartState.set(id, st);
      card.querySelector(".zoom")?.addEventListener("click", (e) => {
        const b = e.target.closest("[data-zoom]");
        if (!b || b.disabled) return;
        if (b.dataset.zoom === "fit") {
          st.step = 0; // smallest = everything visible
          st.pinEnd = true;
          drawChart(st);
        } else zoomChart(st, b.dataset.zoom === "in" ? 1.5 : 1 / 1.5);
      });
      card.querySelector(".types").addEventListener("click", (e) => {
        const b = e.target.closest("[data-type]");
        if (!b) return;
        st.type = b.dataset.type;
        prefSet(`chart_${id}`, st.type);
        card.querySelectorAll(".types button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        drawChart(st);
      });
    }
    if ("ResizeObserver" in window) {
      const ro = new ResizeObserver(() => {
        if (state.viewMode !== "analytics") return;
        requestAnimationFrame(() => {
          for (const st of chartState.values()) if (st.el.clientWidth !== st.w) drawChart(st);
          renderHeatmap(lastHeatItems);
        });
      });
      for (const st of chartState.values()) ro.observe(st.el);
    }
  }

  function drawChart(st) {
    st.w = st.el.clientWidth;
    st.el.classList.remove("cat", "hovering");
    if (st.spec.kind === "cat") drawCat(st.el, st.data, st.type, st.spec);
    else drawSeries(st);
  }

  // ── Data for each chart ─────────────────────────────────────────────
  function monthKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  function dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function weekStart(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - x.getDay());
    return x;
  }
  const fmtDate = (d, o) => d.toLocaleDateString("en-US", o);

  function periodBounds(defaultDays) {
    const b = rangeBounds();
    if (b) return { from: b.from, to: b.year ? new Date(Math.min(b.to, Date.now())) : new Date(), year: b.year };
    return { from: defaultDays ? new Date(Date.now() - defaultDays * DAY_MS) : null, to: new Date() };
  }

  // When the person was involved: the day they opened it, or — for threads
  // they joined — the latest activity (GitHub search has no comment dates),
  // never earlier than the day their account was created.
  function actAt(i) {
    let t = i.bucket === "created" || !i.bucket ? i.createdAt : i.updatedAt || i.createdAt;
    const join = state.profile?.created_at;
    if (join && t && t < join) t = join;
    return t || "";
  }

  function monthlySeries(items, cumulativeAll) {
    const counts = countBy(items, (i) => actAt(i).slice(0, 7));
    const b = periodBounds(0);
    let start;
    if (b.from) start = new Date(b.from.getFullYear(), b.from.getMonth(), 1);
    else {
      const first = Array.from(counts.keys()).filter(Boolean).sort()[0];
      if (!first) return [];
      start = new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, 1);
    }
    const out = [];
    const d = new Date(start);
    const many = (b.to.getFullYear() - start.getFullYear()) * 12 + b.to.getMonth() - start.getMonth() > 18;
    while (d <= b.to) {
      const k = monthKey(d);
      out.push({ label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, short: many ? (d.getMonth() === 0 ? String(d.getFullYear()) : "") : MONTHS[d.getMonth()], value: counts.get(k) || 0 });
      d.setMonth(d.getMonth() + 1);
    }
    void cumulativeAll;
    return out;
  }

  function weeklySeries(items) {
    const b = periodBounds(364);
    const counts = countBy(items, (i) => dayKey(weekStart(new Date(actAt(i)))));
    const out = [];
    const d = weekStart(b.from);
    while (d <= b.to) {
      const k = dayKey(d);
      out.push({ label: `Week of ${fmtDate(d, { month: "short", day: "numeric" })}`, full: `Week of ${fmtDate(d, { month: "short", day: "numeric", year: "numeric" })}`, short: d.getDate() <= 7 ? MONTHS[d.getMonth()] : "", value: counts.get(k) || 0 });
      d.setDate(d.getDate() + 7);
    }
    return out;
  }

  function dailySeries(items) {
    const r = state.dateRange;
    if (r === "1d") {
      const counts = countBy(items, (i) => {
        const d = new Date(actAt(i));
        return Date.now() - d < DAY_MS ? `${dayKey(d)} ${d.getHours()}` : null;
      });
      const out = [];
      const d = new Date(Date.now() - 23 * 3600000);
      d.setMinutes(0, 0, 0);
      for (let h = 0; h < 24; h++) {
        out.push({ label: `${String(d.getHours()).padStart(2, "0")}:00`, full: `${fmtDate(d, { month: "short", day: "numeric" })}, ${String(d.getHours()).padStart(2, "0")}:00`, short: h % 4 === 0 ? `${d.getHours()}h` : "", value: counts.get(`${dayKey(d)} ${d.getHours()}`) || 0 });
        d.setHours(d.getHours() + 1);
      }
      return out;
    }
    const b = periodBounds(r === "all" || r === "1y" ? 89 : 89);
    const from = r === "1y" || r === "all" ? new Date(Date.now() - 89 * DAY_MS) : b.from;
    const counts = countBy(items, (i) => dayKey(new Date(actAt(i))));
    const out = [];
    const d = new Date(from);
    d.setHours(0, 0, 0, 0);
    const end = b.to;
    while (d <= end) {
      out.push({ label: fmtDate(d, { month: "short", day: "numeric" }), full: fmtDate(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" }), short: d.getDate() === 1 || out.length === 0 ? fmtDate(d, { month: "short", day: "numeric" }) : "", value: counts.get(dayKey(d)) || 0 });
      d.setDate(d.getDate() + 1);
    }
    if (out.length <= 31) out.forEach((p, i) => (p.short = i % 7 === 0 ? p.label : ""));
    return out;
  }

  function yearlySeries(all) {
    const counts = countBy(all, (i) => actAt(i).slice(0, 4));
    const years = Array.from(counts.keys()).filter(Boolean).map(Number);
    if (!years.length) return [];
    const out = [];
    for (let y = Math.min(...years); y <= new Date().getFullYear(); y++) out.push({ label: String(y), value: counts.get(String(y)) || 0 });
    return out;
  }

  function binSeries(values, bins) {
    const c = bins.map(() => 0);
    for (const v of values) c[bins.findIndex(([, lim]) => v < lim)]++;
    return bins.map(([label], i) => ({ label, value: c[i] }));
  }

  const statusColor = { open: "var(--open)", merged: "var(--merged)", closed: "var(--closed)", draft: "var(--draft)", "not-planned": "var(--draft)" };

  function filterFeed(patch) {
    Object.assign(state.filters, { kind: "all", status: "all", role: "all", repo: "all" }, patch);
    switchView("feed");
    onFiltersChanged();
  }

  const CHARTS = {
    monthly: { title: "Monthly", kind: "series", def: "bar", sub: () => "Their activity each month", data: (c) => monthlySeries(c.items) },
    weekly: { title: "Weekly", kind: "series", def: "bar", sub: () => `Their activity each week${rangeBounds() ? "" : ", last 52 weeks"}`, data: (c) => weeklySeries(c.items) },
    daily: { title: "Daily", kind: "series", def: "bar", sub: () => (state.dateRange === "1d" ? "Activity per hour, last 24 hours" : /^(all|1y)$/.test(state.dateRange) ? "Activity per day, last 90 days" : "Activity per day"), data: (c) => dailySeries(c.items) },
    yearly: { title: "Yearly", kind: "series", def: "bar", sub: () => "Activity each year, all time", data: (c) => yearlySeries(c.all) },
    growth: { title: "Growth", kind: "series", def: "cumulative", sub: () => "Running total of their activity", data: (c) => monthlySeries(c.items) },
    weekday: { title: "By weekday", kind: "bins", def: "bar", sub: () => "When they open PRs and issues (your local time)", data: (c) => { const m = countBy(c.mine, (i) => new Date(i.createdAt).getDay()); return DAY_NAMES.map((n, i) => ({ label: n, value: m.get(i) || 0 })); } },
    hour: { title: "By hour of day", kind: "bins", def: "bar", sub: () => "When they open PRs and issues (your local time)", data: (c) => { const m = countBy(c.mine, (i) => new Date(i.createdAt).getHours()); return Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, "0")}:00`, short: h % 3 === 0 ? `${h}h` : "", value: m.get(h) || 0 })); } },
    mergeTime: { title: "Time to merge", kind: "bins", def: "bar", sub: () => "How long their merged PRs took", data: (c) => binSeries(c.mergeHours, [["< 1h", 1], ["< 1d", 24], ["1–7d", 168], ["1–4w", 672], ["1–3mo", 2160], ["> 3mo", Infinity]]) },
    discussion: { title: "Discussion size", kind: "bins", def: "bar", sub: () => "Comments per PR or issue", data: (c) => binSeries(c.items.map((i) => i.commentsCount || 0), [["0", 1], ["1–2", 3], ["3–5", 6], ["6–10", 11], ["11–25", 26], ["26+", Infinity]]) },
    prStatus: {
      title: "Pull requests", kind: "cat", def: "donut", colored: true, colLabel: "Status", sub: () => "Status of PRs they opened",
      data: (c) => [["merged", "Merged"], ["open", "Open"], ["draft", "Draft"], ["closed", "Closed"]].map(([k, l]) => ({ key: k, label: l, color: statusColor[k], value: c.mine.filter((i) => i.kind === "pr" && i.status === k).length })).filter((r) => r.value),
      onSelect: (k) => filterFeed({ kind: "pr", role: "created", status: k }),
    },
    issueStatus: {
      title: "Issues", kind: "cat", def: "donut", colored: true, colLabel: "Status", sub: () => "Status of issues they opened",
      data: (c) => [["open", "Open", "var(--open)"], ["closed", "Closed", "var(--merged)"], ["not-planned", "Not planned", "var(--draft)"]].map(([k, l, col]) => ({ key: k, label: l, color: col, value: c.mine.filter((i) => i.kind === "issue" && i.status === k).length })).filter((r) => r.value),
      onSelect: (k) => filterFeed({ kind: "issue", role: "created", status: k }),
    },
    involvement: {
      title: "Involvement", kind: "cat", def: "donut", colored: true, colLabel: "Role", sub: () => "Each item counted once, by strongest link",
      data: (c) => { const m = countBy(c.items, (i) => i.bucket); return REL_ORDER.map((b) => ({ key: b, label: ROLE_TEXT[b], color: ROLE_COLOR[b], value: m.get(b) || 0 })).filter((r) => r.value); },
      onSelect: (k) => filterFeed({ role: k }),
    },
    repos: {
      title: "Repositories", kind: "cat", def: "bars", colLabel: "Repository", sub: (c) => `${fmt(new Set(c.items.map((i) => i.repo)).size)} repositories`,
      data: (c) => Array.from(countBy(c.items, (i) => i.repo).entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: k, value: v })),
      onSelect: (k) => filterFeed({ repo: k }),
    },
    labels: {
      title: "Labels", kind: "cat", def: "bars", colLabel: "Label", sub: () => "Most common labels on their work",
      data: (c) => { const m = new Map(); for (const i of c.items) for (const l of i.labels || []) m.set(l.name, (m.get(l.name) || 0) + 1); return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: k, value: v })); },
    },
    people: {
      title: "People", kind: "cat", def: "bars", colLabel: "Author", sub: () => "Authors of the PRs and issues they joined",
      data: (c) => { const u = state.login.toLowerCase(); return Array.from(countBy(c.items.filter((i) => i.author.toLowerCase() !== u), (i) => i.author).entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: `@${k}`, value: v })); },
    },
  };

  // ── Analytics render ────────────────────────────────────────────────
  let lastHeatItems = [];

  function renderAnalytics() {
    const items = getItemsForCurrentDateRange();
    const all = Array.from(state.itemsMap.values());
    const mine = items.filter((i) => i.bucket === "created");
    const mergeHours = mine.filter((i) => i.kind === "pr" && i.mergedAt).map((i) => (new Date(i.mergedAt) - new Date(i.createdAt)) / 3600000).sort((a, b) => a - b);
    const ctx = { items, all, mine, mergeHours };
    const total = lifetimeTotal();
    const dateNote = " Dates show when they opened an item, or the latest activity on threads they joined.";
    dom.anNote.textContent = (loadedEverything()
      ? `${fmt(items.length)} items${rangeBounds() ? ` in ${rangeBounds().year || `the last ${rangeBounds().label}`}` : ""}.`
      : `Based on ${fmt(state.itemsMap.size)} of ${fmt(total)} items loaded so far — charts update as the rest arrives.`) + dateNote;
    renderTiles(ctx);
    const periodKey = `${state.login}|${state.dateRange}`;
    for (const [id, st] of chartState) {
      if (st.periodKey !== periodKey) {
        st.periodKey = periodKey;
        st.step = null;
        st.pinEnd = true;
      }
      st.data = CHARTS[id].data(ctx);
      st.card.querySelector(".card-sub").textContent = CHARTS[id].sub(ctx);
      drawChart(st);
    }
    lastHeatItems = all;
    renderHeatmap(all);
  }

  function renderTiles(c) {
    const prs = c.mine.filter((i) => i.kind === "pr");
    const merged = prs.filter((i) => i.status === "merged").length;
    const issues = c.mine.filter((i) => i.kind === "issue");
    const closedIssues = issues.filter((i) => i.status !== "open").length;
    const days = new Set(c.mine.map((i) => dayKey(new Date(i.createdAt))));
    let longest = 0;
    let run = 0;
    let prev = null;
    for (const k of Array.from(days).sort()) {
      const d = new Date(`${k}T00:00:00`);
      run = prev && (d - prev) / DAY_MS < 1.5 ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = d;
    }
    let current = 0;
    const cur = new Date();
    if (!days.has(dayKey(cur))) cur.setDate(cur.getDate() - 1);
    while (days.has(dayKey(cur))) {
      current++;
      cur.setDate(cur.getDate() - 1);
    }
    let busiest = null;
    for (const [k, n] of countBy(c.mine, (i) => dayKey(new Date(i.createdAt)))) if (!busiest || n > busiest[1]) busiest = [k, n];
    const med = c.mergeHours.length ? c.mergeHours[Math.floor(c.mergeHours.length / 2)] : null;
    const dur = (h) => (h === null ? "—" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
    const pc = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
    const tiles = [
      ["PRs opened", fmt(prs.length), `${fmt(merged)} merged`],
      ["Merge rate", pc(merged, prs.length), "of PRs they opened"],
      ["Issues opened", fmt(issues.length), `${fmt(closedIssues)} closed`],
      ["Issues closed", pc(closedIssues, issues.length), "of issues they opened"],
      ["Repositories", fmt(new Set(c.items.map((i) => i.repo)).size), "with activity"],
      ["Active days", fmt(days.size), "days they opened something"],
      ["Longest streak", `${fmt(longest)} d`, "days in a row"],
      ["Current streak", `${fmt(current)} d`, current ? "still going" : "not active today"],
      ["Median time to merge", dur(med), `${fmt(c.mergeHours.length)} merged PRs`],
      ["Busiest day", busiest ? fmt(busiest[1]) : "—", busiest ? fmtDate(new Date(`${busiest[0]}T00:00:00`), { month: "short", day: "numeric", year: "numeric" }) : "—"],
    ];
    dom.tiles.innerHTML = tiles.map(([l, v, s]) => `<div class="tile"><div class="tile-label">${l}</div><div class="tile-value">${v}</div><div class="tile-sub">${escapeHtml(s)}</div></div>`).join("");
  }

  // Calendar heatmap: fits the card width, its own year picker
  const heatDd = createDropdown(dom.heatmapYear, { alignRight: true, onChange: (v) => { state.heatYear = v; renderHeatmap(lastHeatItems); } });

  function renderHeatmap(items) {
    const years = yearsAvailable();
    heatDd.set({ options: [{ value: "recent", label: "Last 12 months" }, { sep: true }, ...years.map((y) => ({ value: String(y), label: String(y) }))], value: state.heatYear });
    const el = dom.heatmapCalendar;
    const W = el.parentElement.clientWidth;
    if (!W) return;
    const counts = countBy(items, (i) => dayKey(new Date(actAt(i))));
    const year = state.heatYear === "recent" ? null : Number(state.heatYear);
    const start = year ? new Date(year, 0, 1) : new Date(Date.now() - 364 * DAY_MS);
    start.setHours(0, 0, 0, 0);
    const end = year ? new Date(year, 11, 31) : new Date();
    const first = weekStart(start);
    const cols = Math.ceil((end - first) / DAY_MS / 7) + 1;
    const left = 30;
    const top = 18;
    const gap = 3;
    const cell = Math.max(9, Math.min(20, Math.floor((W - left) / cols) - gap));
    const stride = cell + gap;
    const width = left + cols * stride;
    const height = top + 7 * stride;
    let svg = `<svg class="heat" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Contribution calendar">`;
    [1, 3, 5].forEach((d) => (svg += `<text class="ax" x="0" y="${top + d * stride + cell - 1}">${DAY_NAMES[d]}</text>`));
    let total = 0;
    let lastMonth = -1;
    const d = new Date(first);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < 7; r++) {
        const inRange = d >= start && d <= end;
        const k = dayKey(d);
        const n = inRange ? counts.get(k) || 0 : 0;
        if (inRange) total += n;
        if (r === 0 && d.getMonth() !== lastMonth && d.getDate() <= 7 && inRange) {
          lastMonth = d.getMonth();
          svg += `<text class="ax" x="${left + c * stride}" y="11">${MONTHS[lastMonth]}</text>`;
        }
        if (inRange || d < end) {
          const lvl = n >= 10 ? 4 : n >= 6 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0;
          svg += `<rect class="c l${lvl}${inRange ? "" : " out"}" x="${left + c * stride}" y="${top + r * stride}" width="${cell}" height="${cell}" rx="2"><title>${n} on ${fmtDate(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</title></rect>`;
        }
        d.setDate(d.getDate() + 1);
      }
    }
    el.innerHTML = `${svg}</svg>`;
    const hs = el.parentElement;
    if (hs.scrollWidth > hs.clientWidth) hs.scrollLeft = hs.scrollWidth;
    dom.heatmapCountLabel.textContent = `${fmt(total)} contributions ${year ? `in ${year}` : "in the last 12 months"}`;
  }

  // ── View switching ──────────────────────────────────────────────────
  function switchView(mode) {
    state.viewMode = mode;
    const analytics = mode === "analytics";
    dom.tabBtnAnalytics.setAttribute("aria-selected", String(analytics));
    dom.tabBtnFeed.setAttribute("aria-selected", String(!analytics));
    dom.analyticsView.style.display = analytics ? "block" : "none";
    dom.feedView.style.display = analytics ? "none" : "block";
    renderAll();
  }
  dom.tabBtnFeed.addEventListener("click", () => switchView("feed"));
  dom.tabBtnAnalytics.addEventListener("click", () => switchView("analytics"));

  // ── Search ──────────────────────────────────────────────────────────
  function bindSearch(form, input) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!parseLogin(input.value)) {
        input.setCustomValidity("Enter a GitHub username or profile link");
        input.reportValidity();
        return;
      }
      startTracking(input.value);
      input.blur();
    });
    input.addEventListener("input", () => input.setCustomValidity(""));
    input.addEventListener("paste", () => {
      setTimeout(() => {
        const v = input.value;
        if (/github\.com\//i.test(v) && parseLogin(v)) {
          input.value = parseLogin(v);
          startTracking(v);
        }
      }, 0);
    });
  }
  bindSearch(dom.searchForm, dom.searchInput);
  bindSearch(dom.headerForm, dom.headerInput);
  dom.inputClear.addEventListener("click", () => {
    dom.searchInput.value = "";
    dom.inputClear.style.display = "none";
    dom.searchInput.focus();
  });
  dom.searchInput.addEventListener("input", () => {
    dom.inputClear.style.display = dom.searchInput.value ? "block" : "none";
  });
  // ── Theme: System / Light / Dark ────────────────────────────────────
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  function effectiveTheme() {
    const t = document.documentElement.dataset.theme;
    return t === "light" || t === "dark" ? t : darkQuery.matches ? "dark" : "light";
  }
  const THEME_ICON = {
    system: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11.5V14" stroke-linecap="round"/></svg>`,
    light: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06"/></svg>`,
    dark: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.6A5.75 5.75 0 016.4 2.5a5.75 5.75 0 107.1 7.1z"/></svg>`,
  };
  const themeRoot = $("theme");
  const themeBtn = $("theme-btn");
  function updateFavicon() {
    const link = document.querySelector("link[rel='icon']");
    if (!link) return;
    const dark = effectiveTheme() === "dark";
    const bg = dark ? "%23f5f5f7" : "%231d1d1f";
    const bar = dark ? "%230a0a0b" : "%23f5f5f7";
    const hot = dark ? "%233b82f6" : "%232563eb";
    link.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='7' fill='${bg}'/%3E%3Crect x='6' y='12.5' width='3' height='5.5' rx='1.5' fill='${bar}'/%3E%3Crect x='10.5' y='9' width='3' height='9' rx='1.5' fill='${bar}'/%3E%3Crect x='15' y='5.5' width='3' height='12.5' rx='1.5' fill='${hot}'/%3E%3C/svg%3E`;
  }
  function applyTheme(choice) {
    if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
    prefSet("theme", choice);
    document.querySelectorAll("[data-theme-choice]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === choice)));
    themeBtn.innerHTML = THEME_ICON[choice] || THEME_ICON.system;
    themeBtn.title = `Theme: ${choice[0].toUpperCase()}${choice.slice(1)}`;
    updateFavicon();
    if (state.viewMode === "analytics") renderAnalytics();
  }
  const closeThemeMenu = () => {
    themeRoot.classList.remove("open");
    themeBtn.setAttribute("aria-expanded", "false");
  };
  themeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !themeRoot.classList.contains("open");
    themeRoot.classList.toggle("open", open);
    themeBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!themeRoot.contains(e.target)) closeThemeMenu();
  });
  document.querySelectorAll("[data-theme-choice]").forEach((b) =>
    b.addEventListener("click", () => {
      applyTheme(b.dataset.themeChoice);
      closeThemeMenu();
      themeBtn.focus();
    })
  );
  darkQuery.addEventListener?.("change", () => {
    if (prefGet("theme", "system") === "system") applyTheme("system");
  });

  // ── Keyboard ────────────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) && state.login) {
      e.preventDefault();
      switchView("feed");
      dom.filterText.focus();
    }
    if (e.key === "Escape") {
      closeThemeMenu();
      for (const d of openDropdowns) d.close();
    }
  });

  // ── Init ────────────────────────────────────────────────────────────
  async function detectLocalProxy() {
    if (!IS_LOCAL) return;
    try {
      const res = await fetch("/api/gh/rate_limit");
      if (res.ok && (res.headers.get("content-type") || "").includes("json")) {
        apiBase = "/api/gh";
        localProxy = true;
      }
    } catch {
      /* plain static server: talk to GitHub directly */
    }
  }

  async function init() {
    applyTheme(prefGet("theme", "system"));
    const yearEl = $("year");
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());
    initCharts();
    renderRangeControls();
    renderFilterControls();
    renderPageSize();
    cachePrune();
    window.addEventListener("pagehide", flushSnapshotNow);
    await detectLocalProxy();
    const params = new URLSearchParams(window.location.search);
    const initialName = params.get("name") || params.get("u") || "";
    if (initialName) startTracking(initialName);
  }

  init();
})();
