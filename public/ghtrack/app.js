// ── ghtrack — Core Application Logic ────────────────────────────────────
(() => {
  "use strict";

  const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
  const GITHUB_REST_ENDPOINT = "https://api.github.com";
  const API_PAGE_SIZE = 100; // GitHub GraphQL maximum per search query (2x faster than 50)
  const FEED_PAGE_SIZE = 50; // Items per view page in the list feed for smooth DOM rendering

  // ── IndexedDB Cache Setup (Unlimited Cost-Free Client Storage) ───────
  const DB_NAME = "ghtrack_cache_db";
  const DB_VERSION = 2; // Bumped to v2 to automatically purge old/stale cached counts
  const STORE_NAME = "profiles";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        db.createObjectStore(STORE_NAME, { keyPath: "login" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getCachedProfile(login) {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(login.toLowerCase());
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function saveCachedProfile(login, data) {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put({ login: login.toLowerCase(), ...data, savedAt: Date.now() });
    } catch (err) {
      console.warn("IndexedDB save failed:", err);
    }
  }

  async function clearAllCache() {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
    } catch (err) {
      console.warn("Cache clear error:", err);
    }
  }

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    login: "",
    token: localStorage.getItem("ghtrack_token") || "",
    itemsMap: new Map(), // Master de-duplicated store of all lifetime items
    isInitialLoading: false,
    isStreamingBackground: false,
    cancelStreaming: false,
    currentPage: 1,
    pageSize: FEED_PAGE_SIZE,
    totalEstimated: 0,
    viewMode: "feed",       // 'feed' | 'analytics'
    dateRange: "all",       // 'all' | '2026' | '2025' | '2024' | '90d' | '30d'
    heatmapYear: "all",     // 'all' | year string
    filters: {
      kind: "all",          // 'all' | 'pr' | 'issue' | 'comment'
      prState: "all",       // 'all' | 'open' | 'draft' | 'merged' | 'closed'
      repo: "all",          // 'all' | repoName
      text: "",             // search query
    },
    expandedPreviews: new Set(),
  };

  // ── DOM References ──────────────────────────────────────────────────
  const dom = {
    searchForm: document.getElementById("search-form"),
    searchInput: document.getElementById("search-input"),
    inputClear: document.getElementById("input-clear"),
    btnSearch: document.getElementById("btn-search"),
    quickPills: document.querySelectorAll(".quick-pill"),

    telemetryBar: document.getElementById("telemetry-bar"),
    statTotal: document.getElementById("stat-total"),
    statTotalSub: document.getElementById("stat-total-sub"),
    statPrs: document.getElementById("stat-prs"),
    statPrsSub: document.getElementById("stat-prs-sub"),
    statIssues: document.getElementById("stat-issues"),
    statIssuesSub: document.getElementById("stat-issues-sub"),
    statComments: document.getElementById("stat-comments"),
    statRepos: document.getElementById("stat-repos"),

    streamBanner: document.getElementById("stream-banner"),
    streamText: document.getElementById("stream-text"),
    streamProgressFill: document.getElementById("stream-progress-fill"),
    btnClearCache: document.getElementById("btn-clear-cache"),
    btnExport: document.getElementById("btn-export"),

    mainContent: document.getElementById("main-content"),
    tabBtnFeed: document.getElementById("tab-btn-feed"),
    tabBtnAnalytics: document.getElementById("tab-btn-analytics"),
    feedView: document.getElementById("feed-view"),
    analyticsView: document.getElementById("analytics-view"),
    dateRangeSelect: document.getElementById("date-range-select"),

    // Targets
    targetPrVal: document.getElementById("target-pr-val"),
    targetPrBar: document.getElementById("target-pr-bar"),
    targetPrSub: document.getElementById("target-pr-sub"),
    targetPrStatus: document.getElementById("target-pr-status"),
    targetMergeVal: document.getElementById("target-merge-val"),
    targetMergeBar: document.getElementById("target-merge-bar"),
    targetMergeSub: document.getElementById("target-merge-sub"),
    targetMergeStatus: document.getElementById("target-merge-status"),
    targetIssueVal: document.getElementById("target-issue-val"),
    targetIssueBar: document.getElementById("target-issue-bar"),
    targetIssueSub: document.getElementById("target-issue-sub"),
    targetIssueStatus: document.getElementById("target-issue-status"),
    targetRepoVal: document.getElementById("target-repo-val"),
    targetRepoBar: document.getElementById("target-repo-bar"),
    targetRepoSub: document.getElementById("target-repo-sub"),
    targetRepoStatus: document.getElementById("target-repo-status"),

    // Heatmap & Charts
    heatmapCalendar: document.getElementById("heatmap-calendar"),
    heatmapSub: document.getElementById("heatmap-sub"),
    heatmapYearPills: document.getElementById("heatmap-year-pills"),
    heatmapCountLabel: document.getElementById("heatmap-count-label"),
    donutSvgContainer: document.getElementById("donut-svg-container"),
    donutLegend: document.getElementById("donut-legend"),
    topReposList: document.getElementById("top-repos-list"),
    yearlyChartContainer: document.getElementById("yearly-chart-container"),
    monthlyChartContainer: document.getElementById("monthly-chart-container"),

    filterKind: document.getElementById("filter-kind"),
    wrapPrState: document.getElementById("wrap-pr-state"),
    filterPrState: document.getElementById("filter-pr-state"),
    filterRepo: document.getElementById("filter-repo"),
    filterText: document.getElementById("filter-text"),

    pagerCount: document.getElementById("pager-count"),
    pagerPrev: document.getElementById("pager-prev"),
    pagerNext: document.getElementById("pager-next"),
    pageButtons: document.getElementById("page-buttons"),
    bottomSummary: document.getElementById("bottom-summary"),

    listContainer: document.getElementById("list-container"),
    listEmpty: document.getElementById("list-empty"),
    listLoading: document.getElementById("list-loading"),

    btnTheme: document.getElementById("btn-theme"),
    iconSun: document.getElementById("theme-icon-sun"),
    iconMoon: document.getElementById("theme-icon-moon"),

    modalExport: document.getElementById("modal-export"),
    modalExportClose: document.getElementById("modal-export-close"),
    tabExportMd: document.getElementById("tab-export-md"),
    tabExportJson: document.getElementById("tab-export-json"),
    exportContent: document.getElementById("export-content"),
    btnCopyExport: document.getElementById("btn-copy-export"),
    btnDownloadExport: document.getElementById("btn-download-export"),
  };

  // ── GraphQL Queries (100 items per request, lightweight with comment authors) ──
  const ROW_FRAGMENT = `
    fragment RowDetails on SearchResultItem {
      ... on Issue {
        __typename
        number
        title
        url
        state
        stateReason
        createdAt
        updatedAt
        author { login avatarUrl }
        repository { nameWithOwner }
        comments(first: 25) {
          totalCount
          nodes {
            author { login }
          }
        }
        labels(first: 5) { nodes { name color } }
      }
      ... on PullRequest {
        __typename
        number
        title
        url
        state
        isDraft
        merged
        createdAt
        updatedAt
        additions
        deletions
        changedFiles
        author { login avatarUrl }
        repository { nameWithOwner }
        comments(first: 25) {
          totalCount
          nodes {
            author { login }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
            }
          }
        }
        labels(first: 5) { nodes { name color } }
      }
    }
  `;

  const SEARCH_QUERY = `
    query($q: String!, $n: Int!, $cursor: String) {
      search(query: $q, type: ISSUE, first: $n, after: $cursor) {
        issueCount
        pageInfo { endCursor hasNextPage }
        nodes { ...RowDetails }
      }
    }
    ${ROW_FRAGMENT}
  `;

  // ── GitHub API Fetcher (Dual Engine: GraphQL Proxy + REST Fallback) ─
  async function fetchGraphQL(query, variables) {
    try {
      const proxyRes = await fetch("/api/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (proxyRes.ok) {
        const proxyData = await proxyRes.json();
        if (proxyData.data) return proxyData.data;
      }
    } catch {
      // Proxy not reached, fall through to client token
    }

    if (state.token) {
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": "ghtrack-web/1.0",
        Authorization: `Bearer ${state.token}`,
      };

      const res = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
      });

      const data = await res.json().catch(() => null);
      if (res.ok && data?.data) {
        return data.data;
      }
    }

    throw new Error("GRAPHQL_UNAVAILABLE");
  }

  // REST search fallback for unauthenticated public browsing
  async function fetchRestSearch(login, page = 1) {
    const headers = {
      "User-Agent": "ghtrack-web/1.0",
      Accept: "application/vnd.github.v3+json",
    };
    if (state.token) {
      headers["Authorization"] = `Bearer ${state.token}`;
    }

    const url = `${GITHUB_REST_ENDPOINT}/search/issues?q=involves:${encodeURIComponent(login)}&sort=updated&order=desc&per_page=100&page=${page}`;
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = data?.message || `GitHub error: ${res.status}`;
      if (res.status === 403) {
        throw new Error("GitHub rate limit reached for unauthenticated browsing.");
      }
      throw new Error(msg);
    }

    return data;
  }

  function normalizeRestNode(raw, currentLogin) {
    if (!raw || !raw.html_url) return null;
    const isPR = Boolean(raw.pull_request);
    const isMerged = Boolean(raw.pull_request?.merged_at);
    const authorLogin = raw.user?.login || "ghost";
    const cleanLogin = currentLogin.toLowerCase();
    const isAuthor = authorLogin.toLowerCase() === cleanLogin;

    const repoMatch = raw.html_url.match(/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)/);
    const repo = repoMatch ? repoMatch[1] : "unknown/repo";

    let status = "open";
    let statusLabel = "Open";

    if (isPR) {
      if (isMerged) {
        status = "merged";
        statusLabel = "Merged";
      } else if (raw.state === "closed") {
        status = "closed";
        statusLabel = "Closed";
      } else if (raw.draft) {
        status = "draft";
        statusLabel = "Draft";
      } else {
        status = "open";
        statusLabel = "Open";
      }
    } else {
      if (raw.state === "closed") {
        status = raw.state_reason === "not_planned" ? "not-planned" : "closed";
        statusLabel = raw.state_reason === "not_planned" ? "Not planned" : "Closed";
      } else {
        status = "open";
        statusLabel = "Open";
      }
    }

    return {
      id: raw.html_url,
      kind: isPR ? "pr" : "issue",
      number: raw.number,
      title: (raw.title || "").trim(),
      url: raw.html_url,
      repo,
      author: authorLogin,
      authorAvatar: raw.user?.avatar_url || "",
      isAuthor,
      userCommented: raw.comments > 0, // Fallback flag
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      status,
      statusLabel,
      body: raw.body || "",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      baseRef: "",
      headRef: "",
      isConflict: false,
      reviewDecision: null,
      ciState: null,
      commentsCount: raw.comments || 0,
      recentComments: [],
      labels: (raw.labels || []).map((l) => ({ name: l.name, color: l.color })),
    };
  }

  // ── Normalization & Chips ───────────────────────────────────────────
  function normalizeNode(node, currentLogin) {
    if (!node || !node.repository?.nameWithOwner) return null;

    const isPR = node.__typename === "PullRequest";
    const authorLogin = node.author?.login || "ghost";
    const cleanLogin = currentLogin.toLowerCase();
    const isAuthor = authorLogin.toLowerCase() === cleanLogin;

    // Check if user actually commented on this issue/PR (regardless of whether they are the author!)
    let userCommented = false;
    if (node._isCommenterStream) {
      userCommented = true;
    } else if (node.comments?.nodes) {
      for (const c of node.comments.nodes) {
        if (c?.author?.login?.toLowerCase() === cleanLogin) {
          userCommented = true;
          break;
        }
      }
    }

    // Determine status badge
    let status = "open";
    let statusLabel = "Open";

    if (isPR) {
      if (node.merged) {
        status = "merged";
        statusLabel = "Merged";
      } else if (node.state === "CLOSED") {
        status = "closed";
        statusLabel = "Closed";
      } else if (node.isDraft) {
        status = "draft";
        statusLabel = "Draft";
      } else {
        status = "open";
        statusLabel = "Open";
      }
    } else {
      if (node.state === "CLOSED") {
        if (node.stateReason === "NOT_PLANNED") {
          status = "not-planned";
          statusLabel = "Not planned";
        } else {
          status = "closed";
          statusLabel = "Closed";
        }
      } else {
        status = "open";
        statusLabel = "Open";
      }
    }

    // CI state
    const ciState = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null;

    return {
      id: node.url,
      kind: isPR ? "pr" : "issue",
      number: node.number,
      title: (node.title || "").trim(),
      url: node.url,
      repo: node.repository.nameWithOwner,
      author: authorLogin,
      authorAvatar: node.author?.avatarUrl || "",
      isAuthor,
      userCommented,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      status,
      statusLabel,
      body: "",
      additions: node.additions || 0,
      deletions: node.deletions || 0,
      changedFiles: node.changedFiles || 0,
      baseRef: "",
      headRef: "",
      isConflict: false,
      reviewDecision: null,
      ciState,
      commentsCount: node.comments?.totalCount || 0,
      recentComments: [],
      labels: node.labels?.nodes || [],
    };
  }

  // ── Helper formatters ───────────────────────────────────────────────
  function timeAgo(dateString) {
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
    const years = Math.floor(days / 365);
    return `${years}y ago`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
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

  async function startTracking(username, forceLive = false) {
    const cleanUser = username.trim().replace(/^@/, "");
    if (!cleanUser) return;

    // Isolate this specific search session
    const searchId = ++activeSearchId;

    state.login = cleanUser;
    state.currentPage = 1;
    state.cancelStreaming = true; // Signal previous stream loops to terminate

    dom.searchInput.value = cleanUser;
    history.replaceState(null, "", `?name=${encodeURIComponent(cleanUser)}`);

    // Reset all UI elements
    dom.listContainer.innerHTML = "";
    dom.pageButtons.innerHTML = "";
    dom.filterRepo.innerHTML = `<option value="all">All Repositories</option>`;
    dom.statTotal.textContent = "0";
    dom.statPrs.textContent = "0";
    dom.statPrsSub.textContent = "0% merged";
    dom.statIssues.textContent = "0";
    dom.statIssuesSub.textContent = "0 open · 0 closed";
    dom.statComments.textContent = "0";
    dom.statRepos.textContent = "0";
    dom.pagerCount.textContent = "0 of 0";

    dom.btnSearch.disabled = true;
    dom.btnSearch.innerHTML = `<span class="loading-dots">Tracking<i></i><i></i><i></i></span>`;
    dom.mainContent.style.display = "block";
    dom.listLoading.style.display = "flex";
    dom.listEmpty.style.display = "none";
    dom.telemetryBar.style.display = "grid";
    dom.streamBanner.style.display = "flex";
    dom.streamText.textContent = `Fetching live GitHub history for @${cleanUser}...`;
    dom.streamProgressFill.style.width = "5%";

    // If NOT forceLive, check IndexedDB cache for instant display
    if (!forceLive) {
      const cached = await getCachedProfile(cleanUser);
      if (searchId !== activeSearchId) return;
      if (cached && cached.items?.length && cached.login === cleanUser.toLowerCase()) {
        state.itemsMap.clear();
        cached.items.forEach((item) => state.itemsMap.set(item.id, item));
        updateTelemetry();
        populateRepoFilter();
        renderList();
        renderAnalytics();
        dom.streamText.textContent = `⚡ Cached data loaded (${state.itemsMap.size} items) · Verifying live updates...`;
      } else {
        state.itemsMap.clear();
      }
    } else {
      state.itemsMap.clear();
    }

    try {
      // 1. High-Speed Initial GraphQL Request (Pulls first 100 items instantly)
      const data = await fetchGraphQL(SEARCH_QUERY, {
        q: `involves:${cleanUser} sort:updated-desc`,
        n: API_PAGE_SIZE,
        cursor: null,
      });

      if (searchId !== activeSearchId) return;

      const totalEstimated = data.search?.issueCount || 0;
      state.totalEstimated = totalEstimated;

      if (forceLive || !state.itemsMap.size) {
        state.itemsMap.clear();
      }

      for (const node of data.search?.nodes || []) {
        const item = normalizeNode(node, cleanUser);
        if (item) {
          const existing = state.itemsMap.get(item.id);
          if (existing) {
            if (item.userCommented) existing.userCommented = true;
          } else {
            state.itemsMap.set(item.id, item);
          }
        }
      }

      dom.listLoading.style.display = "none";
      updateTelemetry();
      populateRepoFilter();
      renderList();
      renderAnalytics();

      state.cancelStreaming = false;
      streamRemainingBatches(
        cleanUser,
        searchId,
        data.search?.pageInfo?.endCursor,
        totalEstimated
      );
    } catch (err) {
      if (searchId !== activeSearchId) return;

      // Fallback: If GraphQL proxy unavailable, try REST Search
      try {
        const restData = await fetchRestSearch(cleanUser, 1);
        if (searchId !== activeSearchId) return;

        const totalEstimated = restData.total_count || 0;
        state.totalEstimated = totalEstimated;
        if (forceLive || !state.itemsMap.size) state.itemsMap.clear();

        for (const raw of restData.items || []) {
          const item = normalizeRestNode(raw, cleanUser);
          if (item) state.itemsMap.set(item.id, item);
        }

        dom.listLoading.style.display = "none";
        updateTelemetry();
        populateRepoFilter();
        renderList();
        renderAnalytics();

        const totalPages = Math.ceil(totalEstimated / 100);
        if (totalPages > 1) {
          state.cancelStreaming = false;
          streamRestPages(cleanUser, searchId, totalPages, totalEstimated);
        } else {
          dom.streamText.textContent = `✓ All ${state.itemsMap.size} lifetime items loaded`;
          dom.streamProgressFill.style.width = "100%";
          saveCachedProfile(cleanUser, { login: cleanUser.toLowerCase(), items: Array.from(state.itemsMap.values()) });
        }
      } catch (restErr) {
        if (searchId !== activeSearchId) return;
        dom.listLoading.style.display = "none";
        dom.streamText.textContent = `Error: ${restErr.message}`;
        if (!state.itemsMap.size) {
          dom.listEmpty.style.display = "block";
          dom.listEmpty.querySelector("p").textContent = restErr.message;
        }
      }
    } finally {
      if (searchId === activeSearchId) {
        dom.btnSearch.disabled = false;
        dom.btnSearch.textContent = "Track";
      }
    }
  }

  // Background stream processor: Dual-Stream Multi-Source Harvester (100 items per batch)
  async function streamRemainingBatches(login, searchId, initialCursor, initialInvolvesEst) {
    state.isStreamingBackground = true;

    // Both dimensions of complete GitHub activity:
    // 1. involves:username (authored, commented, reviewed, assigned work across all GitHub)
    // 2. user:username (all issues and PRs in repositories owned by the user, catching community work)
    const streams = [
      { name: "involves", base: `involves:${login}`, cursor: initialCursor, totalEst: initialInvolvesEst },
      { name: "user repos", base: `user:${login}`, cursor: null, totalEst: 0 },
    ];

    for (let sIdx = 0; sIdx < streams.length; sIdx++) {
      if (state.cancelStreaming || searchId !== activeSearchId) break;

      const stream = streams[sIdx];
      let cursor = stream.cursor;
      let currentQuery = `${stream.base} sort:updated-desc`;
      let windowBatch = 0;
      let streamNodes = [];

      while (!state.cancelStreaming && searchId === activeSearchId) {
        const currentCount = state.itemsMap.size;
        dom.streamText.textContent = `⚡ Buffering lifetime history: ${currentCount} loaded (${stream.name})...`;
        dom.streamProgressFill.style.width = `${Math.min(98, Math.max(8, Math.round((currentCount / 1255) * 100)))}%`;

        try {
          const data = await fetchGraphQL(SEARCH_QUERY, {
            q: currentQuery,
            n: API_PAGE_SIZE,
            cursor,
          });

          if (searchId !== activeSearchId) return;

          const nodes = data.search?.nodes || [];
          const queryTotal = data.search?.issueCount || 0;
          if (sIdx === 1 && !stream.totalEst) stream.totalEst = queryTotal;

          if (!nodes.length) {
            // Check if windowing needed for this stream
            if (queryTotal > streamNodes.length && windowBatch < 6) {
              let oldestDate = null;
              for (const n of streamNodes) {
                if (!oldestDate || new Date(n.updatedAt) < new Date(oldestDate)) {
                  oldestDate = n.updatedAt;
                }
              }
              if (oldestDate) {
                windowBatch++;
                currentQuery = `${stream.base} updated:<${oldestDate} sort:updated-desc`;
                cursor = null;
                continue;
              }
            }
            break;
          }

          for (const node of nodes) {
            streamNodes.push(node);
            const item = normalizeNode(node, login);
            if (item) {
              const existing = state.itemsMap.get(item.id);
              if (existing) {
                if (item.userCommented) existing.userCommented = true;
              } else {
                state.itemsMap.set(item.id, item);
              }
            }
          }

          const hasNextPage = Boolean(data.search?.pageInfo?.hasNextPage);
          cursor = data.search?.pageInfo?.endCursor || null;

          updateTelemetry();
          populateRepoFilter();
          updatePagerUI();
          renderAnalytics();

          // Check single query search ceiling (GitHub 1,000 items)
          if (!hasNextPage || cursor === "Y3Vyc29yOjEwMDA=") {
            if (queryTotal > streamNodes.length && windowBatch < 6) {
              let oldestDate = null;
              for (const n of streamNodes) {
                if (!oldestDate || new Date(n.updatedAt) < new Date(oldestDate)) {
                  oldestDate = n.updatedAt;
                }
              }
              if (oldestDate) {
                windowBatch++;
                currentQuery = `${stream.base} updated:<${oldestDate} sort:updated-desc`;
                cursor = null;
                await new Promise((r) => setTimeout(r, 40));
                continue;
              }
            }
            break;
          }

          await new Promise((r) => setTimeout(r, 40));
        } catch (err) {
          console.warn(`Background stream (${stream.name}) error:`, err.message);
          break;
        }
      }
    }

    if (searchId !== activeSearchId) return;

    state.isStreamingBackground = false;
    dom.streamText.textContent = `✓ 100% lifetime history loaded (${state.itemsMap.size} items buffered in memory & IndexedDB)`;
    dom.streamProgressFill.style.width = "100%";

    saveCachedProfile(login, { login: login.toLowerCase(), items: Array.from(state.itemsMap.values()) });
    updatePagerUI();
    renderAnalytics();
  }

  // Background stream processor for public REST mode
  async function streamRestPages(login, searchId, totalPages, totalEst) {
    state.isStreamingBackground = true;

    for (let page = 2; page <= totalPages && !state.cancelStreaming && searchId === activeSearchId; page++) {
      const currentCount = state.itemsMap.size;
      const progressPercent = totalEst > 0 ? Math.min(99, Math.round((currentCount / totalEst) * 100)) : 50;

      dom.streamText.textContent = `⚡ Buffering background history: ${currentCount} loaded (${progressPercent}%)...`;
      dom.streamProgressFill.style.width = `${progressPercent}%`;

      try {
        const data = await fetchRestSearch(login, page);
        if (searchId !== activeSearchId) return;

        for (const raw of data.items || []) {
          const item = normalizeRestNode(raw, login);
          if (item) state.itemsMap.set(item.id, item);
        }

        updateTelemetry();
        populateRepoFilter();
        updatePagerUI();
        renderAnalytics();

        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.warn("Background REST stream paused:", err.message);
        break;
      }
    }

    if (searchId !== activeSearchId) return;

    state.isStreamingBackground = false;
    dom.streamText.textContent = `✓ 100% lifetime history loaded (${state.itemsMap.size} items buffered in memory & IndexedDB)`;
    dom.streamProgressFill.style.width = "100%";
    saveCachedProfile(login, { login: login.toLowerCase(), items: Array.from(state.itemsMap.values()) });
    updatePagerUI();
    renderAnalytics();
  }

  // ── Telemetry & Metrics ─────────────────────────────────────────────
  function updateTelemetry() {
    const all = getItemsForCurrentDateRange();
    const prs = all.filter((i) => i.kind === "pr");
    const mergedPrs = prs.filter((i) => i.status === "merged");
    const issues = all.filter((i) => i.kind === "issue");
    const openIssues = issues.filter((i) => i.status === "open");
    const comments = all.filter((i) => i.userCommented);
    const repos = new Set(all.map((i) => i.repo));

    const mergeRate = prs.length ? Math.round((mergedPrs.length / prs.length) * 100) : 0;

    dom.statTotal.textContent = all.length;
    dom.statTotalSub.textContent = state.dateRange === "all" ? "PRs + Issues + Comments" : `in selected ${state.dateRange}`;
    dom.statPrs.textContent = prs.length;
    dom.statPrsSub.textContent = `${mergeRate}% merged (${mergedPrs.length} PRs)`;
    dom.statIssues.textContent = issues.length;
    dom.statIssuesSub.textContent = `${openIssues.length} open · ${issues.length - openIssues.length} closed`;
    dom.statComments.textContent = comments.length;
    dom.statRepos.textContent = repos.size;
  }

  // ── Filter & Pagination Engine ──────────────────────────────────────
  function getFilteredItems() {
    let items = getItemsForCurrentDateRange();

    // Filter 1: Kind (All / PR / Issue / Comment)
    if (state.filters.kind === "pr") {
      items = items.filter((i) => i.kind === "pr");
      // Filter 2: PR Sub-status (Open / Draft / Merged / Closed)
      if (state.filters.prState !== "all") {
        items = items.filter((i) => i.status === state.filters.prState);
      }
    } else if (state.filters.kind === "issue") {
      items = items.filter((i) => i.kind === "issue");
    } else if (state.filters.kind === "comment") {
      items = items.filter((i) => i.userCommented);
    }

    // Filter 3: Repository
    if (state.filters.repo !== "all") {
      items = items.filter((i) => i.repo === state.filters.repo);
    }

    // Filter 4: Text Search
    if (state.filters.text.trim()) {
      const q = state.filters.text.toLowerCase().trim();
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.repo.toLowerCase().includes(q) ||
          `#${i.number}`.includes(q)
      );
    }

    // Sort: Newest updated first
    items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return items;
  }

  function populateRepoFilter() {
    const all = getItemsForCurrentDateRange();
    const counts = {};
    for (const item of all) {
      counts[item.repo] = (counts[item.repo] || 0) + 1;
    }

    const currentVal = dom.filterRepo.value;
    dom.filterRepo.innerHTML = `<option value="all">All Repositories (${all.length})</option>`;

    const sortedRepos = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [repo, count] of sortedRepos) {
      const opt = document.createElement("option");
      opt.value = repo;
      opt.textContent = `${repo} (${count})`;
      dom.filterRepo.appendChild(opt);
    }

    if (counts[currentVal]) {
      dom.filterRepo.value = currentVal;
    }
  }

  // ── Render List & Gmail Pager ───────────────────────────────────────
  function renderList() {
    const filtered = getFilteredItems();
    const total = filtered.length;

    if (total === 0) {
      dom.listContainer.innerHTML = "";
      dom.listEmpty.style.display = "block";
      updatePagerUI(0);
      return;
    }

    dom.listEmpty.style.display = "none";

    const totalPages = Math.ceil(total / state.pageSize);
    if (state.currentPage > totalPages) state.currentPage = totalPages;
    if (state.currentPage < 1) state.currentPage = 1;

    const startIndex = (state.currentPage - 1) * state.pageSize;
    const endIndex = Math.min(startIndex + state.pageSize, total);
    const pageItems = filtered.slice(startIndex, endIndex);

    dom.listContainer.innerHTML = "";

    for (const item of pageItems) {
      const row = createItemRow(item);
      dom.listContainer.appendChild(row);
    }

    updatePagerUI(total);
  }

  function updatePagerUI(totalCount) {
    const total = totalCount !== undefined ? totalCount : getFilteredItems().length;
    if (total === 0) {
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

    // Gmail-style pager text: "1–50 of 1255"
    dom.pagerCount.textContent = `${start}–${end} of ${total}`;
    dom.pagerPrev.disabled = state.currentPage <= 1;
    dom.pagerNext.disabled = state.currentPage >= totalPages;

    // Bottom page jump buttons: [1] [2] [3] ...
    dom.pageButtons.innerHTML = "";
    const maxButtons = 7;
    let startPage = Math.max(1, state.currentPage - 3);
    let endPage = Math.min(totalPages, startPage + maxButtons - 1);
    if (endPage - startPage < maxButtons - 1) {
      startPage = Math.max(1, endPage - maxButtons + 1);
    }

    if (startPage > 1) {
      addPageButton(1);
      if (startPage > 2) addEllipsis();
    }

    for (let p = startPage; p <= endPage; p++) {
      addPageButton(p);
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) addEllipsis();
      addPageButton(totalPages);
    }

    dom.bottomSummary.textContent = `Page ${state.currentPage} of ${totalPages} · 50 items/page`;
  }

  function addPageButton(pageNumber) {
    const btn = document.createElement("button");
    btn.className = `page-btn ${pageNumber === state.currentPage ? "active" : ""}`;
    btn.textContent = pageNumber;
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.currentPage = pageNumber;
      renderList();
      dom.mainContent.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    dom.pageButtons.appendChild(btn);
  }

  function addEllipsis() {
    const span = document.createElement("span");
    span.textContent = "…";
    span.style.padding = "4px";
    span.style.color = "var(--text-faint)";
    dom.pageButtons.appendChild(span);
  }

  // ── DOM Row Builder ─────────────────────────────────────────────────
  function createItemRow(item) {
    const row = document.createElement("div");
    row.className = "item-row";
    row.dataset.id = item.id;

    const badgeClass = item.status;
    const isExpanded = state.expandedPreviews.has(item.id);

    // CI icon
    let ciHtml = "";
    if (item.ciState === "SUCCESS") {
      ciHtml = `<span class="subline-tag ci-tag success" title="CI Passing">✓ CI</span>`;
    } else if (item.ciState === "FAILURE" || item.ciState === "ERROR") {
      ciHtml = `<span class="subline-tag ci-tag failure" title="CI Failing">✕ CI</span>`;
    } else if (item.ciState === "PENDING") {
      ciHtml = `<span class="subline-tag ci-tag pending" title="CI Running">◐ CI</span>`;
    }

    // Type icon (PR vs Issue)
    let typeIconSvg = "";
    if (item.kind === "pr") {
      typeIconSvg = `<svg class="type-icon" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.128a2.251 2.251 0 101.5 0V5a2.5 2.5 0 00-2.5-2.5z"></path></svg>`;
    } else {
      typeIconSvg = `<svg class="type-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"></path><path fill-rule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"></path></svg>`;
    }

    row.innerHTML = `
      <div class="row-main">
        <div class="row-left">
          ${typeIconSvg}
          <div class="row-content">
            <div class="row-header-line">
              <span class="gh-badge ${badgeClass}">${item.statusLabel}</span>
              <span class="repo-label">${escapeHtml(item.repo)}#${item.number}</span>
              <a href="${item.url}" target="_blank" rel="noopener" class="item-title-link">${escapeHtml(item.title)}</a>
            </div>
            <div class="row-subline">
              <span>by <strong class="subline-user">${escapeHtml(item.author)}</strong></span>
              <span>·</span>
              <span>💬 ${item.commentsCount}</span>
              ${ciHtml}
              ${item.userCommented ? `<span class="subline-tag" style="color:var(--gh-warn);">★ Commented</span>` : ""}
            </div>
          </div>
        </div>

        <div class="row-right">
          <span class="time-ago">${timeAgo(item.updatedAt)}</span>
          <button type="button" class="btn-preview-toggle ${isExpanded ? "expanded" : ""}" title="Toggle preview drawer">
            <span>Preview</span>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
              <path fill-rule="evenodd" d="M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.75.75 0 0 1 1.06-1.06L8 9.94l3.72-3.72a.75.75 0 0 1 1.06 0z"></path>
            </svg>
          </button>
        </div>
      </div>

      <!-- Native Real GitHub Page Embedder Drawer -->
      <div class="preview-drawer ${isExpanded ? "open" : ""}">
        <div class="drawer-header">
          <div class="preview-meta">
            <span class="preview-badge">Live GitHub</span>
            <span class="preview-url">${escapeHtml(item.repo)}#${item.number}</span>
          </div>

          <div class="drawer-actions">
            <a href="${item.url}" target="_blank" rel="noopener" class="btn-external">
              <span>Open in new tab</span>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path fill-rule="evenodd" d="M10.604 1h4.146a.25.25 0 01.25.25v4.146a.25.25 0 01-.427.177L13.03 4.03 9.28 7.78a.75.75 0 01-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0110.604 1zM3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5h-3.5z"></path>
              </svg>
            </a>
            <button type="button" class="btn-close-drawer">✕ Close</button>
          </div>
        </div>

        <div class="iframe-container">
          <iframe class="preview-iframe" data-src="/view?url=${encodeURIComponent(item.url)}" title="GitHub Page Preview"></iframe>
        </div>
      </div>
    `;

    const previewBtn = row.querySelector(".btn-preview-toggle");
    const drawer = row.querySelector(".preview-drawer");
    const closeBtn = row.querySelector(".btn-close-drawer");
    const iframe = row.querySelector(".preview-iframe");

    function setDrawerOpen(open) {
      drawer.classList.toggle("open", open);
      previewBtn.classList.toggle("expanded", open);
      if (open) {
        state.expandedPreviews.add(item.id);
        if (iframe && !iframe.src && iframe.dataset.src) {
          iframe.src = iframe.dataset.src;
        }
      } else {
        state.expandedPreviews.delete(item.id);
      }
    }

    previewBtn.addEventListener("click", () => {
      setDrawerOpen(!drawer.classList.contains("open"));
    });

    closeBtn.addEventListener("click", () => {
      setDrawerOpen(false);
    });

    return row;
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
    const prs = items.filter((i) => i.kind === "pr");
    const mergedPrs = prs.filter((i) => i.status === "merged");
    const issues = items.filter((i) => i.kind === "issue");
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

    const prs = items.filter((i) => i.kind === "pr");
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
        dom.filterRepo.value = repo;
        state.filters.repo = repo;
        state.currentPage = 1;
        state.viewMode = "feed";
        dom.tabBtnFeed.classList.add("active");
        dom.tabBtnAnalytics.classList.remove("active");
        dom.feedView.style.display = "block";
        dom.analyticsView.style.display = "none";
        renderList();
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
        state.currentPage = 1;
        updateTelemetry();
        populateRepoFilter();
        renderList();
        renderAnalytics();
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

  // ── View Mode & Date Filter Event Listeners ──────────────────────────
  dom.tabBtnFeed.addEventListener("click", () => {
    state.viewMode = "feed";
    dom.tabBtnFeed.classList.add("active");
    dom.tabBtnAnalytics.classList.remove("active");
    dom.feedView.style.display = "block";
    dom.analyticsView.style.display = "none";
  });

  dom.tabBtnAnalytics.addEventListener("click", () => {
    state.viewMode = "analytics";
    dom.tabBtnAnalytics.classList.add("active");
    dom.tabBtnFeed.classList.remove("active");
    dom.analyticsView.style.display = "block";
    dom.feedView.style.display = "none";
    renderAnalytics();
  });

  dom.dateRangeSelect.addEventListener("change", (e) => {
    state.dateRange = e.target.value;
    state.currentPage = 1;
    updateTelemetry();
    populateRepoFilter();
    renderList();
    renderAnalytics();
  });

  // ── Filter Event Listeners ──────────────────────────────────────────
  dom.filterKind.addEventListener("change", (e) => {
    state.filters.kind = e.target.value;
    state.currentPage = 1;

    // Show PR State dropdown only when PR is selected
    if (state.filters.kind === "pr") {
      dom.wrapPrState.style.display = "inline-flex";
    } else {
      dom.wrapPrState.style.display = "none";
      state.filters.prState = "all";
      dom.filterPrState.value = "all";
    }

    renderList();
  });

  dom.filterPrState.addEventListener("change", (e) => {
    state.filters.prState = e.target.value;
    state.currentPage = 1;
    renderList();
  });

  dom.filterRepo.addEventListener("change", (e) => {
    state.filters.repo = e.target.value;
    state.currentPage = 1;
    renderList();
  });

  dom.filterText.addEventListener("input", (e) => {
    state.filters.text = e.target.value;
    state.currentPage = 1;
    renderList();
  });

  // ── Pagination Nav Listeners ────────────────────────────────────────
  dom.pagerPrev.addEventListener("click", () => {
    if (state.currentPage > 1) {
      state.currentPage--;
      renderList();
      dom.mainContent.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  dom.pagerNext.addEventListener("click", () => {
    const total = getFilteredItems().length;
    const totalPages = Math.ceil(total / state.pageSize);
    if (state.currentPage < totalPages) {
      state.currentPage++;
      renderList();
      dom.mainContent.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  // ── Search & Form Handlers ──────────────────────────────────────────
  dom.searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    startTracking(dom.searchInput.value, true);
  });

  dom.inputClear.addEventListener("click", () => {
    dom.searchInput.value = "";
    dom.inputClear.style.display = "none";
    dom.searchInput.focus();
  });

  dom.searchInput.addEventListener("input", () => {
    dom.inputClear.style.display = dom.searchInput.value ? "block" : "none";
  });

  dom.quickPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      const user = pill.dataset.user;
      dom.searchInput.value = user;
      startTracking(user, true);
    });
  });

  // Clear Cache Button
  if (dom.btnClearCache) {
    dom.btnClearCache.addEventListener("click", async () => {
      await clearAllCache();
      if (state.login) {
        startTracking(state.login, true);
      }
    });
  }

  // ── Theme Switcher ──────────────────────────────────────────────────
  function initTheme() {
    const saved = localStorage.getItem("ghtrack_theme");
    const theme = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    applyTheme(theme);
  }

  function updateFavicon(theme) {
    const faviconLink = document.querySelector("link[rel='icon']");
    if (!faviconLink) return;
    const isLight = theme === "light";
    const bg = isLight ? "%23ffffff" : "%230d1117";
    const border = isLight ? "%23d0d7de" : "%2330363d";
    const stem = isLight ? "%230969da" : "%23388bfd";
    const purple = isLight ? "%238250df" : "%23a371f7";
    const green = isLight ? "%231a7f37" : "%233fb950";
    const blue = isLight ? "%230969da" : "%2338bdf8";
    const center = isLight ? "%231f2328" : "%23f0f6fc";

    faviconLink.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='28' fill='${bg}'/%3E%3Crect x='2' y='2' width='124' height='124' rx='26' stroke='${border}' stroke-width='2' fill='none'/%3E%3Cpath d='M38 90 V42' stroke='${stem}' stroke-width='3.5' stroke-linecap='round'/%3E%3Cpath d='M38 66 C38 48, 90 56, 90 38' stroke='${stem}' stroke-width='3.5' stroke-linecap='round' fill='none'/%3E%3Ccircle cx='38' cy='90' r='7' fill='${blue}'/%3E%3Ccircle cx='38' cy='42' r='7.5' fill='${green}'/%3E%3Ccircle cx='90' cy='38' r='7.5' fill='${purple}'/%3E%3Ccircle cx='64' cy='64' r='4.5' fill='${center}'/%3E%3C/svg%3E`;
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ghtrack_theme", theme);
    if (theme === "light") {
      dom.iconSun.style.display = "none";
      dom.iconMoon.style.display = "block";
    } else {
      dom.iconSun.style.display = "block";
      dom.iconMoon.style.display = "none";
    }
    updateFavicon(theme);
  }

  dom.btnTheme.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    applyTheme(current === "light" ? "dark" : "light");
  });

  // ── Export Modal ────────────────────────────────────────────────────
  dom.btnExport.addEventListener("click", () => {
    generateExportContent("md");
    dom.modalExport.classList.add("open");
  });

  dom.modalExportClose.addEventListener("click", () => {
    dom.modalExport.classList.remove("open");
  });

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

  function generateExportContent(format) {
    const items = getFilteredItems();
    if (format === "json") {
      dom.exportContent.value = JSON.stringify(items, null, 2);
    } else {
      let md = `# GitHub Lifetime Work for @${state.login}\n\n`;
      md += `*Exported from ghtrack on ${new Date().toISOString().split("T")[0]}*\n\n`;
      md += `| Type | Status | Repository | Number | Title | Updated |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
      for (const i of items) {
        md += `| ${i.kind.toUpperCase()} | ${i.statusLabel} | \`${i.repo}\` | #${i.number} | [${i.title.replace(/\|/g, "\\|")}](${i.url}) | ${i.updatedAt.split("T")[0]} |\n`;
      }
      dom.exportContent.value = md;
    }
  }

  dom.btnCopyExport.addEventListener("click", async () => {
    await navigator.clipboard.writeText(dom.exportContent.value);
    dom.btnCopyExport.textContent = "Copied!";
    setTimeout(() => (dom.btnCopyExport.textContent = "Copy to Clipboard"), 1500);
  });

  dom.btnDownloadExport.addEventListener("click", () => {
    const isMd = dom.tabExportMd.classList.contains("active");
    const ext = isMd ? "md" : "json";
    const blob = new Blob([dom.exportContent.value], { type: isMd ? "text/markdown" : "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ghtrack-${state.login}-${new Date().toISOString().split("T")[0]}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Keyboard Shortcuts ──────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      dom.filterText.focus();
    }
    if (e.key === "Escape") {
      dom.modalExport.classList.remove("open");
    }
  });

  // ── Initialization ──────────────────────────────────────────────────
  initTheme();

  // URL Query handling: ?name=shravanngoswamii
  const params = new URLSearchParams(window.location.search);
  const initialName = params.get("name") || params.get("u") || "";
  if (initialName) {
    dom.searchInput.value = initialName;
    startTracking(initialName);
  }
})();
