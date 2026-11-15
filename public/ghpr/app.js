// ── ghpr — Apple Human Interface Guidelines PR Triage Engine ─────────────────
// Zero dependencies — clean, performant, modern vanilla JavaScript.

(function () {
  "use strict";

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    owner: "",
    repo: "",
    repoData: null,
    prs: [],
    categories: {
      ready: [],
      active: [],
      blocked: [],
      all: [],
    },
    activeQueueTab: "active", // "active" | "ready" | "blocked" | "all"
    activeFilter: "all",      // "all" | "tests" | "first-time" | "small"
    searchFilter: "",
    sortBy: "score",          // "score" | "size-asc" | "size-desc" | "updated" | "created"
    selectedPR: null,
    selectedIndex: -1,
    token: localStorage.getItem("ghpr_token") || "",
    weights: {
      size: 0.25,
      tests: 0.20,
      desc: 0.15,
      author: 0.15,
      ci: 0.25,
    },
    rateLimit: {
      limit: 60,
      remaining: 60,
      reset: 0,
    },
  };

  // Load custom weights from localStorage
  try {
    const savedWeights = localStorage.getItem("ghpr_weights");
    if (savedWeights) {
      state.weights = Object.assign(state.weights, JSON.parse(savedWeights));
    }
  } catch (e) {}

  // ── DOM Elements ──────────────────────────────────────────────────────────
  const els = {
    // Nav & Controls
    appNav: document.querySelector(".app-nav"),
    navRepoBtn: document.getElementById("nav-repo-btn"),
    navRepoName: document.getElementById("nav-repo-name"),
    btnSpotlight: document.getElementById("btn-spotlight"),
    ratePill: document.getElementById("rate-pill"),
    rateText: document.getElementById("rate-text"),
    tokenDot: document.getElementById("token-status-dot"),
    btnTokenModal: document.getElementById("btn-token-modal"),
    btnWeightsModal: document.getElementById("btn-weights-modal"),
    themeDropdown: document.getElementById("theme-dropdown"),
    themeBtn: document.getElementById("theme-btn"),
    themeButtons: document.querySelectorAll("[data-theme]"),

    // Views
    heroView: document.getElementById("hero-view"),
    dashboardView: document.getElementById("dashboard-view"),
    loadingView: document.getElementById("loading-view"),
    errorView: document.getElementById("error-view"),
    loadingTitle: document.getElementById("loading-title"),
    loadingDesc: document.getElementById("loading-desc"),
    errorTitle: document.getElementById("error-title"),
    errorDesc: document.getElementById("error-desc"),
    btnErrorRetry: document.getElementById("btn-error-retry"),
    btnErrorDemo: document.getElementById("btn-error-demo"),

    // Search & Inputs
    searchForm: document.getElementById("search-form"),
    searchInput: document.getElementById("search-input"),
    inputClear: document.getElementById("input-clear"),
    demoChips: document.querySelectorAll(".demo-chip"),
    recentBar: document.getElementById("recent-bar"),

    // Dashboard Overview
    repoAvatar: document.getElementById("repo-avatar"),
    repoLink: document.getElementById("repo-link"),
    repoStars: document.getElementById("repo-stars"),
    repoOpenPrs: document.getElementById("repo-open-prs"),
    repoSyncTime: document.getElementById("repo-sync-time"),
    cacheStatus: document.getElementById("cache-status"),
    btnRefresh: document.getElementById("btn-refresh"),
    exportDropdown: document.getElementById("export-dropdown"),
    btnExportToggle: document.getElementById("btn-export-toggle"),

    // Counters & Segmented Buttons
    countReady: document.getElementById("count-ready"),
    countActive: document.getElementById("count-active"),
    countBlocked: document.getElementById("count-blocked"),
    badgeReady: document.getElementById("badge-ready"),
    badgeActive: document.getElementById("badge-active"),
    badgeBlocked: document.getElementById("badge-blocked"),
    badgeAll: document.getElementById("badge-all"),
    segButtons: document.querySelectorAll(".seg-btn"),
    metricCards: document.querySelectorAll(".metric-card"),

    // Toolbar Filters
    filterInput: document.getElementById("filter-input"),
    filterChips: document.querySelectorAll(".filter-chip"),
    sortSelect: document.getElementById("sort-select"),
    prRowsContainer: document.getElementById("pr-rows-container"),

    // QuickLook Drawer
    drawer: document.getElementById("pr-drawer"),
    drawerBackdrop: document.getElementById("drawer-backdrop"),
    drawerClose: document.getElementById("drawer-close"),
    dPrNumber: document.getElementById("d-pr-number"),
    dPrAuthor: document.getElementById("d-pr-author"),
    dPrTitle: document.getElementById("d-pr-title"),
    dGithubLink: document.getElementById("d-github-link"),
    dGithubBtn: document.getElementById("d-github-btn"),
    dScoreLarge: document.getElementById("d-score-large"),
    dScoreTagline: document.getElementById("d-score-tagline"),
    dScoreRank: document.getElementById("d-score-rank"),
    dScoreVerdict: document.getElementById("d-score-verdict"),
    dRingCircle: document.getElementById("d-ring-circle"),

    // Gauges
    dValSize: document.getElementById("d-val-size"),
    dBarSize: document.getElementById("d-bar-size"),
    dHintSize: document.getElementById("d-hint-size"),
    dValTests: document.getElementById("d-val-tests"),
    dBarTests: document.getElementById("d-bar-tests"),
    dHintTests: document.getElementById("d-hint-tests"),
    dValDesc: document.getElementById("d-val-desc"),
    dBarDesc: document.getElementById("d-bar-desc"),
    dHintDesc: document.getElementById("d-hint-desc"),
    dValAuthor: document.getElementById("d-val-author"),
    dBarAuthor: document.getElementById("d-bar-author"),
    dHintAuthor: document.getElementById("d-hint-author"),
    dValCi: document.getElementById("d-val-ci"),
    dBarCi: document.getElementById("d-bar-ci"),
    dHintCi: document.getElementById("d-hint-ci"),

    // Checklist
    dSigConflict: document.getElementById("d-sig-conflict"),
    dSigCi: document.getElementById("d-sig-ci"),
    dSigReview: document.getElementById("d-sig-review"),
    dSigDraft: document.getElementById("d-sig-draft"),
    dSigAssoc: document.getElementById("d-sig-assoc"),
    dSigAge: document.getElementById("d-sig-age"),
    dFilesCount: document.getElementById("d-files-count"),
    dFilesList: document.getElementById("d-files-list"),
    dDescContent: document.getElementById("d-desc-content"),

    // Spotlight Modal
    spotlightModal: document.getElementById("spotlight-modal"),
    spotlightScrim: document.getElementById("spotlight-scrim"),
    spotlightInput: document.getElementById("spotlight-input"),
    spotlightResults: document.getElementById("spotlight-results"),

    // Token Modal
    tokenModal: document.getElementById("token-modal"),
    tokenBackdrop: document.getElementById("token-backdrop"),
    tokenModalClose: document.getElementById("token-modal-close"),
    tokenInput: document.getElementById("token-input"),
    btnTokenSave: document.getElementById("btn-token-save"),
    btnTokenClear: document.getElementById("btn-token-clear"),

    // Weights Modal
    weightsModal: document.getElementById("weights-modal"),
    weightsBackdrop: document.getElementById("weights-backdrop"),
    weightsModalClose: document.getElementById("weights-modal-close"),
    wSize: document.getElementById("w-size"),
    wSizeVal: document.getElementById("w-size-val"),
    wTests: document.getElementById("w-tests"),
    wTestsVal: document.getElementById("w-tests-val"),
    wDesc: document.getElementById("w-desc"),
    wDescVal: document.getElementById("w-desc-val"),
    wAuthor: document.getElementById("w-author"),
    wAuthorVal: document.getElementById("w-author-val"),
    wCi: document.getElementById("w-ci"),
    wCiVal: document.getElementById("w-ci-val"),
    btnWeightsSave: document.getElementById("btn-weights-save"),
    btnWeightsReset: document.getElementById("btn-weights-reset"),

    // Toasts
    toastContainer: document.getElementById("toast-container"),
  };

  // ── Apple Theme Management ────────────────────────────────────────────────
  function initTheme() {
    const saved = localStorage.getItem("ghpr_theme") || "system";
    applyTheme(saved);

    els.themeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      els.themeDropdown.classList.toggle("open");
    });

    document.addEventListener("click", () => {
      els.themeDropdown.classList.remove("open");
      els.exportDropdown.classList.remove("open");
    });

    document.querySelectorAll("[data-theme]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const choice = btn.dataset.theme;
        localStorage.setItem("ghpr_theme", choice);
        applyTheme(choice);
        els.themeDropdown.classList.remove("open");
      });
    });
  }

  function applyTheme(choice) {
    if (choice === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = choice;
    }

    document.querySelectorAll("[data-theme]").forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === choice);
    });

    const isDark =
      choice === "dark" ||
      (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

    els.themeBtn.innerHTML = isDark
      ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13.5 9.6A5.75 5.75 0 016.4 2.5a5.75 5.75 0 107.1 7.1z"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>';
  }

  // ── Apple Pill Toasts ─────────────────────────────────────────────────────
  function showToast(message, duration = 3000) {
    const toast = document.createElement("div");
    toast.className = "apple-toast";
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px) scale(0.96)";
      toast.style.transition = "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)";
      setTimeout(() => toast.remove(), 220);
    }, duration);
  }

  // ── Token & Quotas Settings ───────────────────────────────────────────────
  function initTokenUI() {
    updateTokenVisuals();

    els.btnTokenModal.addEventListener("click", () => {
      els.tokenInput.value = state.token;
      els.tokenModal.hidden = false;
      setTimeout(() => els.tokenInput.focus(), 50);
    });

    els.tokenModalClose.addEventListener("click", () => (els.tokenModal.hidden = true));
    els.tokenBackdrop.addEventListener("click", () => (els.tokenModal.hidden = true));

    els.btnTokenSave.addEventListener("click", () => {
      const val = els.tokenInput.value.trim();
      state.token = val;
      if (val) {
        localStorage.setItem("ghpr_token", val);
        showToast("GitHub Token active. 5,000 requests/hour enabled.");
      } else {
        localStorage.removeItem("ghpr_token");
        showToast("Token removed. Public rate limits apply.");
      }
      updateTokenVisuals();
      els.tokenModal.hidden = true;
      if (state.owner && state.repo) {
        loadRepository(state.owner, state.repo, true);
      }
    });

    els.btnTokenClear.addEventListener("click", () => {
      els.tokenInput.value = "";
      state.token = "";
      localStorage.removeItem("ghpr_token");
      updateTokenVisuals();
      showToast("Token cleared.");
      els.tokenModal.hidden = true;
    });
  }

  function updateTokenVisuals() {
    if (state.token) {
      els.tokenDot.classList.add("active");
      els.tokenDot.title = "Personal Access Token Active (5,000/hr)";
    } else {
      els.tokenDot.classList.remove("active");
      els.tokenDot.title = "No token set (Public rate limit: 60/hr)";
    }
  }

  // ── Weights Tuner ─────────────────────────────────────────────────────────
  function initWeightsUI() {
    syncWeightsUI();

    els.btnWeightsModal.addEventListener("click", () => {
      syncWeightsUI();
      els.weightsModal.hidden = false;
    });

    els.weightsModalClose.addEventListener("click", () => (els.weightsModal.hidden = true));
    els.weightsBackdrop.addEventListener("click", () => (els.weightsModal.hidden = true));

    // Live update percentage label while sliding
    [els.wSize, els.wTests, els.wDesc, els.wAuthor, els.wCi].forEach((slider) => {
      slider.addEventListener("input", () => {
        document.getElementById(`${slider.id}-val`).textContent = `${slider.value}%`;
      });
    });

    els.btnWeightsSave.addEventListener("click", () => {
      state.weights = {
        size: parseInt(els.wSize.value, 10) / 100,
        tests: parseInt(els.wTests.value, 10) / 100,
        desc: parseInt(els.wDesc.value, 10) / 100,
        author: parseInt(els.wAuthor.value, 10) / 100,
        ci: parseInt(els.wCi.value, 10) / 100,
      };
      localStorage.setItem("ghpr_weights", JSON.stringify(state.weights));
      showToast("Weights updated! Re-evaluating backlog...");
      els.weightsModal.hidden = true;
      if (state.prs.length > 0) {
        processAndCategorizePRs();
        renderActiveQueue();
      }
    });

    els.btnWeightsReset.addEventListener("click", () => {
      state.weights = { size: 0.25, tests: 0.20, desc: 0.15, author: 0.15, ci: 0.25 };
      localStorage.removeItem("ghpr_weights");
      syncWeightsUI();
      showToast("Reset to default weights.");
      els.weightsModal.hidden = true;
      if (state.prs.length > 0) {
        processAndCategorizePRs();
        renderActiveQueue();
      }
    });
  }

  function syncWeightsUI() {
    els.wSize.value = Math.round(state.weights.size * 100);
    els.wSizeVal.textContent = `${els.wSize.value}%`;

    els.wTests.value = Math.round(state.weights.tests * 100);
    els.wTestsVal.textContent = `${els.wTests.value}%`;

    els.wDesc.value = Math.round(state.weights.desc * 100);
    els.wDescVal.textContent = `${els.wDesc.value}%`;

    els.wAuthor.value = Math.round(state.weights.author * 100);
    els.wAuthorVal.textContent = `${els.wAuthor.value}%`;

    els.wCi.value = Math.round(state.weights.ci * 100);
    els.wCiVal.textContent = `${els.wCi.value}%`;
  }

  // ── GitHub API Engine ─────────────────────────────────────────────────────
  function parseRepoInput(raw) {
    if (!raw) return null;
    let s = raw.trim();
    s = s.replace(/^(?:https?:\/\/)?github\.com\//i, "");
    s = s.replace(/\.git$/i, "");
    s = s.replace(/^\/+|\/+$/g, "");
    const parts = s.split("/");
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
    return null;
  }

  function updateRateLimitFromHeaders(headers) {
    const rem = headers.get("x-ratelimit-remaining");
    const lim = headers.get("x-ratelimit-limit");
    const rst = headers.get("x-ratelimit-reset");
    if (rem && lim) {
      state.rateLimit.remaining = parseInt(rem, 10);
      state.rateLimit.limit = parseInt(lim, 10);
      state.rateLimit.reset = parseInt(rst, 10);
      els.ratePill.hidden = false;
      els.rateText.textContent = `${state.rateLimit.remaining}/${state.rateLimit.limit}`;

      const dot = els.ratePill.querySelector(".pulse-dot");
      if (state.rateLimit.remaining < 5) {
        dot.style.backgroundColor = "var(--apple-red)";
      } else if (state.rateLimit.remaining < 20) {
        dot.style.backgroundColor = "var(--apple-orange)";
      } else {
        dot.style.backgroundColor = "var(--apple-green)";
      }
    }
  }

  const GQL_QUERY = `
    query GetRepoPRs($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        name
        nameWithOwner
        stargazerCount
        openPRs: pullRequests(states: OPEN) { totalCount }
        pullRequests(first: 50, after: $cursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            title
            url
            body
            isDraft
            createdAt
            updatedAt
            mergeable
            reviewDecision
            additions
            deletions
            changedFiles
            author { login }
            authorAssociation
            labels(first: 8) { nodes { name color } }
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup { state }
                }
              }
            }
            files(first: 35) {
              nodes { path additions deletions changeType }
            }
            comments { totalCount }
          }
        }
      }
      rateLimit { limit cost remaining resetAt }
    }
  `;

  async function fetchWithGraphQL(owner, repo, cursor = null) {
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "ghpr-web/2.0",
      Accept: "application/vnd.github.v3+json",
    };
    if (state.token) {
      headers["Authorization"] = `Bearer ${state.token}`;
    }

    const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const endpoint = isLocal ? "/api/graphql" : "https://api.github.com/graphql";

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: GQL_QUERY,
        variables: { owner, repo, cursor },
      }),
    });

    updateRateLimitFromHeaders(res.headers);

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0) {
      throw new Error(json.errors[0].message);
    }
    return json.data;
  }

  async function fetchWithREST(owner, repo) {
    const headers = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "ghpr-web/2.0",
    };
    if (state.token) {
      headers["Authorization"] = `Bearer ${state.token}`;
    }

    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    updateRateLimitFromHeaders(repoRes.headers);
    if (!repoRes.ok) {
      throw new Error(`Repository ${owner}/${repo} not found (${repoRes.status})`);
    }
    const repoInfo = await repoRes.json();

    const pullsRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=45&sort=updated&direction=desc`,
      { headers }
    );
    updateRateLimitFromHeaders(pullsRes.headers);
    if (!pullsRes.ok) {
      throw new Error(`Unable to fetch PRs (${pullsRes.status})`);
    }
    const pulls = await pullsRes.json();

    const rawNodes = pulls.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.html_url,
      body: p.body || "",
      isDraft: Boolean(p.draft),
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      mergeable: p.mergeable_state === "dirty" ? "CONFLICTING" : "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      additions: p.additions || 0,
      deletions: p.deletions || 0,
      changedFiles: p.changed_files || 0,
      author: { login: p.user ? p.user.login : "ghost" },
      authorAssociation: p.author_association || "NONE",
      labels: { nodes: (p.labels || []).map((l) => ({ name: l.name, color: l.color })) },
      commits: { nodes: [] },
      files: { nodes: [] },
      comments: { totalCount: p.comments || 0 },
    }));

    return {
      repository: {
        name: repoInfo.name,
        nameWithOwner: repoInfo.full_name,
        stargazerCount: repoInfo.stargazers_count,
        openPRs: { totalCount: repoInfo.open_issues_count },
        pullRequests: {
          nodes: rawNodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }

  // ── Scoring Algorithm Engine ──────────────────────────────────────────────
  const TEST_FILE_REGEX = /(test|spec|__tests__|testing|\.test\.|\.spec\.)/i;
  const DOCS_FILE_REGEX = /\.(md|markdown|txt|rst|docs?)/i;

  function scorePR(pr) {
    const rawFiles = (pr.files && pr.files.nodes) || [];
    const changedFilesCount = pr.changedFiles || rawFiles.length || 1;
    const linesChanged = (pr.additions || 0) + (pr.deletions || 0);

    // 1. Size Score (0–10)
    let sSize = 10.0;
    let sizeBadge = "XS";
    if (linesChanged <= 50) {
      sSize = 10.0;
      sizeBadge = "XS";
    } else if (linesChanged <= 200) {
      sSize = 8.5;
      sizeBadge = "S";
    } else if (linesChanged <= 500) {
      sSize = 6.0;
      sizeBadge = "M";
    } else if (linesChanged <= 1200) {
      sSize = 3.5;
      sizeBadge = "L";
    } else {
      sSize = 1.2;
      sizeBadge = "XL";
    }

    // 2. Test Coverage Score (0–10)
    let testFilesCount = 0;
    let docsOnly = true;

    rawFiles.forEach((f) => {
      if (TEST_FILE_REGEX.test(f.path)) testFilesCount++;
      if (!DOCS_FILE_REGEX.test(f.path)) docsOnly = false;
    });

    let sTests = 2.0;
    const testRatio = changedFilesCount > 0 ? testFilesCount / changedFilesCount : 0;
    if (docsOnly && linesChanged < 100) {
      sTests = 8.5;
    } else if (testRatio >= 0.35) {
      sTests = 10.0;
    } else if (testFilesCount > 0) {
      sTests = 7.0;
    } else {
      sTests = 2.0;
    }

    // 3. Description Completeness Score (0–10)
    const body = pr.body || "";
    let sDesc = 3.0;
    const len = body.trim().length;

    if (len === 0) {
      sDesc = 1.0;
    } else if (len < 40) {
      sDesc = 4.0;
    } else {
      sDesc = 6.5;
      if (/##|###|\*\*|### /i.test(body)) sDesc += 1.5;
      if (/- \[[x ]\]/i.test(body)) sDesc += 1.0;
      if (/(fixes|closes|resolves) #\d+/i.test(body)) sDesc += 1.0;
      sDesc = Math.min(10.0, sDesc);
    }

    // 4. Author Boost (0–10)
    let sAuthor = 6.0;
    const assoc = pr.authorAssociation || "NONE";
    const isFirstTime = assoc === "FIRST_TIME_CONTRIBUTOR" || assoc === "FIRST_TIMER";

    if (isFirstTime) {
      sAuthor = 10.0;
    } else if (assoc === "CONTRIBUTOR") {
      sAuthor = 7.5;
    } else if (assoc === "MEMBER" || assoc === "OWNER") {
      sAuthor = 4.5;
    } else {
      sAuthor = 6.0;
    }

    // 5. CI & Conflict Health Score (0–10)
    let sCi = 6.0;
    const isConflicting = pr.mergeable === "CONFLICTING";
    const commitNode = pr.commits && pr.commits.nodes && pr.commits.nodes[0];
    const ciRollup = commitNode && commitNode.commit && commitNode.commit.statusCheckRollup;
    const ciState = ciRollup ? ciRollup.state : "UNKNOWN";

    if (isConflicting) {
      sCi = 0.5;
    } else if (ciState === "FAILURE" || ciState === "ERROR") {
      sCi = 1.0;
    } else if (ciState === "PENDING") {
      sCi = 5.5;
    } else if (ciState === "SUCCESS") {
      sCi = 10.0;
    } else {
      sCi = 6.0;
    }

    // Weighted Score
    const w = state.weights;
    const finalScore = Number(
      (
        sSize * w.size +
        sTests * w.tests +
        sDesc * w.desc +
        sAuthor * w.author +
        sCi * w.ci
      ).toFixed(1)
    );

    return {
      finalScore,
      sizeBadge,
      linesChanged,
      testFilesCount,
      testRatio,
      isFirstTime,
      isConflicting,
      ciState,
      scores: {
        size: sSize,
        tests: sTests,
        desc: sDesc,
        author: sAuthor,
        ci: sCi,
      },
    };
  }

  // ── Categorization ────────────────────────────────────────────────────────
  function processAndCategorizePRs() {
    state.categories = {
      ready: [],
      active: [],
      blocked: [],
      all: [],
    };

    state.prs.forEach((pr) => {
      const evaluation = scorePR(pr);
      pr._eval = evaluation;

      state.categories.all.push(pr);

      // Blocked: Draft, Conflict, Failing CI
      if (pr.isDraft || evaluation.isConflicting || evaluation.ciState === "FAILURE") {
        state.categories.blocked.push(pr);
      }
      // Ready to Merge: Approved with Passing CI or trivial typo
      else if (
        (pr.reviewDecision === "APPROVED" && evaluation.ciState === "SUCCESS") ||
        (evaluation.linesChanged <= 15 && evaluation.ciState === "SUCCESS" && pr.title.match(/^(docs|typo|fix typo)/i))
      ) {
        state.categories.ready.push(pr);
      }
      // Active Priority Queue: Healthy, needs review
      else {
        state.categories.active.push(pr);
      }
    });

    sortQueue("active");
    sortQueue("all");
    sortQueue("ready");
    sortQueue("blocked");
  }

  function sortQueue(queueName) {
    const list = state.categories[queueName];
    if (!list) return;

    list.sort((a, b) => {
      if (state.sortBy === "score") {
        return b._eval.finalScore - a._eval.finalScore;
      } else if (state.sortBy === "size-asc") {
        return a._eval.linesChanged - b._eval.linesChanged;
      } else if (state.sortBy === "size-desc") {
        return b._eval.linesChanged - a._eval.linesChanged;
      } else if (state.sortBy === "updated") {
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      } else if (state.sortBy === "created") {
        return new Date(a.createdAt) - new Date(b.createdAt);
      }
      return 0;
    });
  }

  // ── Render Dashboard & Rows ───────────────────────────────────────────────
  function renderDashboard() {
    const data = state.repoData;
    if (!data) return;

    // Repo bar
    els.repoAvatar.src = `https://github.com/${state.owner}.png?size=96`;
    els.repoLink.textContent = data.nameWithOwner;
    els.repoLink.href = `https://github.com/${data.nameWithOwner}`;
    els.repoStars.textContent = `★ ${formatNumber(data.stargazerCount)}`;
    els.repoOpenPrs.textContent = `${data.openPRs.totalCount} open PRs`;
    els.repoSyncTime.textContent = timeAgo(new Date());

    els.navRepoName.textContent = data.nameWithOwner;
    els.navRepoBtn.hidden = false;

    // Counts
    els.countReady.textContent = state.categories.ready.length;
    els.countActive.textContent = state.categories.active.length;
    els.countBlocked.textContent = state.categories.blocked.length;

    els.badgeReady.textContent = state.categories.ready.length;
    els.badgeActive.textContent = state.categories.active.length;
    els.badgeBlocked.textContent = state.categories.blocked.length;
    els.badgeAll.textContent = state.categories.all.length;

    renderActiveQueue();

    // Switch View
    els.heroView.hidden = true;
    els.loadingView.hidden = true;
    els.errorView.hidden = true;
    els.dashboardView.hidden = false;
  }

  function renderActiveQueue() {
    const targetQueue = state.categories[state.activeQueueTab] || state.categories.active;
    els.prRowsContainer.innerHTML = "";

    // Apply Filter Chips and Search String
    const filtered = targetQueue.filter((pr) => {
      if (state.searchFilter) {
        const q = state.searchFilter.toLowerCase();
        const num = String(pr.number);
        const title = (pr.title || "").toLowerCase();
        const author = (pr.author ? pr.author.login : "").toLowerCase();
        const labels = (pr.labels.nodes || []).map((l) => l.name.toLowerCase()).join(" ");
        if (!num.includes(q) && !title.includes(q) && !author.includes(q) && !labels.includes(q)) {
          return false;
        }
      }

      if (state.activeFilter === "tests" && pr._eval.testFilesCount === 0) return false;
      if (state.activeFilter === "first-time" && !pr._eval.isFirstTime) return false;
      if (state.activeFilter === "small" && pr._eval.sizeBadge !== "XS" && pr._eval.sizeBadge !== "S") return false;

      return true;
    });

    if (filtered.length === 0) {
      els.prRowsContainer.innerHTML = `
        <div class="empty-state-row">
          <p>No pull requests match the current criteria.</p>
        </div>
      `;
      return;
    }

    filtered.forEach((pr, idx) => {
      const ev = pr._eval;
      const row = document.createElement("div");
      row.className = "pr-row";
      row.dataset.prNumber = pr.number;
      row.dataset.index = idx;

      // Color Tier
      let tierClass = "tier-bad";
      if (ev.finalScore >= 8.0) tierClass = "tier-high";
      else if (ev.finalScore >= 6.0) tierClass = "tier-mid";
      else if (ev.finalScore >= 4.0) tierClass = "tier-low";

      // CI Badge
      let ciBadge = "";
      if (ev.ciState === "SUCCESS") ciBadge = `<span class="apple-tag tag-ci-pass">✓ CI Pass</span>`;
      else if (ev.ciState === "FAILURE") ciBadge = `<span class="apple-tag tag-ci-fail">✕ CI Fail</span>`;
      else if (ev.ciState === "PENDING") ciBadge = `<span class="apple-tag tag-ci-wait">● CI Running</span>`;

      // Conflict Tag
      const conflictTag = ev.isConflicting ? `<span class="apple-tag tag-conflict">🔀 Conflict</span>` : "";

      // Test Tag
      const testTag = ev.testFilesCount > 0 ? `<span class="apple-tag tag-test">+${ev.testFilesCount} Test${ev.testFilesCount > 1 ? "s" : ""}</span>` : "";

      // First timer tag
      const firstTag = ev.isFirstTime ? `<span class="apple-tag tag-first">🆕 1st Timer</span>` : "";

      // Draft tag
      const draftTag = pr.isDraft ? `<span class="apple-tag tag-draft">Draft</span>` : "";

      row.innerHTML = `
        <div class="cell-score">
          <span class="score-badge ${tierClass}">${ev.finalScore}</span>
          <span class="rank-text">#${idx + 1}</span>
        </div>
        <div class="cell-main">
          <div class="pr-row-title">
            <span class="pr-id">#${pr.number}</span>
            <span class="pr-title-string" title="${escapeHtml(pr.title)}">${escapeHtml(pr.title)}</span>
          </div>
          <div class="pr-sub-meta">
            <span>by <strong class="author-link">@${escapeHtml(pr.author ? pr.author.login : "ghost")}</strong></span>
            <span>•</span>
            <span>${timeAgo(new Date(pr.updatedAt))}</span>
            ${pr.comments && pr.comments.totalCount > 0 ? `<span>• 💬 ${pr.comments.totalCount}</span>` : ""}
          </div>
        </div>
        <div class="cell-signals">
          <span class="apple-tag tag-size-${ev.sizeBadge.toLowerCase()}">${ev.sizeBadge} (+${pr.additions || 0}/-${pr.deletions || 0})</span>
          ${firstTag}
          ${testTag}
          ${conflictTag}
          ${ciBadge}
          ${draftTag}
        </div>
        <div class="cell-action">
          <button type="button" class="btn-inspect">Inspect</button>
        </div>
      `;

      row.addEventListener("click", () => openDrawer(pr, idx + 1));
      els.prRowsContainer.appendChild(row);
    });
  }

  // ── Quick Look Drawer (Apple HIG) ─────────────────────────────────────────
  function openDrawer(pr, rank) {
    state.selectedPR = pr;
    const ev = pr._eval;

    els.dPrNumber.textContent = `#${pr.number}`;
    els.dPrAuthor.textContent = `by @${pr.author ? pr.author.login : "ghost"} (${pr.authorAssociation})`;
    els.dPrTitle.textContent = pr.title;
    els.dGithubLink.href = pr.url;
    els.dGithubBtn.href = pr.url;

    // Score Ring
    els.dScoreLarge.textContent = ev.finalScore;
    els.dScoreTagline.textContent = `Priority Score: ${ev.finalScore} / 10`;
    els.dScoreRank.textContent = rank ? `Rank #${rank} in ${state.activeQueueTab.toUpperCase()} queue` : "Backlog Triage Analysis";

    // Stroke-dashoffset animation (Circumference: 2 * PI * 42 = 263.89)
    const circ = 263.89;
    const progress = Math.min(10, Math.max(0, ev.finalScore)) / 10;
    const offset = circ - progress * circ;
    els.dRingCircle.style.strokeDashoffset = offset;

    // Ring Color
    if (ev.finalScore >= 8.0) {
      els.dRingCircle.style.stroke = "var(--apple-green)";
      els.dScoreVerdict.textContent = "High priority — well structured, quick to review.";
    } else if (ev.finalScore >= 6.0) {
      els.dRingCircle.style.stroke = "var(--apple-blue)";
      els.dScoreVerdict.textContent = "Moderate priority — solid contribution ready for review.";
    } else if (ev.finalScore >= 4.0) {
      els.dRingCircle.style.stroke = "var(--apple-orange)";
      els.dScoreVerdict.textContent = "Lower priority — larger surface area or missing tests.";
    } else {
      els.dRingCircle.style.stroke = "var(--apple-red)";
      els.dScoreVerdict.textContent = "Blocked or requires significant author modifications.";
    }

    // Gauges
    setGauge(els.dValSize, els.dBarSize, ev.scores.size, 10, `${ev.linesChanged} lines churn (${ev.sizeBadge})`);
    setGauge(els.dValTests, els.dBarTests, ev.scores.tests, 10, `${ev.testFilesCount} test files modified (${Math.round(ev.testRatio * 100)}% of PR)`);
    setGauge(els.dValDesc, els.dBarDesc, ev.scores.desc, 10, `${(pr.body || "").length} characters completeness`);
    setGauge(els.dValAuthor, els.dBarAuthor, ev.scores.author, 10, `Association: ${pr.authorAssociation}`);
    setGauge(els.dValCi, els.dBarCi, ev.scores.ci, 10, `CI: ${ev.ciState} | Conflict: ${ev.isConflicting ? "YES" : "None"}`);

    // Checklist
    els.dSigConflict.textContent = ev.isConflicting ? "❌ Conflicting" : "✅ Clean Merge";
    els.dSigCi.textContent = ev.ciState === "SUCCESS" ? "✅ All Passed" : ev.ciState === "FAILURE" ? "❌ Failed" : "⏳ Pending";
    els.dSigReview.textContent = pr.reviewDecision ? pr.reviewDecision.replace(/_/g, " ") : "REVIEW REQUIRED";
    els.dSigDraft.textContent = pr.isDraft ? "📝 Yes (Draft)" : "✅ Ready";
    els.dSigAssoc.textContent = pr.authorAssociation;
    els.dSigAge.textContent = `Updated ${timeAgo(new Date(pr.updatedAt))}`;

    // Changed Files
    const files = (pr.files && pr.files.nodes) || [];
    els.dFilesCount.textContent = files.length;
    els.dFilesList.innerHTML = "";
    if (files.length === 0) {
      els.dFilesList.innerHTML = `<div style="color:var(--label-tertiary);padding:8px;">File tree not supplied in summary</div>`;
    } else {
      files.forEach((f) => {
        const isTest = TEST_FILE_REGEX.test(f.path);
        const item = document.createElement("div");
        item.className = `file-chip ${isTest ? "is-test" : ""}`;
        item.innerHTML = `
          <span style="overflow:hidden;text-overflow:ellipsis;" title="${f.path}">${escapeHtml(f.path)}</span>
          <span style="color:var(--label-tertiary);margin-left:8px;">+${f.additions || 0} -${f.deletions || 0}</span>
        `;
        els.dFilesList.appendChild(item);
      });
    }

    // PR Description
    els.dDescContent.textContent = pr.body || "No description provided.";

    els.drawer.classList.add("open");
    els.drawer.setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    els.drawer.classList.remove("open");
    els.drawer.setAttribute("aria-hidden", "true");
    state.selectedPR = null;
  }

  function setGauge(valEl, barEl, score, max, hint) {
    valEl.textContent = `${score.toFixed(1)} / ${max}`;
    const pct = Math.min(100, Math.max(0, (score / max) * 100));
    barEl.style.width = `${pct}%`;
    if (score >= 8.0) barEl.style.background = "var(--apple-green)";
    else if (score >= 6.0) barEl.style.background = "var(--apple-blue)";
    else if (score >= 4.0) barEl.style.background = "var(--apple-orange)";
    else barEl.style.background = "var(--apple-red)";
  }

  // ── Spotlight Command Palette (Cmd+K) ─────────────────────────────────────
  function openSpotlight() {
    els.spotlightModal.hidden = false;
    els.spotlightInput.value = "";
    renderSpotlightResults("");
    setTimeout(() => els.spotlightInput.focus(), 50);
  }

  function closeSpotlight() {
    els.spotlightModal.hidden = true;
  }

  function renderSpotlightResults(query) {
    const q = query.toLowerCase().trim();
    const suggestions = [
      { type: "repo", title: "SciML/OrdinaryDiffEq.jl", sub: "Load SciML differential equations backlog (180+ PRs)" },
      { type: "repo", title: "astral-sh/uv", sub: "High-performance Python tooling by Astral" },
      { type: "repo", title: "facebook/react", sub: "The library for web and native user interfaces" },
      { type: "repo", title: "shadcn-ui/ui", sub: "Beautifully designed components" },
      { type: "action", title: "Export Markdown Summary", action: () => exportMarkdown() },
      { type: "action", title: "Export CSV Table", action: () => exportCSV() },
      { type: "action", title: "Export Full JSON Data", action: () => exportJSON() },
      { type: "action", title: "Configure GitHub Token", action: () => els.btnTokenModal.click() },
      { type: "action", title: "Tuning Scoring Weights", action: () => els.btnWeightsModal.click() },
    ];

    const filtered = suggestions.filter((s) => s.title.toLowerCase().includes(q) || (s.sub && s.sub.toLowerCase().includes(q)));

    els.spotlightResults.innerHTML = "";
    filtered.forEach((item) => {
      const el = document.createElement("div");
      el.className = "spotlight-item";
      el.innerHTML = `
        <div>
          <div style="font-weight:600;">${item.title}</div>
          ${item.sub ? `<div style="font-size:0.78rem;color:var(--label-tertiary);">${item.sub}</div>` : ""}
        </div>
        <span style="font-size:0.75rem;color:var(--label-quaternary);">${item.type.toUpperCase()}</span>
      `;
      el.addEventListener("click", () => {
        closeSpotlight();
        if (item.type === "repo") {
          loadRepository(item.title.split("/")[0], item.title.split("/")[1]);
        } else if (item.action) {
          item.action();
        }
      });
      els.spotlightResults.appendChild(el);
    });
  }

  // ── Load Repository Orchestrator ──────────────────────────────────────────
  async function loadRepository(owner, repo, forceRefresh = false) {
    state.owner = owner;
    state.repo = repo;

    window.location.hash = `${owner}/${repo}`;
    saveRecentRepo(owner, repo);

    const cacheKey = `ghpr_cache_v2_${owner.toLowerCase()}_${repo.toLowerCase()}`;
    if (!forceRefresh) {
      try {
        const cachedRaw = localStorage.getItem(cacheKey);
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw);
          if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
            state.repoData = cached.repoData;
            state.prs = cached.prs;
            processAndCategorizePRs();
            renderDashboard();
            els.cacheStatus.textContent = "Cached (Fresh)";
            return;
          }
        }
      } catch (e) {}
    }

    els.heroView.hidden = true;
    els.dashboardView.hidden = true;
    els.errorView.hidden = true;
    els.loadingView.hidden = false;
    els.loadingTitle.textContent = `Analyzing ${owner}/${repo}...`;
    els.loadingDesc.textContent = "Resolving merge conflict checks, CI runs, test file coverage, and contributor history...";

    try {
      let data;
      try {
        data = await fetchWithGraphQL(owner, repo);
      } catch (gqlErr) {
        console.warn("GraphQL resolution fallback to REST:", gqlErr);
        data = await fetchWithREST(owner, repo);
      }

      state.repoData = data.repository;
      state.prs = (data.repository.pullRequests && data.repository.pullRequests.nodes) || [];

      try {
        localStorage.setItem(
          cacheKey,
          JSON.stringify({
            timestamp: Date.now(),
            repoData: state.repoData,
            prs: state.prs,
          })
        );
      } catch (e) {}

      processAndCategorizePRs();
      renderDashboard();
      els.cacheStatus.textContent = "Live";
      showToast(`Analyzed ${state.prs.length} open PRs for ${owner}/${repo}`);
    } catch (err) {
      console.error(err);
      els.loadingView.hidden = true;
      els.errorView.hidden = false;
      els.errorTitle.textContent = "Repository Analysis Failed";
      els.errorDesc.textContent = err.message || "Please check owner/repo name or rate limits.";
    }
  }

  // ── Demo Offline Backlog Generator ────────────────────────────────────────
  function loadDemoBacklog() {
    const demoPRs = [
      {
        number: 1842,
        title: "Fix adaptive step-size convergence in stiff Rosenbrock solvers",
        body: "Resolves convergence issues when solving high-dimension stiff differential equations.\n\nCloses #1209.\n- [x] Added regression tests\n- [x] Verified backward compatibility",
        isDraft: false,
        createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
        mergeable: "MERGEABLE",
        reviewDecision: "REVIEW_REQUIRED",
        additions: 84,
        deletions: 19,
        changedFiles: 4,
        author: { login: "stiff_math_dev" },
        authorAssociation: "FIRST_TIME_CONTRIBUTOR",
        labels: { nodes: [{ name: "solver", color: "0075ca" }, { name: "stiff", color: "d93f0b" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
        files: {
          nodes: [
            { path: "src/rosenbrock.jl", additions: 52, deletions: 12 },
            { path: "test/stiff_tests.jl", additions: 32, deletions: 7 },
          ],
        },
        comments: { totalCount: 5 },
      },
      {
        number: 1839,
        title: "docs: Correct differential equation parameter formulation in tutorial",
        body: "Fix minor typo in tutorial section 4.1.",
        isDraft: false,
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 7200000).toISOString(),
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        additions: 6,
        deletions: 4,
        changedFiles: 1,
        author: { login: "doc_contributor" },
        authorAssociation: "CONTRIBUTOR",
        labels: { nodes: [{ name: "documentation", color: "0075ca" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
        files: { nodes: [{ path: "docs/tutorials/intro.md", additions: 6, deletions: 4 }] },
        comments: { totalCount: 2 },
      },
      {
        number: 1825,
        title: "WIP: Experimental symplectic integrator for celestial mechanics",
        body: "Draft implementation of 8th order symplectic integrator. Do not merge yet.",
        isDraft: true,
        createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 14400000).toISOString(),
        mergeable: "MERGEABLE",
        reviewDecision: "REVIEW_REQUIRED",
        additions: 420,
        deletions: 30,
        changedFiles: 8,
        author: { login: "kepler_astro" },
        authorAssociation: "MEMBER",
        labels: { nodes: [{ name: "wip", color: "fbca04" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
        files: { nodes: [{ path: "src/symplectic.jl", additions: 420, deletions: 30 }] },
        comments: { totalCount: 1 },
      },
      {
        number: 1810,
        title: "Refactor dense output interpolation cache for multithreaded runs",
        body: "Restructures interpolator cache allocation. Conflict with master branch.",
        isDraft: false,
        createdAt: new Date(Date.now() - 12 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 43200000).toISOString(),
        mergeable: "CONFLICTING",
        reviewDecision: "REVIEW_REQUIRED",
        additions: 290,
        deletions: 110,
        changedFiles: 6,
        author: { login: "julia_parallel" },
        authorAssociation: "CONTRIBUTOR",
        labels: { nodes: [{ name: "multithreading", color: "1d76db" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
        files: { nodes: [{ path: "src/interp.jl", additions: 290, deletions: 110 }] },
        comments: { totalCount: 9 },
      },
    ];

    state.owner = "SciML";
    state.repo = "OrdinaryDiffEq.jl";
    state.repoData = {
      name: "OrdinaryDiffEq.jl",
      nameWithOwner: "SciML/OrdinaryDiffEq.jl",
      stargazerCount: 1420,
      openPRs: { totalCount: 184 },
    };
    state.prs = demoPRs;
    processAndCategorizePRs();
    renderDashboard();
    showToast("Loaded featured backlog (Demo Mode)");
  }

  // ── History & Recents ─────────────────────────────────────────────────────
  function saveRecentRepo(owner, repo) {
    try {
      let recents = JSON.parse(localStorage.getItem("ghpr_recents") || "[]");
      const full = `${owner}/${repo}`;
      recents = recents.filter((r) => r.toLowerCase() !== full.toLowerCase());
      recents.unshift(full);
      if (recents.length > 5) recents.pop();
      localStorage.setItem("ghpr_recents", JSON.stringify(recents));
      renderRecents();
    } catch (e) {}
  }

  function renderRecents() {
    try {
      const recents = JSON.parse(localStorage.getItem("ghpr_recents") || "[]");
      if (recents.length === 0) {
        els.recentBar.hidden = true;
        return;
      }
      els.recentBar.hidden = false;
      els.recentBar.innerHTML = `
        <span style="font-size:0.8rem;color:var(--label-tertiary);">Recent:</span>
        ${recents
          .map((r) => `<button type="button" class="demo-chip recent-btn" data-repo="${r}">${r}</button>`)
          .join("")}
      `;
      els.recentBar.querySelectorAll(".recent-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const parsed = parseRepoInput(btn.dataset.repo);
          if (parsed) loadRepository(parsed.owner, parsed.repo);
        });
      });
    } catch (e) {}
  }

  // ── Export Formats ────────────────────────────────────────────────────────
  function initExportUI() {
    els.btnExportToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      els.exportDropdown.classList.toggle("open");
    });

    document.querySelectorAll("[data-export]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.export;
        if (type === "markdown") exportMarkdown();
        else if (type === "csv") exportCSV();
        else if (type === "json") exportJSON();
        els.exportDropdown.classList.remove("open");
      });
    });
  }

  function exportMarkdown() {
    const active = state.categories.active;
    let md = `# PR Review Priority Queue: ${state.owner}/${state.repo}\n\n`;
    md += `*Generated by [ghpr](https://theramlakhan.com/ghpr/) on ${new Date().toLocaleDateString()}*\n\n`;
    md += `| Rank | PR | Title | Author | Size | Tests | CI | Score |\n`;
    md += `|:----:|:--:|:------|:-------|:----:|:-----:|:--:|:-----:|\n`;

    active.forEach((pr, i) => {
      const ev = pr._eval;
      const ciText = ev.ciState === "SUCCESS" ? "✓ Pass" : ev.ciState === "FAILURE" ? "✕ Fail" : "● Wait";
      const testText = ev.testFilesCount > 0 ? `+${ev.testFilesCount}` : "None";
      md += `| ${i + 1} | [#${pr.number}](${pr.url}) | ${pr.title.replace(/\|/g, "\\|")} | @${pr.author ? pr.author.login : "ghost"} | ${ev.sizeBadge} | ${testText} | ${ciText} | **${ev.finalScore}** |\n`;
    });

    navigator.clipboard.writeText(md).then(() => {
      showToast("Markdown queue copied to clipboard!");
    });
  }

  function exportCSV() {
    let csv = `Rank,Number,Title,Author,Size,Additions,Deletions,TestFiles,CIState,Conflict,Score,URL\n`;
    state.categories.active.forEach((pr, i) => {
      const ev = pr._eval;
      const titleEsc = `"${(pr.title || "").replace(/"/g, '""')}"`;
      csv += `${i + 1},${pr.number},${titleEsc},${pr.author ? pr.author.login : ""},${ev.sizeBadge},${pr.additions || 0},${pr.deletions || 0},${ev.testFilesCount},${ev.ciState},${ev.isConflicting},${ev.finalScore},${pr.url}\n`;
    });

    downloadBlob(csv, `ghpr_${state.owner}_${state.repo}.csv`, "text/csv");
    showToast("CSV downloaded.");
  }

  function exportJSON() {
    const exportData = {
      repository: `${state.owner}/${state.repo}`,
      exportedAt: new Date().toISOString(),
      readyToMerge: state.categories.ready,
      reviewQueue: state.categories.active,
      needsAction: state.categories.blocked,
    };
    downloadBlob(JSON.stringify(exportData, null, 2), `ghpr_${state.owner}_${state.repo}.json`, "application/json");
    showToast("JSON downloaded.");
  }

  function downloadBlob(content, fileName, contentType) {
    const a = document.createElement("a");
    const file = new Blob([content], { type: contentType });
    a.href = URL.createObjectURL(file);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatNumber(num) {
    if (!num) return "0";
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return String(num);
  }

  function timeAgo(date) {
    const sec = Math.floor((new Date() - date) / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return date.toLocaleDateString();
  }

  // ── Global Event Wiring ───────────────────────────────────────────────────
  function initEvents() {
    // Search Form
    els.searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const parsed = parseRepoInput(els.searchInput.value);
      if (parsed) loadRepository(parsed.owner, parsed.repo);
    });

    els.searchInput.addEventListener("input", () => {
      els.inputClear.hidden = !els.searchInput.value.trim();
    });

    els.inputClear.addEventListener("click", () => {
      els.searchInput.value = "";
      els.inputClear.hidden = true;
      els.searchInput.focus();
    });

    // Demo Chips
    els.demoChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const parsed = parseRepoInput(chip.dataset.repo);
        if (parsed) loadRepository(parsed.owner, parsed.repo);
      });
    });

    // Refresh & Retry Buttons
    els.btnRefresh.addEventListener("click", () => {
      if (state.owner && state.repo) loadRepository(state.owner, state.repo, true);
    });
    els.btnErrorRetry.addEventListener("click", () => {
      if (state.owner && state.repo) loadRepository(state.owner, state.repo, true);
    });
    els.btnErrorDemo.addEventListener("click", () => loadDemoBacklog());

    // Nav Quick Switcher
    els.navRepoBtn.addEventListener("click", openSpotlight);
    els.btnSpotlight.addEventListener("click", openSpotlight);
    els.spotlightScrim.addEventListener("click", closeSpotlight);

    els.spotlightInput.addEventListener("input", (e) => {
      renderSpotlightResults(e.target.value);
    });

    // Segmented Queue Tabs
    els.segButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        els.segButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.activeQueueTab = btn.dataset.queue;
        renderActiveQueue();

        // Highlight matching summary card
        els.metricCards.forEach((c) => {
          c.classList.toggle("active-metric", c.dataset.tabSwitch === state.activeQueueTab);
        });
      });
    });

    // Metric Summary Cards Click to Switch Tabs
    els.metricCards.forEach((card) => {
      card.addEventListener("click", () => {
        const target = card.dataset.tabSwitch;
        const matchingBtn = document.querySelector(`.seg-btn[data-queue="${target}"]`);
        if (matchingBtn) matchingBtn.click();
      });
    });

    // Filter Chips
    els.filterChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        els.filterChips.forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.activeFilter = chip.dataset.filter;
        renderActiveQueue();
      });
    });

    // Live search input in toolbar
    els.filterInput.addEventListener("input", () => {
      state.searchFilter = els.filterInput.value.trim();
      renderActiveQueue();
    });

    // Sort Dropdown
    els.sortSelect.addEventListener("change", () => {
      state.sortBy = els.sortSelect.value;
      sortQueue(state.activeQueueTab);
      renderActiveQueue();
    });

    // QuickLook Drawer
    els.drawerClose.addEventListener("click", closeDrawer);
    els.drawerBackdrop.addEventListener("click", closeDrawer);

    // Keyboard Shortcuts (Apple HIG)
    document.addEventListener("keydown", (e) => {
      // Cmd+K Spotlight
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (els.spotlightModal.hidden) openSpotlight();
        else closeSpotlight();
        return;
      }

      // Escape key closes modals / drawer
      if (e.key === "Escape") {
        closeDrawer();
        closeSpotlight();
        els.tokenModal.hidden = true;
        els.weightsModal.hidden = true;
        return;
      }

      // If active typing in input, skip shortcut handling
      if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
        return;
      }

      // / focuses filter
      if (e.key === "/") {
        e.preventDefault();
        const target = els.dashboardView.hidden ? els.searchInput : els.filterInput;
        target.focus();
        target.select();
        return;
      }

      // 1, 2, 3, 4 tab switching
      if (["1", "2", "3", "4"].includes(e.key) && !els.dashboardView.hidden) {
        const idx = parseInt(e.key, 10) - 1;
        if (els.segButtons[idx]) els.segButtons[idx].click();
        return;
      }
    });

    // URL Hash Routing
    window.addEventListener("hashchange", () => {
      const hash = window.location.hash.replace(/^#/, "").trim();
      if (hash) {
        const parsed = parseRepoInput(hash);
        if (parsed && (parsed.owner !== state.owner || parsed.repo !== state.repo)) {
          loadRepository(parsed.owner, parsed.repo);
        }
      }
    });
  }

  // ── App Boot ──────────────────────────────────────────────────────────────
  function init() {
    initTheme();
    initTokenUI();
    initWeightsUI();
    initExportUI();
    initEvents();
    renderRecents();

    // Initial hash check
    const hash = window.location.hash.replace(/^#/, "").trim();
    if (hash) {
      const parsed = parseRepoInput(hash);
      if (parsed) {
        loadRepository(parsed.owner, parsed.repo);
        return;
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
