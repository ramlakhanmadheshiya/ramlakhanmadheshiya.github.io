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
    const rec = { login: state.login.toLowerCase(), items, syncedAt: state.syncStartedAt, savedAt: Date.now() };
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
  class BucketHarvester {
    constructor(bucket, q) {
      this.bucket = bucket;
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
    pageSize: FEED_PAGE_SIZE,
    viewMode: "feed",
    dateRange: "all",
    heatmapYear: "all",
    filters: { kind: "all", status: "all", role: "all", repo: "all", text: "" },
    expandedPreviews: new Set(),
    linkCache: new Map(),      // id -> Set of links found in the preview conversation
  };

  // ── DOM References ──────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const dom = {
    searchForm: $("search-form"),
    searchInput: $("search-input"),
    inputClear: $("input-clear"),
    btnSearch: $("btn-search"),
    quickPills: document.querySelectorAll(".quick-pill"),

    profileLine: $("profile-line"),
    telemetryBar: $("telemetry-bar"),
    statTotal: $("stat-total"),
    statTotalSub: $("stat-total-sub"),
    statPrs: $("stat-prs"),
    statPrsSub: $("stat-prs-sub"),
    statIssues: $("stat-issues"),
    statIssuesSub: $("stat-issues-sub"),
    statReviews: $("stat-reviews"),
    statComments: $("stat-comments"),

    streamBanner: $("stream-banner"),
    streamText: $("stream-text"),
    streamProgressFill: $("stream-progress-fill"),
    btnClearCache: $("btn-clear-cache"),
    btnExport: $("btn-export"),

    mainContent: $("main-content"),
    tabBtnFeed: $("tab-btn-feed"),
    tabBtnAnalytics: $("tab-btn-analytics"),
    feedView: $("feed-view"),
    analyticsView: $("analytics-view"),
    dateRangeSelect: $("date-range-select"),

    targetPrVal: $("target-pr-val"),
    targetPrBar: $("target-pr-bar"),
    targetPrSub: $("target-pr-sub"),
    targetPrStatus: $("target-pr-status"),
    targetMergeVal: $("target-merge-val"),
    targetMergeBar: $("target-merge-bar"),
    targetMergeSub: $("target-merge-sub"),
    targetMergeStatus: $("target-merge-status"),
    targetIssueVal: $("target-issue-val"),
    targetIssueBar: $("target-issue-bar"),
    targetIssueSub: $("target-issue-sub"),
    targetIssueStatus: $("target-issue-status"),
    targetRepoVal: $("target-repo-val"),
    targetRepoBar: $("target-repo-bar"),
    targetRepoSub: $("target-repo-sub"),
    targetRepoStatus: $("target-repo-status"),

    heatmapCalendar: $("heatmap-calendar"),
    heatmapSub: $("heatmap-sub"),
    heatmapYearPills: $("heatmap-year-pills"),
    heatmapCountLabel: $("heatmap-count-label"),
    donutSvgContainer: $("donut-svg-container"),
    donutLegend: $("donut-legend"),
    topReposList: $("top-repos-list"),
    yearlyChartContainer: $("yearly-chart-container"),
    monthlyChartContainer: $("monthly-chart-container"),

    filterKind: $("filter-kind"),
    wrapStatus: $("wrap-status"),
    filterStatus: $("filter-status"),
    filterRole: $("filter-role"),
    filterRepo: $("filter-repo"),
    filterText: $("filter-text"),

    pagerCount: $("pager-count"),
    pagerPrev: $("pager-prev"),
    pagerNext: $("pager-next"),
    pageButtons: $("page-buttons"),
    bottomSummary: $("bottom-summary"),

    listContainer: $("list-container"),
    listEmpty: $("list-empty"),
    listLoading: $("list-loading"),

    btnTheme: $("btn-theme"),
    iconSun: $("theme-icon-sun"),
    iconMoon: $("theme-icon-moon"),

    modalExport: $("modal-export"),
    modalExportClose: $("modal-export-close"),
    tabExportMd: $("tab-export-md"),
    tabExportJson: $("tab-export-json"),
    exportContent: $("export-content"),
    btnCopyExport: $("btn-copy-export"),
    btnDownloadExport: $("btn-download-export"),
  };

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

  // ── Date Filtering Helper ───────────────────────────────────────────
  function getItemsForCurrentDateRange() {
    const all = Array.from(state.itemsMap.values());
    if (state.dateRange === "all") return all;

    const now = Date.now();
    if (state.dateRange === "30d") {
      const cutoff = now - 30 * 24 * 60 * 60 * 1000;
      return all.filter((i) => new Date(i.createdAt).getTime() >= cutoff || new Date(i.updatedAt).getTime() >= cutoff);
    }
    if (state.dateRange === "90d") {
      const cutoff = now - 90 * 24 * 60 * 60 * 1000;
      return all.filter((i) => new Date(i.createdAt).getTime() >= cutoff || new Date(i.updatedAt).getTime() >= cutoff);
    }

    const targetYear = parseInt(state.dateRange, 10);
    if (!isNaN(targetYear)) {
      return all.filter((i) => {
        const cy = new Date(i.createdAt).getFullYear();
        const uy = new Date(i.updatedAt).getFullYear();
        return cy === targetYear || uy === targetYear;
      });
    }

    return all;
  }

  // ── Fetch & Background Stream Engine ────────────────────────────────
  let activeSearchId = 0;



  // ── Start tracking a person ─────────────────────────────────────────
  async function startTracking(username) {
    const login = username.trim().replace(/^@/, "").replace(/^https?:\/\/github\.com\//i, "").split(/[/?#\s]/)[0];
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
      harvesters: REL_ORDER.map((b) => new BucketHarvester(b, bucketExpr(b, login))),
      counts: {},
      listReady: false,
      harvestDone: false,
      fromSnapshot: false,
      currentPage: 1,
    });
    state.expandedPreviews.clear();
    state.linkCache.clear();

    dom.searchInput.value = login;
    dom.inputClear.style.display = "block";
    history.replaceState(null, "", `?name=${encodeURIComponent(login)}`);
    dom.mainContent.style.display = "block";
    dom.telemetryBar.style.display = "grid";
    dom.streamBanner.style.display = "flex";
    dom.profileLine.style.display = "none";
    dom.listEmpty.style.display = "none";
    dom.listContainer.innerHTML = "";
    dom.listLoading.style.display = "flex";
    dom.btnSearch.disabled = true;
    dom.btnSearch.innerHTML = `<span class="loading-dots">Tracking<i></i><i></i><i></i></span>`;
    setBanner(`Fetching @${login} from GitHub…`, 5);
    renderOverview();
    populateRoleFilter();
    populateYears();
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
    apiGet(`/users/${encodeURIComponent(login)}`, { bucket: "core", priority: 0 })
      .then((p) => {
        if (isStale()) return;
        if (p.type === "Organization") {
          showFatal(`@${p.login} is an organization. ghtrack tracks people — try one of its members.`);
          state.gen++;
          return;
        }
        state.profile = p;
        renderProfile();
        populateYears();
      })
      .catch((err) => {
        if (isStale() || err.cancelled) return;
        if (err.status === 404) {
          showFatal(`No GitHub user named @${login} was found. Check the spelling.`);
          state.gen++;
        }
      });

    try {
      // 1. First 100 of every bucket: the newest list + exact bucket totals
      await Promise.all(state.harvesters.map((h) => firstPages(h, snap, isStale)));
      if (isStale()) return;
      state.listReady = true;
      dom.btnSearch.disabled = false;
      dom.btnSearch.textContent = "Track";
      loadExtraCounts(gen);
      renderAll();

      // 2. Everything else, 100 at a time, strongest link first
      for (const h of state.harvesters) {
        while (!h.done && bucketLoaded(h.bucket) < (h.total || 0)) {
          const items = await h.next(3, isStale);
          if (isStale()) return;
          mergeItems(items, h.bucket);
        }
      }
      state.harvestDone = true;
      flushSnapshotNow();
      renderAll();
    } catch (err) {
      if (isStale() || err.cancelled) return;
      if (err.status === 422 && !state.itemsMap.size) {
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

  async function firstPages(h, snap, isStale) {
    let items = await h.next(0, isStale);
    if (isStale()) return;
    mergeItems(items, h.bucket);
    state.counts[h.bucket] = h.total;
    renderOverview();
    populateRoleFilter();
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
      for (const it of state.itemsMap.values()) if (it.bucket === h.bucket && (!oldest || it.updatedAt < oldest)) oldest = it.updatedAt;
      if (oldest) h.resumeBefore(oldest);
    }
  }

  function bucketLoaded(bucket) {
    let n = 0;
    for (const it of state.itemsMap.values()) if (it.bucket === bucket) n++;
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

  // Background counts that need their own search
  function loadExtraCounts(gen) {
    const u = state.login;
    const isStale = () => gen !== state.gen;
    const jobs = { prs: [`author:${u} is:pr`, 1], merged: [`author:${u} is:pr is:merged`, 2], openIssues: [`author:${u} is:issue is:open`, 2] };
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
    setBanner(`⚠ ${message}`, 0);
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
    const since = p.created_at ? new Date(p.created_at).getFullYear() : "";
    dom.profileLine.innerHTML = `
      <img src="${escapeHtml(p.avatar_url)}&s=64" alt="" width="28" height="28" />
      <span><strong>${escapeHtml(p.name || p.login)}</strong> <a href="${escapeHtml(p.html_url)}" target="_blank" rel="noopener">@${escapeHtml(p.login)}</a></span>
      ${since ? `<span class="profile-since">on GitHub since ${since}</span>` : ""}`;
    dom.profileLine.style.display = "flex";
  }

  // ── Header numbers (exact, from GitHub counts) ──────────────────────
  function bucketTotalsKnown() {
    return REL_ORDER.every((b) => state.counts[b] !== undefined);
  }

  function lifetimeTotal() {
    return bucketTotalsKnown() ? REL_ORDER.reduce((s, b) => s + state.counts[b], 0) : undefined;
  }

  function renderOverview() {
    const c = state.counts;
    dom.statTotal.textContent = fmt(lifetimeTotal());
    dom.statPrs.textContent = fmt(c.prs);
    dom.statPrsSub.textContent = c.prs !== undefined && c.merged !== undefined ? `${c.prs ? Math.round((c.merged / c.prs) * 100) : 0}% merged · ${fmt(c.merged)} merged` : " ";
    const issues = c.created !== undefined && c.prs !== undefined ? c.created - c.prs : undefined;
    dom.statIssues.textContent = fmt(issues);
    dom.statIssuesSub.textContent = issues !== undefined && c.openIssues !== undefined ? `${fmt(c.openIssues)} open · ${fmt(issues - c.openIssues)} closed` : " ";
    dom.statReviews.textContent = fmt(c.reviewed);
    dom.statComments.textContent = fmt(c.commented);
  }

  // ── Status banner (no countdowns, no rate-limit talk) ───────────────
  function setBanner(text, pct) {
    dom.streamText.textContent = text;
    dom.streamProgressFill.style.width = `${pct}%`;
  }

  function renderBanner() {
    if (!state.login || dom.telemetryBar.style.display === "none") return;
    const total = lifetimeTotal();
    const loaded = state.itemsMap.size;
    if (!state.listReady) return setBanner(`Fetching @${state.login} from GitHub…`, 5);
    if (state.harvestDone || (total !== undefined && loaded >= total)) {
      return setBanner(`✓ All ${fmt(loaded)} lifetime items loaded for @${state.login}`, 100);
    }
    const pct = total ? Math.max(5, Math.min(99, Math.round((loaded / total) * 100))) : 10;
    setBanner(`✓ Lifetime numbers ready · loading full list: ${fmt(loaded)} of ${fmt(total)}`, pct);
  }

  // ── Filters ─────────────────────────────────────────────────────────
  const ROLE_TEXT = {
    created: "Created",
    assigned: "Assigned",
    reviewed: "Reviewed",
    commented: "Commented",
    other: "Mentioned / other",
  };

  function populateRoleFilter() {
    const u = state.login || "user";
    const total = lifetimeTotal();
    dom.filterRole.title = `How @${u} is involved. Each item is counted once, under its strongest link: created › assigned › reviewed › commented › mentioned.`;
    let html = `<option value="all">Any role${total !== undefined ? ` (${fmt(total)})` : ""}</option>`;
    for (const b of REL_ORDER) {
      const n = state.counts[b];
      html += `<option value="${b}">${escapeHtml(ROLE_TEXT[b].replace("{u}", u))}${n !== undefined ? ` (${fmt(n)})` : ""}</option>`;
    }
    dom.filterRole.innerHTML = html;
    dom.filterRole.value = state.filters.role;
  }

  function populateYears() {
    const current = state.dateRange;
    const nowYear = new Date().getFullYear();
    const fromYear = state.profile?.created_at ? new Date(state.profile.created_at).getFullYear() : nowYear - 3;
    let html = `<option value="all">Lifetime (All Time)</option>`;
    for (let y = nowYear; y >= fromYear; y--) html += `<option value="${y}">Year ${y}</option>`;
    html += `<option value="90d">Last 90 Days</option><option value="30d">Last 30 Days</option>`;
    dom.dateRangeSelect.innerHTML = html;
    dom.dateRangeSelect.value = current;
    if (dom.dateRangeSelect.value !== current) {
      state.dateRange = "all";
      dom.dateRangeSelect.value = "all";
    }
  }

  function populateRepoFilter() {
    const all = getItemsForCurrentDateRange();
    const counts = countBy(all, (i) => i.repo);
    const current = state.filters.repo;
    let html = `<option value="all">All Repositories (${fmt(all.length)})</option>`;
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (current !== "all" && !counts.has(current)) html += `<option value="${escapeHtml(current)}">${escapeHtml(current)} (0)</option>`;
    for (const [repo, n] of sorted) html += `<option value="${escapeHtml(repo)}">${escapeHtml(repo)} (${fmt(n)})</option>`;
    dom.filterRepo.innerHTML = html;
    dom.filterRepo.value = current;
  }

  function syncStatusOptions() {
    const kind = state.filters.kind;
    const opts = [["all", "All States"], ["open", "Open"]];
    if (kind !== "issue") opts.push(["draft", "Draft"], ["merged", "Merged"]);
    opts.push(["closed", "Closed"]);
    if (kind !== "pr") opts.push(["not-planned", "Not planned"]);
    if (!opts.some(([v]) => v === state.filters.status)) state.filters.status = "all";
    dom.filterStatus.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    dom.filterStatus.value = state.filters.status;
  }

  function getFilteredItems() {
    const f = state.filters;
    let items = getItemsForCurrentDateRange();
    if (f.kind !== "all") items = items.filter((i) => i.kind === f.kind);
    if (f.status !== "all") items = items.filter((i) => i.status === f.status);
    if (f.role !== "all") items = items.filter((i) => i.bucket === f.role);
    if (f.repo !== "all") items = items.filter((i) => i.repo === f.repo);
    const q = f.text.toLowerCase().trim();
    if (q) items = items.filter((i) => i.title.toLowerCase().includes(q) || i.repo.toLowerCase().includes(q) || `#${i.number}`.includes(q.replace(/^#?/, "#")));
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return items;
  }

  function onFiltersChanged() {
    state.currentPage = 1;
    renderAll();
  }

  dom.filterKind.addEventListener("change", (e) => {
    state.filters.kind = e.target.value;
    syncStatusOptions();
    onFiltersChanged();
  });
  dom.filterStatus.addEventListener("change", (e) => {
    state.filters.status = e.target.value;
    onFiltersChanged();
  });
  dom.filterRole.addEventListener("change", (e) => {
    state.filters.role = e.target.value;
    onFiltersChanged();
  });
  dom.filterRepo.addEventListener("change", (e) => {
    state.filters.repo = e.target.value;
    onFiltersChanged();
  });
  dom.filterText.addEventListener("input", (e) => {
    state.filters.text = e.target.value;
    onFiltersChanged();
  });
  dom.dateRangeSelect.addEventListener("change", (e) => {
    state.dateRange = e.target.value;
    onFiltersChanged();
  });

  // Overview cards act as shortcuts
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
    dom.filterKind.value = state.filters.kind;
    dom.filterRole.value = state.filters.role;
    syncStatusOptions();
    switchView("feed");
    onFiltersChanged();
    dom.mainContent.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ── Rendering (throttled while data streams in) ─────────────────────
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, 250);
  }

  function renderAll() {
    renderBanner();
    populateRepoFilter();
    renderList();
    if (state.viewMode === "analytics") renderAnalytics();
  }

  function renderList() {
    const filtered = getFilteredItems();
    const total = filtered.length;
    if (!state.listReady && !total) {
      dom.listLoading.style.display = "flex";
      dom.listEmpty.style.display = "none";
      updatePagerUI(0);
      return;
    }
    dom.listLoading.style.display = "none";
    if (!total) {
      dom.listContainer.innerHTML = "";
      dom.listEmpty.style.display = "block";
      dom.listEmpty.querySelector("p").textContent = state.harvestDone ? "No matching GitHub work found under current filters." : "Nothing matches yet — the rest of the list is still loading.";
      updatePagerUI(0);
      return;
    }
    dom.listEmpty.style.display = "none";
    const totalPages = Math.ceil(total / state.pageSize);
    state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
    const start = (state.currentPage - 1) * state.pageSize;
    const pageItems = filtered.slice(start, start + state.pageSize);

    // Keep open previews and scroll position: only rebuild if the page changed
    const signature = pageItems.map((i) => `${i.id}|${i.updatedAt}|${i.bucket}`).join(",");
    if (signature !== dom.listContainer.dataset.signature) {
      dom.listContainer.dataset.signature = signature;
      const frag = document.createDocumentFragment();
      for (const item of pageItems) frag.appendChild(createItemRow(item));
      dom.listContainer.innerHTML = "";
      dom.listContainer.appendChild(frag);
    }
    updatePagerUI(total);
  }

  function updatePagerUI(total) {
    if (!total) {
      dom.pagerCount.textContent = "0 of 0";
      dom.pagerPrev.disabled = true;
      dom.pagerNext.disabled = true;
      dom.pageButtons.innerHTML = "";
      dom.bottomSummary.textContent = "0 items";
      return;
    }
    const totalPages = Math.ceil(total / state.pageSize);
    const start = (state.currentPage - 1) * state.pageSize + 1;
    const end = Math.min(state.currentPage * state.pageSize, total);
    dom.pagerCount.textContent = `${fmt(start)}–${fmt(end)} of ${fmt(total)}`;
    dom.pagerPrev.disabled = state.currentPage <= 1;
    dom.pagerNext.disabled = state.currentPage >= totalPages;

    dom.pageButtons.innerHTML = "";
    const maxButtons = 7;
    let startPage = Math.max(1, state.currentPage - 3);
    const endPage = Math.min(totalPages, startPage + maxButtons - 1);
    if (endPage - startPage < maxButtons - 1) startPage = Math.max(1, endPage - maxButtons + 1);
    if (startPage > 1) {
      addPageButton(1);
      if (startPage > 2) addEllipsis();
    }
    for (let p = startPage; p <= endPage; p++) addPageButton(p);
    if (endPage < totalPages) {
      if (endPage < totalPages - 1) addEllipsis();
      addPageButton(totalPages);
    }
    const loadedAll = state.harvestDone || (lifetimeTotal() !== undefined && state.itemsMap.size >= lifetimeTotal());
    dom.bottomSummary.textContent = `Page ${fmt(state.currentPage)} of ${fmt(totalPages)} · 50 items/page` +
      (loadedAll ? "" : ` · more arriving (${fmt(state.itemsMap.size)} of ${fmt(lifetimeTotal())} loaded so far)`);
  }

  function goToPage(p) {
    state.currentPage = p;
    renderList();
    dom.mainContent.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function addPageButton(pageNumber) {
    const btn = document.createElement("button");
    btn.className = `page-btn ${pageNumber === state.currentPage ? "active" : ""}`;
    btn.textContent = fmt(pageNumber);
    btn.type = "button";
    btn.addEventListener("click", () => goToPage(pageNumber));
    dom.pageButtons.appendChild(btn);
  }

  function addEllipsis() {
    const span = document.createElement("span");
    span.textContent = "…";
    span.style.padding = "4px";
    span.style.color = "var(--text-faint)";
    dom.pageButtons.appendChild(span);
  }

  dom.pagerPrev.addEventListener("click", () => {
    if (state.currentPage > 1) goToPage(state.currentPage - 1);
  });
  dom.pagerNext.addEventListener("click", () => {
    const totalPages = Math.ceil(getFilteredItems().length / state.pageSize);
    if (state.currentPage < totalPages) goToPage(state.currentPage + 1);
  });

  // ── How the person is linked to a row (plain words) ─────────────────
  const ROLE_VERB = { assigned: "assigned", reviewed: "reviewed", commented: "commented", mentioned: "mentioned", other: "mentioned" };

  function roleTagHtml(item) {
    if (item.bucket === "created" || !item.bucket) return "";
    const extra = state.linkCache.get(item.id);
    const verbs = [ROLE_VERB[item.bucket]];
    if (extra) for (const r of ["assigned", "reviewed", "commented", "mentioned"]) if (extra.has(r) && !verbs.includes(ROLE_VERB[r])) verbs.push(ROLE_VERB[r]);
    const text = item.bucket === "other" && !extra ? "mentioned / linked" : verbs.join(" · ");
    return `<span class="subline-tag role-note role-${item.bucket}" title="How @${escapeHtml(state.login)} is involved">★ @${escapeHtml(state.login)} ${escapeHtml(text)}</span>`;
  }

  function refreshRoleTags(items) {
    for (const item of items) {
      const el = dom.listContainer.querySelector(`.item-row[data-id="${CSS.escape(item.id)}"] .role-slot`);
      if (el) el.innerHTML = roleTagHtml(item);
    }
  }
  const LINK_LABEL = { created: "Created", assigned: "Assigned", reviewed: "Reviewed", commented: "Commented", mentioned: "Mentioned" };

  // ── Row builder ─────────────────────────────────────────────────────
  const ICON_PR = `<svg class="type-icon" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.128a2.251 2.251 0 101.5 0V5a2.5 2.5 0 00-2.5-2.5z"></path></svg>`;
  const ICON_ISSUE = `<svg class="type-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"></path><path fill-rule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"></path></svg>`;
  const ICON_EXT = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M10.604 1h4.146a.25.25 0 01.25.25v4.146a.25.25 0 01-.427.177L13.03 4.03 9.28 7.78a.75.75 0 01-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0110.604 1zM3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"></path></svg>`;

  function createItemRow(item) {
    const row = document.createElement("div");
    row.className = "item-row";
    row.dataset.id = item.id;
    const isExpanded = state.expandedPreviews.has(item.id);
    const labels = item.labels.slice(0, 4);

    row.innerHTML = `
      <div class="row-main">
        <div class="row-left">
          ${item.kind === "pr" ? ICON_PR : ICON_ISSUE}
          <div class="row-content">
            <div class="row-header-line">
              <span class="gh-badge ${item.status}">${item.statusLabel}</span>
              <span class="repo-label">${escapeHtml(item.repo)}#${item.number}</span>
              <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="item-title-link">${escapeHtml(item.title)}</a>
            </div>
            <div class="row-subline">
              <span>by <strong class="subline-user ${item.bucket === "created" ? "is-self" : ""}">${escapeHtml(item.author)}</strong></span>
              <span>·</span>
              <span title="Comments">💬 ${fmt(item.commentsCount)}</span>
              <span class="role-slot">${roleTagHtml(item)}</span>
              ${labels.map((l) => `<span class="label-pill" style="--l-color:#${escapeHtml(l.color || "888888")}">${escapeHtml(l.name)}</span>`).join("")}
            </div>
          </div>
        </div>
        <div class="row-right">
          <span class="time-ago" title="Last updated ${escapeHtml(new Date(item.updatedAt).toLocaleString())}">${timeAgo(item.updatedAt)}</span>
          <button type="button" class="btn-preview-toggle ${isExpanded ? "expanded" : ""}" title="Show the conversation here">
            <span>Preview</span>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path fill-rule="evenodd" d="M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.75.75 0 0 1 1.06-1.06L8 9.94l3.72-3.72a.75.75 0 0 1 1.06 0z"></path></svg>
          </button>
        </div>
      </div>
      <div class="preview-drawer ${isExpanded ? "open" : ""}">
        <div class="drawer-header">
          <div class="preview-meta">
            <span class="preview-badge">${localProxy ? "Live GitHub" : "Conversation"}</span>
            <span class="preview-url">${escapeHtml(item.repo)}#${item.number}</span>
          </div>
          <div class="drawer-actions">
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="btn-external"><span>Open on GitHub</span>${ICON_EXT}</a>
            <button type="button" class="btn-close-drawer">✕ Close</button>
          </div>
        </div>
        <div class="preview-body"></div>
      </div>`;

    const previewBtn = row.querySelector(".btn-preview-toggle");
    const drawer = row.querySelector(".preview-drawer");
    const body = row.querySelector(".preview-body");
    let loaded = false;

    function setDrawerOpen(open) {
      drawer.classList.toggle("open", open);
      previewBtn.classList.toggle("expanded", open);
      if (open) {
        state.expandedPreviews.add(item.id);
        if (!loaded) {
          loaded = true;
          mountPreview(item, body);
        }
      } else {
        state.expandedPreviews.delete(item.id);
      }
    }
    previewBtn.addEventListener("click", () => setDrawerOpen(!drawer.classList.contains("open")));
    row.querySelector(".btn-close-drawer").addEventListener("click", () => setDrawerOpen(false));
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
        ? `@${escapeHtml(state.login)}'s links here: ${links.map((r) => `<span class="role-tag primary rel-${r === "mentioned" ? "other" : r}">${LINK_LABEL[r]}</span>`).join(" ")}`
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

  // ── VISUAL ANALYTICS SUITE ──────────────────────────────────────────
  function renderAnalytics() {
    const items = getItemsForCurrentDateRange();
    updateTargets(items);
    renderHeatmap(items);
    renderDonutChart(items);
    renderTopRepos(items);
    renderYearlyChart(items);
    renderMonthlyChart(items);
  }

  // 1. Target Tracking Cards (Dynamic Milestones)
  function updateTargets(items) {
    // Targets are about what they opened themselves
    const prs = items.filter((i) => i.kind === "pr" && i.bucket === "created");
    const mergedPrs = prs.filter((i) => i.status === "merged");
    const issues = items.filter((i) => i.kind === "issue" && i.bucket === "created");
    const closedIssues = issues.filter((i) => i.status === "closed" || i.status === "not-planned");
    const repos = new Set(items.map((i) => i.repo));

    let prMilestone = 50;
    if (prs.length >= 50 && prs.length < 100) prMilestone = 100;
    else if (prs.length >= 100 && prs.length < 250) prMilestone = 250;
    else if (prs.length >= 250 && prs.length < 500) prMilestone = 500;
    else if (prs.length >= 500 && prs.length < 1000) prMilestone = 1000;
    else if (prs.length >= 1000) prMilestone = Math.ceil(prs.length / 500) * 500;

    const prPct = prMilestone > 0 ? Math.min(100, Math.round((prs.length / prMilestone) * 100)) : 0;
    dom.targetPrVal.textContent = prs.length;
    dom.targetPrBar.style.width = `${prPct}%`;
    dom.targetPrSub.textContent = `${prs.length} / ${prMilestone} PRs (${prPct}% of milestone)`;
    if (prPct >= 100) {
      dom.targetPrStatus.textContent = "Achieved";
      dom.targetPrStatus.className = "target-badge achieved";
    } else {
      dom.targetPrStatus.textContent = "On Track";
      dom.targetPrStatus.className = "target-badge";
    }

    const mergeRate = prs.length ? Math.round((mergedPrs.length / prs.length) * 100) : 0;
    const mergeGoal = 80;
    const mergeBarPct = Math.min(100, Math.round((mergeRate / mergeGoal) * 100));
    dom.targetMergeVal.textContent = `${mergeRate}%`;
    dom.targetMergeBar.style.width = `${mergeBarPct}%`;
    dom.targetMergeSub.textContent = `${mergedPrs.length} merged of ${prs.length} total PRs`;
    if (mergeRate >= mergeGoal) {
      dom.targetMergeStatus.textContent = "Goal Exceeded";
      dom.targetMergeStatus.className = "target-badge achieved";
    } else {
      dom.targetMergeStatus.textContent = `Goal: ${mergeGoal}%`;
      dom.targetMergeStatus.className = "target-badge";
    }

    const resRate = issues.length ? Math.round((closedIssues.length / issues.length) * 100) : 0;
    const resGoal = 85;
    const resBarPct = Math.min(100, Math.round((resRate / resGoal) * 100));
    dom.targetIssueVal.textContent = `${resRate}%`;
    dom.targetIssueBar.style.width = `${resBarPct}%`;
    dom.targetIssueSub.textContent = `${closedIssues.length} closed of ${issues.length} total issues`;
    if (resRate >= resGoal) {
      dom.targetIssueStatus.textContent = "Optimal";
      dom.targetIssueStatus.className = "target-badge achieved";
    } else {
      dom.targetIssueStatus.textContent = `Goal: ${resGoal}%`;
      dom.targetIssueStatus.className = "target-badge";
    }

    let repoGoal = 10;
    if (repos.size >= 10 && repos.size < 25) repoGoal = 25;
    else if (repos.size >= 25 && repos.size < 50) repoGoal = 50;
    else if (repos.size >= 50 && repos.size < 100) repoGoal = 100;
    else if (repos.size >= 100) repoGoal = Math.ceil(repos.size / 25) * 25;

    const repoBarPct = Math.min(100, Math.round((repos.size / repoGoal) * 100));
    dom.targetRepoVal.textContent = repos.size;
    dom.targetRepoBar.style.width = `${repoBarPct}%`;
    dom.targetRepoSub.textContent = `${repos.size} distinct repositories`;
    if (repos.size >= repoGoal) {
      dom.targetRepoStatus.textContent = "Achieved";
      dom.targetRepoStatus.className = "target-badge achieved";
    } else {
      dom.targetRepoStatus.textContent = `Goal: ${repoGoal} Repos`;
      dom.targetRepoStatus.className = "target-badge";
    }
  }

  // 2. GitHub-style Contribution Heatmap Calendar
  function renderHeatmap(items) {
    if (!dom.heatmapCalendar) return;

    const dayCounts = new Map();
    const yearsFound = new Set();

    for (const item of items) {
      const d = item.createdAt ? item.createdAt.split("T")[0] : null;
      if (d) {
        dayCounts.set(d, (dayCounts.get(d) || 0) + 1);
        const y = new Date(d).getFullYear();
        if (!isNaN(y)) yearsFound.add(y);
      }
    }

    const sortedYears = Array.from(yearsFound).sort((a, b) => b - a);
    dom.heatmapYearPills.innerHTML = "";

    const addPill = (yearVal, label) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `year-pill ${state.heatmapYear === String(yearVal) ? "active" : ""}`;
      btn.textContent = label;
      btn.addEventListener("click", () => {
        state.heatmapYear = String(yearVal);
        renderHeatmap(items);
      });
      dom.heatmapYearPills.appendChild(btn);
    };

    addPill("all", "52 Weeks");
    for (const y of sortedYears) {
      addPill(y, String(y));
    }

    const now = new Date();
    let startDate = new Date();

    if (state.heatmapYear === "all") {
      startDate.setDate(now.getDate() - 364);
      const dayOfWeek = startDate.getDay();
      startDate.setDate(startDate.getDate() - dayOfWeek);
    } else {
      const selectedYear = parseInt(state.heatmapYear, 10);
      startDate = new Date(selectedYear, 0, 1);
      const dayOfWeek = startDate.getDay();
      startDate.setDate(startDate.getDate() - dayOfWeek);
    }

    const cols = 53;
    const rows = 7;
    const cellSize = 10;
    const cellGap = 3;
    const stride = cellSize + cellGap;
    const offsetX = 32;
    const offsetY = 20;

    let totalCalendarCount = 0;
    let rectsSvg = "";
    let monthLabelsSvg = "";
    let lastMonth = -1;

    const curr = new Date(startDate);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const isoDate = curr.toISOString().split("T")[0];
        const count = dayCounts.get(isoDate) || 0;
        totalCalendarCount += count;

        let lvl = 0;
        if (count >= 10) lvl = 4;
        else if (count >= 6) lvl = 3;
        else if (count >= 3) lvl = 2;
        else if (count >= 1) lvl = 1;

        const x = offsetX + c * stride;
        const y = offsetY + r * stride;

        if (r === 0 && curr.getMonth() !== lastMonth) {
          lastMonth = curr.getMonth();
          monthLabelsSvg += `<text x="${x}" y="12" class="heatmap-month-label">${monthNames[lastMonth]}</text>`;
        }

        const dateStr = curr.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const label = `${count} contribution${count === 1 ? "" : "s"} on ${dateStr}`;

        rectsSvg += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" class="lvl-${lvl}"><title>${label}</title></rect>`;

        curr.setDate(curr.getDate() + 1);
      }
    }

    const svgWidth = offsetX + cols * stride + 10;
    const svgHeight = offsetY + rows * stride + 10;

    dom.heatmapCalendar.innerHTML = `
      <svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}">
        ${monthLabelsSvg}
        <text x="6" y="${offsetY + 1 * stride + 8}" class="heatmap-day-label">Mon</text>
        <text x="6" y="${offsetY + 3 * stride + 8}" class="heatmap-day-label">Wed</text>
        <text x="6" y="${offsetY + 5 * stride + 8}" class="heatmap-day-label">Fri</text>
        ${rectsSvg}
      </svg>
    `;

    const periodLabel = state.heatmapYear === "all" ? "last 52 weeks" : `year ${state.heatmapYear}`;
    dom.heatmapCountLabel.textContent = `${totalCalendarCount} contribution${totalCalendarCount === 1 ? "" : "s"} in ${periodLabel}`;
  }

  // 3. Pull Request Health & Distribution Donut Chart
  function renderDonutChart(items) {
    if (!dom.donutSvgContainer || !dom.donutLegend) return;

    const prs = items.filter((i) => i.kind === "pr" && i.bucket === "created");
    const merged = prs.filter((i) => i.status === "merged").length;
    const open = prs.filter((i) => i.status === "open").length;
    const closed = prs.filter((i) => i.status === "closed").length;
    const draft = prs.filter((i) => i.status === "draft").length;
    const totalPrs = prs.length;

    const mergeRate = totalPrs ? Math.round((merged / totalPrs) * 100) : 0;

    const slices = [
      { key: "merged", label: "Merged", count: merged, color: "#a371f7" },
      { key: "open", label: "Open", count: open, color: "#3fb950" },
      { key: "closed", label: "Closed", count: closed, color: "#f85149" },
      { key: "draft", label: "Draft", count: draft, color: "#8b949e" },
    ];

    const radius = 54;
    const circumference = 2 * Math.PI * radius; // ~339.29

    let accumulatedPct = 0;
    let pathsSvg = "";

    if (totalPrs === 0) {
      pathsSvg = `<circle cx="80" cy="80" r="${radius}" fill="none" stroke="var(--canvas-subtle)" stroke-width="18" />`;
    } else {
      for (const slice of slices) {
        if (slice.count === 0) continue;
        const pct = slice.count / totalPrs;
        const dashLen = pct * circumference;
        const spaceLen = circumference - dashLen;
        const offset = -accumulatedPct * circumference;

        pathsSvg += `
          <circle
            cx="80" cy="80" r="${radius}"
            fill="none"
            stroke="${slice.color}"
            stroke-width="18"
            stroke-dasharray="${dashLen.toFixed(2)} ${spaceLen.toFixed(2)}"
            stroke-dashoffset="${offset.toFixed(2)}"
            transform="rotate(-90 80 80)"
          >
            <title>${slice.label}: ${slice.count} (${Math.round(pct * 100)}%)</title>
          </circle>
        `;
        accumulatedPct += pct;
      }
    }

    dom.donutSvgContainer.innerHTML = `
      <svg viewBox="0 0 160 160" width="160" height="160">
        ${pathsSvg}
        <text x="80" y="78" text-anchor="middle" font-size="22" font-weight="700" fill="var(--text-white)" font-family="var(--font-mono)">${mergeRate}%</text>
        <text x="80" y="96" text-anchor="middle" font-size="11" fill="var(--text-faint)" font-family="var(--font-mono)">Merged</text>
      </svg>
    `;

    dom.donutLegend.innerHTML = slices
      .map((s) => {
        const pct = totalPrs ? Math.round((s.count / totalPrs) * 100) : 0;
        return `
          <div class="donut-legend-row">
            <div class="donut-legend-label">
              <span class="legend-color-dot" style="background:${s.color};"></span>
              <span>${s.label}</span>
            </div>
            <span class="donut-legend-val">${s.count} <span style="opacity:0.6;">(${pct}%)</span></span>
          </div>
        `;
      })
      .join("");
  }

  // 4. Top Repositories Breakdown (Horizontal Bars)
  function renderTopRepos(items) {
    if (!dom.topReposList) return;

    const counts = new Map();
    for (const item of items) {
      counts.set(item.repo, (counts.get(item.repo) || 0) + 1);
    }

    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxVal = sorted.length ? sorted[0][1] : 1;
    const total = items.length || 1;

    if (!sorted.length) {
      dom.topReposList.innerHTML = `<p style="font-size:0.8rem;color:var(--text-faint);">No repository data available.</p>`;
      return;
    }

    dom.topReposList.innerHTML = sorted
      .map(([repo, count]) => {
        const barPct = Math.round((count / maxVal) * 100);
        const overallPct = Math.round((count / total) * 100);
        return `
          <div class="top-repo-row" data-repo="${escapeHtml(repo)}" style="cursor:pointer;" title="Click to filter by ${escapeHtml(repo)}">
            <div class="top-repo-meta">
              <span class="top-repo-name">${escapeHtml(repo)}</span>
              <span class="top-repo-count">${count} <span style="opacity:0.6;">(${overallPct}%)</span></span>
            </div>
            <div class="top-repo-bar-wrap">
              <div class="top-repo-bar-fill" style="width: ${barPct}%;"></div>
            </div>
          </div>
        `;
      })
      .join("");

    dom.topReposList.querySelectorAll(".top-repo-row").forEach((row) => {
      row.addEventListener("click", () => {
        const repo = row.dataset.repo;
        state.filters.repo = repo;
        switchView("feed");
        onFiltersChanged();
      });
    });
  }

  // 5. Year-over-Year Performance (Bar Chart)
  function renderYearlyChart(items) {
    if (!dom.yearlyChartContainer) return;

    const allItems = Array.from(state.itemsMap.values());
    const yearCounts = new Map();

    for (const item of allItems) {
      const y = item.createdAt ? new Date(item.createdAt).getFullYear() : null;
      if (y && !isNaN(y)) {
        yearCounts.set(y, (yearCounts.get(y) || 0) + 1);
      }
    }

    const sortedYears = Array.from(yearCounts.keys()).sort((a, b) => a - b);
    const maxVal = sortedYears.length ? Math.max(...sortedYears.map((y) => yearCounts.get(y))) : 1;

    if (!sortedYears.length) {
      dom.yearlyChartContainer.innerHTML = `<p style="font-size:0.8rem;color:var(--text-faint);">No yearly data available.</p>`;
      return;
    }

    dom.yearlyChartContainer.innerHTML = sortedYears
      .map((y) => {
        const count = yearCounts.get(y);
        const height = Math.max(6, Math.round((count / maxVal) * 125));
        const isCurrentSelected = state.dateRange === String(y);
        return `
          <div class="chart-bar-col" data-year="${y}" style="cursor:pointer;" title="${count} contributions in ${y} (click to view)">
            <span class="chart-bar-val">${count}</span>
            <div class="chart-bar-body ${isCurrentSelected ? "peak-bar" : ""}" style="height:${height}px;"></div>
            <span class="chart-bar-label">${y}</span>
          </div>
        `;
      })
      .join("");

    dom.yearlyChartContainer.querySelectorAll(".chart-bar-col").forEach((col) => {
      col.addEventListener("click", () => {
        const y = col.dataset.year;
        dom.dateRangeSelect.value = y;
        state.dateRange = y;
        onFiltersChanged();
      });
    });
  }

  // 6. Monthly Trajectory (Jan–Dec Bar Chart)
  function renderMonthlyChart(items) {
    if (!dom.monthlyChartContainer) return;

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthCounts = new Array(12).fill(0);

    for (const item of items) {
      if (item.createdAt) {
        const m = new Date(item.createdAt).getMonth();
        if (m >= 0 && m < 12) monthCounts[m]++;
      }
    }

    const maxVal = Math.max(1, ...monthCounts);
    const peakIndex = monthCounts.indexOf(maxVal);

    dom.monthlyChartContainer.innerHTML = monthNames
      .map((name, idx) => {
        const count = monthCounts[idx];
        const height = Math.max(6, Math.round((count / maxVal) * 125));
        const isPeak = idx === peakIndex && count > 0;
        return `
          <div class="chart-bar-col" title="${count} contributions in ${name}">
            <span class="chart-bar-val">${count}</span>
            <div class="chart-bar-body ${isPeak ? "peak-bar" : ""}" style="height:${height}px;"></div>
            <span class="chart-bar-label">${name}</span>
          </div>
        `;
      })
      .join("");
  }

  // ── View switching ──────────────────────────────────────────────────
  function switchView(mode) {
    state.viewMode = mode;
    const analytics = mode === "analytics";
    dom.tabBtnAnalytics.classList.toggle("active", analytics);
    dom.tabBtnFeed.classList.toggle("active", !analytics);
    dom.analyticsView.style.display = analytics ? "block" : "none";
    dom.feedView.style.display = analytics ? "none" : "block";
    if (analytics) renderAnalytics();
  }
  dom.tabBtnFeed.addEventListener("click", () => switchView("feed"));
  dom.tabBtnAnalytics.addEventListener("click", () => switchView("analytics"));

  // ── Search form ─────────────────────────────────────────────────────
  dom.searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    startTracking(dom.searchInput.value);
  });
  dom.inputClear.addEventListener("click", () => {
    dom.searchInput.value = "";
    dom.inputClear.style.display = "none";
    dom.searchInput.focus();
  });
  dom.searchInput.addEventListener("input", () => {
    dom.inputClear.style.display = dom.searchInput.value ? "block" : "none";
  });
  dom.quickPills.forEach((pill) => pill.addEventListener("click", () => startTracking(pill.dataset.user)));
  dom.btnClearCache?.addEventListener("click", async () => {
    await cacheClear();
    if (state.login) startTracking(state.login);
  });

  // ── Theme ───────────────────────────────────────────────────────────
  function updateFavicon(theme) {
    const link = document.querySelector("link[rel='icon']");
    if (!link) return;
    const L = theme === "light";
    const c = (light, dark) => (L ? light : dark);
    link.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='28' fill='${c("%23ffffff", "%230d1117")}'/%3E%3Crect x='2' y='2' width='124' height='124' rx='26' stroke='${c("%23d0d7de", "%2330363d")}' stroke-width='2' fill='none'/%3E%3Cpath d='M38 90 V42' stroke='${c("%230969da", "%23388bfd")}' stroke-width='3.5' stroke-linecap='round'/%3E%3Cpath d='M38 66 C38 48, 90 56, 90 38' stroke='${c("%230969da", "%23388bfd")}' stroke-width='3.5' stroke-linecap='round' fill='none'/%3E%3Ccircle cx='38' cy='90' r='7' fill='${c("%230969da", "%2338bdf8")}'/%3E%3Ccircle cx='38' cy='42' r='7.5' fill='${c("%231a7f37", "%233fb950")}'/%3E%3Ccircle cx='90' cy='38' r='7.5' fill='${c("%238250df", "%23a371f7")}'/%3E%3Ccircle cx='64' cy='64' r='4.5' fill='${c("%231f2328", "%23f0f6fc")}'/%3E%3C/svg%3E`;
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("ghtrack_theme", theme);
    } catch {
      /* private mode */
    }
    dom.iconSun.style.display = theme === "light" ? "none" : "block";
    dom.iconMoon.style.display = theme === "light" ? "block" : "none";
    updateFavicon(theme);
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("ghtrack_theme");
      localStorage.removeItem("ghtrack_token"); // tokens are no longer used
    } catch {
      /* private mode */
    }
    applyTheme(saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  }

  dom.btnTheme.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));

  // ── Export ──────────────────────────────────────────────────────────
  function generateExportContent(format) {
    const items = getFilteredItems();
    if (format === "json") {
      dom.exportContent.value = JSON.stringify(items.map(({ body, ...rest }) => rest), null, 2);
      return;
    }
    let md = `# GitHub Lifetime Work for @${state.login}\n\n`;
    md += `*Exported from ghtrack on ${isoDay(new Date())} · ${fmt(items.length)} items*\n\n`;
    md += `| Type | Status | Involvement | Repository | Number | Title | Updated |\n| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    for (const i of items) {
      md += `| ${i.kind.toUpperCase()} | ${i.statusLabel} | ${i.bucket || ""} | \`${i.repo}\` | #${i.number} | [${i.title.replace(/\|/g, "\\|")}](${i.url}) | ${(i.updatedAt || "").slice(0, 10)} |\n`;
    }
    dom.exportContent.value = md;
  }

  dom.btnExport.addEventListener("click", () => {
    dom.tabExportMd.classList.add("active");
    dom.tabExportJson.classList.remove("active");
    generateExportContent("md");
    dom.modalExport.classList.add("open");
  });
  dom.modalExportClose.addEventListener("click", () => dom.modalExport.classList.remove("open"));
  dom.tabExportMd.addEventListener("click", () => {
    dom.tabExportMd.classList.add("active");
    dom.tabExportJson.classList.remove("active");
    generateExportContent("md");
  });
  dom.tabExportJson.addEventListener("click", () => {
    dom.tabExportJson.classList.add("active");
    dom.tabExportMd.classList.remove("active");
    generateExportContent("json");
  });
  dom.btnCopyExport.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(dom.exportContent.value);
      dom.btnCopyExport.textContent = "Copied!";
    } catch {
      dom.exportContent.select();
      dom.btnCopyExport.textContent = "Press ⌘/Ctrl+C";
    }
    setTimeout(() => (dom.btnCopyExport.textContent = "Copy to Clipboard"), 1500);
  });
  dom.btnDownloadExport.addEventListener("click", () => {
    const isMd = dom.tabExportMd.classList.contains("active");
    const blob = new Blob([dom.exportContent.value], { type: isMd ? "text/markdown" : "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ghtrack-${state.login}-${isoDay(new Date())}.${isMd ? "md" : "json"}`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Keyboard ────────────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      dom.filterText.focus();
    }
    if (e.key === "Escape") dom.modalExport.classList.remove("open");
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
    initTheme();
    syncStatusOptions();
    populateRoleFilter();
    populateYears();
    cachePrune();
    window.addEventListener("pagehide", flushSnapshotNow);
    await detectLocalProxy();
    const params = new URLSearchParams(window.location.search);
    const initialName = params.get("name") || params.get("u") || "";
    if (initialName) startTracking(initialName);
  }

  init();
})();
