// Bear Dashboard — Single-page app
// Router, state store, API client, 4 views
// Note: innerHTML usage is safe here — all rendered data comes from our own
// backend API (Stellar addresses, contract state). No untrusted user input.

(() => {
  // ── Theme (dark/light) ── #461
  (function initTheme() {
    var saved = localStorage.getItem("bear-theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    var btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        var current = document.documentElement.getAttribute("data-theme") || "dark";
        var next = current === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("bear-theme", next);
      });
    }
  })();
  // ── State Store ──
  const state = {
    stats: null,
    wallets: null,
    agents: null,
    jobs: null,
    history: null,
    loading: { stats: false, wallets: false, agents: false, jobs: false },
    jobFilter: "Active",
    jobSearch: "",
    agentPage: 1,
    agentPageSize: 24,
    agentTotal: 0,
    txPending: false,
  };

  // ── Stellar Wallets Kit integration ──
  const wallet = {
    connected: false,
    publicKey: null,
    network: null, // 'testnet' | 'mainnet' | null
  };
  window.__walletState = wallet;

  // Initialize Stellar Wallets Kit (loaded via UMD script tag)
  var swkReady = false;
  var StellarWalletsKit, KitEventType, SwkAppDarkTheme, defaultModules;
  if (window.MyWalletKit) {
    StellarWalletsKit = window.MyWalletKit.StellarWalletsKit;
    KitEventType = window.MyWalletKit.KitEventType;
    SwkAppDarkTheme = window.MyWalletKit.SwkAppDarkTheme;
    defaultModules = window.MyWalletKit.defaultModules;
    StellarWalletsKit.init({
      theme: SwkAppDarkTheme,
      modules: defaultModules(),
    });
    // Mount the connect button in sidebar
    var btnWrapper = document.getElementById("swk-button-wrapper");
    if (btnWrapper) StellarWalletsKit.createButton(btnWrapper);
    // Listen for wallet state changes
    StellarWalletsKit.on(KitEventType.STATE_UPDATED, function (event) {
      var addr =
        event.payload &&
        (event.payload.address ||
          (event.payload.accounts &&
            event.payload.accounts[0] &&
            event.payload.accounts[0].address));
      if (!addr || addr.length <= 10) {
        // Fallback: fetch current address from SWK
        StellarWalletsKit.getAddress()
          .then(function (res) {
            wallet.connected = true;
            wallet.publicKey = res.address;
            updateWalletUI();
          })
          .catch(function () {});
        return;
      }
      wallet.connected = true;
      wallet.publicKey = addr;
      updateWalletUI();
    });
    swkReady = true;
  }

  // Freighter detection: prefer Freighter if present
  async function detectFreighter() {
    try {
      const api = window.freighterApi || window.freighter;
      if (!api || typeof api.getPublicKey !== "function") return;
      const pk = await api.getPublicKey();
      if (!pk || pk.length <= 10) return;
      let net = null;
      if (typeof api.getNetwork === "function") {
        try {
          const n = await api.getNetwork();
          if (String(n).toLowerCase().includes("test")) net = "testnet";
          else if (
            String(n).toLowerCase().includes("pub") ||
            String(n).toLowerCase().includes("main")
          )
            net = "mainnet";
        } catch (e) {}
      }
      wallet.connected = true;
      wallet.publicKey = pk;
      wallet.network = net;
      updateWalletUI();
      if (typeof api.onNetworkChanged === "function") {
        api.onNetworkChanged(function (n) {
          let updatedNet = null;
          if (String(n).toLowerCase().includes("test")) updatedNet = "testnet";
          else if (
            String(n).toLowerCase().includes("pub") ||
            String(n).toLowerCase().includes("main")
          )
            updatedNet = "mainnet";
          wallet.network = updatedNet;
          updateWalletUI();
        });
      }
    } catch (e) {
      // ignore
    }
  }

  // Retry Freighter detection a few times on load
  async function retryDetectFreighter(attempts) {
    if (attempts <= 0) return;
    await detectFreighter();
    if (!wallet.connected) {
      setTimeout(function () {
        retryDetectFreighter(attempts - 1);
      }, 1000);
    }
  }
  retryDetectFreighter(3);

  function disconnectWallet() {
    wallet.connected = false;
    wallet.publicKey = null;
    wallet.network = null;
    // Clear all cached state so the next session starts fresh
    state.stats = null;
    state.wallets = null;
    state.agents = null;
    state.jobs = null;
    state.history = null;
    // Invalidate server-side session token if present
    var token = window.__sessionToken;
    if (token) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      }).catch(function () {});
      window.__sessionToken = null;
    }
    // Tell SWK to disconnect if the API supports it
    if (swkReady && StellarWalletsKit && typeof StellarWalletsKit.disconnect === "function") {
      try {
        StellarWalletsKit.disconnect();
      } catch (e) {}
    }
    updateWalletUI();
    // Re-show the SWK connect button
    var btnWrapper = document.getElementById("swk-button-wrapper");
    if (btnWrapper) btnWrapper.style.display = "";
    toast("Wallet disconnected");
    // Navigate to the root so the user lands on the connect prompt
    window.location.hash = "#/";
    navigate();
  }

  function updateWalletUI() {
    var connectedEl = document.getElementById("wallet-connected");
    var addrText = document.getElementById("wallet-addr-text");
    var modeLabel = document.getElementById("wallet-mode-label");
    var btnWrapper = document.getElementById("swk-button-wrapper");
    if (wallet.connected && wallet.publicKey) {
      if (connectedEl) connectedEl.style.display = "flex";
      if (addrText) {
        addrText.textContent = wallet.publicKey.slice(0, 6) + "..." + wallet.publicKey.slice(-4);
        // Make address clickable to copy
        var addrDisplay = document.getElementById("wallet-addr-display");
        if (addrDisplay)
          addrDisplay.onclick = function () {
            copyToClipboard(wallet.publicKey);
          };
      }
      if (modeLabel) {
        const netLabel =
          wallet.network === "mainnet"
            ? "Mainnet"
            : wallet.network === "testnet"
              ? "Testnet"
              : "Connected";
        modeLabel.textContent = "Connected — " + netLabel;
      }
      // Update sidebar network badge
      try {
        var nb = document.getElementById("network-badge");
        if (nb)
          nb.innerHTML =
            '<span class="badge-dot"></span>' +
            (wallet.network === "mainnet"
              ? "Stellar Mainnet"
              : wallet.network === "testnet"
                ? "Stellar Testnet"
                : "Unknown Network");
      } catch (e) {}
      // Hide the SWK connect button once connected
      if (btnWrapper) btnWrapper.style.display = "none";
    } else {
      if (connectedEl) connectedEl.style.display = "none";
      if (modeLabel) modeLabel.textContent = "Demo Mode";
      if (btnWrapper) btnWrapper.style.display = "";
    }
  }

  /** Build unsigned tx on server, sign with Stellar Wallets Kit, submit via server */
  async function signAndSubmit(buildEndpoint, params) {
    await ensureSession();
    // 1. Build unsigned tx on server
    var buildRes = await api(buildEndpoint, {
      method: "POST",
      body: { publicKey: wallet.publicKey, ...params },
    });
    // 2. Sign with Stellar Wallets Kit
    // Prefer Freighter if available
    try {
      const api = window.freighterApi || window.freighter;
      if (api && typeof api.signTransaction === "function") {
        if (wallet.network === "mainnet")
          throw new Error(
            "Freighter is on Mainnet — dashboard blocks mainnet signing to avoid real transactions",
          );
        const sigRes = await api.signTransaction(buildRes.xdr);
        // Accept multiple possible response shapes
        const signedXdr =
          sigRes.signedTransaction ||
          sigRes.signedTx ||
          sigRes.signedTxXdr ||
          sigRes.signedXdr ||
          sigRes;
        return await apiClientSubmit(signedXdr);
      }
    } catch (e) {
      // Fall through to SWK path if Freighter signing fails
      console.warn("Freighter signing failed, falling back to SWK:", e);
    }

    if (!swkReady) throw new Error("Stellar Wallets Kit not loaded");
    var { address } = await StellarWalletsKit.getAddress();
    var { signedTxXdr } = await StellarWalletsKit.signTransaction(buildRes.xdr, {
      networkPassphrase: "Test SDF Network ; September 2015",
      address: address,
    });
    return await apiClientSubmit(signedTxXdr);
  }

  async function apiClientSubmit(signedXdr) {
    return await api("/submit", {
      method: "POST",
      body: { signedXdr: signedXdr },
    });
  }

  // Expose wallet functions globally
  window.__disconnectWallet = disconnectWallet;

  // ── API Client ──
  async function api(path, opts = {}) {
    const headers = opts.body ? { "Content-Type": "application/json" } : {};
    if (window.__sessionToken) headers.Authorization = "Bearer " + window.__sessionToken;
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (networkErr) {
      // Network-level failure (offline, DNS, etc.)
      var networkMsg = "Network error — could not reach the server";
      if (!opts._silent) toast(networkMsg, "error");
      throw new Error(networkMsg);
    }
    const data = await res.json();
    if (!res.ok) {
      var errMsg = data.error || "Request failed (" + res.status + ")";
      if (!opts._silent) toast(errMsg, "error");
      throw new Error(errMsg);
    }
    return data;
  }

  var authPromise = null;
  async function ensureSession() {
    if (!wallet.connected || !wallet.publicKey || window.__sessionToken) return;
    if (wallet.network === "mainnet") {
      throw new Error("Dashboard authentication is disabled for Mainnet wallets");
    }
    if (authPromise) return authPromise;
    authPromise = (async function () {
      const challenge = await api(
        "/auth/challenge?publicKey=" + encodeURIComponent(wallet.publicKey),
      );
      const signed = await signWalletTransaction(challenge.xdr);
      const verified = await api("/auth/verify", {
        method: "POST",
        body: { publicKey: wallet.publicKey, nonce: challenge.nonce, signedXdr: signed },
      });
      window.__sessionToken = verified.token;
    })();
    try {
      await authPromise;
    } finally {
      authPromise = null;
    }
  }

  async function signWalletTransaction(txXdr) {
    const freighter = window.freighterApi || window.freighter;
    if (freighter && typeof freighter.signTransaction === "function") {
      const result = await freighter.signTransaction(txXdr);
      return (
        result.signedTransaction ||
        result.signedTx ||
        result.signedTxXdr ||
        result.signedXdr ||
        result
      );
    }
    if (!swkReady) throw new Error("Stellar Wallet Kit not loaded");
    const addressResult = await StellarWalletsKit.getAddress();
    const result = await StellarWalletsKit.signTransaction(txXdr, {
      networkPassphrase: "Test SDF Network ; September 2015",
      address: addressResult.address,
    });
    return result.signedTxXdr;
  }

  // ── Helpers ──
  function truncAddr(addr) {
    if (!addr) return "\u2014";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatMusd(raw) {
    if (!raw) return "0.00";
    if (String(raw).includes(".")) return parseFloat(raw).toFixed(2);
    const val = BigInt(raw);
    const whole = val / 10000000n;
    const frac = Number(val % 10000000n) / 10000000;
    return (Number(whole) + frac).toFixed(2);
  }

  // ── Status tooltip descriptions (#466) ──
  const STATUS_TOOLTIPS = {
    Open:      "Job created but not yet funded — awaiting escrow deposit.",
    Funded:    "Escrow deposit received; waiting for the provider to submit a deliverable.",
    Submitted: "Provider has submitted a deliverable URI; waiting for evaluator approval.",
    Completed: "Evaluator approved the deliverable and funds have been released to the provider.",
    Rejected:  "Evaluator rejected the deliverable (reserved for future dispute resolution).",
    Cancelled: "Job was cancelled by the client or timed out; budget has been refunded.",
    Disputed:  "Client opened a dispute on the submitted deliverable; evaluator must resolve.",
  };

  function statusBadge(status) {
    const safe = escapeHtml(status);
    const tip = escapeHtml(STATUS_TOOLTIPS[status] || status);
    return (
      '<span class="status-badge status-' + safe + '" title="' + tip + '"><span class="dot"></span>' + safe + "</span>"
    );
  }

  // ── Identicon generator (#468) ──
  // Generates a deterministic 5×5 symmetric SVG identicon from a Stellar public key.
  function agentIdenticon(pubkey) {
    if (!pubkey || pubkey.length < 10) {
      return '<div class="agent-avatar">?</div>';
    }
    // Derive a numeric seed from the key characters
    var seed = 0;
    for (var i = 0; i < pubkey.length; i++) {
      seed = (seed * 31 + pubkey.charCodeAt(i)) >>> 0;
    }
    // Simple seeded PRNG (xorshift32)
    function rand() {
      seed ^= seed << 13;
      seed ^= seed >> 17;
      seed ^= seed << 5;
      seed = seed >>> 0;
      return seed;
    }
    // Pick a hue from the key
    var hue = rand() % 360;
    var color = "hsl(" + hue + ",60%,65%)";
    var bg = "hsl(" + hue + ",30%,15%)";
    // Build 5×5 symmetric grid (only fill left 3 columns, mirror to right)
    var cells = [];
    for (var r = 0; r < 5; r++) {
      for (var c = 0; c < 3; c++) {
        cells.push(rand() % 2 === 1);
      }
    }
    var size = 40;
    var cell = size / 5;
    var rects = "";
    for (var row = 0; row < 5; row++) {
      for (var col = 0; col < 5; col++) {
        var srcCol = col < 3 ? col : 4 - col;
        if (cells[row * 3 + srcCol]) {
          rects += '<rect x="' + (col * cell) + '" y="' + (row * cell) + '" width="' + cell + '" height="' + cell + '" fill="' + color + '"/>';
        }
      }
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="border-radius:8px;display:block">'
      + '<rect width="' + size + '" height="' + size + '" fill="' + bg + '"/>'
      + rects
      + '</svg>';
    return '<div class="agent-avatar agent-avatar-svg" title="' + escapeHtml(pubkey) + '">' + svg + '</div>';
  }
  function toast(msg, type = "success", duration = null) {
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", type === "error" ? "assertive" : "polite");

    var msgSpan = document.createElement("span");
    msgSpan.textContent = msg;
    el.appendChild(msgSpan);

    var closeBtn = document.createElement("span");
    closeBtn.className = "toast-close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Dismiss");
    el.appendChild(closeBtn);

    function dismiss() {
      el.style.animation = "toast-out 0.25s ease-in forwards";
      setTimeout(function () { el.remove(); }, 260);
    }
    closeBtn.addEventListener("click", dismiss);

    container.appendChild(el);
    var autoDismiss = duration || 4000;
    setTimeout(dismiss, autoDismiss);
  }

  // Public alias required by the issue spec
  window.showToast = toast;

  // ── Transaction Overlay ──
  function showTxOverlay(text) {
    const overlay = document.getElementById("tx-overlay");
    const modal = overlay.querySelector(".tx-modal");
    modal.innerHTML =
      '<div class="tx-spinner"></div><div class="tx-text">' +
      escapeHtml(text || "Submitting to Stellar...") +
      "</div>";
    overlay.classList.add("active");
  }
  function hideTxOverlay() {
    document.getElementById("tx-overlay").classList.remove("active");
  }

  // ── Copy to clipboard ──
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast("Copied to clipboard");
  }

  // ── Modal ──
  function showModal(contentHtml) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = contentHtml; // Safe: only called with our own static template strings
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  // ── Skeleton Loaders ──
  function skeletonCards(n) {
    let html = '<div class="stat-grid">';
    for (let i = 0; i < (n || 4); i++) {
      html +=
        '<div class="skeleton-card"><div class="skeleton skeleton-lg"></div><div class="skeleton skeleton-line w60"></div></div>';
    }
    return html + "</div>";
  }
  function skeletonList(n) {
    let html = "";
    for (let i = 0; i < (n || 3); i++) {
      html +=
        '<div class="skeleton-card" style="height:64px;margin-bottom:8px"><div class="skeleton skeleton-line w80"></div></div>';
    }
    return html;
  }

  // ── Safe DOM render helper ──
  function setPage(html) {
    // All HTML is constructed from trusted sources (our API responses contain
    // only Stellar addresses and contract state, not user-generated content)
    document.getElementById("page").innerHTML = html;
  }

  // ── Data Fetchers ──
  async function loadStats() {
    state.loading.stats = true;
    try {
      state.stats = await api("/stats");
    } catch (e) {
      console.error(e);
    }
    state.loading.stats = false;
  }
  async function loadWallets() {
    state.loading.wallets = true;
    try {
      state.wallets = await api("/wallets");
    } catch (e) {
      console.error(e);
    }
    state.loading.wallets = false;
  }
  async function loadAgents(page = state.agentPage, paged = true) {
    state.loading.agents = true;
    try {
      const data = await api(
        paged ? "/agents?page=" + page + "&pageSize=" + state.agentPageSize : "/agents",
      );
      state.agents = data.items || data;
      state.agentPage = data.page || page;
      state.agentTotal = data.total || state.agents.length;
    } catch (e) {
      console.error(e);
    }
    state.loading.agents = false;
  }
  async function loadJobs(status) {
    state.loading.jobs = true;
    try {
      const query = status ? "?status=" + encodeURIComponent(status) : "";
      state.jobs = await api("/jobs" + query);
    } catch (e) {
      console.error(e);
    }
    state.loading.jobs = false;
  }

  // ── Views ──

  // 1. Dashboard Overview
  async function renderDashboard() {
    setPage(
      '<div class="page-header"><div class="page-header-row">' +
        '<div><div class="page-title">Dashboard</div><div class="page-subtitle">Bear Protocol overview on Stellar Testnet</div></div>' +
        '<div class="page-badge"><span class="dot"></span>Connected</div>' +
        "</div></div>" +
        skeletonCards(4) +
        skeletonList(5),
    );

    await Promise.all([loadStats(), loadJobs()]);

    const s = state.stats || { totalAgents: 0, totalJobs: 0, activeJobs: 0, feeBps: 100 };
    const jobs = state.jobs || [];
    const recentJobs = jobs.slice(-8).reverse();

    // Compute total escrowed from funded+submitted jobs
    let totalEscrowed = 0;
    for (const j of jobs) {
      if (j.status === "Funded" || j.status === "Submitted") {
        totalEscrowed += parseFloat(formatMusd(j.budget));
      }
    }

    // Stat cards with icons
    var statCards =
      '<div class="stat-grid">' +
      '<div class="stat-card">' +
      '<div class="stat-card-top"><div class="stat-label">Total Agents</div>' +
      '<div class="stat-icon blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>' +
      '</div><div class="stat-value">' +
      s.totalAgents +
      "</div></div>" +
      '<div class="stat-card">' +
      '<div class="stat-card-top"><div class="stat-label">Active Jobs</div>' +
      '<div class="stat-icon amber"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></div>' +
      '</div><div class="stat-value accent">' +
      s.activeJobs +
      "</div></div>" +
      '<div class="stat-card">' +
      '<div class="stat-card-top"><div class="stat-label">Total Escrowed</div>' +
      '<div class="stat-icon green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg></div>' +
      '</div><div class="stat-value">' +
      totalEscrowed.toFixed(2) +
      ' <span style="font-size:14px;color:var(--text-muted);font-weight:400">USDC</span></div></div>' +
      '<div class="stat-card">' +
      '<div class="stat-card-top"><div class="stat-label">Fee Rate</div>' +
      '<div class="stat-icon orange"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M20.66 8A10 10 0 0 0 16 3.34"/></svg></div>' +
      '</div><div class="stat-value">' +
      (s.feeBps / 100).toFixed(0) +
      "%</div></div>" +
      "</div>";

    // Activity feed
    var activityHtml = "";
    if (recentJobs.length === 0) {
      activityHtml =
        '<div class="empty-state" style="padding:48px 24px">' +
        '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></div>' +
        '<div class="empty-title">No jobs yet</div>' +
        '<div class="empty-desc">Create your first job to see activity here.</div></div>';
    } else {
      for (const j of recentJobs) {
        activityHtml +=
          '<div class="activity-row">' +
          '<div class="activity-id">#' +
          escapeHtml(String(j.id)) +
          "</div>" +
          '<div class="activity-info">' +
          '<div class="activity-desc">' +
          escapeHtml(j.description || "\u2014") +
          "</div>" +
          '<div class="activity-meta">Client: ' +
          truncAddr(j.client) +
          "</div>" +
          "</div>" +
          '<div class="activity-right">' +
          '<div class="activity-amount">' +
          formatMusd(j.budget) +
          ' <span class="activity-unit">USDC</span></div>' +
          '<div class="activity-status">' +
          statusBadge(j.status) +
          "</div>" +
          "</div></div>";
      }
    }

    // Quick actions sidebar
    var quickActions =
      "" +
      '<a href="#/jobs" class="quick-action" onclick="setTimeout(function(){window.__showCreateJob()},300)">' +
      '<div class="qa-icon orange"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></div>' +
      '<div class="qa-info"><div class="qa-title">Create Job</div><div class="qa-desc">Lock USDC in escrow</div></div>' +
      '<svg class="qa-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></a>' +
      '<a href="#/agents" class="quick-action" onclick="setTimeout(function(){window.__showRegisterAgent()},300)">' +
      '<div class="qa-icon blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg></div>' +
      '<div class="qa-info"><div class="qa-title">Register Agent</div><div class="qa-desc">On-chain identity</div></div>' +
      '<svg class="qa-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></a>' +
      '<a href="#/wallet" class="quick-action">' +
      '<div class="qa-icon green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg></div>' +
      '<div class="qa-info"><div class="qa-title">View Wallets</div><div class="qa-desc">Check balances</div></div>' +
      '<svg class="qa-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></a>';

    setPage(
      '<div class="page-header"><div class="page-header-row">' +
        '<div><div class="page-title">Dashboard</div><div class="page-subtitle">Bear Protocol overview on Stellar Testnet</div></div>' +
        '<div class="page-badge"><span class="dot"></span>Connected</div>' +
        "</div></div>" +
        statCards +
        '<div class="dash-grid">' +
        '<div class="dash-panel">' +
        '<div class="dash-panel-header"><div class="dash-panel-title">Recent Activity</div><a href="#/jobs" class="dash-panel-link">View all jobs</a></div>' +
        activityHtml +
        "</div>" +
        '<div class="dash-panel">' +
        '<div class="dash-panel-header"><div class="dash-panel-title">Quick Actions</div></div>' +
        quickActions +
        "</div>" +
        "</div>",
    );
  }

  // 2. Wallets
  async function renderWallets() {
    var skeletonCount = wallet.connected ? 3 : 2;
    var skeletons = "";
    for (var si = 0; si < skeletonCount; si++)
      skeletons += '<div class="skeleton-card" style="height:280px"></div>';
    setPage(
      '<div class="page-header"><div class="page-title">Wallets</div><div class="page-subtitle">Testnet accounts for buyer and seller agents</div></div>' +
        '<div class="wallet-grid">' +
        skeletons +
        "</div>",
    );

    // Load demo wallets + optionally Freighter wallet balance
    var freighterBalance = null;
    var promises = [loadWallets()];
    if (wallet.connected) {
      promises.push(
        api("/balance/" + wallet.publicKey)
          .then(function (b) {
            freighterBalance = b;
          })
          .catch(function () {}),
      );
    }
    await Promise.all(promises);
    const w = state.wallets;
    if (!w) {
      setPage('<p style="color:var(--status-cancelled)">Failed to load wallets</p>');
      return;
    }

    function walletCard(label, role, data, type) {
      return (
        '<div class="wallet-card ' +
        type +
        '">' +
        '<div class="wallet-card-header">' +
        '<div class="wallet-name">' +
        escapeHtml(label) +
        "</div>" +
        '<div class="wallet-role">' +
        escapeHtml(role) +
        "</div>" +
        "</div>" +
        '<div class="wallet-card-body">' +
        '<div class="wallet-addr" onclick="window.__copy(\'' +
        data.address +
        "')\">" +
        "<code>" +
        escapeHtml(data.address) +
        "</code>" +
        '<span class="copy-hint">Click to copy</span>' +
        "</div>" +
        '<div class="balance-row"><span class="balance-label xlm">XLM</span>' +
        '<span class="balance-value">' +
        parseFloat(data.xlm).toFixed(2) +
        '<span class="balance-unit">XLM</span></span></div>' +
        '<div class="balance-row"><span class="balance-label musd">MUSD</span>' +
        '<span class="balance-value">' +
        parseFloat(data.musd).toFixed(2) +
        '<span class="balance-unit">MUSD</span></span></div>' +
        '<div style="margin-top:18px">' +
        '<a href="https://friendbot.stellar.org?addr=' +
        encodeURIComponent(data.address) +
        '" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">Fund XLM via Friendbot</a>' +
        "</div></div></div>"
      );
    }

    var freighterCard = "";
    if (wallet.connected && freighterBalance) {
      freighterCard = walletCard(
        "Your Wallet",
        "Freighter (Connected)",
        freighterBalance,
        "freighter",
      );
    }

    setPage(
      '<div class="page-header"><div class="page-title">Wallets</div><div class="page-subtitle">Testnet accounts for buyer and seller agents</div></div>' +
        '<div class="wallet-grid">' +
        freighterCard +
        walletCard("Buyer Wallet", "Client / Evaluator", w.buyer, "buyer") +
        walletCard("Seller Wallet", "Provider", w.seller, "seller") +
        "</div>",
    );
  }

  // 3. Jobs
  async function renderJobs() {
    setPage(
      '<div class="section-header"><div><div class="section-title">Jobs</div><div class="page-subtitle" style="margin-top:2px">Escrow-based job marketplace on Soroban</div></div>' +
        '<button class="btn btn-primary" onclick="window.__showCreateJob()">+ Create Job</button></div>' +
        skeletonList(4),
    );
    await loadJobs("Active");
    renderJobList();
  }

  function renderJobList() {
    const jobs = state.jobs || [];
    const filters = ["Active", "All", "Funded", "Submitted", "Completed", "Cancelled"];
    let filtered;
    if (state.jobFilter === "Active") {
      filtered = jobs.filter(function (j) {
        return j.status === "Funded" || j.status === "Submitted";
      });
    } else if (state.jobFilter === "All") {
      filtered = jobs;
    } else {
      filtered = jobs.filter(function (j) {
        return j.status === state.jobFilter;
      });
    }

    // Apply search filter (#460)
    var searchTerm = (state.jobSearch || "").toLowerCase().trim();
    if (searchTerm) {
      filtered = filtered.filter(function (j) {
        return (
          String(j.id).includes(searchTerm) ||
          (j.description || "").toLowerCase().includes(searchTerm) ||
          (j.client || "").toLowerCase().includes(searchTerm) ||
          (j.provider || "").toLowerCase().includes(searchTerm)
        );
      });
    }

    let tabs = '<div class="filter-tabs">';
    for (const f of filters) {
      tabs +=
        '<button class="filter-tab ' +
        (f === state.jobFilter ? "active" : "") +
        '" onclick="window.__filterJobs(\'' +
        f +
        "')\">" +
        f +
        "</button>";
    }
    tabs += "</div>";

    // Search + export toolbar (#460, #464)
    var toolbar =
      '<div class="jobs-toolbar">' +
      '<div class="jobs-search-wrap">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>' +
      '<input class="jobs-search-input" id="jobs-search-input" type="search" ' +
      'placeholder="Search by description, client, or provider…" ' +
      'value="' + escapeHtml(state.jobSearch) + '" ' +
      'oninput="window.__searchJobs(this.value)">' +
      '</div>' +
      '<div class="export-btns">' +
      '<button class="btn btn-secondary btn-sm" onclick="window.__exportJobs(\'json\')">⬇ JSON</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="window.__exportJobs(\'csv\')">⬇ CSV</button>' +
      '</div>' +
      '</div>';

    let content = "";
    if (filtered.length === 0) {
      let label = "";
      if (state.jobFilter === "All") {
        label = "";
      } else if (state.jobFilter === "Active") {
        label = "active ";
      } else {
        label = state.jobFilter.toLowerCase() + " ";
      }
      var noMatchMsg = searchTerm
        ? '<div class="empty-state"><div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></div>' +
          '<div class="empty-title">No results for &ldquo;' + escapeHtml(searchTerm) + '&rdquo;</div>' +
          '<div class="empty-desc">Try a different search term or clear the filter.</div></div>'
        : '<div class="empty-state">' +
          '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></div>' +
          '<div class="empty-title">No ' +
          label +
          "jobs</div>" +
          '<div class="empty-desc">Create your first job to see it here.</div></div>';
      content = noMatchMsg;
    } else {
      content = '<div class="job-list">';
      for (const j of filtered) {
        let actions = "";
        if (j.status === "Funded") {
          actions =
            '<button class="btn btn-primary btn-sm" onclick="window.__submitJob(\'' +
            j.id +
            "')\">Submit Work</button>" +
            '<button class="btn btn-danger btn-sm" onclick="window.__cancelJob(\'' +
            j.id +
            "')\">Cancel</button>";
        } else if (j.status === "Submitted") {
          actions =
            '<button class="btn btn-primary btn-sm" onclick="window.__completeJob(\'' +
            j.id +
            "')\">Complete (Release Funds)</button>";
        } else {
          actions =
            '<span style="font-size:13px;color:var(--text-dim)">Job is ' +
            escapeHtml(j.status.toLowerCase()) +
            ". No actions available.</span>";
        }

        let deliverableHtml = "";
        if (j.deliverable) {
          deliverableHtml =
            '<div class="detail-item" style="grid-column:1/-1">' +
            '<div class="detail-label">Deliverable</div>' +
            '<div class="detail-value">' +
            escapeHtml(j.deliverable) +
            "</div></div>";
        }

        content +=
          '<div class="job-row" id="job-' +
          j.id +
          '">' +
          '<div class="job-summary" onclick="window.__toggleJob(\'' +
          j.id +
          "')\">" +
          '<div class="job-id">#' +
          escapeHtml(String(j.id)) +
          "</div>" +
          statusBadge(j.status) +
          '<div class="job-desc">' +
          escapeHtml(j.description || "\u2014") +
          "</div>" +
          '<div class="job-budget">' +
          formatMusd(j.budget) +
          ' <span class="unit">MUSD</span></div>' +
          '<svg class="job-expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>' +
          "</div>" +
          '<div class="job-detail">' +
          '<div class="detail-grid">' +
          '<div class="detail-item"><div class="detail-label">Client</div>' +
          '<div class="detail-value addr-with-copy">' +
          '<span style="cursor:pointer" onclick="window.__copy(\'' + j.client + '\')">' + truncAddr(j.client) + '</span>' +
          copyBtn(j.client) +
          "</div></div>" +
          '<div class="detail-item"><div class="detail-label">Provider</div>' +
          '<div class="detail-value addr-with-copy">' +
          '<span style="cursor:pointer" onclick="window.__copy(\'' + j.provider + '\')">' + truncAddr(j.provider) + '</span>' +
          copyBtn(j.provider) +
          "</div></div>" +
          '<div class="detail-item"><div class="detail-label">Evaluator</div>' +
          '<div class="detail-value addr-with-copy">' +
          '<span style="cursor:pointer" onclick="window.__copy(\'' + j.evaluator + '\')">' + truncAddr(j.evaluator) + '</span>' +
          copyBtn(j.evaluator) +
          "</div></div>" +
          '<div class="detail-item"><div class="detail-label">Token</div>' +
          '<div class="detail-value addr-with-copy">' +
          '<span style="cursor:pointer" onclick="window.__copy(\'' + j.token + '\')">' + truncAddr(j.token) + '</span>' +
          copyBtn(j.token) +
          "</div></div>" +
          (j.created_at
            ? '<div class="detail-item"><div class="detail-label">Created</div>' +
              '<div class="detail-value" title="' + escapeHtml(new Date(Number(j.created_at) * 1000).toISOString()) + '">' +
              escapeHtml(formatRelativeTime(j.created_at)) +
              "</div></div>"
            : "") +
          deliverableHtml +
          "</div>" +
          '<div class="job-actions">' +
          actions +
          "</div>" +
          "</div></div>";
      }
      content += "</div>";
    }

    setPage(
      '<div class="section-header"><div><div class="section-title">Jobs</div><div class="page-subtitle" style="margin-top:2px">Escrow-based job marketplace on Soroban</div></div>' +
        '<button class="btn btn-primary" onclick="window.__showCreateJob()">+ Create Job</button></div>' +
        tabs +
        toolbar +
        content,
    );
  }

  // 4. Agents
  async function renderAgents() {
    setPage(
      '<div class="section-header"><div><div class="section-title">Agents</div><div class="page-subtitle" style="margin-top:2px">On-chain identity registry for AI agents</div></div>' +
        '<button class="btn btn-primary" onclick="window.__showRegisterAgent()">+ Register Agent</button></div>' +
        skeletonList(3),
    );

    await loadAgents();
    const agents = state.agents || [];

    let cards = "";
    if (agents.length === 0) {
      cards =
        '<div class="empty-state">' +
        '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>' +
        '<div class="empty-title">No agents registered</div>' +
        '<div class="empty-desc">Register your first agent to get started.</div></div>';
    } else {
      cards = '<div class="agent-grid">';
      for (const a of agents) {
        cards +=
          '<div class="agent-card">' +
          '<div class="agent-card-top">' +
          agentIdenticon(a.owner) +
          '<div class="agent-id">Agent <span>#' +
          escapeHtml(String(a.id)) +
          "</span></div>" +
          "</div>" +
          '<div class="agent-field"><div class="agent-field-label">Owner</div>' +
          '<div class="agent-field-value addr-with-copy">' +
          '<span style="cursor:pointer" onclick="window.__copy(\'' + a.owner + '\')">' +
          truncAddr(a.owner) +
          '</span>' +
          copyBtn(a.owner) +
          "</div></div>" +
          '<div class="agent-field"><div class="agent-field-label">Metadata URI</div>' +
          '<div class="agent-field-value">' +
          escapeHtml(a.uri) +
          "</div></div>" +
          "</div>";
      }
      cards += "</div>";
    }

    const totalPages = Math.max(1, Math.ceil(state.agentTotal / state.agentPageSize));
    if (totalPages > 1) {
      cards +=
        '<div class="filter-tabs" style="margin-top:20px">' +
        '<button class="filter-tab" ' +
        (state.agentPage === 1 ? "disabled" : "") +
        ' onclick="window.__changeAgentPage(' +
        (state.agentPage - 1) +
        ')">Previous</button>' +
        '<span class="filter-tab active">Page ' +
        state.agentPage +
        " of " +
        totalPages +
        '</span><button class="filter-tab" ' +
        (state.agentPage >= totalPages ? "disabled" : "") +
        ' onclick="window.__changeAgentPage(' +
        (state.agentPage + 1) +
        ')">Next</button></div>';
    }

    setPage(
      '<div class="section-header"><div><div class="section-title">Agents</div><div class="page-subtitle" style="margin-top:2px">On-chain identity registry for AI agents</div></div>' +
        '<button class="btn btn-primary" onclick="window.__showRegisterAgent()">+ Register Agent</button></div>' +
        '<div class="stat-grid" style="margin-bottom:24px;grid-template-columns:repeat(3,1fr)">' +
        '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Registered</div>' +
        '<div class="stat-icon blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>' +
        '</div><div class="stat-value">' +
        agents.length +
        "</div></div>" +
        '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Network</div>' +
        '<div class="stat-icon green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>' +
        '</div><div class="stat-value" style="font-size:18px;color:var(--status-completed)">Testnet</div></div>' +
        '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Registry</div>' +
        '<div class="stat-icon orange"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>' +
        '</div><div class="stat-value" style="font-size:14px;font-weight:600;color:var(--text-muted);font-family:var(--mono)">ERC-8004</div></div>' +
        "</div>" +
        cards,
    );
  }

  // 5. Transaction History
  async function renderHistory() {
    setPage(
      '<div class="page-header"><div class="page-title">Transaction History</div><div class="page-subtitle">All past activity on the Bear Protocol contracts</div></div>' +
        skeletonList(6),
    );

    await Promise.all([loadJobs(), loadAgents(1, false)]);

    var jobs = state.jobs || [];
    var agents = state.agents || [];

    // Build a unified event list: jobs (all statuses) + agent registrations
    var events = [];
    for (var j of jobs) {
      events.push({
        kind: "job",
        id: j.id,
        status: j.status,
        desc: j.description || "—",
        budget: j.budget,
        actor: j.client,
        deliverable: j.deliverable || null,
      });
    }
    for (var a of agents) {
      events.push({ kind: "agent", id: a.id, uri: a.uri, actor: a.owner });
    }
    // Sort by numeric id descending (latest first)
    events.sort(function (a, b) {
      return Number(b.id) - Number(a.id);
    });

    if (events.length === 0) {
      setPage(
        '<div class="page-header"><div class="page-title">Transaction History</div><div class="page-subtitle">All past activity on the Bear Protocol contracts</div></div>' +
          '<div class="empty-state">' +
          '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg></div>' +
          '<div class="empty-title">No history yet</div>' +
          '<div class="empty-desc">Jobs and agent registrations will appear here.</div></div>',
      );
      return;
    }

    // Filter tabs for history
    var histFilter = window.__histFilter || "All";
    var histFilters = ["All", "Jobs", "Agents", "Completed", "Cancelled"];
    var filteredEvents = events.filter(function (ev) {
      if (histFilter === "All") return true;
      if (histFilter === "Jobs") return ev.kind === "job";
      if (histFilter === "Agents") return ev.kind === "agent";
      if (histFilter === "Completed") return ev.kind === "job" && ev.status === "Completed";
      if (histFilter === "Cancelled") return ev.kind === "job" && ev.status === "Cancelled";
      return true;
    });

    var tabs = '<div class="filter-tabs">';
    for (var hf of histFilters) {
      tabs +=
        '<button class="filter-tab ' +
        (hf === histFilter ? "active" : "") +
        '" onclick="window.__filterHistory(\'' +
        hf +
        "')\">" +
        hf +
        "</button>";
    }
    tabs += "</div>";

    var rows = '<div class="history-list">';
    if (filteredEvents.length === 0) {
      rows +=
        '<div class="empty-state" style="margin-top:24px">' +
        '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg></div>' +
        '<div class="empty-title">No matching records</div>' +
        '<div class="empty-desc">Try a different filter.</div></div>';
    } else {
      for (var ev of filteredEvents) {
        var icon, label, meta, badge;
        if (ev.kind === "job") {
          icon =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>';
          label = escapeHtml(ev.desc);
          var deliverablePart = ev.deliverable
            ? ' &nbsp;·&nbsp; <a href="' +
              escapeHtml(ev.deliverable) +
              '" target="_blank" rel="noopener" style="color:var(--accent);font-weight:500">View Deliverable ↗</a>'
            : "";
          meta =
            "Client: " +
            truncAddr(ev.actor) +
            " &nbsp;·&nbsp; " +
            formatMusd(ev.budget) +
            " USDC" +
            deliverablePart;
          badge = statusBadge(ev.status);
        } else {
          icon =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>';
          label = "Agent registered";
          meta = "Owner: " + truncAddr(ev.actor) + " &nbsp;·&nbsp; " + escapeHtml(ev.uri || "");
          badge =
            '<span class="status-badge status-Completed"><span class="dot"></span>Registered</span>';
        }
        rows +=
          '<div class="history-row">' +
          '<div class="history-icon ' +
          (ev.kind === "job" ? "hist-job" : "hist-agent") +
          '">' +
          icon +
          "</div>" +
          '<div class="history-body">' +
          '<div class="history-label">' +
          label +
          "</div>" +
          '<div class="history-meta">' +
          meta +
          "</div>" +
          "</div>" +
          '<div class="history-right">' +
          '<div class="history-id">#' +
          escapeHtml(String(ev.id)) +
          "</div>" +
          badge +
          "</div>" +
          "</div>";
      }
    }
    rows += "</div>";

    var completedCount = jobs.filter(function (j) {
      return j.status === "Completed";
    }).length;
    var cancelledCount = jobs.filter(function (j) {
      return j.status === "Cancelled";
    });
    var totalVolume = 0;
    for (var cj of jobs.filter(function (j) {
      return j.status === "Completed";
    })) {
      totalVolume += parseFloat(formatMusd(cj.budget));
    }

    var summary =
      '<div class="stat-grid" style="margin-bottom:24px;grid-template-columns:repeat(4,1fr)">' +
      '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Total Jobs</div>' +
      '<div class="stat-icon blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></div>' +
      '</div><div class="stat-value">' +
      jobs.length +
      "</div></div>" +
      '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Completed</div>' +
      '<div class="stat-icon green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></div>' +
      '</div><div class="stat-value">' +
      completedCount +
      "</div></div>" +
      '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Total Settled</div>' +
      '<div class="stat-icon amber"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/></svg></div>' +
      '</div><div class="stat-value">' +
      totalVolume.toFixed(2) +
      ' <span style="font-size:12px;color:var(--text-muted);font-weight:400">USDC</span></div></div>' +
      '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Agents Registered</div>' +
      '<div class="stat-icon orange"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>' +
      '</div><div class="stat-value">' +
      agents.length +
      "</div></div>" +
      "</div>";

    setPage(
      '<div class="page-header"><div class="page-title">Transaction History</div><div class="page-subtitle">All past activity on the Bear Protocol contracts</div></div>' +
        summary +
        tabs +
        rows,
    );
  }

  window.__filterHistory = function (filter) {
    window.__histFilter = filter;
    renderHistory();
  };

  // ── Global Actions ──

  window.__copy = copyToClipboard;

  window.__toggleJob = function (id) {
    const row = document.getElementById("job-" + id);
    if (row) row.classList.toggle("expanded");
  };

  window.__filterJobs = function (filter) {
    state.jobFilter = filter;
    state.jobSearch = ""; // reset search when switching filter tabs
    loadJobs(filter === "All" ? undefined : filter)
      .then(renderJobList)
      .catch(function (e) {
        toast(e.message, "error");
      });
  };

  // #460 — live search filter
  window.__searchJobs = function (value) {
    state.jobSearch = value;
    renderJobList();
    // Re-focus the input after re-render (setPage wipes DOM)
    var input = document.getElementById("jobs-search-input");
    if (input) {
      input.focus();
      // Place cursor at end
      var len = input.value.length;
      input.setSelectionRange(len, len);
    }
  };

  // #464 — export jobs to JSON or CSV
  window.__exportJobs = function (format) {
    var jobs = state.jobs || [];
    if (jobs.length === 0) {
      toast("No jobs to export", "error");
      return;
    }
    var dateStr = new Date().toISOString().slice(0, 10);
    var filename = "marc-jobs-" + dateStr + "." + format;
    var blob;
    if (format === "json") {
      var rows = jobs.map(function (j) {
        return {
          id: j.id,
          client: j.client || "",
          provider: j.provider || "",
          evaluator: j.evaluator || "",
          token: j.token || "",
          budget: formatMusd(j.budget),
          description: j.description || "",
          status: j.status || "",
          deliverable: j.deliverable || "",
        };
      });
      blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    } else {
      var header = "id,client,provider,evaluator,token,budget,description,status,deliverable";
      var csvRows = jobs.map(function (j) {
        function csvCell(v) {
          var s = String(v == null ? "" : v);
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            s = '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        }
        return [
          j.id,
          j.client || "",
          j.provider || "",
          j.evaluator || "",
          j.token || "",
          formatMusd(j.budget),
          j.description || "",
          j.status || "",
          j.deliverable || "",
        ]
          .map(csvCell)
          .join(",");
      });
      blob = new Blob([[header].concat(csvRows).join("\n")], { type: "text/csv" });
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Downloaded " + filename);
  };

  window.__changeAgentPage = async function (page) {
    if (page < 1) return;
    await loadAgents(page);
    renderAgents();
  };

  window.__showCreateJob = function () {
    var walletField = wallet.connected
      ? '<div class="form-group"><label class="form-label">Signing Wallet</label>' +
        '<div class="form-input" style="color:var(--accent);cursor:default">' +
        truncAddr(wallet.publicKey) +
        " (Freighter)</div></div>"
      : '<div class="form-group"><label class="form-label">Signing Wallet</label>' +
        '<select class="form-select" id="cj-wallet"><option value="buyer">Buyer (Client)</option><option value="seller">Seller</option></select></div>';
    showModal(
      '<h2 class="modal-title">Create Job</h2>' +
        walletField +
        '<div class="form-group"><label class="form-label">Description</label>' +
        '<input class="form-input" id="cj-desc" value="Dashboard test job" placeholder="Job description..."></div>' +
        '<div class="form-group"><label class="form-label">Budget (MUSD units, 7 decimals)</label>' +
        '<input class="form-input" id="cj-budget" value="10000000" placeholder="10000000 = 1 MUSD"></div>' +
        '<div class="form-group"><label class="form-label">Provider Address <span style="color:var(--text-muted);font-weight:400">(must be a registered agent)</span></label>' +
        '<input class="form-input" id="cj-provider" placeholder="Leave blank to use default seller" autocomplete="off" spellcheck="false"></div>' +
        '<div class="modal-actions">' +
        '<button class="btn btn-secondary" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="window.__doCreateJob()">Create Job</button></div>',
    );
  };

  window.__doCreateJob = async function () {
    if (state.txPending) return;
    state.txPending = true;
    const description = document.getElementById("cj-desc").value;
    const budget = document.getElementById("cj-budget").value;
    const walletEl = document.getElementById("cj-wallet");
    const walletVal = walletEl ? walletEl.value : "buyer";
    const providerEl = document.getElementById("cj-provider");
    const providerVal = providerEl && providerEl.value.trim() ? providerEl.value.trim() : undefined;
    const overlay = document.querySelector(".modal-overlay");
    if (overlay) overlay.remove();
    showTxOverlay("Creating job on Stellar...");
    try {
      if (wallet.connected) {
        const params = { description: description, budget: budget };
        if (providerVal) params.provider = providerVal;
        const res = await signAndSubmit("/build/createJob", params);
        hideTxOverlay();
        toast("Job created! tx: " + (res.hash || "").slice(0, 8) + "...");
      } else {
        const body = { wallet: walletVal, description: description, budget: budget };
        if (providerVal) body.provider = providerVal;
        const res = await api("/jobs/create", { method: "POST", body: body });
        hideTxOverlay();
        toast("Job #" + res.jobId + " created!");
      }
      await loadJobs();
      renderJobList();
    } catch (e) {
      hideTxOverlay();
      toast(e.message, "error");
    } finally {
      state.txPending = false;
    }
  };

  window.__submitJob = async function (id) {
    if (state.txPending) return;
    state.txPending = true;
    showTxOverlay("Submitting work...");
    try {
      if (wallet.connected) {
        await signAndSubmit("/build/submit", {
          jobId: id,
          deliverable: "ipfs://dashboard-delivery-" + id,
        });
      } else {
        await api("/jobs/" + id + "/submit", {
          method: "POST",
          body: { wallet: "seller", deliverable: "ipfs://dashboard-delivery-" + id },
        });
      }
      hideTxOverlay();
      toast("Job #" + id + " submitted!");
      await loadJobs();
      renderJobList();
    } catch (e) {
      hideTxOverlay();
      toast(e.message, "error");
    } finally {
      state.txPending = false;
    }
  };

  window.__completeJob = async function (id) {
    if (state.txPending) return;
    state.txPending = true;
    showTxOverlay("Completing job & releasing funds...");
    try {
      if (wallet.connected) {
        await signAndSubmit("/build/complete", { jobId: id });
      } else {
        await api("/jobs/" + id + "/complete", { method: "POST", body: { wallet: "buyer" } });
      }
      hideTxOverlay();
      toast("Job #" + id + " completed! Funds released.");
      await loadJobs();
      renderJobList();
    } catch (e) {
      hideTxOverlay();
      toast(e.message, "error");
    } finally {
      state.txPending = false;
    }
  };

  window.__cancelJob = async function (id) {
    if (state.txPending) return;
    const confirmed = window.confirm("Cancel this job and refund the escrowed funds?");
    if (!confirmed) return;

    state.txPending = true;
    showTxOverlay("Cancelling job & refunding...");
    try {
      if (wallet.connected) {
        await signAndSubmit("/build/cancel", { jobId: id });
      } else {
        await api("/jobs/" + id + "/cancel", { method: "POST", body: { wallet: "buyer" } });
      }
      hideTxOverlay();
      toast("Job #" + id + " cancelled. Funds refunded.");
      await loadJobs();
      renderJobList();
    } catch (e) {
      hideTxOverlay();
      toast(e.message, "error");
    } finally {
      state.txPending = false;
    }
  };

  window.__showRegisterAgent = function () {
    var walletField = wallet.connected
      ? '<div class="form-group"><label class="form-label">Signing Wallet</label>' +
        '<div class="form-input" style="color:var(--accent);cursor:default">' +
        truncAddr(wallet.publicKey) +
        " (Freighter)</div></div>"
      : '<div class="form-group"><label class="form-label">Signing Wallet</label>' +
        '<select class="form-select" id="ra-wallet"><option value="buyer">Buyer</option><option value="seller">Seller</option></select></div>';
    showModal(
      '<h2 class="modal-title">Register Agent</h2>' +
        walletField +
        '<div class="form-group"><label class="form-label">Metadata URI</label>' +
        '<input class="form-input" id="ra-uri" value="ipfs://dashboard-agent" placeholder="ipfs://..."></div>' +
        '<div class="modal-actions">' +
        '<button class="btn btn-secondary" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>' +
        '<button class="btn btn-primary" onclick="window.__doRegister()">Register</button></div>',
    );
  };

  window.__doRegister = async function () {
    if (state.txPending) return;
    state.txPending = true;
    const uri = document.getElementById("ra-uri").value;
    const walletEl = document.getElementById("ra-wallet");
    const walletVal = walletEl ? walletEl.value : "buyer";
    const overlay = document.querySelector(".modal-overlay");
    if (overlay) overlay.remove();
    showTxOverlay("Registering agent on Stellar...");
    try {
      let agentId = null;
      if (wallet.connected) {
        const res = await signAndSubmit("/agents/register", { wallet: "freighter", uri: uri });
        hideTxOverlay();
        toast("Agent registered! tx: " + (res.hash || "").slice(0, 8) + "...");
      } else {
        const res = await api("/agents/register", {
          method: "POST",
          body: { wallet: walletVal, uri: uri },
        });
        hideTxOverlay();
        agentId = res.agentId;
        toast("Agent #" + res.agentId + " registered!");
      }
      await new Promise((r) => setTimeout(r, 1500));
      await loadAgents();
      if (agentId !== null && state.agents) {
        const found = state.agents.find(function (a) {
          return String(a.id) === String(agentId);
        });
        if (!found && wallet.connected) {
          state.agents = state.agents.concat([
            {
              id: Number(agentId),
              owner: wallet.publicKey,
              uri: uri,
            },
          ]);
        }
      }
      renderAgents();
    } catch (e) {
      hideTxOverlay();
      toast(e.message, "error");
    } finally {
      state.txPending = false;
    }
  };

  // ── Router ──
  const routes = {
    "/": renderDashboard,
    "/wallet": renderWallets,
    "/jobs": renderJobs,
    "/agents": renderAgents,
    "/history": renderHistory,
  };

  function getRoute() {
    return window.location.hash.slice(1) || "/";
  }

  function navigate() {
    const route = getRoute();
    const render = routes[route] || renderDashboard;

    // Update active nav
    document.querySelectorAll(".nav-item").forEach(function (el) {
      el.classList.toggle("active", el.dataset.route === route);
    });

    // Re-trigger page transition
    const page = document.getElementById("page");
    page.style.animation = "none";
    void page.offsetHeight;
    page.style.animation = "";

    render();

    // Close mobile sidebar on navigation
    if (typeof closeDrawer === "function") closeDrawer();
  }

  window.addEventListener("hashchange", navigate);

  // Mobile menu — drawer with backdrop and ARIA state
  var menuBtn = document.getElementById("menu-btn");
  var sidebar = document.getElementById("sidebar");
  var backdrop = document.getElementById("sidebar-backdrop");

  function openDrawer() {
    sidebar.classList.add("open");
    menuBtn.classList.add("active");
    menuBtn.setAttribute("aria-expanded", "true");
    backdrop.classList.add("visible");
    document.body.style.overflow = "hidden"; // prevent background scroll
  }

  function closeDrawer() {
    sidebar.classList.remove("open");
    menuBtn.classList.remove("active");
    menuBtn.setAttribute("aria-expanded", "false");
    backdrop.classList.remove("visible");
    document.body.style.overflow = "";
  }

  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      if (sidebar.classList.contains("open")) {
        closeDrawer();
      } else {
        openDrawer();
      }
    });
  }

  if (backdrop) {
    backdrop.addEventListener("click", closeDrawer);
  }

  // Close drawer when a nav link is tapped on mobile
  document.querySelectorAll(".nav-item").forEach(function (el) {
    el.addEventListener("click", function () {
      if (window.innerWidth < 768) closeDrawer();
    });
  });

  // ── Auto-refresh polling ──
  // Re-fetch data every 4s and re-render current view for live updates
  var pollTimer = null;
  var polling = false;
  var pollIntervalMs = 10000; // default 10 s

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      var route = getRoute();
      if (route === "/") {
        var oldStats = JSON.stringify(state.stats);
        var oldJobs = JSON.stringify(state.jobs);
        await Promise.all([loadStats(), loadJobs()]);
        if (JSON.stringify(state.stats) !== oldStats || JSON.stringify(state.jobs) !== oldJobs) {
          renderDashboard();
        }
      } else if (route === "/agents") {
        var oldAgents = JSON.stringify(state.agents);
        await loadAgents();
        if (JSON.stringify(state.agents) !== oldAgents) {
          renderAgents();
        }
      } else if (route === "/jobs") {
        var oldJobs2 = JSON.stringify(state.jobs);
        await loadJobs();
        if (JSON.stringify(state.jobs) !== oldJobs2) {
          renderJobList();
        }
      } else if (route === "/wallet") {
        var oldWallets = JSON.stringify(state.wallets);
        await loadWallets();
        if (JSON.stringify(state.wallets) !== oldWallets) {
          renderWallets();
        }
      } else if (route === "/history") {
        var oldJobs3 = JSON.stringify(state.jobs);
        var oldAgents3 = JSON.stringify(state.agents);
        await Promise.all([loadJobs(), loadAgents(1, false)]);
        if (
          JSON.stringify(state.jobs) !== oldJobs3 ||
          JSON.stringify(state.agents) !== oldAgents3
        ) {
          renderHistory();
        }
      }
    } catch (e) {
      // silent — don't break polling on transient errors
    }
    polling = false;
  }

  function startPolling() {
    stopPolling();
    if (pollIntervalMs === 0) return; // Off
    pollTimer = setInterval(poll, pollIntervalMs);
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Expose interval change handler for the dropdown
  window.__setRefreshInterval = function (ms) {
    pollIntervalMs = Number(ms);
    startPolling();
    if (pollIntervalMs === 0) {
      toast("Auto-refresh disabled", "success");
    } else {
      toast("Auto-refresh set to " + pollIntervalMs / 1000 + "s", "success");
    }
    // Persist selection in localStorage so it survives page reloads
    try { localStorage.setItem("bearRefreshInterval", String(pollIntervalMs)); } catch (e) {}
    // Sync the dropdown in case it was changed programmatically
    var sel = document.getElementById("refresh-interval-select");
    if (sel) sel.value = String(pollIntervalMs);
  };

  // Restore saved preference
  try {
    var savedInterval = localStorage.getItem("bearRefreshInterval");
    if (savedInterval !== null) pollIntervalMs = Number(savedInterval);
  } catch (e) {}

  // Start polling on load, restart on visibility change
  startPolling();
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
      poll();
    }
  });

  // Server-Sent Events: listen for invalidation events to refresh quickly
  if (typeof EventSource !== "undefined") {
    try {
      const es = new EventSource("/api/stream");
      es.addEventListener("invalidate", function (e) {
        try {
          const payload = JSON.parse(e.data);
          // On any invalidation, run a quick poll to refresh current view
          poll();
        } catch (err) {
          poll();
        }
      });
      es.addEventListener("ping", function () {});
      es.onerror = function () {
        // Close noisy stream errors; polling remains as a fallback
        try {
          es.close();
        } catch (e) {}
      };
    } catch (e) {
      // ignore SSE setup failures — polling is the primary mechanism
    }
  }

  // Initial render
  navigate();

  // Sync the refresh-interval dropdown to the restored/default interval
  (function syncRefreshSelect() {
    var sel = document.getElementById("refresh-interval-select");
    if (sel) sel.value = String(pollIntervalMs);
  })();
})();
