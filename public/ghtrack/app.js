// ── ghtrack — Core Application Logic ────────────────────────────────────
// Architecture: "ask GitHub the question, don't download everything".
// Every number and every list page is one GitHub search request, so results
// appear in about a second for any account size — no token, no login, no server.
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
  const DB_VERSION = 5;           // v5: query-response cache (replaces full-profile cache)
  const STORE = "responses";
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
    const reserve = job.priority >= 2 ? 2 : 0; // keep budget for the user's next clicks
    return L.remaining <= reserve;
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
    notifyWait();
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

  // ── Paged result stream: walks past GitHub's 1,000-result cap ───────
  class ResultStream {
    constructor(q, order = "desc") {
      this.q = q;
      this.order = order;
      this.rows = [];
      this.ids = new Set();
      this.extra = "";
      this.page = 0;
      this.total = null;
      this.done = false;
      this.pending = null;
      this.lastBoundary = null;
    }

    fetchNext(priority, isStale) {
      if (this.done) return Promise.resolve();
      if (this.pending) return this.pending;
      this.pending = (async () => {
        const page = this.page + 1;
        const q = this.extra ? `${this.q} ${this.extra}` : this.q;
        const data = await apiGet(searchPath(q, { page, order: this.order }), { priority, isStale });
        const items = data.items || [];
        if (this.total === null) this.total = data.total_count || 0;
        let added = 0;
        for (const raw of items) {
          const item = normalize(raw);
          if (item && !this.ids.has(item.id)) {
            this.ids.add(item.id);
            this.rows.push(item);
            added++;
          }
        }
        if (items.length < API_PER_PAGE || this.rows.length >= this.total) {
          this.done = true;
        } else if (page * API_PER_PAGE >= SEARCH_WINDOW) {
          // Next window: continue from the oldest timestamp seen (duplicates skipped)
          const boundary = items[items.length - 1].updated_at;
          if (boundary === this.lastBoundary && added === 0) this.done = true;
          this.lastBoundary = boundary;
          this.extra = `updated:${this.order === "desc" ? "<=" : ">="}${boundary}`;
          this.page = 0;
        } else {
          this.page = page;
        }
      })().finally(() => {
        this.pending = null;
      });
      return this.pending;
    }

    async ensure(n, priority, isStale, onProgress) {
      while (!this.done && this.rows.length < n) {
        await this.fetchNext(priority, isStale);
        if (onProgress) onProgress(this.rows.length);
      }
    }
  }

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    login: "",
    profile: null,
    gen: 0,                    // increments on every new person
    analyticsGen: 0,
    startedAt: 0,
    readyAt: 0,
    streams: new Map(),        // query -> { fwd, rev }
    listQuery: "",
    listTotal: null,
    pageRows: [],
    currentPage: 1,
    overview: {},
    roles: new Map(),          // item id -> Set of known links (created, commented, …)
    primary: new Map(),        // item id -> bucket it is counted under
    seenRepos: new Map(),      // repo -> count (for the repo dropdown)
    harvest: null,             // { rows, total, label, done }
    viewMode: "feed",
    filters: {
      rel: new Set(WORK_SET),
      type: "all",
      state: "all",
      time: "all",
      repo: "all",
      text: "",
    },
    expandedPreviews: new Set(),
    status: "",
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

    relChips: $("rel-chips"),
    relPresets: document.querySelectorAll(".rel-preset"),
    relHelp: $("rel-help"),
    relHelpBox: $("rel-help-box"),

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

    filterType: $("filter-type"),
    filterState: $("filter-state"),
    filterRepo: $("filter-repo"),
    filterText: $("filter-text"),

    pagerCount: $("pager-count"),
    pagerPrev: $("pager-prev"),
    pagerNext: $("pager-next"),
    pageButtons: $("page-buttons"),
    bottomSummary: $("bottom-summary"),

    paceNote: $("pace-note"),
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

  function isDefaultScope() {
    const f = state.filters;
    return f.type === "all" && f.state === "all" && f.time === "all" && f.repo === "all" && !cleanText(f.text);
  }

  function noteRepo(repo, n = 1) {
    state.seenRepos.set(repo, (state.seenRepos.get(repo) || 0) + n);
  }

  // ── Wait / pacing feedback ──────────────────────────────────────────
  let waitTicker = null;

  function searchWaitInfo() {
    const L = limits.search;
    const now = Date.now();
    if (!L.queue.length || !L.queue.some((j) => isBlocked(L, j, now))) return null;
    return {
      secs: Math.max(1, Math.ceil((L.reset - now) / 1000)),
      foreground: L.queue.some((j) => j.priority === 0),
    };
  }

  function notifyWait() {
    const info = searchWaitInfo();
    if (info && !waitTicker) waitTicker = setInterval(renderWait, 1000);
    if (!info && waitTicker) {
      clearInterval(waitTicker);
      waitTicker = null;
    }
    renderWait();
  }

  function renderWait() {
    const info = searchWaitInfo();
    if (info && info.foreground) {
      dom.paceNote.style.display = "flex";
      dom.paceNote.innerHTML = `<span class="pace-dot"></span><span>GitHub allows 10 searches a minute without login — this loads automatically in <strong>${info.secs}s</strong>.</span>`;
    } else {
      dom.paceNote.style.display = "none";
    }
    renderBanner();
  }

  function renderBanner() {
    if (!state.login) return;
    const info = searchWaitInfo();
    const h = state.harvest;
    let text = state.status;
    let pct = 100;
    if (state.viewMode === "analytics" && h && !h.done) {
      pct = h.total ? Math.min(99, Math.round((h.rows / Math.min(h.total, HARVEST_CAP)) * 100)) : 5;
      text = h.total === null || h.total === undefined
        ? `Building charts for ${h.label}…`
        : `Building charts: ${fmt(h.rows)} of ${fmt(Math.min(h.total, HARVEST_CAP))} items (${h.label})`;
      if (info && !info.foreground) text += ` · next batch in ${info.secs}s`;
    } else if (info && !info.foreground) {
      text = `${state.status} · finishing details in ${info.secs}s`;
    }
    dom.streamText.textContent = text;
    dom.streamProgressFill.style.width = `${pct}%`;
  }

  // ── Start tracking a person ─────────────────────────────────────────
  async function startTracking(username) {
    const login = username.trim().replace(/^@/, "").replace(/^https?:\/\/github\.com\//i, "").split(/[/?#\s]/)[0];
    if (!login) return;
    const gen = ++state.gen;

    // Drop everything queued for the previous person
    for (const L of Object.values(limits)) {
      for (const j of L.queue.splice(0)) j.reject(new ApiError("cancelled", 0, { cancelled: true }));
    }

    Object.assign(state, {
      login,
      profile: null,
      startedAt: performance.now(),
      readyAt: 0,
      streams: new Map(),
      listQuery: "",
      listTotal: null,
      pageRows: [],
      currentPage: 1,
      overview: {},
      overviewDone: false,
      roles: new Map(),
      primary: new Map(),
      seenRepos: new Map(),
      harvest: null,
      status: `Asking GitHub about @${login}…`,
    });
    state.expandedPreviews.clear();

    dom.searchInput.value = login;
    dom.inputClear.style.display = "block";
    history.replaceState(null, "", `?name=${encodeURIComponent(login)}`);

    dom.mainContent.style.display = "block";
    dom.telemetryBar.style.display = "grid";
    dom.streamBanner.style.display = "flex";
    dom.profileLine.style.display = "none";
    dom.listEmpty.style.display = "none";
    dom.btnSearch.disabled = true;
    dom.btnSearch.innerHTML = `<span class="loading-dots">Tracking<i></i><i></i><i></i></span>`;
    renderOverview();
    renderRelChips();
    populateTimeframe();
    populateRepoFilter();
    renderBanner();

    try {
      // 1. Profile (validates the username, gives join date for year filters)
      const profile = await apiGet(`/users/${encodeURIComponent(login)}`, { bucket: "core", priority: 0 }).catch((err) => {
        if (err.status === 404) throw new ApiError(`No GitHub user named @${login} was found. Check the spelling.`, 404, { fatal: true });
        return null; // core limit reached etc. — searches still work
      });
      if (gen !== state.gen) return;
      if (profile && profile.type === "Organization") {
        throw new ApiError(`@${profile.login} is an organization. ghtrack tracks people — try one of its members.`, 400, { fatal: true });
      }
      if (profile) {
        state.profile = profile;
        if (profile.login && profile.login !== login) state.login = profile.login;
        renderProfile();
        populateTimeframe();
      }

      // 2. List first (what you look at), exact lifetime numbers right behind it
      const listDone = applyFilters();
      loadOverview(gen);
      await listDone;
    } catch (err) {
      if (gen !== state.gen || err.cancelled) return;
      showFatal(err.fatal || err.status === 422 ? err.message : `Could not load GitHub data: ${err.message}`);
    } finally {
      if (gen === state.gen) {
        dom.btnSearch.disabled = false;
        dom.btnSearch.textContent = "Track";
      }
    }
  }

  function showFatal(message) {
    state.status = `⚠ ${message}`;
    dom.listLoading.style.display = "none";
    dom.listContainer.innerHTML = "";
    dom.listEmpty.style.display = "block";
    dom.listEmpty.querySelector("p").textContent = message;
    dom.telemetryBar.style.display = "none";
    updatePagerUI(0);
    renderBanner();
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

  // ── Exact lifetime numbers (one count request each) ─────────────────
  function loadOverview(gen) {
    const u = state.login;
    const isStale = () => gen !== state.gen;
    const queries = {
      total: [`involves:${u}`, 1],
      prs: [`author:${u} is:pr`, 1],
      issues: [`author:${u} is:issue`, 1],
      reviewed: [bucketExpr("reviewed", u), 1],
      commented: [bucketExpr("commented", u), 1],
      merged: [`author:${u} is:pr is:merged`, 3],
      openIssues: [`author:${u} is:issue is:open`, 3],
    };
    const jobs = Object.entries(queries).map(([key, [q, priority]]) =>
      countQuery(q, priority, isStale).then((n) => {
        if (gen !== state.gen) return;
        state.overview[key] = n;
        renderOverview();
        renderRelChips();
      })
    );
    Promise.allSettled(jobs.slice(0, 5)).then(() => {
      if (gen !== state.gen) return;
      state.overviewDone = true;
      markReady();
    });
  }

  function overviewDerived() {
    const o = state.overview;
    const d = {};
    if (o.prs !== undefined && o.issues !== undefined) d.created = o.prs + o.issues;
    // "My work" total comes free with the first list page; Assigned = the remainder
    if (o.work !== undefined && d.created !== undefined && o.reviewed !== undefined && o.commented !== undefined) {
      d.assigned = Math.max(0, o.work - d.created - o.reviewed - o.commented);
    }
    d.reviewed = o.reviewed;
    d.commented = o.commented;
    const known = ["created", "assigned", "reviewed", "commented"];
    if (o.total !== undefined && known.every((k) => d[k] !== undefined)) {
      d.other = Math.max(0, o.total - known.reduce((s, k) => s + d[k], 0));
    }
    if (WORK_SET.every((k) => d[k] !== undefined)) d.work = WORK_SET.reduce((s, k) => s + d[k], 0);
    d.all = o.total;
    return d;
  }

  function renderOverview() {
    const o = state.overview;
    dom.statTotal.textContent = fmt(o.total);
    dom.statPrs.textContent = fmt(o.prs);
    dom.statPrsSub.textContent =
      o.prs !== undefined && o.merged !== undefined
        ? `${o.prs ? Math.round((o.merged / o.prs) * 100) : 0}% merged · ${fmt(o.merged)} merged`
        : " ";
    dom.statIssues.textContent = fmt(o.issues);
    dom.statIssuesSub.textContent =
      o.issues !== undefined && o.openIssues !== undefined
        ? `${fmt(o.openIssues)} open · ${fmt(o.issues - o.openIssues)} closed`
        : " ";
    dom.statReviews.textContent = fmt(o.reviewed);
    dom.statComments.textContent = fmt(o.commented);
  }

  function markReady() {
    if (state.readyAt || !state.listQuery || state.listTotal === null) return;
    if (!state.overviewDone) return;
    state.readyAt = performance.now();
    const secs = ((state.readyAt - state.startedAt) / 1000).toFixed(1);
    state.status = `✓ Exact lifetime numbers for @${state.login} · loaded in ${secs}s`;
    renderBanner();
  }

  // ── Relationship chips ──────────────────────────────────────────────
  function renderRelChips() {
    const counts = isDefaultScope() ? overviewDerived() : {};
    const sel = state.filters.rel;
    dom.relChips.innerHTML = REL_ORDER.map((r) => {
      const n = counts[r];
      return `<button type="button" class="rel-chip ${sel.has(r) ? "active" : ""}" data-rel="${r}" title="${escapeHtml(REL_HINT[r])}" aria-pressed="${sel.has(r)}">
        <span class="rel-dot rel-${r}"></span>${REL_LABEL[r]}${n !== undefined ? ` <span class="rel-count">${fmt(n)}</span>` : ""}
      </button>`;
    }).join("");
    const isWork = sel.size === WORK_SET.length && WORK_SET.every((r) => sel.has(r));
    const isAll = sel.size === REL_ORDER.length;
    dom.relPresets.forEach((btn) => {
      const preset = btn.dataset.preset;
      btn.classList.toggle("active", preset === "work" ? isWork : isAll);
      const span = btn.querySelector(".rel-count");
      const n = counts[preset];
      span.textContent = n !== undefined ? fmt(n) : "";
    });
  }

  dom.relChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".rel-chip");
    if (!chip) return;
    const rel = chip.dataset.rel;
    const sel = state.filters.rel;
    const isWork = sel.size === WORK_SET.length && WORK_SET.every((r) => sel.has(r));
    if (isWork || sel.size === REL_ORDER.length) {
      // From a preset, clicking a chip focuses on just that bucket
      state.filters.rel = new Set([rel]);
    } else if (sel.has(rel)) {
      if (sel.size > 1) sel.delete(rel);
    } else {
      sel.add(rel);
    }
    onFiltersChanged();
  });

  dom.relPresets.forEach((btn) =>
    btn.addEventListener("click", () => {
      state.filters.rel = new Set(btn.dataset.preset === "all" ? REL_ORDER : WORK_SET);
      onFiltersChanged();
    })
  );

  dom.relHelp.addEventListener("click", () => {
    dom.relHelpBox.style.display = dom.relHelpBox.style.display === "none" ? "block" : "none";
  });

  // Overview cards act as shortcuts
  dom.telemetryBar.addEventListener("click", (e) => {
    const card = e.target.closest("[data-card]");
    if (!card || !state.login) return;
    const presets = {
      total: { rel: REL_ORDER, type: "all" },
      prs: { rel: ["created"], type: "pr" },
      issues: { rel: ["created"], type: "issue" },
      reviewed: { rel: ["reviewed"], type: "pr" },
      commented: { rel: ["commented"], type: "all" },
    };
    const p = presets[card.dataset.card];
    Object.assign(state.filters, { rel: new Set(p.rel), type: p.type, state: "all", time: "all", repo: "all", text: "" });
    syncFilterControls();
    switchView("feed");
    onFiltersChanged();
    dom.mainContent.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ── Filters ─────────────────────────────────────────────────────────
  function syncFilterControls() {
    const f = state.filters;
    dom.filterType.value = f.type;
    dom.filterState.value = f.state;
    dom.dateRangeSelect.value = f.time;
    dom.filterText.value = f.text;
    populateRepoFilter();
    // Disable states that can't apply to the chosen type
    for (const opt of dom.filterState.options) {
      opt.disabled =
        (f.type === "issue" && (opt.value === "merged" || opt.value === "draft")) ||
        (f.type === "pr" && opt.value === "not_planned");
    }
  }

  function populateTimeframe() {
    const current = state.filters.time;
    const nowYear = new Date().getFullYear();
    const fromYear = state.profile?.created_at ? new Date(state.profile.created_at).getFullYear() : nowYear - 5;
    let html = `<option value="all">Lifetime (All Time)</option>
      <option value="30d">Last 30 days</option>
      <option value="90d">Last 90 days</option>
      <option value="365d">Last 12 months</option>`;
    for (let y = nowYear; y >= fromYear; y--) html += `<option value="y${y}">${y}</option>`;
    dom.dateRangeSelect.innerHTML = html;
    dom.dateRangeSelect.value = current;
    if (dom.dateRangeSelect.value !== current) {
      state.filters.time = "all";
      dom.dateRangeSelect.value = "all";
    }
  }

  function populateRepoFilter() {
    const current = state.filters.repo;
    const repos = Array.from(state.seenRepos.entries()).sort((a, b) => b[1] - a[1]).slice(0, 300);
    let html = `<option value="all">All repositories</option>`;
    if (current !== "all" && !state.seenRepos.has(current)) html += `<option value="${escapeHtml(current)}">${escapeHtml(current)}</option>`;
    for (const [repo] of repos) html += `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`;
    dom.filterRepo.innerHTML = html;
    dom.filterRepo.value = current;
  }

  function onFiltersChanged() {
    const f = state.filters;
    if (f.type === "issue" && (f.state === "merged" || f.state === "draft")) f.state = "all";
    if (f.type === "pr" && f.state === "not_planned") f.state = "all";
    syncFilterControls();
    renderRelChips();
    applyFilters();
    if (state.viewMode === "analytics") loadAnalytics();
  }

  dom.filterType.addEventListener("change", (e) => {
    state.filters.type = e.target.value;
    onFiltersChanged();
  });
  dom.filterState.addEventListener("change", (e) => {
    state.filters.state = e.target.value;
    if (["merged", "draft"].includes(e.target.value)) state.filters.type = "pr";
    if (e.target.value === "not_planned") state.filters.type = "issue";
    onFiltersChanged();
  });
  dom.filterRepo.addEventListener("change", (e) => {
    state.filters.repo = e.target.value;
    onFiltersChanged();
  });
  dom.dateRangeSelect.addEventListener("change", (e) => {
    state.filters.time = e.target.value;
    onFiltersChanged();
  });
  let textTimer = null;
  dom.filterText.addEventListener("input", (e) => {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      if (cleanText(e.target.value) === cleanText(state.filters.text)) return;
      state.filters.text = e.target.value;
      onFiltersChanged();
    }, 450);
  });

  // ── List ────────────────────────────────────────────────────────────
  function streamsFor(q) {
    let s = state.streams.get(q);
    if (!s) {
      s = { fwd: new ResultStream(q, "desc"), rev: null };
      state.streams.set(q, s);
    }
    return s;
  }

  async function getPageRows(q, pageNum, isStale) {
    const s = streamsFor(q);
    if (s.fwd.total === null) await s.fwd.fetchNext(0, isStale);
    const total = s.fwd.total;
    const start = (pageNum - 1) * FEED_PAGE_SIZE;
    const end = Math.min(start + FEED_PAGE_SIZE, total);
    if (s.fwd.rows.length >= end || s.fwd.done) return { rows: s.fwd.rows.slice(start, end), total };

    // Far pages: read from whichever end is closer (newest-first or oldest-first)
    const fwdCost = Math.ceil((end - s.fwd.rows.length) / API_PER_PAGE);
    const revNeed = total - start;
    if (!s.rev) s.rev = new ResultStream(q, "asc");
    const revCost = Math.ceil((revNeed - s.rev.rows.length) / API_PER_PAGE);
    const progress = (loaded, need) => {
      if (isStale()) return;
      dom.bottomSummary.textContent = `Loading page ${pageNum}… (${fmt(Math.min(loaded, need))} of ${fmt(need)} scanned)`;
    };
    if (revCost < fwdCost) {
      await s.rev.ensure(revNeed, 0, isStale, (n) => progress(n, revNeed));
      const rows = [];
      for (let i = start; i < end; i++) {
        const r = s.rev.rows[total - 1 - i];
        if (r) rows.push(r);
      }
      return { rows, total };
    }
    await s.fwd.ensure(end, 0, isStale, (n) => progress(n, end));
    return { rows: s.fwd.rows.slice(start, end), total };
  }

  async function applyFilters() {
    if (!state.login) return;
    state.listQuery = buildQuery(state.filters, state.login);
    state.currentPage = 1;
    await renderList();
  }

  async function renderList() {
    const q = state.listQuery;
    const page = state.currentPage;
    const gen = state.gen;
    const isStale = () => gen !== state.gen || q !== state.listQuery;
    const isCurrent = () => !isStale() && page === state.currentPage;

    dom.listEmpty.style.display = "none";
    dom.listLoading.style.display = "flex";
    dom.listContainer.style.opacity = "0.45";

    try {
      const { rows, total } = await getPageRows(q, page, isStale);
      if (!isCurrent()) return;
      state.listTotal = total;
      state.pageRows = rows;
      if (q === buildQuery({ ...state.filters, rel: new Set(WORK_SET), type: "all", state: "all", time: "all", repo: "all", text: "" }, state.login)) {
        state.overview.work = total;
        renderRelChips();
      }
      for (const r of rows) noteRepo(r.repo);
      populateRepoFilter();

      dom.listLoading.style.display = "none";
      dom.listContainer.style.opacity = "1";
      dom.listContainer.innerHTML = "";
      if (!rows.length) {
        dom.listEmpty.style.display = "block";
        dom.listEmpty.querySelector("p").textContent = total ? "No more results." : "Nothing matches these filters.";
      }
      const frag = document.createDocumentFragment();
      const rel = new Set(state.filters.rel);
      for (const item of rows) frag.appendChild(createItemRow(item, rel));
      dom.listContainer.appendChild(frag);
      updatePagerUI(total);
      markReady();
      enrichRoles(rows, rel, isCurrent);
    } catch (err) {
      if (err.cancelled || !isCurrent()) return;
      dom.listLoading.style.display = "none";
      dom.listContainer.style.opacity = "1";
      dom.listContainer.innerHTML = "";
      dom.listEmpty.style.display = "block";
      const msg =
        err.status === 422
          ? state.overview.total === undefined && !state.profile
            ? `No GitHub user named @${state.login} was found. Check the spelling.`
            : "GitHub couldn't run this search. Try simpler search words."
          : `Could not load results: ${err.message}`;
      dom.listEmpty.querySelector("p").textContent = msg;
      updatePagerUI(0);
    }
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
    const totalPages = Math.ceil(total / FEED_PAGE_SIZE);
    const start = (state.currentPage - 1) * FEED_PAGE_SIZE + 1;
    const end = Math.min(state.currentPage * FEED_PAGE_SIZE, total);
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
    dom.bottomSummary.textContent = `Page ${fmt(state.currentPage)} of ${fmt(totalPages)} · newest activity first`;
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
    const totalPages = Math.ceil((state.listTotal || 0) / FEED_PAGE_SIZE);
    if (state.currentPage < totalPages) goToPage(state.currentPage + 1);
  });

  // ── Relationship tags per row ───────────────────────────────────────
  // Primary = the one bucket the row is counted under. Secondary = other links
  // (filled in for free when the preview conversation loads).
  function knownRoles(item) {
    let set = state.roles.get(item.id);
    if (!set) {
      set = new Set();
      state.roles.set(item.id, set);
    }
    const u = state.login.toLowerCase();
    if (item.author.toLowerCase() === u) set.add("created");
    if (item.assignees.includes(u)) set.add("assigned");
    return set;
  }

  function primaryBucket(item, rel) {
    const roles = knownRoles(item);
    if (roles.has("created")) return "created";
    if (roles.has("assigned")) return "assigned";
    if (state.primary.has(item.id)) return state.primary.get(item.id);
    // Not created/assigned: if the query only allows one remaining bucket, that's it
    const left = ["reviewed", "commented", "other"].filter((b) => rel.has(b) && (b !== "reviewed" || item.kind === "pr"));
    if (left.length === 1) return left[0];
    for (const b of ["reviewed", "commented"]) if (roles.has(b)) return b;
    return null;
  }

  function roleTagsHtml(item, rel) {
    const primary = primaryBucket(item, rel);
    if (!primary) return `<span class="role-tag pending" title="Checking how they're linked…">…</span>`;
    const roles = knownRoles(item);
    const extras = ["created", "assigned", "reviewed", "commented", "mentioned"].filter((r) => r !== primary && roles.has(r));
    return (
      `<span class="role-tag primary rel-${primary}" title="Counted under: ${escapeHtml(REL_HINT[primary])}">${escapeHtml(REL_LABEL[primary])}</span>` +
      extras.map((r) => `<span class="role-tag rel-${r === "mentioned" ? "other" : r}" title="Also: ${escapeHtml(REL_HINT[r])}">${REL_LABEL[r]}</span>`).join("")
    );
  }

  // Background (low priority): at most 2 searches limited to this page's
  // time window work out the bucket of rows that aren't created/assigned.
  async function enrichRoles(rows, rel, isCurrent) {
    const u = state.login;
    const todo = rows.filter((r) => !primaryBucket(r, rel));
    if (!todo.length) return;
    const times = todo.map((r) => r.updatedAt).sort();
    const range = `updated:${times[0]}..${times[times.length - 1]}`;
    const narrow = [typeQualifier(state.filters.type), state.filters.repo !== "all" ? `repo:${state.filters.repo}` : ""].filter(Boolean).join(" ");
    const lookup = (qual) =>
      apiGet(searchPath(`${qual}:${u} ${range} ${narrow}`.trim()), { priority: 2, isStale: () => !isCurrent() }).then((d) => ({
        ids: new Set((d.items || []).map((x) => x.html_url)),
        complete: (d.total_count || 0) <= API_PER_PAGE,
      }));
    try {
      const needReviewed = rel.has("reviewed") && todo.some((r) => r.kind === "pr");
      const needCommented = rel.has("commented") && rel.has("other");
      const [rev, com] = await Promise.all([needReviewed ? lookup("reviewed-by") : null, needCommented ? lookup("commenter") : null]);
      for (const r of todo) {
        if (rev && rev.ids.has(r.id)) {
          state.primary.set(r.id, "reviewed");
          continue;
        }
        if (rev && !rev.complete && r.kind === "pr") continue; // unknown, keep "…"
        if (!rel.has("commented")) state.primary.set(r.id, "other");
        else if (!com) state.primary.set(r.id, "commented");
        else if (com.ids.has(r.id)) state.primary.set(r.id, "commented");
        else if (com.complete) state.primary.set(r.id, "other");
      }
    } catch {
      /* tags stay "…"; the preview still shows every link */
    }
    refreshRoleTags(todo, rel);
  }

  function refreshRoleTags(items, rel) {
    for (const item of items) {
      const el = dom.listContainer.querySelector(`.item-row[data-id="${CSS.escape(item.id)}"] .role-tags`);
      if (el) el.innerHTML = roleTagsHtml(item, rel);
    }
  }

  // ── Row builder ─────────────────────────────────────────────────────
  const ICON_PR = `<svg class="type-icon" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.128a2.251 2.251 0 101.5 0V5a2.5 2.5 0 00-2.5-2.5z"></path></svg>`;
  const ICON_ISSUE = `<svg class="type-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"></path><path fill-rule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"></path></svg>`;
  const ICON_EXT = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M10.604 1h4.146a.25.25 0 01.25.25v4.146a.25.25 0 01-.427.177L13.03 4.03 9.28 7.78a.75.75 0 01-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0110.604 1zM3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"></path></svg>`;

  function createItemRow(item, rel) {
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
              <span class="role-tags">${roleTagsHtml(item, rel)}</span>
              <span>by <strong class="subline-user">${escapeHtml(item.author)}</strong></span>
              <span>·</span>
              <span title="Comments">💬 ${fmt(item.commentsCount)}</span>
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
    if (!text || !text.trim()) return `<p class="conv-empty">No description provided.</p>`;
    return `<div class="md-plain">${escapeHtml(text)}</div>`;
  }

  // Formatted description (markdown rendered by GitHub); plain text stays if this fails
  async function loadDescription(item, el) {
    if (!el || !item.body || !item.body.trim()) return;
    const [owner, name] = item.repo.split("/");
    try {
      const issue = await apiGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${item.number}`, {
        bucket: "core",
        priority: 0,
        html: true,
      });
      if (issue?.body_html) el.innerHTML = sanitizeHtml(issue.body_html);
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
    const roles = knownRoles(item);
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
    const rel = new Set(state.filters.rel);
    refreshRoleTags([item], rel);
    const links = ["created", "assigned", "reviewed", "commented", "mentioned"].filter((r) => roles.has(r));
    const head = container?.querySelector(".conv-links");
    if (head) {
      head.innerHTML = links.length
        ? `@${escapeHtml(state.login)}'s links here: ${links.map((r) => `<span class="role-tag primary rel-${r === "mentioned" ? "other" : r}">${REL_LABEL[r]}</span>`).join(" ")}`
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

  // ── Visual analytics ────────────────────────────────────────────────
  function harvestWindow() {
    const t = state.filters.time;
    const y = /^y(\d{4})$/.exec(t);
    if (y) {
      const year = Number(y[1]);
      return { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year, 11, 31)), year, label: String(year) };
    }
    const days = /^(\d+)d$/.exec(t) ? Number(/^(\d+)d$/.exec(t)[1]) : 365;
    return { from: new Date(Date.now() - days * DAY_MS), to: new Date(), year: null, label: days === 365 ? "last 12 months" : `last ${days} days` };
  }

  async function loadAnalytics() {
    if (state.viewMode !== "analytics" || !state.login) return;
    const gen = state.gen;
    const aGen = ++state.analyticsGen;
    const isStale = () => gen !== state.gen || aGen !== state.analyticsGen;
    const u = state.login;
    const tq = timeQualifier(state.filters.time);
    const t = tq ? ` ${tq}` : "";
    const o = state.overview;
    const cq = (q) => countQuery(q, 1, isStale);

    // 1. Targets + PR health (things they opened) — exact counts
    const lifetime = !tq;
    const nums = {};
    const paint = () => {
      if (isStale()) return;
      updateTargets(nums);
      renderDonutChart(nums);
    };
    const want = {
      prs: lifetime && o.prs !== undefined ? Promise.resolve(o.prs) : cq(`author:${u} is:pr${t}`),
      merged: lifetime && o.merged !== undefined ? Promise.resolve(o.merged) : cq(`author:${u} is:pr is:merged${t}`),
      openPrs: cq(`author:${u} is:pr is:open${t}`),
      draft: cq(`author:${u} is:pr is:open draft:true${t}`),
      issues: lifetime && o.issues !== undefined ? Promise.resolve(o.issues) : cq(`author:${u} is:issue${t}`),
      openIssues: lifetime && o.openIssues !== undefined ? Promise.resolve(o.openIssues) : cq(`author:${u} is:issue is:open${t}`),
    };
    paint();
    for (const [k, p] of Object.entries(want)) {
      p.then((n) => {
        nums[k] = n;
        paint();
      }).catch(() => {});
    }

    // 2. Year-over-year (exact counts, current relationship + type)
    const relQ = [relSetExpr(state.filters.rel, u), typeQualifier(state.filters.type)].filter(Boolean).join(" ");
    const nowYear = new Date().getFullYear();
    const fromYear = state.profile?.created_at ? new Date(state.profile.created_at).getFullYear() : nowYear - 5;
    const years = new Map([["earlier", undefined]]); // threads opened before they joined
    for (let y = fromYear; y <= nowYear; y++) years.set(y, undefined);
    renderYearlyChart(years);
    for (const y of years.keys()) {
      const range = y === "earlier" ? `created:<${fromYear}-01-01` : `created:${y}-01-01..${y}-12-31`;
      countQuery(`${relQ} ${range}`, 3, isStale)
        .then((n) => {
          if (isStale()) return;
          years.set(y, n);
          renderYearlyChart(years);
        })
        .catch(() => {});
    }

    // 3. Heatmap, monthly, top repos, reach: items in the window, pulled in background
    const win = harvestWindow();
    const hq = [relQ, `created:${isoDay(win.from)}..${isoDay(win.to)}`, state.filters.repo !== "all" ? `repo:${state.filters.repo}` : ""]
      .filter(Boolean)
      .join(" ");
    const stream = streamsFor(hq).fwd;
    state.harvest = { rows: stream.rows.length, total: stream.total, label: win.label, done: false };
    const paintHarvest = () => {
      if (isStale()) return;
      const items = stream.rows;
      state.harvest.rows = items.length;
      state.harvest.total = stream.total;
      const partial = !stream.done && items.length < Math.min(stream.total || 0, HARVEST_CAP);
      const capped = (stream.total || 0) > HARVEST_CAP;
      const note = capped ? ` (newest ${fmt(HARVEST_CAP)} of ${fmt(stream.total)})` : partial ? " (loading…)" : "";
      renderHeatmap(items, win, note);
      renderMonthlyChart(items, win);
      renderTopRepos(items, note);
      const repos = new Set(items.map((i) => i.repo)).size;
      nums.repos = repos;
      nums.reposLabel = `${win.label}${note}`;
      for (const i of items) if (!state.seenRepos.has(i.repo)) state.seenRepos.set(i.repo, 0);
      for (const [repo, n] of countBy(items, (i) => i.repo)) state.seenRepos.set(repo, Math.max(state.seenRepos.get(repo) || 0, n));
      paint();
      renderBanner();
    };
    paintHarvest();
    try {
      while (!stream.done && stream.rows.length < HARVEST_CAP) {
        await stream.fetchNext(2, isStale);
        paintHarvest();
      }
    } catch (err) {
      if (err.cancelled || isStale()) return;
    }
    if (isStale()) return;
    state.harvest.done = true;
    paintHarvest();
    populateRepoFilter();
  }

  function countBy(items, keyFn) {
    const m = new Map();
    for (const i of items) {
      const k = keyFn(i);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  function setTarget(prefix, { val, pct, sub, status, achieved }) {
    dom[`target${prefix}Val`].textContent = val;
    dom[`target${prefix}Bar`].style.width = `${pct}%`;
    dom[`target${prefix}Sub`].textContent = sub;
    dom[`target${prefix}Status`].textContent = status;
    dom[`target${prefix}Status`].className = `target-badge ${achieved ? "achieved" : ""}`;
  }

  function nextMilestone(n, steps) {
    for (const s of steps) if (n < s) return s;
    const last = steps[steps.length - 1];
    return Math.ceil((n + 1) / last) * last;
  }

  function updateTargets(n) {
    const prs = n.prs;
    if (prs !== undefined) {
      const goal = nextMilestone(prs, [50, 100, 250, 500, 1000, 2500, 5000]);
      const pct = Math.min(100, Math.round((prs / goal) * 100));
      setTarget("Pr", { val: fmt(prs), pct, sub: `${fmt(prs)} / ${fmt(goal)} PRs opened (${pct}% of next milestone)`, status: "On Track", achieved: false });
    } else setTarget("Pr", { val: "…", pct: 0, sub: "Counting…", status: "…" });

    if (prs !== undefined && n.merged !== undefined) {
      const rate = prs ? Math.round((n.merged / prs) * 100) : 0;
      setTarget("Merge", {
        val: `${rate}%`,
        pct: Math.min(100, Math.round((rate / 80) * 100)),
        sub: `${fmt(n.merged)} merged of ${fmt(prs)} PRs opened`,
        status: rate >= 80 ? "Goal Exceeded" : "Goal: 80%",
        achieved: rate >= 80,
      });
    } else setTarget("Merge", { val: "…", pct: 0, sub: "Counting…", status: "…" });

    if (n.issues !== undefined && n.openIssues !== undefined) {
      const closed = n.issues - n.openIssues;
      const rate = n.issues ? Math.round((closed / n.issues) * 100) : 0;
      setTarget("Issue", {
        val: `${rate}%`,
        pct: Math.min(100, Math.round((rate / 85) * 100)),
        sub: `${fmt(closed)} closed of ${fmt(n.issues)} issues opened`,
        status: rate >= 85 ? "Optimal" : "Goal: 85%",
        achieved: rate >= 85,
      });
    } else setTarget("Issue", { val: "…", pct: 0, sub: "Counting…", status: "…" });

    if (n.repos !== undefined) {
      const goal = nextMilestone(n.repos, [10, 25, 50, 100, 250]);
      setTarget("Repo", {
        val: fmt(n.repos),
        pct: Math.min(100, Math.round((n.repos / goal) * 100)),
        sub: `${fmt(n.repos)} repositories · ${n.reposLabel}`,
        status: `Goal: ${goal} Repos`,
        achieved: false,
      });
    } else setTarget("Repo", { val: "…", pct: 0, sub: "Counting…", status: "…" });
  }

  function renderHeatmap(items, win, note) {
    if (!dom.heatmapCalendar) return;
    dom.heatmapYearPills.innerHTML = "";
    const dayCounts = countBy(items, (i) => (i.createdAt || "").slice(0, 10));

    let startDate;
    if (win.year) {
      startDate = new Date(win.year, 0, 1);
    } else {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 364);
    }
    startDate.setDate(startDate.getDate() - startDate.getDay());

    const cols = 53;
    const rows = 7;
    const cellSize = 10;
    const stride = 13;
    const offsetX = 32;
    const offsetY = 20;
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let total = 0;
    let rects = "";
    let monthsSvg = "";
    let lastMonth = -1;
    const curr = new Date(startDate);
    const today = new Date();

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const iso = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, "0")}-${String(curr.getDate()).padStart(2, "0")}`;
        const count = dayCounts.get(iso) || 0;
        const inRange = curr <= today && (!win.year || curr.getFullYear() === win.year);
        if (inRange) total += count;
        const lvl = count >= 10 ? 4 : count >= 6 ? 3 : count >= 3 ? 2 : count >= 1 ? 1 : 0;
        const x = offsetX + c * stride;
        const y = offsetY + r * stride;
        if (r === 0 && curr.getMonth() !== lastMonth) {
          lastMonth = curr.getMonth();
          monthsSvg += `<text x="${x}" y="12" class="heatmap-month-label">${monthNames[lastMonth]}</text>`;
        }
        const dateStr = curr.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        rects += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" class="lvl-${lvl}" ${inRange ? "" : 'opacity="0.35"'}><title>${count} opened on ${dateStr}</title></rect>`;
        curr.setDate(curr.getDate() + 1);
      }
    }
    const w = offsetX + cols * stride + 10;
    const h = offsetY + rows * stride + 10;
    dom.heatmapCalendar.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${monthsSvg}
      <text x="6" y="${offsetY + stride + 8}" class="heatmap-day-label">Mon</text>
      <text x="6" y="${offsetY + 3 * stride + 8}" class="heatmap-day-label">Wed</text>
      <text x="6" y="${offsetY + 5 * stride + 8}" class="heatmap-day-label">Fri</text>${rects}</svg>`;
    dom.heatmapSub.textContent = "PRs & issues opened per day, for the selected relationship";
    dom.heatmapCountLabel.textContent = `${fmt(total)} in ${win.year ? win.year : "the last 52 weeks"}${note}`;
  }

  function renderDonutChart(n) {
    if (!dom.donutSvgContainer) return;
    const ready = n.prs !== undefined && n.merged !== undefined && n.openPrs !== undefined && n.draft !== undefined;
    const merged = n.merged || 0;
    const draft = n.draft || 0;
    const open = Math.max(0, (n.openPrs || 0) - draft);
    const closed = Math.max(0, (n.prs || 0) - merged - (n.openPrs || 0));
    const total = ready ? n.prs : 0;
    const rate = total ? Math.round((merged / total) * 100) : 0;
    const slices = [
      { label: "Merged", count: merged, color: "#a371f7" },
      { label: "Open", count: open, color: "#3fb950" },
      { label: "Closed", count: closed, color: "#f85149" },
      { label: "Draft", count: draft, color: "#8b949e" },
    ];
    const radius = 54;
    const circ = 2 * Math.PI * radius;
    let acc = 0;
    let paths = "";
    if (!total) {
      paths = `<circle cx="80" cy="80" r="${radius}" fill="none" stroke="var(--canvas-subtle)" stroke-width="18" />`;
    } else {
      for (const s of slices) {
        if (!s.count) continue;
        const pct = s.count / total;
        paths += `<circle cx="80" cy="80" r="${radius}" fill="none" stroke="${s.color}" stroke-width="18"
          stroke-dasharray="${(pct * circ).toFixed(2)} ${(circ - pct * circ).toFixed(2)}" stroke-dashoffset="${(-acc * circ).toFixed(2)}"
          transform="rotate(-90 80 80)"><title>${s.label}: ${fmt(s.count)} (${Math.round(pct * 100)}%)</title></circle>`;
        acc += pct;
      }
    }
    dom.donutSvgContainer.innerHTML = `<svg viewBox="0 0 160 160" width="160" height="160">${paths}
      <text x="80" y="78" text-anchor="middle" font-size="22" font-weight="700" fill="var(--text-white)" font-family="var(--font-mono)">${ready ? `${rate}%` : "…"}</text>
      <text x="80" y="96" text-anchor="middle" font-size="11" fill="var(--text-faint)" font-family="var(--font-mono)">Merged</text></svg>`;
    dom.donutLegend.innerHTML = slices
      .map(
        (s) => `<div class="donut-legend-row"><div class="donut-legend-label"><span class="legend-color-dot" style="background:${s.color};"></span><span>${s.label}</span></div>
        <span class="donut-legend-val">${ready ? fmt(s.count) : "…"} <span style="opacity:0.6;">${ready && total ? `(${Math.round((s.count / total) * 100)}%)` : ""}</span></span></div>`
      )
      .join("");
  }

  function renderTopRepos(items, note) {
    if (!dom.topReposList) return;
    const sorted = Array.from(countBy(items, (i) => i.repo).entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!sorted.length) {
      dom.topReposList.innerHTML = `<p style="font-size:0.8rem;color:var(--text-faint);">${state.harvest && !state.harvest.done ? "Loading…" : "No repository activity in this period."}</p>`;
      return;
    }
    const max = sorted[0][1];
    const total = items.length || 1;
    dom.topReposList.innerHTML =
      sorted
        .map(
          ([repo, count]) => `<div class="top-repo-row" data-repo="${escapeHtml(repo)}" style="cursor:pointer;" title="Show ${escapeHtml(repo)} in the feed">
          <div class="top-repo-meta"><span class="top-repo-name">${escapeHtml(repo)}</span><span class="top-repo-count">${fmt(count)} <span style="opacity:0.6;">(${Math.round((count / total) * 100)}%)</span></span></div>
          <div class="top-repo-bar-wrap"><div class="top-repo-bar-fill" style="width:${Math.round((count / max) * 100)}%;"></div></div></div>`
        )
        .join("") + (note ? `<p class="chart-note">${escapeHtml(note.trim())}</p>` : "");
    dom.topReposList.querySelectorAll(".top-repo-row").forEach((row) =>
      row.addEventListener("click", () => {
        state.filters.repo = row.dataset.repo;
        switchView("feed");
        onFiltersChanged();
      })
    );
  }

  function renderYearlyChart(years) {
    if (!dom.yearlyChartContainer) return;
    // Hide the "earlier" bar when nothing predates the account
    const entries = Array.from(years.entries()).filter(([y, n]) => y !== "earlier" || n);
    const max = Math.max(1, ...entries.map(([, n]) => n || 0));
    const selected = /^y(\d{4})$/.exec(state.filters.time)?.[1];
    dom.yearlyChartContainer.innerHTML = entries
      .map(([y, n]) => {
        const h = n === undefined ? 6 : Math.max(6, Math.round((n / max) * 125));
        if (y === "earlier") {
          return `<div class="chart-bar-col" title="${fmt(n)} opened before they joined GitHub (they took part later)">
          <span class="chart-bar-val">${fmt(n)}</span>
          <div class="chart-bar-body" style="height:${h}px;opacity:.6;"></div>
          <span class="chart-bar-label">Earlier</span></div>`;
        }
        return `<div class="chart-bar-col" data-year="${y}" style="cursor:pointer;" title="${n === undefined ? "Counting…" : `${fmt(n)} opened in ${y}`} — click to focus on ${y}">
          <span class="chart-bar-val">${n === undefined ? "…" : fmt(n)}</span>
          <div class="chart-bar-body ${String(y) === selected ? "peak-bar" : ""}" style="height:${h}px;${n === undefined ? "opacity:.3;" : ""}"></div>
          <span class="chart-bar-label">${y}</span></div>`;
      })
      .join("");
    dom.yearlyChartContainer.querySelectorAll(".chart-bar-col[data-year]").forEach((col) =>
      col.addEventListener("click", () => {
        state.filters.time = `y${col.dataset.year}`;
        onFiltersChanged();
      })
    );
  }

  function renderMonthlyChart(items, win) {
    if (!dom.monthlyChartContainer) return;
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const months = [];
    if (win.year) {
      for (let m = 0; m < 12; m++) months.push({ key: `${win.year}-${String(m + 1).padStart(2, "0")}`, label: names[m] });
    } else {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 11);
      for (let i = 0; i < 12; i++) {
        months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: names[d.getMonth()] });
        d.setMonth(d.getMonth() + 1);
      }
    }
    const counts = countBy(items, (i) => (i.createdAt || "").slice(0, 7));
    const values = months.map((m) => counts.get(m.key) || 0);
    const max = Math.max(1, ...values);
    const peak = values.indexOf(max);
    dom.monthlyChartContainer.innerHTML = months
      .map((m, i) => {
        const n = values[i];
        return `<div class="chart-bar-col" title="${fmt(n)} opened in ${m.label} ${m.key.slice(0, 4)}">
          <span class="chart-bar-val">${fmt(n)}</span>
          <div class="chart-bar-body ${i === peak && n ? "peak-bar" : ""}" style="height:${Math.max(6, Math.round((n / max) * 125))}px;"></div>
          <span class="chart-bar-label">${m.label}</span></div>`;
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
    if (analytics) loadAnalytics();
    else {
      state.analyticsGen++; // stop background chart loading
      renderBanner();
    }
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

  // ── Export (the rows loaded for the current filters) ────────────────
  function exportRows() {
    const s = state.streams.get(state.listQuery);
    const rows = s ? s.fwd.rows : state.pageRows;
    return { rows, total: state.listTotal || rows.length };
  }

  function generateExportContent(format) {
    const { rows, total } = exportRows();
    if (format === "json") {
      dom.exportContent.value = JSON.stringify(
        rows.map(({ body, ...rest }) => ({ ...rest, countedUnder: primaryBucket(rest, state.filters.rel), links: [...knownRoles(rest)] })),
        null,
        2
      );
      return;
    }
    let md = `# GitHub work for @${state.login}\n\n`;
    md += `*Exported from ghtrack on ${isoDay(new Date())} · ${fmt(rows.length)} of ${fmt(total)} matching items loaded · filter: \`${state.listQuery}\`*\n\n`;
    md += `| Type | Status | Repository | Number | Title | Updated |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    for (const i of rows) {
      md += `| ${i.kind.toUpperCase()} | ${i.statusLabel} | \`${i.repo}\` | #${i.number} | [${i.title.replace(/\|/g, "\\|")}](${i.url}) | ${(i.updatedAt || "").slice(0, 10)} |\n`;
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
    syncFilterControls();
    renderRelChips();
    cachePrune();
    await detectLocalProxy();
    const params = new URLSearchParams(window.location.search);
    const initialName = params.get("name") || params.get("u") || "";
    if (initialName) startTracking(initialName);
  }

  init();
})();
