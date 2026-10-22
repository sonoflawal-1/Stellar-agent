// Bear Dashboard — Single-page app
// Router, state store, API client, 4 views
// Note: innerHTML usage is safe here — all rendered data comes from our own
// backend API (Stellar addresses, contract state). No untrusted user input.

(() => {
  // ── Theme (dark/light) ── #461, #578, #758
  // The initial data-theme attribute is set by the inline blocking script in
  // <head> (index.html) so the very first painted frame already uses the
  // correct theme (no FOUC). Here we only wire up the toggle button, which
  // reads the current attribute set by that inline script.
  (function initThemeToggle() {
    var btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        var current = document.documentElement.getAttribute("data-theme") || "dark";
        var next = current === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("bear-theme", next);
      });
    }
    // Follow live OS theme changes until the user makes a manual choice (#832).
    if (window.matchMedia) {
      var mql = window.matchMedia("(prefers-color-scheme: dark)");
      var onSystemThemeChange = function (e) {
        try {
          var stored = localStorage.getItem("bear-theme");
          if (stored === "dark" || stored === "light") return;
        } catch (err) {}
        document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
      };
      if (mql.addEventListener) mql.addEventListener("change", onSystemThemeChange);
      else if (mql.addListener) mql.addListener(onSystemThemeChange);
    }
  })();
  // ── Network presets (#761) ──
  // Contract addresses / RPC endpoints per network. The backend exposes the
  // active network via /api/config; these presets are used for the switcher
  // UI, wallet-network mismatch warnings and mainnet safety banner.
  var NETWORK_PRESETS = {
    testnet: {
      id: "testnet",
      label: "Testnet",
      passphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      explorer: "https://stellar.expert/explorer/testnet",
      realFunds: false,
    },
    futurenet: {
      id: "futurenet",
      label: "Futurenet",
      passphrase: "Test SDF Future Network ; October 2022",
      rpcUrl: "https://rpc-futurenet.stellar.org",
      explorer: "https://stellar.expert/explorer/futurenet",
      realFunds: false,
    },
    mainnet: {
      id: "mainnet",
      label: "Mainnet",
      passphrase: "Public Global Stellar Network ; September 2015",
      rpcUrl: "https://soroban-rpc.mainnet.stellar.gateway.fm",
      explorer: "https://stellar.expert/explorer/public",
      realFunds: true,
    },
  };

  function readPersistedNetwork() {
    try {
      var saved = localStorage.getItem("bear-network");
      if (saved && NETWORK_PRESETS[saved]) return saved;
    } catch (e) {}
    return "testnet";
  }

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
    jobPage: 1,
    jobPageSize: 24,
    jobTotal: 0,
    jobHasNext: false,
    jobDateFrom: "",
    jobDateTo: "",
    agentSearch: "",   // #583 — agent name/description/tag filter
    agentPage: 1,
    agentPageSize: 24,
    agentTotal: 0,
    txPending: false,
    // #755 — multi-tag / sort agent search state
    agentFilters: { query: "", tags: [], sort: "Most Active" },
    // #756 — sidebar wallet balance widget
    walletBalances: null,
    faucetPending: false,
  };

  // ── Debounce helper ──
  function debounce(fn, ms) {
    var timer;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  // ── Web Notifications (#754) ──
  // Opt-in desktop notifications for background job status changes.
  // Permission is requested at most once; a denial is remembered and never
  // re-prompted.  All calls are guarded for browsers without the API.
  var NOTIFY_PREF_KEY = "bear-notifications-enabled";
  var NOTIFY_DENIED_KEY = "bear-notifications-denied";
  var notifications = {
    supported: typeof window !== "undefined" && "Notification" in window,
    enabled: false,
  };
  try {
    notifications.enabled = localStorage.getItem(NOTIFY_PREF_KEY) === "1";
  } catch (e) {}

  function notificationsDenied() {
    try {
      return localStorage.getItem(NOTIFY_DENIED_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function setNotificationPref(enabled) {
    notifications.enabled = !!enabled;
    try {
      localStorage.setItem(NOTIFY_PREF_KEY, enabled ? "1" : "0");
    } catch (e) {}
    if (!enabled) return;
    if (!notifications.supported) {
      toast("Desktop notifications are not supported in this browser", "error");
      return;
    }
    if (Notification.permission === "granted") return;
    if (Notification.permission === "denied" || notificationsDenied()) {
      toast("Notifications are blocked — enable them in your browser settings", "error");
      return;
    }
    // Request permission exactly once on opt-in.
    try {
      Notification.requestPermission().then(function (perm) {
        if (perm === "denied") {
          try { localStorage.setItem(NOTIFY_DENIED_KEY, "1"); } catch (e) {}
          notifications.enabled = false;
          try { localStorage.setItem(NOTIFY_PREF_KEY, "0"); } catch (e) {}
          toast("Notifications were denied by the browser", "error");
        } else if (perm === "granted") {
          toast("Desktop notifications enabled");
        }
        syncNotificationToggle();
      }).catch(function () {});
    } catch (e) {
      // Older Safari uses the callback form
      try {
        Notification.requestPermission(function (perm) {
          if (perm === "denied") {
            try { localStorage.setItem(NOTIFY_DENIED_KEY, "1"); } catch (e) {}
            notifications.enabled = false;
          }
          syncNotificationToggle();
        });
      } catch (e2) {}
    }
  }

  function syncNotificationToggle() {
    var toggle = document.getElementById("notifications-toggle");
    if (toggle) toggle.checked = !!notifications.enabled;
    var status = document.getElementById("notifications-status");
    if (status) {
      if (!notifications.supported) status.textContent = "Not supported in this browser";
      else if (Notification.permission === "denied") status.textContent = "Blocked by browser";
      else if (notifications.enabled) status.textContent = "Enabled";
      else status.textContent = "Disabled";
    }
  }

  // Opens the jobs view and expands the specific job row.
  function focusJob(jobId) {
    try { window.focus(); } catch (e) {}
    var target = "#/jobs";
    if (getRoute() !== "/jobs") {
      window.location.hash = target;
    }
    // Wait for the jobs view to render, then expand the row.
    var attempts = 0;
    function tryExpand() {
      var row = document.getElementById("job-" + jobId);
      if (row) {
        if (!row.classList.contains("expanded")) {
          row.classList.add("expanded");
          loadJobTimeline(jobId);
        }
        try { row.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
        return;
      }
      if (attempts++ < 20) setTimeout(tryExpand, 250);
    }
    setTimeout(tryExpand, 300);
  }

  var NOTIFY_STATE_LABELS = {
    Funded: "has been funded",
    Submitted: "deliverable was submitted",
    Completed: "was approved and funds released",
    Approved: "was approved",
  };

  function notifyJobEvent(job, newStatus) {
    if (!notifications.enabled) return;
    if (!notifications.supported) return;
    if (Notification.permission !== "granted") return;
    var label = NOTIFY_STATE_LABELS[newStatus];
    if (!label) return;
    var title = "Bear Job #" + job.id + " " + newStatus;
    var body = "Job #" + job.id + " " + label + (job.description ? ": " + job.description : "");
    try {
      var n = new Notification(title, {
        body: body,
        tag: "bear-job-" + job.id + "-" + newStatus,
      });
      n.onclick = function () {
        try { window.focus(); } catch (e) {}
        focusJob(job.id);
        try { n.close(); } catch (e) {}
      };
    } catch (e) {
      // Some browsers require a service worker; degrade silently.
    }
  }

  // Compares the previous job snapshot against the freshly loaded one and
  // fires notifications for transitions involving the connected wallet.
  function detectJobTransitions(prevJobs, nextJobs) {
    if (!notifications.enabled || !wallet.connected || !wallet.publicKey) return;
    if (!Array.isArray(prevJobs) || !Array.isArray(nextJobs)) return;
    var prevById = {};
    for (var i = 0; i < prevJobs.length; i++) prevById[String(prevJobs[i].id)] = prevJobs[i];
    var me = wallet.publicKey;
    for (var k = 0; k < nextJobs.length; k++) {
      var job = nextJobs[k];
      var prev = prevById[String(job.id)];
      var oldStatus = prev ? prev.status : null;
      if (oldStatus === job.status) continue;
      var involvesMe = job.client === me || job.provider === me || job.evaluator === me;
      if (!involvesMe) continue;
      notifyJobEvent(job, job.status);
    }
  }

  window.__setNotificationsEnabled = function (enabled) {
    setNotificationPref(enabled);
  };

  // ── Stellar Wallets Kit integration ──
  const wallet = {
    connected: false,
    publicKey: null,
    network: null, // 'testnet' | 'mainnet' | null
    provider: null, // 'freighter' | 'xbull' | 'albedo' | 'lobstr' | null
  };
  window.__walletState = wallet;

  // Target network for the dashboard (Testnet). Used for mismatch prompts.
  var TARGET_NETWORK = "testnet";
  var TARGET_PASSPHRASE = "Test SDF Network ; September 2015";
  var WALLET_STORAGE_KEY = "bear-wallet-provider";

  // Provider metadata: brand icons + extension detection (#743)
  var WALLET_PROVIDERS = [
    {
      id: "freighter",
      name: "Freighter",
      detect: function () {
        return Boolean(window.freighterApi || window.freighter);
      },
      icon:
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
        '<path d="M3 12h18M12 3v18"/><circle cx="12" cy="12" r="9"/></svg>',
    },
    {
      id: "xbull",
      name: "xBull",
      detect: function () {
        return Boolean(window.xBullSDK || (window.xBull && window.xBull.sign));
      },
      icon:
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
        '<path d="M4 4l16 16M20 4L4 20"/></svg>',
    },
    {
      id: "albedo",
      name: "Albedo",
      detect: function () {
        return Boolean(window.albedo);
      },
      icon:
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18"/></svg>',
    },
    {
      id: "lobstr",
      name: "Lobstr",
      detect: function () {
        return Boolean(window.lobstr || window.lobstrApi);
      },
      icon:
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
        '<path d="M4 14c0-4 3-8 8-8s8 4 8 8-3 6-8 6-8-2-8-6z"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/></svg>',
    },
  ];

  function providerById(id) {
    for (var i = 0; i < WALLET_PROVIDERS.length; i++) {
      if (WALLET_PROVIDERS[i].id === id) return WALLET_PROVIDERS[i];
    }
    return null;
  }

  // Initialize Stellar Wallets Kit (loaded via UMD script tag)
  var swkReady = false;
  var StellarWalletsKit, KitEventType, SwkAppDarkTheme, defaultModules;
  var swkModules = null;
  if (window.MyWalletKit) {
    StellarWalletsKit = window.MyWalletKit.StellarWalletsKit;
    KitEventType = window.MyWalletKit.KitEventType;
    SwkAppDarkTheme = window.MyWalletKit.SwkAppDarkTheme;
    defaultModules = window.MyWalletKit.defaultModules;
    // Configure explicit modules for Freighter, xBull, Albedo, Lobstr (#743)
    try {
      var mk = window.MyWalletKit;
      var modules = [];
      if (mk.FreighterModule) modules.push(new mk.FreighterModule());
      if (mk.XbullModule) modules.push(new mk.XbullModule());
      if (mk.AlbedoModule) modules.push(new mk.AlbedoModule());
      if (mk.LobstrModule) modules.push(new mk.LobstrModule());
      swkModules = modules.length ? modules : defaultModules();
    } catch (e) {
      swkModules = defaultModules();
    }
    StellarWalletsKit.init({
      theme: SwkAppDarkTheme,
      modules: swkModules,
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
    // Account switching / network mismatch events (#743)
    try {
      if (KitEventType.ACCOUNT_CHANGED) {
        StellarWalletsKit.on(KitEventType.ACCOUNT_CHANGED, function (event) {
          var addr =
            event.payload &&
            (event.payload.address ||
              (event.payload.accounts &&
                event.payload.accounts[0] &&
                event.payload.accounts[0].address));
          if (addr && addr.length > 10) handleAccountChanged(addr);
        });
      }
      if (KitEventType.NETWORK_CHANGED) {
        StellarWalletsKit.on(KitEventType.NETWORK_CHANGED, function (event) {
          var net = event.payload && (event.payload.network || event.payload.networkPassphrase);
          handleNetworkChanged(net);
        });
      }
    } catch (e) {}
    swkReady = true;
  }

  // Track previous public key for account change detection (#575)
  var previousPublicKey = null;

  function normalizeNetwork(n) {
    var s = String(n || "").toLowerCase();
    if (s.includes("test")) return "testnet";
    if (s.includes("pub") || s.includes("main")) return "mainnet";
    return null;
  }

  // Handle account switching: clear session, update state (#743)
  function handleAccountChanged(newPk) {
    if (previousPublicKey && previousPublicKey !== newPk) {
      toast("Account changed to " + truncAddr(newPk), "info");
      var token = window.__sessionToken;
      if (token) {
        fetch("/api/auth/logout", {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
        }).catch(function () {});
        window.__sessionToken = null;
      }
    }
    wallet.publicKey = newPk;
    previousPublicKey = newPk;
    updateWalletUI();
  }

  // Handle network changes: prompt on mismatch (#743)
  function handleNetworkChanged(n) {
    var net = normalizeNetwork(n);
    wallet.network = net;
    updateWalletUI();
    if (net && net !== TARGET_NETWORK) {
      showNetworkMismatchPrompt(net);
    }
  }

  function showNetworkMismatchPrompt(net) {
    var overlay = showModal(
      '<h2 class="modal-title">Network Mismatch</h2>' +
        '<p style="color:var(--text-muted);margin-bottom:16px">Your wallet is connected to <strong>' +
        escapeHtml(net === "mainnet" ? "Mainnet" : net) +
        "</strong> but this dashboard targets <strong>Testnet</strong>. " +
        "Signing is blocked on Mainnet to avoid real transactions.</p>" +
        '<div class="modal-actions">' +
        '<button class="btn btn-secondary" onclick="this.closest(\'.modal-overlay\').remove()">Dismiss</button>' +
        '<button class="btn btn-primary" onclick="this.closest(\'.modal-overlay\').remove();window.__openWalletModal()">Switch Wallet</button>' +
        "</div>",
    );
    return overlay;
  }

  // Persist selected provider for auto-reconnection (#743)
  function persistProvider(id) {
    try {
      if (id) localStorage.setItem(WALLET_STORAGE_KEY, id);
      else localStorage.removeItem(WALLET_STORAGE_KEY);
    } catch (e) {}
  }
  function getPersistedProvider() {
    try {
      return localStorage.getItem(WALLET_STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  // Responsive wallet selector modal with brand icons + installed detection (#743)
  window.__openWalletModal = function () {
    var cards = "";
    for (var i = 0; i < WALLET_PROVIDERS.length; i++) {
      var p = WALLET_PROVIDERS[i];
      var installed = false;
      try {
        installed = p.detect();
      } catch (e) {}
      cards +=
        '<button type="button" class="wallet-provider-card" data-provider="' +
        escapeAttr(p.id) +
        '" onclick="window.__selectWalletProvider(\'' +
        p.id +
        "')\" aria-label=\"Connect with " +
        escapeAttr(p.name) +
        '">' +
        '<span class="wallet-provider-icon">' +
        p.icon +
        "</span>" +
        '<span class="wallet-provider-name">' +
        escapeHtml(p.name) +
        "</span>" +
        '<span class="wallet-provider-status ' +
        (installed ? "installed" : "not-installed") +
        '">' +
        (installed ? "Detected" : "Not installed") +
        "</span>" +
        "</button>";
    }
    showModal(
      '<h2 class="modal-title">Connect a Wallet</h2>' +
        '<p style="color:var(--text-muted);margin-bottom:16px">Choose a Stellar wallet provider to connect.</p>' +
        '<div class="wallet-provider-grid">' +
        cards +
        "</div>" +
        '<div class="modal-actions">' +
        '<button class="btn btn-secondary" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>' +
        "</div>",
    );
  };

  // Connect using the selected provider via Stellar Wallets Kit (#743)
  window.__selectWalletProvider = async function (id) {
    var overlay = document.querySelector(".modal-overlay");
    if (overlay) overlay.remove();
    if (!swkReady) {
      toast("Stellar Wallets Kit not loaded", "error");
      return;
    }
    try {
      if (typeof StellarWalletsKit.setWallet === "function") {
        StellarWalletsKit.setWallet(id);
      }
      var res = await StellarWalletsKit.getAddress();
      var addr = res && res.address;
      if (!addr || addr.length <= 10) throw new Error("No address returned by wallet");
      wallet.connected = true;
      wallet.publicKey = addr;
      wallet.provider = id;
      previousPublicKey = addr;
      persistProvider(id);
      updateWalletUI();
      toast("Connected with " + (providerById(id) ? providerById(id).name : id));
      // Check network after connect
      try {
        if (typeof StellarWalletsKit.getNetwork === "function") {
          var netRes = await StellarWalletsKit.getNetwork();
          handleNetworkChanged(netRes && (netRes.network || netRes.networkPassphrase));
        }
      } catch (e) {}
    } catch (e) {
      notifyError(e);
    }
  };

  // Auto-reconnect to the persisted provider on load (#743)
  async function autoReconnect() {
    var saved = getPersistedProvider();
    if (!saved || !swkReady) return;
    var p = providerById(saved);
    if (!p) return;
    var installed = false;
    try {
      installed = p.detect();
    } catch (e) {}
    if (!installed) return;
    try {
      if (typeof StellarWalletsKit.setWallet === "function") {
        StellarWalletsKit.setWallet(saved);
      }
      var res = await StellarWalletsKit.getAddress();
      var addr = res && res.address;
      if (!addr || addr.length <= 10) return;
      wallet.connected = true;
      wallet.publicKey = addr;
      wallet.provider = saved;
      previousPublicKey = addr;
      updateWalletUI();
    } catch (e) {
      // Silent — user can connect manually
    }
  }
  autoReconnect();

  // Periodic poll for account changes (#575)
  async function checkAccountChange() {
    if (!wallet.connected) return;
    try {
      var currentPk = null;
      if (swkReady && StellarWalletsKit && typeof StellarWalletsKit.getAddress === "function") {
        try {
          var res = await StellarWalletsKit.getAddress();
          currentPk = res && res.address;
        } catch (e) {}
      }
      if (!currentPk || currentPk.length <= 10) {
        const api = window.freighterApi || window.freighter;
        if (api && typeof api.getPublicKey === "function") {
          currentPk = await api.getPublicKey();
        }
      }
      if (!currentPk || currentPk.length <= 10) return;
      if (previousPublicKey && previousPublicKey !== currentPk) {
        toast("Account changed to " + truncAddr(currentPk), "info");
        // Clear session token
        var token = window.__sessionToken;
        if (token) {
          safeFetch("/api/auth/logout", {
            method: "POST",
            headers: { Authorization: "Bearer " + token },
          }, { _silent: true }).catch(function () {});
          window.__sessionToken = null;
        }
        // Update wallet state
        wallet.publicKey = currentPk;
        updateWalletUI();
      }
      previousPublicKey = currentPk;
    } catch (e) {
      // ignore
    }
  }

  // Poll for account changes every 3 seconds
  setInterval(checkAccountChange, 3000);

  function disconnectWallet() {
    wallet.connected = false;
    wallet.publicKey = null;
    wallet.network = null;
    wallet.provider = null;
    previousPublicKey = null; // Clear account change tracking (#575)
    persistProvider(null);
    // Clear all cached state so the next session starts fresh
    state.stats = null;
    state.wallets = null;
    state.agents = null;
    state.jobs = null;
    state.history = null;
    // Invalidate server-side session token if present
    var token = window.__sessionToken;
    if (token) {
      safeFetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      }, { _silent: true }).catch(function () {});
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

  // Reflect the active network in the sidebar badge. When no wallet is
  // connected we fall back to the network the dashboard targets by default.
  function renderNetworkBadge() {
    var nb = document.getElementById("network-badge");
    if (!nb) return;
    var net = (wallet && wallet.connected && wallet.network) || TARGET_NETWORK;
    var label =
      net === "mainnet"
        ? "Stellar Mainnet"
        : net === "testnet"
          ? "Stellar Testnet"
          : "Unknown Network";
    nb.innerHTML = '<span class="badge-dot"></span>' + label;
  }

  function updateWalletUI() {
    var connectedEl = document.getElementById("wallet-connected");
    var modeLabel = document.getElementById("wallet-mode-label");
    var btnWrapper = document.getElementById("swk-button-wrapper");
    // #756 — refresh the sidebar balance widget whenever wallet state changes
    try { refreshWalletWidget(); } catch (e) {}
    if (wallet.connected && wallet.publicKey) {
      if (connectedEl) connectedEl.style.display = "flex";
      var addrDisplay = document.getElementById("wallet-addr-display");
      if (addrDisplay) {
        addrDisplay.title = wallet.publicKey;
        addrDisplay.innerHTML =
          '<span id="wallet-addr-text">' +
          escapeHtml(truncAddr(wallet.publicKey)) +
          "</span>" +
          copyBtn(wallet.publicKey, "wallet public key");
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
    if (wallet.network === "mainnet") {
      throw new Error(
        "Wallet is on Mainnet — dashboard blocks mainnet signing to avoid real transactions",
      );
    }
    // 1. Build unsigned tx on server
    var buildRes = await api(buildEndpoint, {
      method: "POST",
      body: { publicKey: wallet.publicKey, ...params },
    });
    // 2. Sign with Stellar Wallets Kit (multi-wallet, #743)
    if (!swkReady) throw new Error("Stellar Wallets Kit not loaded");
    var addressResult = await StellarWalletsKit.getAddress();
    var signResult = await StellarWalletsKit.signTransaction(buildRes.xdr, {
      networkPassphrase: TARGET_PASSPHRASE,
      address: addressResult.address,
    });
    var signedXdr =
      signResult.signedTxXdr ||
      signResult.signedTransaction ||
      signResult.signedTx ||
      signResult.signedXdr ||
      signResult;
    return await apiClientSubmit(signedXdr);
  }

  async function apiClientSubmit(signedXdr) {
    return await api("/submit", {
      method: "POST",
      body: { signedXdr: signedXdr },
    });
  }

  // Expose wallet functions globally
  window.__disconnectWallet = disconnectWallet;

  // ── Sidebar Wallet Balance Widget (#756) ──
  // Fetches XLM via Horizon and USDC via the backend Soroban token balance
  // endpoint, renders them in the sidebar, and offers a one-click Friendbot
  // faucet for testnet wallets.  Hidden entirely on Mainnet.
  var HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
  var FRIENDBOT_URL = "https://friendbot.stellar.org";

  function isMainnet() {
    return wallet.network === "mainnet";
  }

  async function fetchXlmBalance(publicKey) {
    try {
      var res = await fetch(HORIZON_TESTNET + "/accounts/" + encodeURIComponent(publicKey));
      if (!res.ok) return null;
      var data = await res.json();
      var balances = (data && data.balances) || [];
      for (var i = 0; i < balances.length; i++) {
        if (balances[i].asset_type === "native") return parseFloat(balances[i].balance);
      }
      return 0;
    } catch (e) {
      return null;
    }
  }

  async function fetchUsdcBalance(publicKey) {
    try {
      var data = await api("/balance/" + encodeURIComponent(publicKey), { _silent: true });
      if (data && data.usdc != null) return parseFloat(data.usdc);
      if (data && data.musd != null) return parseFloat(data.musd);
      return null;
    } catch (e) {
      return null;
    }
  }

  async function refreshWalletWidget() {
    var widget = document.getElementById("wallet-balance-widget");
    if (!widget) return;
    if (!wallet.connected || !wallet.publicKey || isMainnet()) {
      widget.style.display = "none";
      return;
    }
    widget.style.display = "";
    var xlmEl = document.getElementById("wallet-xlm-balance");
    var usdcEl = document.getElementById("wallet-usdc-balance");
    if (xlmEl) xlmEl.innerHTML = '<span class="skeleton skeleton-balance"></span>';
    if (usdcEl) usdcEl.innerHTML = '<span class="skeleton skeleton-balance"></span>';
    var results = await Promise.all([
      fetchXlmBalance(wallet.publicKey),
      fetchUsdcBalance(wallet.publicKey),
    ]);
    var xlm = results[0];
    var usdc = results[1];
    state.walletBalances = { xlm: xlm, usdc: usdc };
    if (xlmEl) xlmEl.textContent = xlm == null ? "—" : xlm.toFixed(2);
    if (usdcEl) usdcEl.textContent = usdc == null ? "—" : usdc.toFixed(2);
  }

  window.__fundViaFaucet = async function () {
    if (state.faucetPending) return;
    if (!wallet.connected || !wallet.publicKey) {
      toast("Connect a wallet first", "error");
      return;
    }
    if (isMainnet()) {
      toast("Friendbot is only available on Testnet", "error");
      return;
    }
    state.faucetPending = true;
    var btn = document.getElementById("faucet-btn");
    var originalHtml = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Funding…';
    }
    try {
      var res = await fetch(FRIENDBOT_URL + "/?addr=" + encodeURIComponent(wallet.publicKey));
      if (!res.ok) throw new Error("Friendbot request failed (" + res.status + ")");
      toast("Wallet funded with 10,000 testnet XLM");
      await refreshWalletWidget();
    } catch (e) {
      notifyError(e);
    } finally {
      state.faucetPending = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
  };

  /**
   * Returns a display label for the currently connected wallet.
   * Prefers the wallet name exposed by Stellar Wallets Kit; falls back to
   * "Freighter" when only the legacy freighterApi is present, and "Wallet"
   * as a generic catch-all.  Closes #584 (hardcoded "(Freighter)" label).
   */
  function connectedWalletLabel() {
    if (swkReady && StellarWalletsKit && typeof StellarWalletsKit.getWalletName === "function") {
      try {
        var name = StellarWalletsKit.getWalletName();
        if (name && name.length > 0) return name;
      } catch (e) {}
    }
    if (wallet.provider) {
      var p = providerById(wallet.provider);
      if (p) return p.name;
    }
    return "Wallet";
  }

  // ── Reliability Layer (#750) ──
  // Connectivity detection, global error boundaries, RPC healthcheck and
  // automatic recovery.  All state lives on the module-level `reliability`
  // object so other modules (polling, api client) can consult it.
  var reliability = {
    online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    rpcHealthy: true,
    lastHealthcheck: 0,
    banner: null,
    errorView: null,
  };
  window.__reliability = reliability;

  function ensureBanner() {
    if (reliability.banner && document.body.contains(reliability.banner)) {
      return reliability.banner;
    }
    var el = document.getElementById("offline-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "offline-banner";
      el.className = "offline-banner";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "assertive");
      el.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:9999;display:none;" +
        "padding:10px 16px;text-align:center;font-size:13px;font-weight:600;" +
        "background:#b45309;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35)";
      el.textContent = "Network Disconnected — Retrying connection to Stellar RPC...";
      document.body.appendChild(el);
    }
    reliability.banner = el;
    return el;
  }

  function showOfflineBanner() {
    var el = ensureBanner();
    el.style.display = "block";
  }
  function hideOfflineBanner() {
    var el = ensureBanner();
    el.style.display = "none";
  }

  // Renders an actionable "Something went wrong" view in place of the page.
  function renderErrorView(message, retryFn) {
    var page = document.getElementById("page");
    if (!page) return;
    var safeMsg = escapeHtml(message || "An unexpected error occurred.");
    page.innerHTML =
      '<div class="error-view" role="alert" style="max-width:560px;margin:64px auto;text-align:center;padding:32px">' +
      '<div style="font-size:40px;margin-bottom:12px">⚠️</div>' +
      '<h2 style="margin:0 0 8px;font-size:20px">Something went wrong</h2>' +
      '<p style="color:var(--text-muted);margin:0 0 20px;line-height:1.5">' + safeMsg + "</p>" +
      '<button type="button" class="btn btn-primary" id="error-retry-btn">Retry</button>' +
      "</div>";
    reliability.errorView = message || true;
    var btn = document.getElementById("error-retry-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        reliability.errorView = null;
        if (typeof retryFn === "function") {
          try {
            retryFn();
          } catch (e) {
            renderErrorView(errorText(e), retryFn);
          }
        } else {
          navigate();
        }
      });
    }
  }

  // safeFetch wraps every network call in try/catch.  On failure it renders
  // the actionable error view (unless the caller opted out) and re-throws so
  // callers can still handle the error themselves.
  async function safeFetch(url, init, opts) {
    var options = opts || {};
    try {
      return await fetch(url, init);
    } catch (err) {
      if (!options._silent) {
        renderErrorView(
          "We could not reach the Bear backend. Check your connection and try again.",
          function () {
            navigate();
          },
        );
      }
      throw err;
    }
  }

  // Startup / reconnect RPC healthcheck.  Probes the backend health endpoint
  // which in turn verifies the Stellar RPC node is reachable.
  async function runHealthcheck() {
    reliability.lastHealthcheck = Date.now();
    try {
      var res = await fetch("/api/health", { method: "GET" });
      reliability.rpcHealthy = res.ok;
      return res.ok;
    } catch (e) {
      reliability.rpcHealthy = false;
      return false;
    }
  }

  // Called when connectivity is restored: re-probe the RPC node, resume
  // polling and refresh the current view's data.
  async function handleReconnect() {
    reliability.online = true;
    hideOfflineBanner();
    var healthy = await runHealthcheck();
    reliability.rpcHealthy = healthy;
    if (typeof startPolling === "function") startPolling();
    if (typeof poll === "function") {
      try {
        await poll();
      } catch (e) {}
    }
    if (healthy) toast("Connection restored", "success", 2500);
  }

  function handleOffline() {
    reliability.online = false;
    showOfflineBanner();
    if (typeof stopPolling === "function") stopPolling();
  }

  window.addEventListener("online", function () {
    handleReconnect();
  });
  window.addEventListener("offline", function () {
    handleOffline();
  });

  // Global error boundaries — render the error view instead of a blank page.
  window.addEventListener("error", function (event) {
    // Ignore resource load errors (no message) and errors already handled.
    if (!event || !event.message) return;
    renderErrorView(event.message, function () {
      navigate();
    });
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    var msg = reason && reason.message ? reason.message : errorText(reason);
    // Network errors already surface via the offline banner / api client.
    if (/network error|failed to fetch|load failed/i.test(String(msg))) return;
    renderErrorView(msg || "An unexpected error occurred.", function () {
      navigate();
    });
  });

  // ── API Client ──
  async function api(path, opts = {}) {
    const headers = opts.body ? { "Content-Type": "application/json" } : {};
    if (window.__sessionToken) headers.Authorization = "Bearer " + window.__sessionToken;
    // #761 — tell the backend which network the dashboard is configured for
    headers["X-Bear-Network"] = state.network || "testnet";
    let res;
    try {
      res = await safeFetch(`/api${path}`, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }, { _silent: opts._silent });
    } catch (networkErr) {
      var networkMsg = "Network error — could not reach the server";
      var networkError = new Error(networkMsg);
      if (!opts._silent) notifyError(networkError);
      throw networkError;
    }
    var responseText = "";
    try {
      responseText = await res.text();
    } catch (readError) {
      var readErrorMessage = "The server response could not be read.";
      var readResponseError = new Error(readErrorMessage);
      readResponseError.technicalDetails = res.status + " " + res.statusText;
      if (!opts._silent) notifyError(readResponseError);
      throw readResponseError;
    }
    var data;
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        var responseMsg = "The server returned an invalid response.";
        var responseError = new Error(responseMsg);
        responseError.technicalDetails = res.status + " " + res.statusText + (responseText ? "\n" + responseText : "");
        if (!opts._silent) notifyError(responseError);
        throw responseError;
      }
    }
    if (!res.ok) {
      var rawError = data && data.error ? data.error : responseText || "Request failed (" + res.status + ")";
      var apiError = new Error(formatSorobanError(rawError));
      apiError.technicalDetails = responseText || getTechnicalDetails(rawError);
      if (!opts._silent) notifyError(apiError);
      throw apiError;
    }
    return data == null ? {} : data;
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
    if (!swkReady) throw new Error("Stellar Wallet Kit not loaded");
    const addressResult = await StellarWalletsKit.getAddress();
    const result = await StellarWalletsKit.signTransaction(txXdr, {
      networkPassphrase: TARGET_PASSPHRASE,
      address: addressResult.address,
    });
    return (
      result.signedTxXdr ||
      result.signedTransaction ||
      result.signedTx ||
      result.signedXdr ||
      result
    );
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

  function escapeAttr(str) {
    return escapeHtml(String(str == null ? "" : str))
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  // ── Optimistic UI helpers (#744) ──
  // Tracks in-flight escrow actions to guard against double submission.
  var inFlightActions = Object.create(null);

  function isActionInFlight(key) {
    return Boolean(inFlightActions[key]);
  }

  function beginOptimisticAction(key, opts) {
    if (inFlightActions[key]) return false;
    inFlightActions[key] = true;
    opts = opts || {};
    // Immediately disable buttons and show pending badge within 50ms
    var row = opts.jobId != null ? document.getElementById("job-" + opts.jobId) : null;
    if (row) {
      row.classList.add("job-pending");
      var buttons = row.querySelectorAll(".job-actions button");
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = true;
        buttons[i].classList.add("btn-pending");
      }
      var summary = row.querySelector(".job-summary");
      if (summary && !summary.querySelector(".pending-badge")) {
        var badge = document.createElement("span");
        badge.className = "pending-badge";
        badge.setAttribute("role", "status");
        badge.textContent = "In-Flight / Pending";
        summary.appendChild(badge);
      }
    }
    // Non-intrusive progress toast
    showProgressToast(opts.label || "Submitting to Stellar…", opts.expertUrl);
    return true;
  }

  function endOptimisticAction(key, success, opts) {
    delete inFlightActions[key];
    opts = opts || {};
    var row = opts.jobId != null ? document.getElementById("job-" + opts.jobId) : null;
    if (row) {
      row.classList.remove("job-pending");
      var buttons = row.querySelectorAll(".job-actions button");
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = false;
        buttons[i].classList.remove("btn-pending");
      }
      var badge = row.querySelector(".pending-badge");
      if (badge) badge.remove();
    }
    dismissProgressToast();
  }

  var progressToastEl = null;
  function showProgressToast(text, expertUrl) {
    dismissProgressToast();
    if (!container) container = document.getElementById("toasts");
    if (!container) return;
    var el = document.createElement("div");
    el.className = "toast progress";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    var spinner = document.createElement("span");
    spinner.className = "toast-spinner";
    el.appendChild(spinner);
    var msg = document.createElement("span");
    msg.textContent = text;
    el.appendChild(msg);
    if (expertUrl) {
      var link = document.createElement("a");
      link.href = expertUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "toast-link";
      link.textContent = "View on Stellar Expert ↗";
      el.appendChild(link);
    }
    container.appendChild(el);
    progressToastEl = el;
  }
  function dismissProgressToast() {
    if (progressToastEl && progressToastEl.parentNode) {
      progressToastEl.parentNode.removeChild(progressToastEl);
    }
    progressToastEl = null;
  }

  function stellarExpertUrl(hash) {
    if (!hash) return null;
    return "https://stellar.expert/explorer/testnet/tx/" + encodeURIComponent(hash);
  }

  // ── Job lifecycle stepper (#745) ──
  // Visualizes Created -> Funded -> Submitted -> Evaluated -> Settled with
  // branched Disputed / Cancelled paths. Accessible via ARIA attributes.
  var LIFECYCLE_STEPS = ["Created", "Funded", "Submitted", "Evaluated", "Settled"];

  function lifecycleIndexForStatus(status) {
    switch (status) {
      case "Open":
        return 0;
      case "Funded":
        return 1;
      case "Submitted":
        return 2;
      case "Completed":
        return 4;
      case "Disputed":
        return 2;
      case "Cancelled":
      case "Rejected":
        return -1;
      default:
        return 0;
    }
  }

  function lifecycleRoleHint(status) {
    switch (status) {
      case "Open":
        return "Waiting on Client to fund escrow";
      case "Funded":
        return "Waiting on Provider to submit work";
      case "Submitted":
        return "Waiting on Evaluator Approval";
      case "Completed":
        return "Settled — funds released to Provider";
      case "Disputed":
        return "Disputed — awaiting Evaluator resolution";
      case "Cancelled":
        return "Cancelled — funds refunded to Client";
      case "Rejected":
        return "Rejected — deliverable not accepted";
      default:
        return "";
    }
  }

  function renderLifecycleStepper(job) {
    if (!job) return "";
    var status = job.status || "Open";
    var activeIdx = lifecycleIndexForStatus(status);
    var branched = status === "Disputed" || status === "Cancelled" || status === "Rejected";

    var stepsHtml = "";
    for (var i = 0; i < LIFECYCLE_STEPS.length; i++) {
      var stepName = LIFECYCLE_STEPS[i];
      var isComplete = !branched && i < activeIdx;
      var isActive = !branched && i === activeIdx;
      var cls = "lifecycle-step" + (isComplete ? " complete" : "") + (isActive ? " active" : "");
      var tip = stepName;
      if (isComplete) {
        tip = stepName + " — completed";
        if (job.created_at && i === 0) {
          tip += " · " + new Date(Number(job.created_at) * 1000).toLocaleString();
        }
      }
      stepsHtml +=
        '<li class="' + cls + '" aria-current="' + (isActive ? "step" : "false") + '">' +
        '<span class="lifecycle-dot" aria-hidden="true"></span>' +
        '<span class="lifecycle-label" title="' + escapeAttr(tip) + '">' + escapeHtml(stepName) + "</span>" +
        "</li>";
      if (i < LIFECYCLE_STEPS.length - 1) {
        var connCls = "lifecycle-connector" + (isComplete ? " complete" : "");
        stepsHtml += '<li class="' + connCls + '" aria-hidden="true"></li>';
      }
    }

    var branchHtml = "";
    if (branched) {
      branchHtml =
        '<div class="lifecycle-branch" role="note">' +
        '<span class="lifecycle-branch-badge status-' + escapeHtml(status) + '">' +
        escapeHtml(status) +
        "</span>" +
        '<span class="lifecycle-branch-hint">' + escapeHtml(lifecycleRoleHint(status)) + "</span>" +
        "</div>";
    }

    var roleHint = lifecycleRoleHint(status);
    return (
      '<div class="lifecycle-stepper" role="group" aria-label="Job lifecycle: ' +
      escapeAttr(roleHint) +
      '">' +
      '<ol class="lifecycle-track">' + stepsHtml + "</ol>" +
      (roleHint && !branched
        ? '<div class="lifecycle-role" role="status">' + escapeHtml(roleHint) + "</div>"
        : "") +
      branchHtml +
      "</div>"
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
  // ── Toast container — resolved from DOM once on first call ──
  var container = document.getElementById("toasts");

  function toast(msg, type = "success", duration = null, details = "") {
    if (!container) container = document.getElementById("toasts");
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", type === "error" ? "assertive" : "polite");

    var msgSpan = document.createElement("span");
    msgSpan.textContent = msg;
    el.appendChild(msgSpan);

    if (details) {
      var detailsEl = document.createElement("details");
      detailsEl.className = "toast-details";
      var detailsSummary = document.createElement("summary");
      detailsSummary.textContent = "View Technical Details";
      var detailsText = document.createElement("pre");
      detailsText.textContent = details;
      detailsEl.appendChild(detailsSummary);
      detailsEl.appendChild(detailsText);
      el.appendChild(detailsEl);
    }

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
    var autoDismiss = duration == null ? 4000 : duration;
    setTimeout(dismiss, autoDismiss);
  }

  function errorText(error) {
    if (error == null) return "";
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    if (typeof error === "object") {
      if (typeof error.error === "string") return error.error;
      if (typeof error.message === "string") return error.message;
      try {
        return JSON.stringify(error);
      } catch (e) {
        return String(error);
      }
    }
    return String(error);
  }

  function extractSorobanCode(text) {
    var match = text.match(/(?:HostError|Error)\s*\(?\s*Contract\s*,\s*#?\s*(\d+)/i);
    if (match) return Number(match[1]);
    match = text.match(/contract(?:[_ ]error)?\s*(?:code)?\s*[:#]\s*(\d+)/i);
    if (match) return Number(match[1]);
    return null;
  }

  function formatSorobanError(error) {
    var text = errorText(error);
    if (!text) return "Transaction failed. Try again or view technical details.";
    var code = extractSorobanCode(text);
    var messages = {
      1: "The client and provider must be different accounts.",
      2: "The provider and evaluator must be different accounts.",
      3: "The contract is paused. Please try again later.",
      4: "This job is not in a valid status for this action.",
      5: "The requested job could not be found.",
    };
    if (code != null && messages[code]) return messages[code];
    if (/self[\s_-]*escrow/i.test(text)) return messages[1];
    if (/invalid[\s_-]*(parties|addresses?|participants?)/i.test(text)) return messages[2];
    if (/\bcontract[\s_-]*paused\b|\bpaused\b/i.test(text)) return messages[3];
    if (/invalid[\s_-]*status/i.test(text)) return messages[4];
    if (/job[\s_-]*not[\s_-]*found|unknown[\s_-]*job/i.test(text)) return messages[5];
    if (/(tx failed|submit failed|simulation error|hosterror|host error|contract error|xdr)/i.test(text)) {
      return "Transaction failed. Try again or view technical details.";
    }
    return text;
  }

  function getTechnicalDetails(error) {
    if (error && typeof error.technicalDetails === "string") return error.technicalDetails;
    if (error && typeof error.raw === "string") return error.raw;
    if (error && error.details != null) {
      try {
        return JSON.stringify(error.details, null, 2);
      } catch (e) {}
    }
    if (error && error.data != null) {
      try {
        return JSON.stringify(error.data, null, 2);
      } catch (e) {}
    }
    return errorText(error);
  }

  function notifyError(error) {
    if (error && error.__dashboardNotified) return;
    toast(formatSorobanError(error), "error", null, getTechnicalDetails(error));
    if (error && typeof error === "object") error.__dashboardNotified = true;
  }

  // Public alias required by the issue spec
  window.showToast = toast;
  window.__formatSorobanError = formatSorobanError;

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
  async function copyToClipboard(text, source) {
    var value = String(text == null ? "" : text);
    if (!value) return false;
    var copied = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch (e) {}
    if (!copied) {
      var ta = document.createElement("textarea");
      ta.value = value;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        copied = document.execCommand("copy");
      } catch (e) {}
      ta.remove();
    }
    if (!copied) {
      toast("Could not copy to clipboard", "error");
      return false;
    }
    if (source) {
      if (!source.__copyIcon) {
        source.__copyIcon = source.innerHTML;
        source.__copyLabel = source.getAttribute("aria-label") || "Copy to clipboard";
        source.__copyTitle = source.title;
      }
      source.classList.add("copied");
      source.setAttribute("aria-label", "Copied!");
      source.title = "Copied!";
      source.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l4 4L19 6"/></svg>';
      clearTimeout(source.__copyResetTimer);
      source.__copyResetTimer = setTimeout(function () {
        source.classList.remove("copied");
        source.setAttribute("aria-label", source.__copyLabel);
        source.title = source.__copyTitle;
        source.innerHTML = source.__copyIcon;
      }, 2000);
    }
    toast("Copied!", "success", 2000);
    return true;
  }

  function copyBtn(value, label) {
    if (value == null || String(value) === "") return "";
    var safe = escapeAttr(String(value));
    var safeLabel = escapeAttr(label || "value");
    return (
      '<button type="button" class="copy-btn" data-copy-value="' +
      safe +
      '" aria-label="Copy ' +
      safeLabel +
      '" title="Copy ' +
      safeLabel +
      '" onclick="event.stopPropagation()">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
      "</svg></button>"
    );
  }

  function copyable(value, label, display) {
    if (value == null || String(value) === "") return "";
    var text = String(value);
    var visible = display == null ? truncAddr(text) : String(display);
    return (
      '<span class="copyable-value" title="' +
      escapeAttr(text) +
      '">' +
      escapeHtml(visible) +
      "</span>" +
      copyBtn(text, label)
    );
  }

  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target.closest("[data-copy-value]") : null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    copyToClipboard(target.getAttribute("data-copy-value"), target);
  }, true);


  /**
   * Returns a human-readable relative time string (e.g. "2 hours ago") for a
   * Unix timestamp (seconds).  Falls back to an absolute ISO date string when
   * the Intl.RelativeTimeFormat API is unavailable.
   * Closes #584 (missing helper that caused ReferenceError on render).
   */
  function formatRelativeTime(unixSeconds) {
    if (!unixSeconds) return "—";
    var ts = Number(unixSeconds) * 1000;
    if (!Number.isFinite(ts)) return "—";
    var diffMs = Date.now() - ts;
    var diffSec = Math.round(diffMs / 1000);
    var diffMin = Math.round(diffSec / 60);
    var diffHr  = Math.round(diffMin / 60);
    var diffDay = Math.round(diffHr  / 24);

    if (typeof Intl !== "undefined" && Intl.RelativeTimeFormat) {
      var rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
      if (Math.abs(diffSec) < 60)  return rtf.format(-diffSec, "second");
      if (Math.abs(diffMin) < 60)  return rtf.format(-diffMin, "minute");
      if (Math.abs(diffHr)  < 24)  return rtf.format(-diffHr,  "hour");
      if (Math.abs(diffDay) < 30)  return rtf.format(-diffDay, "day");
    }
    return new Date(ts).toLocaleDateString();
  }

  // ── Modal ──
  function showModal(contentHtml) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = contentHtml; // Safe: only called with our own static template strings
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    // #748 — focus trapping and keyboard handlers for accessibility
    trapModalFocus(overlay);
    return overlay;
  }

  // #748 — Focus trap: keep Tab cycling inside the modal, Escape closes it.
  function trapModalFocus(overlay) {
    var modal = overlay.querySelector(".modal");
    if (!modal) return;
    var previousActive = document.activeElement;
    function focusables() {
      return Array.prototype.slice
        .call(
          modal.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        )
        .filter(function (el) {
          return el.offsetParent !== null || el === document.activeElement;
        });
    }
    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal(overlay);
        return;
      }
      if (e.key !== "Tab") return;
      var items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    function closeModal(el) {
      document.removeEventListener("keydown", onKeyDown, true);
      el.remove();
      if (previousActive && typeof previousActive.focus === "function") {
        try {
          previousActive.focus();
        } catch (err) {}
      }
    }
    overlay.__closeModal = function () {
      closeModal(overlay);
    };
    document.addEventListener("keydown", onKeyDown, true);
    // Move focus into the modal
    var items = focusables();
    if (items.length > 0) {
      try {
        items[0].focus();
      } catch (err) {}
    }
  }

  // ── Pre-flight Transaction Simulation (#746) ──
  // Wraps the Stellar SDK rpc.Server.simulateTransaction() so the dashboard can
  // show estimated fees, resource consumption and balance diffs before the
  // wallet signature prompt is opened.

  // Resolve the configured RPC URL (falls back to the public testnet endpoint).
  function getRpcUrl() {
    if (window.__BEAR_RPC_URL) return window.__BEAR_RPC_URL;
    var meta = document.querySelector('meta[name="bear-rpc-url"]');
    if (meta && meta.getAttribute("content")) return meta.getAttribute("content");
    return "https://soroban-testnet.stellar.org";
  }

  // Lazily construct an rpc.Server from the Stellar SDK (UMD global `StellarSdk`).
  var _rpcServer = null;
  function getRpcServer() {
    if (_rpcServer) return _rpcServer;
    var sdk = window.StellarSdk || window.Stellar;
    if (!sdk || !sdk.rpc || typeof sdk.rpc.Server !== "function") {
      throw new Error("Stellar SDK rpc.Server is not available");
    }
    _rpcServer = new sdk.rpc.Server(getRpcUrl(), { allowHttp: getRpcUrl().indexOf("http://") === 0 });
    return _rpcServer;
  }

  /**
   * Simulate a transaction XDR against the configured Soroban RPC server.
   * Returns the raw simulation result (or throws on transport errors).
   */
  async function simulateTransaction(txXdr) {
    var server = getRpcServer();
    var sdk = window.StellarSdk || window.Stellar;
    var tx = sdk.TransactionBuilder.fromXDR(txXdr, sdk.Networks.TESTNET);
    return await server.simulateTransaction(tx);
  }

  /**
   * Parse a simulateTransaction() result into a display-friendly summary.
   * Extracts CPU instructions, memory bytes, min resource fee and balance diffs.
   */
  function parseSimulationResult(result) {
    var out = {
      success: true,
      cpuInsns: 0,
      memBytes: 0,
      minResourceFee: "0",
      networkFeeXlm: "0.0000000",
      balanceDiffs: [],
      error: null,
    };
    if (!result) {
      out.success = false;
      out.error = "Empty simulation result";
      return out;
    }
    // Soroban RPC returns { error } on failure, or { transactionData, cost, ... } on success.
    if (result.error) {
      out.success = false;
      out.error = result.error;
      return out;
    }
    var cost = result.cost || (result.result && result.result.cost) || {};
    out.cpuInsns = Number(cost.cpuInsns || cost.cpu_insns || 0) || 0;
    out.memBytes = Number(cost.memBytes || cost.mem_bytes || 0) || 0;
    var minFee = result.minResourceFee != null ? result.minResourceFee : result.min_resource_fee;
    out.minResourceFee = minFee != null ? String(minFee) : "0";
    // Convert stroops (1 XLM = 10,000,000 stroops) to XLM.
    var stroops = Number(out.minResourceFee);
    if (Number.isFinite(stroops)) {
      out.networkFeeXlm = (stroops / 10000000).toFixed(7);
    }
    // Extract balance diffs from the returned ledger entries / events when present.
    var diffs = result.balanceDiffs || result.balance_diffs;
    if (Array.isArray(diffs)) {
      out.balanceDiffs = diffs.map(function (d) {
        return {
          asset: d.asset || d.token || "XLM",
          amount: String(d.amount != null ? d.amount : d.delta != null ? d.delta : "0"),
          address: d.address || d.account || "",
        };
      });
    }
    return out;
  }

  /**
   * Extract a Soroban contract error code/message from a failed simulation.
   * Returns { code, message } or null when no error is present.
   */
  function extractSimulationError(result) {
    if (!result) return null;
    var raw = result.error;
    if (!raw && result.status && result.status !== "SUCCESS") raw = result.status;
    if (!raw) return null;
    var text = typeof raw === "string" ? raw : errorText(raw);
    var code = extractSorobanCode(text);
    return {
      code: code,
      message: formatSorobanError(text),
      raw: text,
    };
  }

  // Render the pre-flight confirmation modal. Resolves true when the user
  // confirms, false when they cancel.
  function showSimulationModal(details) {
    return new Promise(function (resolve) {
      var sim = details.simulation || {};
      var failed = sim.success === false;
      var body;
      if (failed) {
        var err = extractSimulationError({ error: sim.error });
        body =
          '<div class="sim-error" role="alert">' +
          '<div class="sim-error-title">Transaction would fail</div>' +
          '<div class="sim-error-msg">' +
          escapeHtml(err ? err.message : "Simulation failed") +
          "</div>" +
          (err && err.code != null
            ? '<div class="sim-error-code">Contract error code: ' + escapeHtml(String(err.code)) + "</div>"
            : "") +
          "</div>";
      } else {
        var diffsHtml = "";
        if (Array.isArray(sim.balanceDiffs) && sim.balanceDiffs.length > 0) {
          diffsHtml = '<div class="sim-section"><div class="sim-section-title">Projected Balances</div>';
          for (var i = 0; i < sim.balanceDiffs.length; i++) {
            var d = sim.balanceDiffs[i];
            diffsHtml +=
              '<div class="sim-row"><span class="sim-row-label">' +
              escapeHtml(d.asset) +
              "</span><span class=\"sim-row-value\">" +
              escapeHtml(d.amount) +
              "</span></div>";
          }
          diffsHtml += "</div>";
        }
        body =
          '<div class="sim-section">' +
          '<div class="sim-row"><span class="sim-row-label">Action</span><span class="sim-row-value">' +
          escapeHtml(details.action || "Transaction") +
          "</span></div>" +
          '<div class="sim-row"><span class="sim-row-label">Target Contract</span><span class="sim-row-value sim-mono">' +
          escapeHtml(details.targetContract || "—") +
          "</span></div>" +
          '<div class="sim-row"><span class="sim-row-label">Budget Amount</span><span class="sim-row-value">' +
          escapeHtml(details.budgetAmount || "—") +
          "</span></div>" +
          '<div class="sim-row"><span class="sim-row-label">Network Fee</span><span class="sim-row-value">' +
          escapeHtml(sim.networkFeeXlm) +
          " XLM</span></div>" +
          "</div>" +
          '<div class="sim-section"><div class="sim-section-title">Resource Consumption</div>' +
          '<div class="sim-row"><span class="sim-row-label">CPU Instructions</span><span class="sim-row-value">' +
          escapeHtml(String(sim.cpuInsns)) +
          "</span></div>" +
          '<div class="sim-row"><span class="sim-row-label">Memory</span><span class="sim-row-value">' +
          escapeHtml(String(sim.memBytes)) +
          " bytes</span></div>" +
          "</div>" +
          diffsHtml;
      }
      var actions = failed
        ? '<button class="btn btn-secondary" data-sim-cancel>Close</button>'
        : '<button class="btn btn-secondary" data-sim-cancel>Cancel</button>' +
          '<button class="btn btn-primary" data-sim-confirm>Confirm &amp; Sign</button>';
      var overlay = showModal(
        '<h2 class="modal-title">Review Transaction</h2>' + body + '<div class="modal-actions">' + actions + "</div>",
      );
      function finish(value) {
        if (overlay.__closeModal) overlay.__closeModal();
        else overlay.remove();
        resolve(value);
      }
      var cancelBtn = overlay.querySelector("[data-sim-cancel]");
      if (cancelBtn) cancelBtn.addEventListener("click", function () { finish(false); });
      var confirmBtn = overlay.querySelector("[data-sim-confirm]");
      if (confirmBtn) confirmBtn.addEventListener("click", function () { finish(true); });
    });
  }

  // Build, simulate, and (on user confirmation) sign & submit a transaction.
  // Returns the submit result, or null when the user cancels / simulation fails.
  async function simulateThenSubmit(buildEndpoint, params, details) {
    await ensureSession();
    var buildRes = await api(buildEndpoint, {
      method: "POST",
      body: { publicKey: wallet.publicKey, ...params },
    });
    var simulation;
    try {
      var raw = await simulateTransaction(buildRes.xdr);
      simulation = parseSimulationResult(raw);
    } catch (e) {
      simulation = { success: false, error: errorText(e) };
    }
    var confirmed = await showSimulationModal({
      action: details && details.action,
      targetContract: details && details.targetContract,
      budgetAmount: details && details.budgetAmount,
      simulation: simulation,
    });
    if (!confirmed || simulation.success === false) return null;
    // User confirmed a successful simulation — now open the wallet prompt.
    var signedXdr = await signWalletTransaction(buildRes.xdr);
    return await apiClientSubmit(signedXdr);
  }

  // Expose parsers for unit testing (#746)
  window.__parseSimulationResult = parseSimulationResult;
  window.__extractSimulationError = extractSimulationError;
  window.__simulateTransaction = simulateTransaction;
  window.__showSimulationModal = showSimulationModal;

  // Expose the virtualized list renderer for unit testing (#762)
  window.__VirtualList = VirtualList;
  window.__VIRTUALIZE_THRESHOLD = VIRTUALIZE_THRESHOLD;

  // ── Skeleton Loaders (#582) ──
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
        '<div class="skeleton-card skeleton-job-row">' +
        '<div class="skeleton skeleton-line w40" style="margin-bottom:8px"></div>' +
        '<div class="skeleton skeleton-line w80"></div>' +
        '</div>';
    }
    return html;
  }
  // Skeleton grid for agent cards (#582)
  function skeletonAgentCards(n) {
    let html = '<div class="agent-grid">';
    for (let i = 0; i < (n || 4); i++) {
      html +=
        '<div class="skeleton-card skeleton-agent-card">' +
        '<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">' +
        '<div class="skeleton" style="width:40px;height:40px;border-radius:10px;flex-shrink:0"></div>' +
        '<div class="skeleton skeleton-line w60" style="margin:0"></div>' +
        '</div>' +
        '<div class="skeleton skeleton-line w80"></div>' +
        '<div class="skeleton skeleton-line w60"></div>' +
        '</div>';
    }
    return html + "</div>";
  }

  // ── Safe DOM render helper ──
  function setPage(html) {
    // All HTML is constructed from trusted sources (our API responses contain
    // only Stellar addresses and contract state, not user-generated content)
    document.getElementById("page").innerHTML = html;
  }

  // ── Virtualized list renderer (#762) ──
  // Renders only the rows within the viewport plus a small buffer, keeping the
  // number of live DOM nodes bounded (below 100) regardless of list length.
  // Row heights are measured after mount and cached, so both fixed- and
  // variable-height rows lay out correctly. The viewport is absolutely
  // positioned inside a spacer whose height equals the total content height, so
  // the native scrollbar and scroll position stay accurate.
  var VIRTUAL_OVERSCAN = 5; // buffer rows above + below the viewport
  var VIRTUAL_MIN_WINDOW = 40; // fallback viewport height (px) when not yet laid out

  function VirtualList(options) {
    var opts = options || {};
    var container = opts.container; // scroll container element (must exist)
    if (!container) throw new Error("VirtualList: container is required");
    var getItems = opts.getItems || function () { return []; };
    var renderRow = opts.renderRow; // function(item, index) -> HTML string
    if (typeof renderRow !== "function") {
      throw new Error("VirtualList: renderRow is required");
    }
    var overscan = opts.overscan != null ? opts.overscan : VIRTUAL_OVERSCAN;
    var estimate = opts.estimatedRowHeight || 64;

    // The container becomes the scroll surface, so give it the virtual-list
    // class (bounded height + overflow) and remember the prior state for dispose.
    var hadVirtualClass = container.classList.contains("virtual-list");
    container.classList.add("virtual-list");
    // The list's own flex/gap layout is replaced by absolute positioning.
    var prevDisplay = container.style.display;
    var prevGap = container.style.gap;
    container.style.display = "block";
    container.style.gap = "0";

    // Spacer holds the full scroll height; viewport is translated to the window.
    var spacer = document.createElement("div");
    spacer.className = "virtual-spacer";
    var viewport = document.createElement("div");
    viewport.className = "virtual-viewport";
    spacer.appendChild(viewport);
    container.appendChild(spacer);

    // Pool of reusable row nodes, keyed by slot position within the window.
    var pool = [];
    var heights = []; // measured height per item index
    var offsets = []; // prefix-sum offsets for variable heights
    var totalHeight = 0;
    var windowStart = -1;
    var windowCount = 0;
    var rafId = null;
    var disposed = false;

    function itemsCount() {
      var items = getItems();
      return items ? items.length : 0;
    }

    // Rebuild prefix-sum offsets. Uses measured heights where available and the
    // estimate elsewhere, so the scroll height is correct from the first pass.
    function recomputeOffsets() {
      var count = itemsCount();
      heights.length = count;
      offsets = new Array(count + 1);
      offsets[0] = 0;
      for (var i = 0; i < count; i++) {
        var h = heights[i] != null ? heights[i] : estimate;
        offsets[i + 1] = offsets[i] + h;
      }
      totalHeight = offsets[count];
      spacer.style.height = totalHeight + "px";
    }

    // Binary search: first index whose cumulative offset is >= y.
    function findStartIndex(y) {
      var lo = 0;
      var hi = offsets.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (offsets[mid] < y) lo = mid + 1;
        else hi = mid;
      }
      return Math.max(0, lo - 1);
    }

    function measureRow(node, index) {
      var measured = node.offsetHeight;
      if (measured > 0 && heights[index] !== measured) {
        heights[index] = measured;
        return true;
      }
      return false;
    }

    function render() {
      if (disposed) return;
      var items = getItems() || [];
      var count = items.length;
      var viewportHeight = container.clientHeight || VIRTUAL_MIN_WINDOW;
      var scrollTop = container.scrollTop || 0;

      var start = findStartIndex(scrollTop);
      start = Math.max(0, start - overscan);
      var end = findStartIndex(scrollTop + viewportHeight);
      end = Math.min(count, end + overscan + 1);
      // Guarantee at least one full screen worth of rows in the window.
      end = Math.max(end, Math.min(count, start + overscan * 2 + 1));
      var visibleCount = Math.max(0, end - start);

      // Grow the pool to cover the window.
      while (pool.length < visibleCount) {
        var node = document.createElement("div");
        node.className = "virtual-row";
        viewport.appendChild(node);
        pool.push(node);
      }

      var changed = false;
      for (var i = 0; i < visibleCount; i++) {
        var index = start + i;
        var node2 = pool[i];
        var html = renderRow(items[index], index);
        // Only rewrite the DOM when the content actually differs (avoids layout
        // thrash on scroll and preserves inline expansion state).
        if (node2.__index !== index || node2.__html !== html) {
          node2.innerHTML = html;
          node2.__index = index;
          node2.__html = html;
        }
        node2.style.display = "";
        if (measureRow(node2, index)) changed = true;
      }
      // Hide surplus pooled nodes instead of destroying them (recycling).
      for (var j = visibleCount; j < pool.length; j++) {
        if (pool[j].style.display !== "none") {
          pool[j].style.display = "none";
          pool[j].__index = -1;
          pool[j].__html = undefined;
        }
      }

      // If measurement changed the layout, refresh offsets and re-render once.
      if (changed) {
        recomputeOffsets();
        return render();
      }

      viewport.style.transform = "translateY(" + offsets[start] + "px)";
      windowStart = start;
      windowCount = visibleCount;
    }

    function schedule() {
      if (disposed || rafId != null) return;
      var raf =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame
          : function (cb) { return setTimeout(cb, 16); };
      rafId = raf(function () {
        rafId = null;
        render();
      });
    }

    function onScroll() {
      schedule();
    }

    container.addEventListener("scroll", onScroll, { passive: true });

    // Public-ish introspection used by tests and perf instrumentation.
    function stats() {
      return {
        total: itemsCount(),
        rendered: windowCount,
        liveNodes: pool.filter(function (n) { return n.style.display !== "none"; }).length,
        pooledNodes: pool.length,
        windowStart: windowStart,
        totalHeight: totalHeight,
      };
    }

    function update() {
      recomputeOffsets();
      render();
    }

    function dispose() {
      disposed = true;
      container.removeEventListener("scroll", onScroll);
      if (rafId != null) {
        var caf =
          typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
        caf(rafId);
        rafId = null;
      }
      if (spacer.parentNode) spacer.parentNode.removeChild(spacer);
      container.style.display = prevDisplay;
      container.style.gap = prevGap;
      if (!hadVirtualClass) container.classList.remove("virtual-list");
      pool.length = 0;
    }

    return {
      update: update,
      render: render,
      scheduleRender: schedule,
      stats: stats,
      dispose: dispose,
      container: container,
      spacer: spacer,
      viewport: viewport,
    };
  }

  // Only virtualize once a list is large enough that the DOM cost matters.
  // Below the threshold the overhead of measurement is not worth it.
  var VIRTUALIZE_THRESHOLD = 30;

  // Registry of active virtual lists keyed by container id, so re-rendering a
  // view can dispose the previous instance instead of stacking scroll listeners.
  var virtualLists = {};

  function destroyVirtualList(key) {
    var vl = virtualLists[key];
    if (vl) {
      vl.dispose();
      delete virtualLists[key];
    }
  }

  function destroyAllVirtualLists() {
    for (var key in virtualLists) {
      if (Object.prototype.hasOwnProperty.call(virtualLists, key)) destroyVirtualList(key);
    }
  }

  // Load the job-event timeline for each job row currently mounted in the DOM.
  // With virtualization only a handful of rows exist at once, so this stays
  // cheap even when the underlying list holds thousands of jobs (#762).
  function loadVisibleJobTimelines() {
    var rows = document.querySelectorAll(".job-timeline[id^='job-timeline-']");
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].id.replace("job-timeline-", "");
      loadJobTimeline(id);
    }
  }

  // ── Deliverable Preview (#580) ──
  // Detects deliverable type and renders a safe, interactive preview.
  // All user-supplied strings are run through escapeHtml before insertion.
  function renderDeliverable(raw) {
    if (!raw) return "";
    var str = String(raw).trim();

    // Detect URL (IPFS or HTTP/HTTPS)
    var isUrl = /^(https?:\/\/|ipfs:\/\/)/i.test(str);
    if (isUrl) {
      var safeUrl = escapeHtml(str);
      // Only allow http/https/ipfs in href — strip anything else
      var hrefSafe = /^(https?:|ipfs:)/i.test(str) ? safeUrl : "#";
      return (
        '<div class="deliverable-preview deliverable-url">' +
        '<div class="deliverable-label">Deliverable Link</div>' +
        '<a class="deliverable-link" href="' + hrefSafe + '" target="_blank" rel="noopener noreferrer">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
        escapeHtml(str.length > 80 ? str.slice(0, 80) + "…" : str) +
        '</a>' +
        '</div>'
      );
    }

    // Detect Markdown (starts with #, **, -, >, ```, or contains \n##)
    var isMarkdown = /^#{1,6}\s|^\*\*|^[-*+]\s|^>\s|^```|(\n#{1,6}\s)/.test(str);
    if (isMarkdown) {
      // Safe markdown-to-HTML: only handle headings, bold, italic, code, line breaks
      // Every raw string segment is escaped before any HTML is emitted
      var mdHtml = str
        .split("\n")
        .map(function (line) {
          var l = escapeHtml(line);
          // ### Heading
          l = l.replace(/^(#{1,6})\s(.+)$/, function (_, hashes, content) {
            var level = Math.min(hashes.length + 2, 6); // h3–h6
            return "<h" + level + " class='md-heading'>" + content + "</h" + level + ">";
          });
          // **bold**
          l = l.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          // *italic*
          l = l.replace(/\*(.+?)\*/g, "<em>$1</em>");
          // `inline code`
          l = l.replace(/`([^`]+)`/g, "<code class='md-code'>$1</code>");
          // List items
          l = l.replace(/^[-*+]\s(.+)$/, "<li>$1</li>");
          // Blockquote
          l = l.replace(/^&gt;\s(.+)$/, "<blockquote class='md-blockquote'>$1</blockquote>");
          return l || "<br>";
        })
        .join("\n");
      return (
        '<div class="deliverable-preview deliverable-markdown">' +
        '<div class="deliverable-label">Markdown Preview</div>' +
        '<div class="deliverable-md-body">' + mdHtml + '</div>' +
        '</div>'
      );
    }

    // JSON detection
    var isJson = false;
    var prettyJson = null;
    if ((str.startsWith("{") || str.startsWith("[")) && str.length < 50000) {
      try {
        prettyJson = JSON.stringify(JSON.parse(str), null, 2);
        isJson = true;
      } catch (e) {}
    }

    // Plain text / JSON — render as code block with copy button
    var codeContent = isJson ? prettyJson : str;
    var uid = "dlv-copy-" + Date.now();
    return (
      '<div class="deliverable-preview deliverable-code">' +
      '<div class="deliverable-label-row">' +
      '<div class="deliverable-label">' + (isJson ? "JSON Deliverable" : "Deliverable") + '</div>' +
      copyBtn(codeContent, "deliverable") +
      '</div>' +
      '<pre class="deliverable-pre"><code>' + escapeHtml(codeContent) + '</code></pre>' +
      '</div>'
    );
  }

  // ── CSV Export (#757) ──
  // Builds a UTF-8 BOM-prefixed CSV from the currently filtered job records.
  function csvEscapeCell(value) {
    var s = String(value == null ? "" : value);
    if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function formatCsvDate(unixSeconds) {
    if (!unixSeconds) return "";
    var d = new Date(Number(unixSeconds) * 1000);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  function buildTransactionCsv(jobs) {
    var header = ["Date", "Job ID", "Type", "Counterparty", "Amount", "Status", "TxHash"];
    var lines = [header.map(csvEscapeCell).join(",")];
    var me = wallet.publicKey || "";
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var counterparty = "";
      if (me && j.client === me) counterparty = j.provider || "";
      else if (me && j.provider === me) counterparty = j.client || "";
      else counterparty = j.client || j.provider || "";
      lines.push(
        [
          formatCsvDate(j.created_at),
          j.id,
          "Escrow",
          counterparty,
          formatMusd(j.budget),
          j.status || "",
          j.txHash || j.tx_hash || "",
        ]
          .map(csvEscapeCell)
          .join(","),
      );
    }
    return "\uFEFF" + lines.join("\r\n");
  }

  function downloadBlob(content, filename, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  window.__exportHistoryCsv = function () {
    var jobs = state.jobs || [];
    var searchTerm = (state.jobSearch || "").toLowerCase().trim();
    var from = state.jobDateFrom ? new Date(state.jobDateFrom).getTime() : null;
    var to = state.jobDateTo ? new Date(state.jobDateTo).getTime() + 86400000 : null;
    var filtered = jobs.filter(function (j) {
      if (searchTerm) {
        var hay = (
          String(j.id) + " " + (j.description || "") + " " + (j.client || "") + " " + (j.provider || "")
        ).toLowerCase();
        if (hay.indexOf(searchTerm) === -1) return false;
      }
      if (from != null || to != null) {
        var ts = Number(j.created_at) * 1000;
        if (!Number.isFinite(ts)) return false;
        if (from != null && ts < from) return false;
        if (to != null && ts > to) return false;
      }
      return true;
    });
    if (filtered.length === 0) {
      toast("No transactions to export", "error");
      return;
    }
    var csv = buildTransactionCsv(filtered);
    var walletPart = wallet.publicKey ? wallet.publicKey.slice(0, 8) : "demo";
    var dateStr = new Date().toISOString().slice(0, 10);
    var filename = "bear-transactions-" + walletPart + "-" + dateStr + ".csv";
    downloadBlob(csv, filename, "text/csv;charset=utf-8");
    toast("Exported " + filtered.length + " transactions");
  };

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
    // Fetch capability badges for the loaded agents (#701)
    await loadAgentBadges(state.agents);
  }

  // ── Capability Badges (#701) ──
  // Badges are stored on-chain under DataKey::Badges(agent_id, tag) and exposed
  // by the backend as { tag, score, issued_at, expires_at, issuer }.  We only
  // render active, non-expired credentials and degrade gracefully when the
  // endpoint is unavailable or returns nothing.
  function isBadgeActive(badge, nowSeconds) {
    if (!badge) return false;
    var expiresAt = Number(badge.expires_at || badge.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
    return expiresAt > nowSeconds;
  }

  function normalizeBadges(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.badges)) return raw.badges;
    if (Array.isArray(raw.items)) return raw.items;
    return [];
  }

  async function loadAgentBadges(agents) {
    var list = Array.isArray(agents) ? agents : [];
    if (list.length === 0) return;
    var nowSeconds = Math.floor(Date.now() / 1000);
    await Promise.all(
      list.map(function (a) {
        if (a == null || a.id === undefined || a.id === null) return Promise.resolve();
        return api("/agents/" + encodeURIComponent(String(a.id)) + "/badges", { _silent: true })
          .then(function (data) {
            a.badges = normalizeBadges(data).filter(function (b) {
              return isBadgeActive(b, nowSeconds);
            });
          })
          .catch(function () {
            // Endpoint may not exist yet — degrade gracefully, no badges shown.
            a.badges = [];
          });
      }),
    );
  }

  // Renders active capability badges as escaped visual chips.
  function renderBadgeChips(badges) {
    if (!Array.isArray(badges) || badges.length === 0) return "";
    var chips = "";
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i] || {};
      var tag = b.tag == null ? "" : String(b.tag);
      if (!tag) continue;
      var score = Number(b.score);
      var scoreText = Number.isFinite(score) ? String(score) : "";
      var title = "Verified capability: " + tag + (scoreText ? " (score " + scoreText + ")" : "");
      chips +=
        '<span class="badge-chip" title="' + escapeAttr(title) + '">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
        '<path d="M20 6 9 17l-5-5"/></svg>' +
        '<span class="badge-chip-tag">' + escapeHtml(tag) + "</span>" +
        (scoreText ? '<span class="badge-chip-score">' + escapeHtml(scoreText) + "</span>" : "") +
        "</span>";
    }
    if (!chips) return "";
    return '<div class="agent-badges" aria-label="Verified capability badges">' + chips + "</div>";
  }
  async function loadJobs(status, page = state.jobPage) {
    state.loading.jobs = true;
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(state.jobPageSize) });
      if (status) params.set("status", status);
      const query = "?" + params.toString();
      const result = await api("/jobs" + query);
      state.jobs = Array.isArray(result) ? result : result.items || [];
      state.jobPage = result.page || page;
      state.jobTotal = result.total || 0;
      state.jobHasNext = Boolean(result.hasNext);
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
          '<div class="activity-id-with-copy"><span class="activity-id">#' +
          escapeHtml(String(j.id)) +
          "</span>" +
          copyBtn(j.id, "job ID") +
          "</div>" +
          '<div class="activity-info">' +
          '<div class="activity-desc">' +
          escapeHtml(j.description || "\u2014") +
          "</div>" +
          '<div class="activity-meta">Client: ' +
          copyable(j.client, "wallet public key") +
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
         '<div class="wallet-addr">' +
         '<code class="copyable-value" title="' +
         escapeHtml(data.address) +
         '">' +
         escapeHtml(truncAddr(data.address)) +
         "</code>" +
         copyBtn(data.address, "wallet public key") +
         '<span class="copy-hint">Copy</span>' +
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

    // Count jobs by status for badges (#579)
    var counts = {
      "All": jobs.length,
      "Active": jobs.filter(function (j) { return j.status === "Funded" || j.status === "Submitted"; }).length,
      "Funded": jobs.filter(function (j) { return j.status === "Funded"; }).length,
      "Submitted": jobs.filter(function (j) { return j.status === "Submitted"; }).length,
      "Completed": jobs.filter(function (j) { return j.status === "Completed"; }).length,
      "Cancelled": jobs.filter(function (j) { return j.status === "Cancelled"; }).length,
    };

    let tabs = '<div class="filter-tabs">';
    for (const f of filters) {
      var count = counts[f] || 0;
      tabs +=
        '<button class="filter-tab ' +
        (f === state.jobFilter ? "active" : "") +
        '" onclick="window.__filterJobs(\'' +
        f +
        "')\">" +
        f +
        (count > 0 ? ' <span class="filter-badge">' + count + '</span>' : '') +
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
      content = '<div class="job-list" id="job-list"></div>';
    }

    const pagination =
      '<div class="job-pagination" style="display:flex;justify-content:center;align-items:center;gap:12px;margin-top:20px">' +
      '<button class="btn btn-secondary btn-sm" onclick="window.__changeJobPage(-1)" ' +
      (state.jobPage <= 1 ? "disabled" : "") +
      '>Newer</button><span>Page ' +
      state.jobPage +
      " · " +
      state.jobTotal +
      " jobs</span><button class=\"btn btn-secondary btn-sm\" onclick=\"window.__changeJobPage(1)\" " +
      (!state.jobHasNext ? "disabled" : "") +
      ">Older</button></div>";

    setPage(
      '<div class="section-header"><div><div class="section-title">Jobs</div><div class="page-subtitle" style="margin-top:2px">Escrow-based job marketplace on Soroban</div></div>' +
        '<button class="btn btn-primary" onclick="window.__showCreateJob()">+ Create Job</button></div>' +
        tabs +
        toolbar +
        content +
        pagination,
    );

    // Render the rows: fully when the list is short, virtualized when it is not
    // (#762). Virtualization keeps live DOM nodes bounded (viewport + buffer) so
    // large job histories stay smooth.
    var listEl = document.getElementById("job-list");
    if (listEl && filtered.length > 0) {
      if (filtered.length > VIRTUALIZE_THRESHOLD) {
        destroyVirtualList("job-list");
        var vl = VirtualList({
          container: listEl,
          getItems: function () { return filtered; },
          renderRow: jobRowHtml,
          estimatedRowHeight: 64,
        });
        vl.update();
        virtualLists["job-list"] = vl;
      } else {
        var html = "";
        for (var idx = 0; idx < filtered.length; idx++) {
          html += '<div class="virtual-row">' + jobRowHtml(filtered[idx], idx) + "</div>";
        }
        listEl.innerHTML = html;
      }
      loadVisibleJobTimelines();
    }
  }

  // Build the HTML for a single job row. Split out from renderJobList so the
  // virtualized renderer can produce rows on demand (#762).
  function jobRowHtml(j) {
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
      if (j.evaluatorProgress) {
        if (j.evaluatorProgress.approvals < j.evaluatorProgress.threshold) {
          actions =
            '<button class="btn btn-primary btn-sm" onclick="window.__approveJob(\'' +
            j.id +
            "')\">Approve quorum</button>";
        }
      } else {
        actions +=
          '<button class="btn btn-primary btn-sm" onclick="window.__completeJob(\'' +
          j.id +
          "')\">Complete (Release Funds)</button>";
      }
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
        renderDeliverable(j.deliverable) +
        "</div></div>";
    }

    let evaluatorProgressHtml = "";
    if (j.evaluatorProgress) {
      const progress = j.evaluatorProgress;
      const percent = Math.min(100, Math.round((progress.approvals / progress.threshold) * 100));
      evaluatorProgressHtml =
        '<div class="detail-item evaluator-progress-item" style="grid-column:1/-1">' +
        '<div class="evaluator-progress-heading"><div class="detail-label">Evaluator approvals</div>' +
        '<div class="evaluator-progress-count">' + progress.approvals + ' / ' + progress.threshold + '</div></div>' +
        '<div class="evaluator-progress-track" role="progressbar" aria-label="Evaluator approvals" aria-valuemin="0" aria-valuemax="' +
        progress.threshold + '" aria-valuenow="' + progress.approvals + '"><span style="width:' + percent + '%"></span></div>' +
        '</div>';
    }

    return (
      '<div class="job-row" id="job-' +
      j.id +
      '">' +
      '<div class="job-summary" data-job-id="' +
      escapeHtml(String(j.id)) +
      '" onclick="window.__toggleJob(event.currentTarget.dataset.jobId)">' +
      '<div class="job-id-with-copy"><span class="job-id">#' +
      escapeHtml(String(j.id)) +
      "</span>" +
      copyBtn(j.id, "job ID") +
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
      copyable(j.client, "wallet public key") +
      "</div></div>" +
      '<div class="detail-item"><div class="detail-label">Provider</div>' +
      '<div class="detail-value addr-with-copy">' +
      copyable(j.provider, "wallet public key") +
      "</div></div>" +
      '<div class="detail-item"><div class="detail-label">Evaluator</div>' +
      '<div class="detail-value addr-with-copy">' +
      copyable(j.evaluator, "wallet public key") +
      "</div></div>" +
      '<div class="detail-item"><div class="detail-label">Token</div>' +
      '<div class="detail-value addr-with-copy">' +
      copyable(j.token, "token contract address") +
      "</div></div>" +
      (j.created_at
        ? '<div class="detail-item"><div class="detail-label">Created</div>' +
          '<div class="detail-value" title="' + escapeHtml(new Date(Number(j.created_at) * 1000).toISOString()) + '">' +
          escapeHtml(formatRelativeTime(j.created_at)) +
          "</div></div>"
        : "") +
      evaluatorProgressHtml +
      deliverableHtml +
      '<div class="detail-item" style="grid-column:1/-1">' +
      '<div class="detail-label">Timeline</div>' +
      '<div class="job-timeline" role="list" id="job-timeline-' +
      escapeAttr(String(j.id)) +
      '"><div class="job-timeline-empty" role="listitem">Loading events…</div></div>' +
      "</div>" +
      "</div>" +
      renderLifecycleStepper(j) +
      '<div class="job-actions">' +
      actions +
      "</div>" +
      "</div></div>"
    );
  }

  // Returns true when an agent matches the search query (case-insensitive).
  function matchAgent(a, q) {
    var query = String(q || "").toLowerCase().trim();
    if (!query) return true;
    const nameMatch = Boolean(a.name && a.name.toLowerCase().includes(query));
    const descMatch = Boolean(a.description && a.description.toLowerCase().includes(query));
    const tagsMatch = Boolean(
      Array.isArray(a.tags)
        ? a.tags.some(function (t) {
            return String(t).toLowerCase().includes(query);
          })
        : typeof a.tag === "string" && a.tag.toLowerCase().includes(query),
    );
    const skillsMatch = Boolean(
      Array.isArray(a.skills)
        ? a.skills.some(function (s) {
            return String(s).toLowerCase().includes(query);
          })
        : typeof a.skill === "string" && a.skill.toLowerCase().includes(query),
    );
    const uriMatch = Boolean(a.uri && String(a.uri).toLowerCase().includes(query));
    const ownerMatch = Boolean(a.owner && String(a.owner).toLowerCase().includes(query));
    const idMatch = Boolean(a.id !== undefined && String(a.id).toLowerCase().includes(query));

    return nameMatch || descMatch || tagsMatch || skillsMatch || uriMatch || ownerMatch || idMatch;
  }

  // 4. Agents
  async function renderAgents() {
    if (!state.agents) {
      setPage(
        '<div class="section-header"><div><div class="section-title">Agents</div><div class="page-subtitle" style="margin-top:2px">On-chain identity registry for AI agents</div></div>' +
          '<button class="btn btn-primary" onclick="window.__showRegisterAgent()">+ Register Agent</button></div>' +
          skeletonList(3),
      );
      await loadAgents();
    }

    const agents = state.agents || [];
    const searchTerm = (state.agentSearch || "").trim();
    let filtered = searchTerm
      ? agents.filter(function (a) {
          return matchAgent(a, searchTerm);
        })
      : agents;

    // #583 — apply agent search filter
    var agentQuery = (state.agentSearch || "").toLowerCase().trim();
    if (agentQuery) {
      filtered = agents.filter(function (a) {
        return (
          (a.owner || "").toLowerCase().includes(agentQuery) ||
          (a.uri || "").toLowerCase().includes(agentQuery) ||
          String(a.id).includes(agentQuery) ||
          (Array.isArray(a.tags) && a.tags.some(function (t) {
            return t.toLowerCase().includes(agentQuery);
          })) ||
          (a.description || "").toLowerCase().includes(agentQuery) ||
          (a.name || "").toLowerCase().includes(agentQuery)
        );
      });
    }

    // #583 — search bar with 200ms debounce
    var searchBar =
      '<div class="agent-search-wrap" style="margin-bottom:16px">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>' +
      '<input class="agent-search-input" id="agent-search" type="search" ' +
      'placeholder="Search agents by name, skill, or tag…" ' +
      'value="' + escapeHtml(state.agentSearch) + '" ' +
      'oninput="window.__searchAgentsDebounced(this.value)" ' +
      'aria-label="Search agents">' +
      '</div>';

    let cards = "";
    if (filtered.length === 0) {
      var emptyMsg = agentQuery
        ? '<div class="empty-state">' +
          '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></div>' +
          '<div class="empty-title">No agents found matching &ldquo;' + escapeHtml(agentQuery) + '&rdquo;</div>' +
          '<div class="empty-desc">Try a different search term.</div></div>'
        : '<div class="empty-state">' +
          '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>' +
          '<div class="empty-title">No agents registered</div>' +
          '<div class="empty-desc">Register your first agent to get started.</div></div>';
      cards = emptyMsg;
    } else {
      cards = '<div class="agent-grid">';
      for (const a of filtered) {
        cards +=
          '<div class="agent-card">' +
           '<div class="agent-card-top">' +
           agentIdenticon(a.owner) +
           '<div class="agent-id">Agent <span>#' +
           escapeHtml(String(a.id)) +
           "</span>" +
           copyBtn(a.id, "agent ID") +
           "</div>" +
           "</div>" +
           '<div class="agent-field"><div class="agent-field-label">Owner</div>' +
           '<div class="agent-field-value addr-with-copy">' +
           copyable(a.owner, "wallet public key") +
           "</div></div>" +
          '<div class="agent-field"><div class="agent-field-label">Metadata URI</div>' +
          '<div class="agent-field-value">' +
          escapeHtml(a.uri) +
          "</div></div>" +
          renderBadgeChips(a.badges) +
          "</div>";
      }
      cards += "</div>";
    }

    const totalPages = Math.max(1, Math.ceil(state.agentTotal / state.agentPageSize));
    if (totalPages > 1 && !agentQuery) {
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

    const searchToolbar =
      '<div class="agent-search-wrap">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>' +
      '<input type="search" id="agent-search" class="agent-search-input" ' +
      'placeholder="Search agents by name, skill, or tag..." ' +
      'value="' +
      escapeHtml(state.agentSearch || "") +
      '" ' +
      'oninput="window.__searchAgents(this.value)" />' +
      "</div>";

    setPage(
      '<div class="section-header"><div><div class="section-title">Agents</div><div class="page-subtitle" style="margin-top:2px">On-chain identity registry for AI agents</div></div>' +
        '<button class="btn btn-primary" onclick="window.__showRegisterAgent()">+ Register Agent</button></div>' +
        '<div class="stat-grid" style="margin-bottom:24px;grid-template-columns:repeat(3,1fr)">' +
        '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Registered</div>' +
        '<div class="stat-icon blue"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>' +
        '</div><div class="stat-value">' +
        (searchTerm ? filtered.length : agents.length) +
        "</div></div>" +
        '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Network</div>' +
        '<div class="stat-icon green"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>' +
        '</div><div class="stat-value" style="font-size:18px;color:var(--status-completed)">Testnet</div></div>' +
        '<div class="stat-card"><div class="stat-card-top"><div class="stat-label">Registry</div>' +
        '<div class="stat-icon orange"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>' +
        '</div><div class="stat-value" style="font-size:14px;font-weight:600;color:var(--text-muted);font-family:var(--mono)">ERC-8004</div></div>' +
        "</div>" +
        searchBar +
        cards,
    );

    // Restore focus to search input after re-render
    var inp = document.getElementById("agent-search");
    if (inp && agentQuery) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
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

    var rows = '<div class="history-list" id="history-list">';
    if (filteredEvents.length === 0) {
      rows +=
        '<div class="empty-state" style="margin-top:24px">' +
        '<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg></div>' +
        '<div class="empty-title">No matching records</div>' +
        '<div class="empty-desc">Try a different filter.</div></div>';
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

    // Render history rows, virtualized once the list is large (#762).
    var histListEl = document.getElementById("history-list");
    if (histListEl && filteredEvents.length > 0) {
      if (filteredEvents.length > VIRTUALIZE_THRESHOLD) {
        destroyVirtualList("history-list");
        var hvl = VirtualList({
          container: histListEl,
          getItems: function () { return filteredEvents; },
          renderRow: historyRowHtml,
          estimatedRowHeight: 64,
        });
        hvl.update();
        virtualLists["history-list"] = hvl;
      } else {
        var histHtml = "";
        for (var hi = 0; hi < filteredEvents.length; hi++) {
          histHtml += '<div class="virtual-row">' + historyRowHtml(filteredEvents[hi], hi) + "</div>";
        }
        histListEl.innerHTML = histHtml;
      }
    }
  }

  // Build the HTML for a single history row (#762).
  function historyRowHtml(ev) {
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
        copyable(ev.actor, "wallet public key") +
        " &nbsp;·&nbsp; " +
        formatMusd(ev.budget) +
        " USDC" +
        deliverablePart;
      badge = statusBadge(ev.status);
    } else {
      icon =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>';
      label = "Agent registered";
      meta = "Owner: " + copyable(ev.actor, "wallet public key") + " &nbsp;·&nbsp; " + escapeHtml(ev.uri || "");
      badge =
        '<span class="status-badge status-Completed"><span class="dot"></span>Registered</span>';
    }
    return (
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
      '<div class="history-id-with-copy"><span class="history-id">#' +
      escapeHtml(String(ev.id)) +
      "</span>" +
      copyBtn(ev.id, ev.kind === "job" ? "job ID" : "agent ID") +
      "</div>" +
      badge +
      "</div>" +
      "</div>"
    );
  }

  window.__filterHistory = function (filter) {
    window.__histFilter = filter;
    renderHistory();
  };

  // ── Global Actions ──

  window.__copy = copyToClipboard;

  // ── Job lifecycle timeline (#831) ──
  var TIMELINE_LABELS = {
    jobcreated: "Job created & funded",
    jobsubmitted: "Deliverable submitted",
    jobcompleted: "Job completed",
    jobrejected: "Job rejected",
    jobcancelled: "Job cancelled",
    jobdisputed: "Dispute opened",
    disputeresolved: "Dispute resolved",
    jobresolved: "Dispute resolved",
    jobrefunded: "Job refunded",
    jobexpired: "Payment claimed after timeout",
  };

  function eventPayload(ev) {
    var data = ev.data != null ? ev.data : ev.payload;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { data = null; }
    }
    return data && typeof data === "object" ? data : {};
  }

  function eventJobId(data) {
    var id = data.job_id != null ? data.job_id : data.jobId != null ? data.jobId : data.job;
    return id == null ? null : String(id);
  }

  function eventUnixSeconds(ts) {
    if (ts == null || ts === "") return null;
    var n = Number(ts);
    if (!Number.isFinite(n)) n = Date.parse(ts) / 1000;
    else if (n > 1e12) n = n / 1000;
    return Number.isFinite(n) ? n : null;
  }

  function renderJobTimeline(items) {
    if (items.length === 0) {
      return '<div class="job-timeline-empty" role="listitem">No events recorded for this job yet.</div>';
    }
    return items
      .map(function (item) {
        var type = String(item.ev.eventType || item.ev.event_type || item.ev.type || "");
        var key = type.toLowerCase().replace(/[_\s]/g, "");
        var label = TIMELINE_LABELS[key] || type || "Event";
        var data = item.data;
        var time = item.ts
          ? '<span class="job-timeline-time" title="' +
            escapeAttr(new Date(item.ts * 1000).toISOString()) +
            '">' +
            escapeHtml(formatRelativeTime(item.ts)) +
            "</span>"
          : "";
        var meta = "";
        var provider = data.provider || data.provider_id;
        if (provider) meta += '<span class="job-timeline-meta">Provider: ' + copyable(provider, "wallet public key") + "</span>";
        if (data.evaluator) meta += '<span class="job-timeline-meta">Evaluator: ' + copyable(data.evaluator, "wallet public key") + "</span>";
        var hash = data.deliverable_hash || data.deliverableHash;
        if (hash) {
          meta +=
            '<span class="job-timeline-meta">Deliverable hash: ' +
            copyable(hash, "deliverable hash", String(hash).slice(0, 10) + "…" + String(hash).slice(-6)) +
            "</span>";
        }
        return (
          '<div class="job-timeline-item" role="listitem">' +
          '<span class="job-timeline-dot"></span>' +
          '<div class="job-timeline-body">' +
          '<div class="job-timeline-head"><span class="job-timeline-label">' +
          escapeHtml(label) +
          "</span>" +
          time +
          "</div>" +
          meta +
          "</div></div>"
        );
      })
      .join("");
  }

  async function loadJobTimeline(id) {
    var el = document.getElementById("job-timeline-" + id);
    if (!el) return;
    try {
      var res = await api("/events?limit=1000", { _silent: true });
      var items = (res.items || [])
        .map(function (ev) {
          var data = eventPayload(ev);
          return { ev: ev, data: data, jobId: eventJobId(data), ts: eventUnixSeconds(ev.timestamp) };
        })
        .filter(function (item) {
          return item.jobId === String(id);
        })
        .sort(function (a, b) {
          return (a.ts || 0) - (b.ts || 0) || (Number(a.ev.ledger) || 0) - (Number(b.ev.ledger) || 0);
        });
      el.innerHTML = renderJobTimeline(items);
    } catch (e) {
      el.innerHTML = '<div class="job-timeline-empty" role="listitem">Could not load job events.</div>';
    }
  }

  window.__toggleJob = function (id) {
    const row = document.getElementById("job-" + id);
    if (row) {
      row.classList.toggle("expanded");
      if (row.classList.contains("expanded")) loadJobTimeline(id);
    }
  };

  window.__filterJobs = function (filter) {
    state.jobFilter = filter;
    state.jobSearch = ""; // reset search when switching filter tabs
    state.jobPage = 1;
    loadJobs(filter === "All" ? undefined : filter)
      .then(renderJobList)
      .catch(function (e) {
        notifyError(e);
      });
  };

  window.__changeJobPage = function (delta) {
    var nextPage = state.jobPage + delta;
    if (nextPage < 1 || (delta > 0 && !state.jobHasNext)) return;
    var status = state.jobFilter === "All" ? undefined : state.jobFilter;
    loadJobs(status, nextPage)
      .then(renderJobList)
      .catch(function (e) {
        notifyError(e);
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

  // #583 — debounced agent search handler
  var _searchAgentsImmediate = function (value) {
    state.agentSearch = value;
    renderAgents();
  };
  window.__searchAgentsDebounced = debounce(_searchAgentsImmediate, 200);

  window.__showCreateJob = function (prefill) {
    var prefillProvider = prefill && prefill.provider != null ? String(prefill.provider) : "";
    var walletField = wallet.connected
      ? '<div class="form-group"><label class="form-label">Signing Wallet</label>' +
         '<div class="form-input signing-wallet-display" style="color:var(--accent);cursor:default">' +
         copyable(wallet.publicKey, "wallet public key") +
        " (" + connectedWalletLabel() + ")</div></div>"
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
        '<input class="form-input" id="cj-provider" value="' + escapeAttr(prefillProvider) + '" placeholder="Leave blank to use default seller" autocomplete="off" spellcheck="false"></div>' +
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
    try {
      if (wallet.connected) {
        const params = { description: description, budget: budget };
        if (providerVal) params.provider = providerVal;
        // #746 — pre-flight simulation before wallet prompt
        const res = await simulateThenSubmit("/build/createJob", params, {
          action: "Create Job",
          targetContract: "Bear Escrow",
          budgetAmount: formatMusd(budget) + " MUSD",
        });
        if (!res) {
          state.txPending = false;
          return;
        }
        hideTxOverlay();
        toast("Job created! tx: " + (res.hash || "").slice(0, 8) + "...");
      } else {
        showTxOverlay("Creating job on Stellar...");
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
      notifyError(e);
    } finally {
      state.txPending = false;
    }
  };

  window.__submitJob = async function (id) {
    if (state.txPending) return;
    state.txPending = true;
    try {
      if (wallet.connected) {
        // #746 — pre-flight simulation before wallet prompt
        const res = await simulateThenSubmit(
          "/build/submit",
          { jobId: id, deliverable: "ipfs://dashboard-delivery-" + id },
          {
            action: "Submit Work",
            targetContract: "Bear Escrow",
            budgetAmount: "—",
          },
        );
        if (!res) {
          state.txPending = false;
          return;
        }
        hideTxOverlay();
      } else {
        showTxOverlay("Submitting work...");
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
      notifyError(e);
    } finally {
      state.txPending = false;
    }
  };

  window.__completeJob = async function (id) {
    if (state.txPending) return;
    state.txPending = true;
    try {
      if (wallet.connected) {
        // #746 — pre-flight simulation before wallet prompt
        const res = await simulateThenSubmit("/build/complete", { jobId: id }, {
          action: "Complete Job (Release Funds)",
          targetContract: "Bear Escrow",
          budgetAmount: "—",
        });
        if (!res) {
          state.txPending = false;
          return;
        }
        hideTxOverlay();
      } else {
        showTxOverlay("Completing job & releasing funds...");
        await api("/jobs/" + id + "/complete", { method: "POST", body: { wallet: "buyer" } });
      }
      hideTxOverlay();
      toast("Job #" + id + " completed! Funds released.");
      await loadJobs();
      renderJobList();
    } catch (e) {
      hideTxOverlay();
      notifyError(e);
    } finally {
      state.txPending = false;
    }
  };

  window.__approveJob = async function (id) {
    if (state.txPending) return;
    state.txPending = true;
    try {
      if (wallet.connected) {
        // #746 — pre-flight simulation before wallet prompt
        const res = await simulateThenSubmit("/build/approve", { jobId: id }, {
          action: "Approve Job",
          targetContract: "Bear Escrow",
          budgetAmount: "—",
        });
        if (!res) {
          state.txPending = false;
          return;
        }
        hideTxOverlay();
      } else {
        showTxOverlay("Recording evaluator approval...");
        await api("/jobs/" + id + "/approve", { method: "POST", body: { wallet: "buyer" } });
      }
      hideTxOverlay();
      toast("Approval recorded for job #" + id + ".");
      await loadJobs();
      renderJobList();
    } catch (e) {
      hideTxOverlay();
      notifyError(e);
    } finally {
      state.txPending = false;
    }
  };

  window.__cancelJob = async function (id) {
    if (state.txPending) return;
    const confirmed = window.confirm("Cancel this job and refund the escrowed funds?");
    if (!confirmed) return;

    state.txPending = true;
    try {
      if (wallet.connected) {
        // #746 — pre-flight simulation before wallet prompt
        const res = await simulateThenSubmit("/build/cancel", { jobId: id }, {
          action: "Cancel Job (Refund)",
          targetContract: "Bear Escrow",
          budgetAmount: "—",
        });
        if (!res) {
          state.txPending = false;
          return;
        }
        hideTxOverlay();
      } else {
        showTxOverlay("Cancelling job & refunding...");
        await api("/jobs/" + id + "/cancel", { method: "POST", body: { wallet: "buyer" } });
      }
      hideTxOverlay();
      toast("Job #" + id + " cancelled. Funds refunded.");
      await loadJobs();
      renderJobList();
    } catch (e) {
      hideTxOverlay();
      notifyError(e);
    } finally {
      state.txPending = false;
    }
  };

  window.__showRegisterAgent = function () {
    var walletField = wallet.connected
      ? '<div class="form-group"><label class="form-label">Signing Wallet</label>' +
         '<div class="form-input signing-wallet-display" style="color:var(--accent);cursor:default">' +
         copyable(wallet.publicKey, "wallet public key") +
        " (" + connectedWalletLabel() + ")</div></div>"
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
    try {
      let agentId = null;
      if (wallet.connected) {
        // Pass 'connected' so the server uses the caller's public key regardless
        // of which wallet adapter (Freighter, Albedo, xBull…) is active. (#584)
        // #746 — pre-flight simulation before wallet prompt
        const res = await simulateThenSubmit("/agents/register", { wallet: "connected", uri: uri }, {
          action: "Register Agent",
          targetContract: "Agent Registry",
          budgetAmount: "—",
        });
        if (!res) {
          state.txPending = false;
          return;
        }
        hideTxOverlay();
        toast("Agent registered! tx: " + (res.hash || "").slice(0, 8) + "...");
      } else {
        showTxOverlay("Registering agent on Stellar...");
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
      notifyError(e);
    } finally {
      state.txPending = false;
    }
  };

  // ── Agent Profile view (#760) ──
  function setMetaTag(attr, key, content) {
    var el = document.head.querySelector('meta[' + attr + '="' + key + '"]');
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content);
  }

  function injectAgentOpenGraph(agent) {
    var title = "Agent #" + agent.id + " — Bear Protocol";
    var desc = agent.description || agent.uri || "On-chain AI agent profile on Bear Protocol";
    var url = window.location.href;
    document.title = title;
    setMetaTag("property", "og:title", title);
    setMetaTag("property", "og:description", desc);
    setMetaTag("property", "og:type", "profile");
    setMetaTag("property", "og:url", url);
    setMetaTag("name", "twitter:card", "summary");
    setMetaTag("name", "twitter:title", title);
    setMetaTag("name", "twitter:description", desc);
  }

  function resetOpenGraph() {
    document.title = "Bear Protocol Dashboard";
    setMetaTag("property", "og:title", "Bear Protocol Dashboard");
    setMetaTag("property", "og:description", "Escrow-based AI agent marketplace on Stellar");
    setMetaTag("property", "og:url", window.location.href);
  }

  async function renderAgentProfile(id) {
    setPage(
      '<div class="page-header"><div class="page-title">Agent Profile</div></div>' +
        skeletonCards(2) +
        skeletonList(3),
    );

    var agent = null;
    try {
      agent = await api("/agents/" + encodeURIComponent(String(id)));
    } catch (e) {
      agent = null;
    }
    if (!agent) {
      setPage(
        '<div class="empty-state">' +
          '<div class="empty-title">Agent not found</div>' +
          '<div class="empty-desc">No agent with ID #' + escapeHtml(String(id)) + " exists.</div>" +
          '<a href="#/agents" class="btn btn-secondary" style="margin-top:16px">Back to agents</a>' +
          "</div>",
      );
      return;
    }

    injectAgentOpenGraph(agent);

    // Load verified badges from the agent-identity contract
    var badges = [];
    try {
      var badgeData = await api("/agents/" + encodeURIComponent(String(id)) + "/badges", { _silent: true });
      var nowSeconds = Math.floor(Date.now() / 1000);
      badges = normalizeBadges(badgeData).filter(function (b) {
        return isBadgeActive(b, nowSeconds);
      });
    } catch (e) {
      badges = [];
    }

    // Recent job history for this agent
    var jobs = [];
    try {
      jobs = (await api("/jobs?agent=" + encodeURIComponent(String(id)), { _silent: true })) || [];
      if (!Array.isArray(jobs)) jobs = jobs.items || [];
    } catch (e) {
      jobs = [];
    }

    var shareUrl = window.location.origin + window.location.pathname + "#/agent/" + id;
    var capabilities = Array.isArray(agent.tags) ? agent.tags : [];
    var pricing = agent.pricing || agent.price || null;

    var capabilitiesHtml = "";
    if (capabilities.length > 0) {
      capabilitiesHtml = '<div class="agent-profile-section"><div class="agent-profile-heading">Capabilities</div><div class="agent-badges">';
      for (var i = 0; i < capabilities.length; i++) {
        capabilitiesHtml += '<span class="badge-chip"><span class="badge-chip-tag">' + escapeHtml(String(capabilities[i])) + "</span></span>";
      }
      capabilitiesHtml += "</div></div>";
    }

    var pricingHtml = "";
    if (pricing) {
      pricingHtml =
        '<div class="agent-profile-section"><div class="agent-profile-heading">Pricing</div>' +
        '<div class="agent-profile-pricing">' + escapeHtml(String(pricing)) + "</div></div>";
    }

    var historyHtml = '<div class="agent-profile-section"><div class="agent-profile-heading">Recent Jobs</div>';
    if (jobs.length === 0) {
      historyHtml += '<div class="empty-desc">No jobs yet.</div>';
    } else {
      historyHtml += '<div class="history-list">';
      for (var j = 0; j < jobs.length && j < 10; j++) {
        var job = jobs[j];
        historyHtml +=
          '<div class="history-row">' +
          '<div class="history-body"><div class="history-label">' + escapeHtml(job.description || "—") + "</div>" +
          '<div class="history-meta">' + formatMusd(job.budget) + " USDC</div></div>" +
          '<div class="history-right">' + statusBadge(job.status) + "</div>" +
          "</div>";
      }
      historyHtml += "</div>";
    }
    historyHtml += "</div>";

    setPage(
      '<div class="agent-profile">' +
        '<div class="agent-profile-banner"></div>' +
        '<div class="agent-profile-header">' +
        agentIdenticon(agent.owner) +
        '<div class="agent-profile-title-wrap">' +
        '<div class="agent-profile-title">Agent #' + escapeHtml(String(agent.id)) + "</div>" +
        '<div class="agent-profile-owner">Owner: ' + copyable(agent.owner, "wallet public key") + "</div>" +
        "</div>" +
        '<div class="agent-profile-actions">' +
        '<button class="btn btn-primary" onclick="window.__hireAgent(\'' + escapeHtml(String(agent.id)) + "')\">Hire Agent</button>" +
        '<button class="btn btn-secondary" onclick="window.__copyShareLink(\'' + escapeAttr(shareUrl) + "')\">Copy Link</button>" +
        "</div></div>" +
        renderBadgeChips(badges) +
        '<div class="agent-profile-section"><div class="agent-profile-heading">Bio</div>' +
        '<div class="agent-profile-bio">' + escapeHtml(agent.description || agent.uri || "No bio provided.") + "</div></div>" +
        pricingHtml +
        capabilitiesHtml +
        historyHtml +
        "</div>",
    );
  }

  window.__copyShareLink = function (url) {
    copyToClipboard(url, null);
  };

  window.__hireAgent = function (agentId) {
    window.__showCreateJob({ provider: agentId });
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

  function parseRoute(route) {
    var agentMatch = route.match(/^\/agent\/([^/]+)$/);
    if (agentMatch) {
      return { name: "agent", id: decodeURIComponent(agentMatch[1]) };
    }
    return { name: route, id: null };
  }

  function navigate() {
    const route = getRoute();
    const parsed = parseRoute(route);

    // Tear down any virtualized lists from the previous view so their scroll
    // listeners and DOM nodes don't leak across navigations (#762).
    destroyAllVirtualLists();

    // Update active nav
    document.querySelectorAll(".nav-item").forEach(function (el) {
      el.classList.toggle("active", el.dataset.route === route);
    });

    // Re-trigger page transition
    const page = document.getElementById("page");
    page.style.animation = "none";
    void page.offsetHeight;
    page.style.animation = "";

    if (parsed.name === "agent") {
      renderAgentProfile(parsed.id);
    } else {
      resetOpenGraph();
      const render = routes[route] || renderDashboard;
      render();
    }

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
    if (reliability.online === false) return; // skip while offline (#750)
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

  // ── Server-Sent Events: real-time Soroban event stream (#719) ──
  // Subscribes to GET /api/events/stream. When the stream is live we slow the
  // polling fallback down (or disable it) since events arrive instantly.
  // Browsers without EventSource keep the regular polling behaviour.
  var sse = {
    source: null,
    live: false,
    lastEventId: null,
    retryTimer: null,
    retryDelayMs: 1000,
    maxRetryDelayMs: 30000,
    // Polling interval to restore when the stream drops.
    fallbackIntervalMs: null,
  };

  // #581 — SSE connection status helpers
  function setSseStatus(status) {
    // status: 'connecting' | 'live' | 'reconnecting'
    var dots = [
      document.getElementById("sse-dot"),
      document.getElementById("sse-dot-desktop"),
    ];
    var labels = [
      document.getElementById("sse-label"),
      document.getElementById("sse-label-desktop"),
    ];
    var pills = [
      document.getElementById("sse-status-pill"),
      document.getElementById("sse-status-pill-desktop"),
    ];
    var text = status === "live" ? "Live" : status === "reconnecting" ? "Reconnecting…" : "Connecting…";
    dots.forEach(function (d) {
      if (!d) return;
      d.className = "sse-dot sse-dot-" + status;
    });
    labels.forEach(function (l) { if (l) l.textContent = text; });
    pills.forEach(function (p) {
      if (!p) return;
      p.className = "sse-status-pill sse-" + status + (p.classList.contains("sse-status-sidebar") ? " sse-status-sidebar" : "");
    });
  }

  // While the stream is live, polling is only a safety net: slow it down to
  // 60 s (or keep it off if the user explicitly disabled auto-refresh).
  function applyLivePolling() {
    if (sse.fallbackIntervalMs === null) sse.fallbackIntervalMs = pollIntervalMs;
    if (pollIntervalMs === 0) return;
    pollIntervalMs = 60000;
    startPolling();
  }

  function restoreFallbackPolling() {
    if (sse.fallbackIntervalMs === null) return;
    pollIntervalMs = sse.fallbackIntervalMs;
    sse.fallbackIntervalMs = null;
    startPolling();
  }

  // Refresh whichever view is currently visible after a new event arrives.
  function refreshCurrentView() {
    var route = getRoute();
    if (route === "/") {
      renderDashboard();
    } else if (route === "/agents") {
      loadAgents().then(function () { renderAgents(); }).catch(function () {});
    } else if (route === "/jobs") {
      loadJobs().then(function () { renderJobList(); }).catch(function () {});
    } else if (route === "/wallet") {
      loadWallets().then(function () { renderWallets(); }).catch(function () {});
    } else if (route === "/history") {
      Promise.all([loadJobs(), loadAgents(1, false)])
        .then(function () { renderHistory(); })
        .catch(function () {});
    }
  }

  function handleStreamEvent(e) {
    setSseStatus("live");
    if (e && e.lastEventId) sse.lastEventId = e.lastEventId;
    var payload = null;
    try {
      payload = e && e.data ? JSON.parse(e.data) : null;
    } catch (err) {
      payload = null;
    }
    // Invalidation events from the legacy stream just trigger a poll.
    if (payload && payload.type === "invalidate") {
      poll();
      return;
    }
    // Newly indexed Soroban events: refresh the active view immediately.
    refreshCurrentView();
  }

  function scheduleReconnect() {
    if (sse.retryTimer) return;
    var delay = sse.retryDelayMs;
    sse.retryDelayMs = Math.min(sse.retryDelayMs * 2, sse.maxRetryDelayMs);
    sse.retryTimer = setTimeout(function () {
      sse.retryTimer = null;
      connectEventStream();
    }, delay);
  }

  function connectEventStream() {
    if (typeof EventSource === "undefined") return; // polling fallback
    if (sse.source) {
      try { sse.source.close(); } catch (e) {}
      sse.source = null;
    }
    var url = "/api/events/stream";
    // Resume from the last seen event id so no events are missed on reconnect.
    if (sse.lastEventId) {
      url += "?lastEventId=" + encodeURIComponent(sse.lastEventId);
    }
    setSseStatus("connecting");
    try {
      var es = new EventSource(url);
      sse.source = es;

      es.onopen = function () {
        sse.live = true;
        sse.retryDelayMs = 1000;
        setSseStatus("live");
        applyLivePolling();
      };

      // Named event types emitted by the indexer EventHub.
      ["event", "soroban_event", "invalidate"].forEach(function (name) {
        es.addEventListener(name, handleStreamEvent);
      });

      // Default (unnamed) messages also carry events.
      es.onmessage = handleStreamEvent;

      es.addEventListener("ping", function () {
        setSseStatus("live");
      });

      es.onerror = function () {
        sse.live = false;
        setSseStatus("reconnecting");
        try { es.close(); } catch (e) {}
        sse.source = null;
        restoreFallbackPolling();
        // EventSource auto-reconnects, but we manage backoff ourselves so we
        // can attach Last-Event-ID and avoid hammering a downed server.
        scheduleReconnect();
      };
    } catch (e) {
      // ignore SSE setup failures — polling remains the fallback
      restoreFallbackPolling();
      scheduleReconnect();
    }
  }

  connectEventStream();

  // Initial render
  renderNetworkBadge();
  navigate();

  // Sync the refresh-interval dropdown to the restored/default interval
  (function syncRefreshSelect() {
    var sel = document.getElementById("refresh-interval-select");
    if (sel) sel.value = String(pollIntervalMs);
  })();
})();
