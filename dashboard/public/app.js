// Bear Dashboard — Single-page app
// Router, state store, API client, 4 views
// Note: innerHTML usage is safe here — all rendered data comes from our own
// backend API (Stellar addresses, contract state). No untrusted user input.

(() => {
  // ── State Store ──
  const state = {
    stats: null,
    wallets: null,
    agents: null,
    jobs: null,
    loading: { stats: false, wallets: false, agents: false, jobs: false },
    jobFilter: "All",
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
    StellarWalletsKit.on(KitEventType.STATE_UPDATED, function(event) {
      var addr = event.payload && event.payload.address;
      if (addr && addr.length > 10) {
        wallet.connected = true;
        wallet.publicKey = addr;
        updateWalletUI();
      }
    });
    swkReady = true;
  }

  // Freighter detection: prefer Freighter if present
  async function detectFreighter() {
    try {
      const api = window.freighterApi || window.freighter;
      if (api && typeof api.getPublicKey === "function") {
        const pk = await api.getPublicKey();
        let net = null;
        if (typeof api.getNetwork === "function") {
          try {
            const n = await api.getNetwork();
            // freighter may return 'TESTNET'|'PUBLIC' or a passphrase string
            if (String(n).toLowerCase().includes("test")) net = "testnet";
            else if (String(n).toLowerCase().includes("pub") || String(n).toLowerCase().includes("main")) net = "mainnet";
          } catch (e) {}
        }
        wallet.connected = true;
        wallet.publicKey = pk;
        wallet.network = net || null;
        updateWalletUI();
      }
    } catch (e) {
      // ignore
    }
  }

  // Try detect Freighter immediately
  detectFreighter();

  function disconnectWallet() {
    wallet.connected = false;
    wallet.publicKey = null;
    updateWalletUI();
    // Re-show the SWK button
    var btnWrapper = document.getElementById("swk-button-wrapper");
    if (btnWrapper) btnWrapper.style.display = "";
    toast("Wallet disconnected");
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
        if (addrDisplay) addrDisplay.onclick = function() { copyToClipboard(wallet.publicKey); };
      }
      if (modeLabel) {
        const netLabel = wallet.network === "mainnet" ? "Mainnet" : wallet.network === "testnet" ? "Testnet" : "Connected";
        modeLabel.textContent = "Connected — " + netLabel;
      }
      // Update sidebar network badge
      try {
        var nb = document.getElementById("network-badge");
        if (nb) nb.innerHTML = '<span class="badge-dot"></span>' + (wallet.network === "mainnet" ? "Stellar Mainnet" : wallet.network === "testnet" ? "Stellar Testnet" : "Unknown Network");
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
        if (wallet.network === "mainnet") throw new Error("Freighter is on Mainnet — dashboard blocks mainnet signing to avoid real transactions");
        const sigRes = await api.signTransaction(buildRes.xdr);
        // Accept multiple possible response shapes
        const signedXdr = sigRes.signedTransaction || sigRes.signedTx || sigRes.signedTxXdr || sigRes.signedXdr || sigRes;
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
    const res = await fetch(`/api${path}`, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
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

  function statusBadge(status) {
    const safe = escapeHtml(status);
    return '<span class="status-badge status-' + safe + '"><span class="dot"></span>' + safe + '</span>';
  }

  // ── Toast ──
  function toast(msg, type = "success") {
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    document.getElementById("toasts").appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ── Transaction Overlay ──
  function showTxOverlay(text) {
    const overlay = document.getElementById("tx-overlay");
    overlay.querySelector(".tx-text").textContent = text || "Submitting to Stellar...";
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
      html += '<div class="skeleton-card"><div class="skeleton skeleton-lg"></div><div class="skeleton skeleton-line w60"></div></div>';
    }
    return html + '</div>';
  }
  function skeletonList(n) {
    let html = '';
    for (let i = 0; i < (n || 3); i++) {
      html += '<div class="skeleton-card" style="height:64px;margin-bottom:8px"><div class="skeleton skeleton-line w80"></div></div>';
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
    try { state.stats = await api("/stats"); } catch (e) { console.error(e); }
    state.loading.stats = false;
  }
  async function loadWallets() {
    state.loading.wallets = true;
    try { state.wallets = await api("/wallets"); } catch (e) { console.error(e); }
    state.loading.wallets = false;
  }
  async function loadAgents() {
    state.loading.agents = true;
    try { state.agents = await api("/agents"); } catch (e) { console.error(e); }
    state.loading.agents = false;
  }
  async function loadJobs() {
    state.loading.jobs = true;
    try { state.jobs = await api("/jobs"); } catch (e) { console.error(e); }
    state.loading.jobs = false;
  }

  // ── Views ──

  // 1. Dashboard Overview
  async function renderDashboard() {
    setPage(
      '<div class="page-header"><div class="page-header-row">'
      + '<div><div class="page-title">Dashboard</div><div class="page-subtitle">Bear Protocol overview on Stellar Testnet</div></div>'
      + '<div class="page-badge"><span class="dot"></span>Connected</div>'
      + '</div></div>'
      + skeletonCards(4) + skeletonList(5)
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
    var statCards = '<div class="stat-grid">'
      + '<div class="stat-card">'
      + '<div class="stat-card-top"><div class="stat-label">Total Agents</div>'
      + '<div class="stat-icon blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>'
      + '</div><div class="stat-value">' + s.totalAgents + '</div></div>'
      + '<div class="stat-card">'
      + '<div class="stat-card-top"><div class="stat-label">Active Jobs</div>'
      + '<div class="stat-icon amber"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></div>'
      + '</div><div class="stat-value accent">' + s.activeJobs + '</div></div>'
      + '<div class="stat-card">'
      + '<div class="stat-card-top"><div class="stat-label">Total Escrowed</div>'
      + '<div class="stat-icon green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg></div>'
      + '</div><div class="stat-value">' + totalEscrowed.toFixed(2) + ' <span style="font-size:14px;color:var(--text-muted);font-weight:400">USDC</span></div></div>'
      + '<div class="stat-card">'
      + '<div class="stat-card-top"><div class="stat-label">Fee Rate</div>'
      + '<div class="stat-icon orange"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M20.66 8A10 10 0 0 0 16 3.34"/></svg></div>'
      + '</div><div class="stat-value">' + (s.feeBps / 100).toFixed(0) + '%</div></div>'
      + '</div>';

    // Activity feed
    var activityHtml = '';
    if (recentJobs.length === 0) {
      activityHtml = '<div class="empty-state" style="padding:48px 24px">'
        + '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></div>'
        + '<div class="empty-title">No jobs yet</div>'
        + '<div class="empty-desc">Create your first job to see activity here.</div></div>';
    } else {
      for (const j of recentJobs) {
        activityHtml += '<div class="activity-row">'
          + '<div class="activity-id">#' + escapeHtml(String(j.id)) + '</div>'
          + '<div class="activity-info">'
          + '<div class="activity-desc">' + escapeHtml(j.description || "\u2014") + '</div>'
          + '<div class="activity-meta">Client: ' + truncAddr(j.client) + '</div>'
          + '</div>'
          + '<div class="activity-right">'
          + '<div class="activity-amount">' + formatMusd(j.budget) + ' <span class="activity-unit">USDC</span></div>'
          + '<div class="activity-status">' + statusBadge(j.status) + '</div>'
          + '</div></div>';
      }
    }

    // Quick actions sidebar
    var quickActions = ''
      + '<a href="#/jobs" class="quick-action" onclick="setTimeout(function(){window.__showCreateJob()},300)">'
      + '<div class="qa-icon orange"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></div>'
      + '<div class="qa-info"><div class="qa-title">Create Job</div><div class="qa-desc">Lock USDC in escrow</div></div>'
      + '<svg class="qa-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></a>'
      + '<a href="#/agents" class="quick-action" onclick="setTimeout(function(){window.__showRegisterAgent()},300)">'
      + '<div class="qa-icon blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg></div>'
      + '<div class="qa-info"><div class="qa-title">Register Agent</div><div class="qa-desc">On-chain identity</div></div>'
      + '<svg class="qa-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></a>'
      + '<a href="#/wallet" class="quick-action">'
      + '<div class="qa-icon green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg></div>'
      + '<div class="qa-info"><div class="qa-title">View Wallets</div><div class="qa-desc">Check balances</div></div>'
      + '<svg class="qa-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></a>';

    setPage(
      '<div class="page-header"><div class="page-header-row">'
      + '<div><div class="page-title">Dashboard</div><div class="page-subtitle">Bear Protocol overview on Stellar Testnet</div></div>'
      + '<div class="page-badge"><span class="dot"></span>Connected</div>'
      + '</div></div>'
      + statCards
      + '<div class="dash-grid">'
      + '<div class="dash-panel">'
      + '<div class="dash-panel-header"><div class="dash-panel-title">Recent Activity</div><a href="#/jobs" class="dash-panel-link">View all jobs</a></div>'
      + activityHtml
      + '</div>'
      + '<div class="dash-panel">'
      + '<div class="dash-panel-header"><div class="dash-panel-title">Quick Actions</div></div>'
      + quickActions
      + '</div>'
      + '</div>'
    );
  }

  // 2. Wallets
  async function renderWallets() {
    var skeletonCount = wallet.connected ? 3 : 2;
    var skeletons = '';
    for (var si = 0; si < skeletonCount; si++) skeletons += '<div class="skeleton-card" style="height:280px"></div>';
    setPage('<div class="page-header"><div class="page-title">Wallets</div><div class="page-subtitle">Testnet accounts for buyer and seller agents</div></div>'
      + '<div class="wallet-grid">' + skeletons + '</div>');

    // Load demo wallets + optionally Freighter wallet balance
    var freighterBalance = null;
    var promises = [loadWallets()];
    if (wallet.connected) {
      promises.push(
        api("/balance/" + wallet.publicKey).then(function(b) { freighterBalance = b; }).catch(function() {})
      );
    }
    await Promise.all(promises);
    const w = state.wallets;
    if (!w) {
      setPage('<p style="color:var(--status-cancelled)">Failed to load wallets</p>');
      return;
    }

    function walletCard(label, role, data, type) {
      return '<div class="wallet-card ' + type + '">'
        + '<div class="wallet-card-header">'
        + '<div class="wallet-name">' + escapeHtml(label) + '</div>'
        + '<div class="wallet-role">' + escapeHtml(role) + '</div>'
        + '</div>'
        + '<div class="wallet-card-body">'
        + '<div class="wallet-addr" onclick="window.__copy(\'' + data.address + '\')">'
        + '<code>' + escapeHtml(data.address) + '</code>'
        + '<span class="copy-hint">Click to copy</span>'
        + '</div>'
        + '<div class="balance-row"><span class="balance-label xlm">XLM</span>'
        + '<span class="balance-value">' + parseFloat(data.xlm).toFixed(2) + '<span class="balance-unit">XLM</span></span></div>'
        + '<div class="balance-row"><span class="balance-label musd">MUSD</span>'
        + '<span class="balance-value">' + parseFloat(data.musd).toFixed(2) + '<span class="balance-unit">MUSD</span></span></div>'
        + '<div style="margin-top:18px">'
        + '<a href="https://friendbot.stellar.org?addr=' + encodeURIComponent(data.address) + '" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">Fund XLM via Friendbot</a>'
        + '</div></div></div>';
    }

    var freighterCard = '';
    if (wallet.connected && freighterBalance) {
      freighterCard = walletCard("Your Wallet", "Freighter (Connected)", freighterBalance, "freighter");
    }

    setPage(
      '<div class="page-header"><div class="page-title">Wallets</div><div class="page-subtitle">Testnet accounts for buyer and seller agents</div></div>'
      + '<div class="wallet-grid">'
      + freighterCard
      + walletCard("Buyer Wallet", "Client / Evaluator", w.buyer, "buyer")
      + walletCard("Seller Wallet", "Provider", w.seller, "seller")
      + '</div>'
    );
  }

  // 3. Jobs
  async function renderJobs() {
    setPage(
      '<div class="section-header"><div><div class="section-title">Jobs</div><div class="page-subtitle" style="margin-top:2px">Escrow-based job marketplace on Soroban</div></div>'
      + '<button class="btn btn-primary" onclick="window.__showCreateJob()">+ Create Job</button></div>'
      + skeletonList(4)
    );
    await loadJobs();
    renderJobList();
  }

  function renderJobList() {
    const jobs = state.jobs || [];
    const filters = ["All", "Funded", "Submitted", "Completed", "Cancelled"];
    const filtered = state.jobFilter === "All" ? jobs : jobs.filter(function(j) { return j.status === state.jobFilter; });

    let tabs = '<div class="filter-tabs">';
    for (const f of filters) {
      tabs += '<button class="filter-tab ' + (f === state.jobFilter ? 'active' : '') + '" onclick="window.__filterJobs(\'' + f + '\')">' + f + '</button>';
    }
    tabs += '</div>';

    let content = '';
    if (filtered.length === 0) {
      const label = state.jobFilter === "All" ? "" : state.jobFilter.toLowerCase() + " ";
      content = '<div class="empty-state">'
        + '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg></div>'
        + '<div class="empty-title">No ' + label + 'jobs</div>'
        + '<div class="empty-desc">Create your first job to see it here.</div></div>';
    } else {
      content = '<div class="job-list">';
      for (const j of filtered) {
        let actions = '';
        if (j.status === "Funded") {
          actions = '<button class="btn btn-primary btn-sm" onclick="window.__submitJob(\'' + j.id + '\')">Submit Work</button>'
            + '<button class="btn btn-danger btn-sm" onclick="window.__cancelJob(\'' + j.id + '\')">Cancel</button>';
        } else if (j.status === "Submitted") {
          actions = '<button class="btn btn-primary btn-sm" onclick="window.__completeJob(\'' + j.id + '\')">Complete (Release Funds)</button>';
        } else {
          actions = '<span style="font-size:13px;color:var(--text-dim)">Job is ' + escapeHtml(j.status.toLowerCase()) + '. No actions available.</span>';
        }

        let deliverableHtml = '';
        if (j.deliverable) {
          deliverableHtml = '<div class="detail-item" style="grid-column:1/-1">'
            + '<div class="detail-label">Deliverable</div>'
            + '<div class="detail-value">' + escapeHtml(j.deliverable) + '</div></div>';
        }

        content += '<div class="job-row" id="job-' + j.id + '">'
          + '<div class="job-summary" onclick="window.__toggleJob(\'' + j.id + '\')">'
          + '<div class="job-id">#' + escapeHtml(String(j.id)) + '</div>'
          + statusBadge(j.status)
          + '<div class="job-desc">' + escapeHtml(j.description || "\u2014") + '</div>'
          + '<div class="job-budget">' + formatMusd(j.budget) + ' <span class="unit">MUSD</span></div>'
          + '<svg class="job-expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>'
          + '</div>'
          + '<div class="job-detail">'
          + '<div class="detail-grid">'
          + '<div class="detail-item"><div class="detail-label">Client</div><div class="detail-value" style="cursor:pointer" onclick="window.__copy(\'' + j.client + '\')">' + truncAddr(j.client) + '</div></div>'
          + '<div class="detail-item"><div class="detail-label">Provider</div><div class="detail-value" style="cursor:pointer" onclick="window.__copy(\'' + j.provider + '\')">' + truncAddr(j.provider) + '</div></div>'
          + '<div class="detail-item"><div class="detail-label">Evaluator</div><div class="detail-value" style="cursor:pointer" onclick="window.__copy(\'' + j.evaluator + '\')">' + truncAddr(j.evaluator) + '</div></div>'
          + '<div class="detail-item"><div class="detail-label">Token</div><div class="detail-value" style="cursor:pointer" onclick="window.__copy(\'' + j.token + '\')">' + truncAddr(j.token) + '</div></div>'
          + deliverableHtml
          + '</div>'
          + '<div class="job-actions">' + actions + '</div>'
          + '</div></div>';
      }
      content += '</div>';
    }

    setPage(
      '<div class="section-header"><div><div class="section-title">Jobs</div><div class="page-subtitle" style="margin-top:2px">Escrow-based job marketplace on Soroban</div></div>'
      + '<button class="btn btn-primary" onclick="window.__showCreateJob()">+ Create Job</button></div>'
      + tabs + content
    );
  }

  // 4. Agents
  async function renderAgents() {
    setPage(
      '<div class="section-header"><div><div class="section-title">Agents</div><div class="page-subtitle" style="margin-top:2px">On-chain identity registry for AI agents</div></div>'
      + '<button class="btn btn-primary" onclick="window.__showRegisterAgent()">+ Register Agent</button></div>'
      + skeletonList(3)
    );

    await loadAgents();
    const agents = state.agents || [];

    let cards = '';
    if (agents.length === 0) {
      cards = '<div class="empty-state">'
        + '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>'
        + '<div class="empty-title">No agents registered</div>'
        + '<div class="empty-desc">Register your first agent to get started.</div></div>';
    } else {
      cards = '<div class="agent-grid">';
      for (const a of agents) {
        var initial = a.owner ? a.owner.charAt(0) : '?';
        cards += '<div class="agent-card">'
          + '<div class="agent-card-top">'
          + '<div class="agent-avatar">' + escapeHtml(initial) + '</div>'
          + '<div class="agent-id">Agent <span>#' + escapeHtml(String(a.id)) + '</span></div>'
          + '</div>'
          + '<div class="agent-field"><div class="agent-field-label">Owner</div>'
          + '<div class="agent-field-value" style="cursor:pointer" onclick="window.__copy(\'' + a.owner + '\')">' + truncAddr(a.owner) + '</div></div>'
          + '<div class="agent-field"><div class="agent-field-label">Metadata URI</div>'
          + '<div class="agent-field-value">' + escapeHtml(a.uri) + '</div></div>'
          + '</div>';
      }
      cards += '</div>';
    }

    setPage(
      '<div class="section-header"><div><div class="section-title">Agents</div><div class="page-subtitle" style="margin-top:2px">On-chain identity registry for AI agents</div></div>'
      + '<button class="btn btn-primary" onclick="window.__showRegisterAgent()">+ Register Agent</button></div>'
      + '<div class="stat-grid" style="margin-bottom:24px;grid-template-columns:repeat(3,1fr)">'
      + '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Registered</div>'
      + '<div class="stat-icon blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>'
      + '</div><div class="stat-value">' + agents.length + '</div></div>'
      + '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Network</div>'
      + '<div class="stat-icon green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>'
      + '</div><div class="stat-value" style="font-size:18px;color:var(--status-completed)">Testnet</div></div>'
      + '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Registry</div>'
      + '<div class="stat-icon orange"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>'
      + '</div><div class="stat-value" style="font-size:14px;font-weight:600;color:var(--text-muted);font-family:var(--mono)">ERC-8004</div></div>'
      + '</div>'
      + cards
    );
  }

  // ── Global Actions ──

  window.__copy = copyToClipboard;

  window.__toggleJob = function(id) {
    const row = document.getElementById("job-" + id);
    if (row) row.classList.toggle("expanded");
  };

  window.__filterJobs = function(filter) {
    state.jobFilter = filter;
    renderJobList();
  };

  window.__showCreateJob = function() {
    var walletField = wallet.connected
      ? '<div class="form-group"><label class="form-label">Signing Wallet</label>'
        + '<div class="form-input" style="color:var(--accent);cursor:default">' + truncAddr(wallet.publicKey) + ' (Freighter)</div></div>'
      : '<div class="form-group"><label class="form-label">Signing Wallet</label>'
        + '<select class="form-select" id="cj-wallet"><option value="buyer">Buyer (Client)</option><option value="seller">Seller</option></select></div>';
    showModal(
      '<h2 class="modal-title">Create Job</h2>'
      + walletField
      + '<div class="form-group"><label class="form-label">Description</label>'
      + '<input class="form-input" id="cj-desc" value="Dashboard test job" placeholder="Job description..."></div>'
      + '<div class="form-group"><label class="form-label">Budget (MUSD units, 7 decimals)</label>'
      + '<input class="form-input" id="cj-budget" value="10000000" placeholder="10000000 = 1 MUSD"></div>'
      + '<div class="modal-actions">'
      + '<button class="btn btn-secondary" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>'
      + '<button class="btn btn-primary" onclick="window.__doCreateJob()">Create Job</button></div>'
    );
  };

  window.__doCreateJob = async function() {
    const description = document.getElementById("cj-desc").value;
    const budget = document.getElementById("cj-budget").value;
    const walletEl = document.getElementById("cj-wallet");
    const walletVal = walletEl ? walletEl.value : "buyer";
    const overlay = document.querySelector(".modal-overlay");
    if (overlay) overlay.remove();
    showTxOverlay("Creating job on Stellar...");
    try {
      if (wallet.connected) {
        const res = await signAndSubmit("/build/createJob", { description: description, budget: budget });
        hideTxOverlay();
        toast("Job created! tx: " + (res.hash || "").slice(0, 8) + "...");
      } else {
        const res = await api("/jobs/create", { method: "POST", body: { wallet: walletVal, description: description, budget: budget } });
        hideTxOverlay();
        toast("Job #" + res.jobId + " created!");
      }
      await loadJobs();
      renderJobList();
    } catch (e) {
      hideTxOverlay();
      toast(e.message, "error");
    }
  };

  window.__submitJob = async function(id) {
    showTxOverlay("Submitting work...");
    try {
      if (wallet.connected) {
        await signAndSubmit("/build/submit", { jobId: id, deliverable: "ipfs://dashboard-delivery-" + id });
      } else {
        await api("/jobs/" + id + "/submit", { method: "POST", body: { wallet: "seller", deliverable: "ipfs://dashboard-delivery-" + id } });
      }
      hideTxOverlay();
      toast("Job #" + id + " submitted!");
      await loadJobs();
      renderJobList();
    } catch (e) {
      hideTxOverlay();
      toast(e.message, "error");
    }
  };

  window.__completeJob = async function(id) {
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
    }
  };

  window.__cancelJob = async function(id) {
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
    }
  };

  window.__showRegisterAgent = function() {
    var walletField = wallet.connected
      ? '<div class="form-group"><label class="form-label">Signing Wallet</label>'
        + '<div class="form-input" style="color:var(--accent);cursor:default">' + truncAddr(wallet.publicKey) + ' (Freighter)</div></div>'
      : '<div class="form-group"><label class="form-label">Signing Wallet</label>'
        + '<select class="form-select" id="ra-wallet"><option value="buyer">Buyer</option><option value="seller">Seller</option></select></div>';
    showModal(
      '<h2 class="modal-title">Register Agent</h2>'
      + walletField
      + '<div class="form-group"><label class="form-label">Metadata URI</label>'
      + '<input class="form-input" id="ra-uri" value="ipfs://dashboard-agent" placeholder="ipfs://..."></div>'
      + '<div class="modal-actions">'
      + '<button class="btn btn-secondary" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>'
      + '<button class="btn btn-primary" onclick="window.__doRegister()">Register</button></div>'
    );
  };

  window.__doRegister = async function() {
    const uri = document.getElementById("ra-uri").value;
    const walletEl = document.getElementById("ra-wallet");
    const walletVal = walletEl ? walletEl.value : "buyer";
    const overlay = document.querySelector(".modal-overlay");
    if (overlay) overlay.remove();
    showTxOverlay("Registering agent on Stellar...");
    try {
      if (wallet.connected) {
        const res = await signAndSubmit("/build/register", { uri: uri });
        hideTxOverlay();
        toast("Agent registered! tx: " + (res.hash || "").slice(0, 8) + "...");
      } else {
        const res = await api("/agents/register", { method: "POST", body: { wallet: walletVal, uri: uri } });
        hideTxOverlay();
        toast("Agent #" + res.agentId + " registered!");
      }
      renderAgents();
    } catch (e) {
      hideTxOverlay();
      toast(e.message, "error");
    }
  };

  // ── Router ──
  const routes = {
    "/": renderDashboard,
    "/wallet": renderWallets,
    "/jobs": renderJobs,
    "/agents": renderAgents,
  };

  function getRoute() {
    return window.location.hash.slice(1) || "/";
  }

  function navigate() {
    const route = getRoute();
    const render = routes[route] || renderDashboard;

    // Update active nav
    document.querySelectorAll(".nav-item").forEach(function(el) {
      el.classList.toggle("active", el.dataset.route === route);
    });

    // Re-trigger page transition
    const page = document.getElementById("page");
    page.style.animation = "none";
    void page.offsetHeight;
    page.style.animation = "";

    render();

    // Close mobile sidebar
    document.getElementById("sidebar").classList.remove("open");
  }

  window.addEventListener("hashchange", navigate);

  // Mobile menu
  var menuBtn = document.getElementById("menu-btn");
  if (menuBtn) {
    menuBtn.addEventListener("click", function() {
      document.getElementById("sidebar").classList.toggle("open");
    });
  }

  // ── Auto-refresh polling ──
  // Re-fetch data every 4s and re-render current view for live updates
  var pollTimer = null;
  var polling = false;

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
      }
    } catch (e) {
      // silent — don't break polling on transient errors
    }
    polling = false;
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(poll, 4000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Start polling on load, restart on visibility change
  startPolling();
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) { stopPolling(); } else { startPolling(); poll(); }
  });

  // Server-Sent Events: listen for invalidation events to refresh quickly
  if (typeof EventSource !== "undefined") {
    try {
      const es = new EventSource("/api/stream");
      es.addEventListener("invalidate", function(e) {
        try {
          const payload = JSON.parse(e.data);
          // On any invalidation, run a quick poll to refresh current view
          poll();
        } catch (err) { poll(); }
      });
      es.addEventListener("ping", function() {});
      es.onerror = function() {
        // Close noisy stream errors; polling remains as a fallback
        try { es.close(); } catch (e) {}
      };
    } catch (e) {
      // ignore SSE setup failures — polling is the primary mechanism
    }
  }

  // Initial render
  navigate();
})();
