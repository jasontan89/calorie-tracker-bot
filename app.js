/**
 * Calorie Tracker Bot - Telegram Mini App (Web App)
 * Interacts with Supabase Edge Function API using authenticated Telegram WebApp initData.
 */

const API_BASE_URL = "https://blcsjvifiytbznwesmyx.supabase.co/functions/v1/telegram-bot";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsY3NqdmlmaXl0Ynpud2VzbXl4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MTkzNDcsImV4cCI6MjA5ODM5NTM0N30.PhO08MviDmKyRn941IngM9-WaG_j7lwiCL5IqzG5qt0";

// Global App State
let appState = {
  user: null,
  profile: null,
  todayDate: "",
  selectedDate: "",
  todayTotals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
  macroTargets: { protein: 150, carbs: 200, fat: 67 },
  todayLogs: [],
  history7d: [],
  presets: [],
  activeFast: null,
  recentFasts: [],
  currentChartView: "calories",
  chartInstance: null
};

// Fasting Timer state & interval
let fastingTimerInterval = null;
let selectedFastHours = 16;

// Barcode Scanner state
let html5QrCodeScanner = null;
let isScannerActive = false;
let isProcessingScan = false;
let currentScannedProduct = null;
let currentServingMultiplier = 1.0;

// Telegram WebApp Object Reference
const tg = window.Telegram?.WebApp;

/**
 * Robust initData extraction: reads from Telegram SDK or directly from location hash (#tgWebAppData=...)
 */
function getTelegramInitData() {
  if (tg?.initData) {
    return tg.initData;
  }
  try {
    const hash = window.location.hash.substring(1);
    if (hash) {
      const p = new URLSearchParams(hash);
      const tgData = p.get("tgWebAppData");
      if (tgData) return tgData;
    }
  } catch (e) {}
  return "";
}

/**
 * Build request headers with Supabase apikey
 */
function getApiHeaders(customHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    ...customHeaders
  };
  const initData = getTelegramInitData();
  if (initData) {
    try {
      headers["X-Telegram-Init-Data"] = encodeURIComponent(initData);
    } catch (e) {
      headers["X-Telegram-Init-Data"] = initData;
    }
  }
  return headers;
}

/**
 * Centralized API fetch helper: automatically injects query params, initData, headers, and body
 */
async function callApi(action, options = {}) {
  const initData = getTelegramInitData();
  const params = new URLSearchParams(options.params || {});
  params.set("api", action);
  if (initData) {
    params.set("initData", initData);
  }

  const url = `${API_BASE_URL}?${params.toString()}`;
  const headers = getApiHeaders(options.headers || {});

  const fetchOptions = {
    method: options.method || "GET",
    headers: headers,
    signal: options.signal
  };

  if (options.body) {
    fetchOptions.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }

  return await fetch(url, fetchOptions);
}

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", () => {
  initTelegramWebApp();
  setupEventListeners();
  fetchDashboardData();
});

/**
 * Initialize Telegram WebApp SDK
 */
function initTelegramWebApp() {
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.enableClosingConfirmation();
    } catch (e) {}

    // Apply header & background color based on Telegram theme
    if (tg.themeParams) {
      if (tg.themeParams.bg_color) {
        document.documentElement.style.setProperty("--bg-color", tg.themeParams.bg_color);
      }
      if (tg.themeParams.secondary_bg_color) {
        document.documentElement.style.setProperty("--secondary-bg-color", tg.themeParams.secondary_bg_color);
      }
      if (tg.themeParams.text_color) {
        document.documentElement.style.setProperty("--text-color", tg.themeParams.text_color);
      }
      if (tg.themeParams.button_color) {
        document.documentElement.style.setProperty("--button-color", tg.themeParams.button_color);
      }
    }

    // Set User details from Telegram
    if (tg.initDataUnsafe?.user) {
      const u = tg.initDataUnsafe.user;
      const userNameElem = document.getElementById("user-name");
      const userAvatarElem = document.getElementById("user-avatar");
      if (userNameElem) userNameElem.textContent = u.first_name + (u.last_name ? ` ${u.last_name}` : "");
      if (userAvatarElem && u.first_name) {
        userAvatarElem.textContent = u.first_name.charAt(0).toUpperCase();
      }
    }
  }
}

/**
 * Setup Event Listeners for Tabs, Toggles, Fasting, Barcode, and Forms
 */
function setupEventListeners() {
  // Tab Switching
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-tab");
      switchTab(tabId);
      triggerHaptic("light");
    });
  });

  // Chart View Toggle (Calories vs Macros)
  document.getElementById("btn-chart-cal")?.addEventListener("click", () => {
    appState.currentChartView = "calories";
    document.getElementById("btn-chart-cal").classList.add("active");
    document.getElementById("btn-chart-macros").classList.remove("active");
    renderChart();
    triggerHaptic("light");
  });

  document.getElementById("btn-chart-macros")?.addEventListener("click", () => {
    appState.currentChartView = "macros";
    document.getElementById("btn-chart-macros").classList.add("active");
    document.getElementById("btn-chart-cal").classList.remove("active");
    renderChart();
    triggerHaptic("light");
  });

  // Fasting Preset Selection Pills
  document.querySelectorAll(".btn-fast-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".btn-fast-preset").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedFastHours = parseInt(btn.getAttribute("data-hours"), 10) || 16;
      const startBtn = document.getElementById("btn-start-fast");
      if (startBtn) startBtn.textContent = `⏰ Start ${selectedFastHours}h Fast`;
      triggerHaptic("light");
    });
  });

  // Fasting Actions (Start, Stop, Cancel)
  document.getElementById("btn-start-fast")?.addEventListener("click", () => {
    handleStartFast(selectedFastHours);
    triggerHaptic("medium");
  });

  document.getElementById("btn-stop-fast")?.addEventListener("click", () => {
    handleStopFast();
    triggerHaptic("warning");
  });

  document.getElementById("btn-cancel-fast")?.addEventListener("click", () => {
    handleCancelFast();
    triggerHaptic("light");
  });

  // Barcode Scanner Modal Controls
  document.getElementById("btn-open-scanner")?.addEventListener("click", () => {
    openBarcodeScanner();
    triggerHaptic("medium");
  });

  document.getElementById("btn-close-scanner")?.addEventListener("click", () => {
    closeBarcodeScanner();
    triggerHaptic("light");
  });

  document.getElementById("btn-search-barcode")?.addEventListener("click", () => {
    const input = document.getElementById("input-manual-barcode");
    const code = input?.value?.trim();
    if (code) {
      lookupBarcodeProduct(code);
      triggerHaptic("medium");
    } else {
      showToast("Please enter barcode digits", true);
    }
  });

  // Barcode Product Result Modal Controls
  document.getElementById("btn-close-result-modal")?.addEventListener("click", () => {
    closeProductResultModal();
    triggerHaptic("light");
  });

  // Serving Multiplier Pills
  document.querySelectorAll(".portion-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".portion-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentServingMultiplier = parseFloat(pill.getAttribute("data-mul")) || 1.0;
      updateProductResultCalculations();
      triggerHaptic("light");
    });
  });

  document.getElementById("btn-log-barcode-item")?.addEventListener("click", () => {
    handleLogBarcodeProduct();
    triggerHaptic("success");
  });

  // Weekly Report Button
  document.getElementById("btn-generate-weekly-report")?.addEventListener("click", () => {
    handleGenerateWeeklyReport();
    triggerHaptic("medium");
  });

  // Persona Selection Cards
  document.querySelectorAll(".persona-card").forEach((card) => {
    card.addEventListener("click", () => {
      const persona = card.getAttribute("data-persona");
      updatePersona(persona);
      triggerHaptic("medium");
    });
  });

  // Logging Mode Selection Cards
  document.querySelectorAll(".mode-card").forEach((card) => {
    card.addEventListener("click", () => {
      const mode = card.getAttribute("data-mode");
      updateLoggingMode(mode);
      triggerHaptic("medium");
    });
  });

  // Target Goal Save Button
  document.getElementById("btn-save-target")?.addEventListener("click", () => {
    const input = document.getElementById("input-daily-target");
    const val = parseInt(input.value, 10);
    if (!val || val <= 0) {
      showToast("Please enter a valid positive number", true);
      return;
    }
    updateCalorieTarget(val);
    triggerHaptic("medium");
  });

  // Custom Macro Targets Save Button
  document.getElementById("btn-save-macros")?.addEventListener("click", () => {
    const p = parseInt(document.getElementById("input-target-p")?.value, 10);
    const c = parseInt(document.getElementById("input-target-c")?.value, 10);
    const f = parseInt(document.getElementById("input-target-f")?.value, 10);

    if (isNaN(p) || isNaN(c) || isNaN(f) || p < 0 || c < 0 || f < 0) {
      showToast("Please enter valid positive numbers for macros", true);
      return;
    }
    updateMacroTargets(p, c, f);
    triggerHaptic("medium");
  });

  // Auto-calculate Macros Button
  document.getElementById("btn-auto-macros")?.addEventListener("click", () => {
    resetToAutoMacros();
    triggerHaptic("light");
  });

  // CSV Export Button
  document.getElementById("btn-export-csv")?.addEventListener("click", () => {
    exportFoodLogsCSV();
    triggerHaptic("medium");
  });

  // Reconnect button on full-screen loading overlay
  document.getElementById("loading-reconnect-btn")?.addEventListener("click", () => {
    triggerHaptic("medium");
    fetchDashboardData(1);
  });

  // Retry Button (if present)
  document.getElementById("retry-btn")?.addEventListener("click", () => {
    const banner = document.getElementById("error-banner");
    if (banner) banner.style.display = "none";
    fetchDashboardData(1);
  });
}

/**
 * Switch Navigation Tab
 */
function switchTab(tabId) {
  document.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

  const targetTabBtn = document.querySelector(`[data-tab="${tabId}"]`);
  const targetContent = document.getElementById(tabId);

  if (targetTabBtn) targetTabBtn.classList.add("active");
  if (targetContent) targetContent.classList.add("active");
}

let isInitialLoad = true;

/**
 * Fetch Main Dashboard Data from Backend API
 * Automatically handles Edge Function cold starts with progressive status updates & auto-retry.
 */
async function fetchDashboardData(attempt = 1) {
  const maxRetries = 3;
  showLoading(true);

  const statusTextElem = document.getElementById("loading-status-text");
  const spinnerAnimElem = document.getElementById("loading-spinner-anim");
  const reconnectWrap = document.getElementById("loading-reconnect-wrap");

  if (reconnectWrap) reconnectWrap.style.display = "none";
  if (spinnerAnimElem) spinnerAnimElem.style.display = "block";

  // Progressive status updates for user feedback during cold starts
  if (statusTextElem) {
    if (attempt === 1) {
      statusTextElem.textContent = "Loading your nutrition data...";
    } else {
      statusTextElem.textContent = `Connecting to server (attempt ${attempt} of ${maxRetries})...`;
    }
  }

  // Timer 1: after 3.5 seconds
  const timer1 = setTimeout(() => {
    if (statusTextElem) {
      statusTextElem.textContent = "Waking up server & syncing live logs...";
    }
  }, 3500);

  // Timer 2: after 8 seconds
  const timer2 = setTimeout(() => {
    if (statusTextElem) {
      statusTextElem.textContent = "Almost ready, fetching your latest records...";
    }
  }, 8000);

  // Timer 3: after 16 seconds
  const timer3 = setTimeout(() => {
    if (statusTextElem) {
      statusTextElem.textContent = "Establishing secure database session...";
    }
  }, 16000);

  // Generous 35-second timeout per attempt to allow cold starts to finish
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35000);

  const clearAllTimers = () => {
    clearTimeout(timer1);
    clearTimeout(timer2);
    clearTimeout(timer3);
    clearTimeout(timeoutId);
  };

  try {
    const response = await callApi("dashboard", { signal: controller.signal });
    clearAllTimers();

    if (!response.ok) {
      throw new Error(`API returned HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data || !data.profile) {
      throw new Error("Invalid dashboard payload received from server");
    }

    // Successfully received real user data
    appState = {
      ...appState,
      ...data,
      selectedDate: data.todayDate || new Date().toISOString().substring(0, 10)
    };

    isInitialLoad = false;
    renderAllViews();
    showLoading(false);

    const errorBanner = document.getElementById("error-banner");
    if (errorBanner) errorBanner.style.display = "none";
  } catch (err) {
    clearAllTimers();
    console.warn(`Dashboard fetch attempt ${attempt} failed:`, err);

    // If we haven't exhausted our automatic retries, retry automatically after a short delay
    if (attempt < maxRetries) {
      if (statusTextElem) {
        statusTextElem.textContent = `Server cold start in progress. Retrying in a moment... (${attempt + 1}/${maxRetries})`;
      }
      await new Promise((r) => setTimeout(r, 1200));
      return fetchDashboardData(attempt + 1);
    }

    // All automatic retries exhausted
    console.error("All dashboard load attempts failed:", err);

    if (isInitialLoad && !appState.profile) {
      // Keep loading overlay up so user NEVER sees blank/demo data or an offline banner!
      if (spinnerAnimElem) spinnerAnimElem.style.display = "none";
      if (statusTextElem) {
        statusTextElem.textContent = "Unable to connect to server. Please check your internet connection.";
      }
      if (reconnectWrap) {
        reconnectWrap.style.display = "block";
      }
    } else {
      // Already had loaded session; notify softly with toast
      showLoading(false);
      showToast("Could not refresh data. Check your connection.", true);
    }
  }
}

/**
 * Render All UI Components
 */
function renderAllViews() {
  if (!appState.profile) return;
  try {
    renderHeader();
    renderSummaryCard();
    renderFastingCard();
    renderChart();
    renderDatePills();
    renderMealsList();
    renderPresetsList();
    renderSettingsView();
  } catch (renderErr) {
    console.error("Error rendering views:", renderErr);
  }
}

/**
 * Render Header Badges
 */
function renderHeader() {
  const profile = appState.profile;
  if (profile) {
    const streakElem = document.getElementById("streak-count");
    const targetElem = document.getElementById("header-target");
    const userNameElem = document.getElementById("user-name");
    const avatarElem = document.getElementById("user-avatar");

    if (streakElem) streakElem.textContent = profile.streak_count || 0;
    if (targetElem) targetElem.textContent = profile.daily_target || 2000;
    if (userNameElem && profile.first_name) userNameElem.textContent = profile.first_name;
    if (avatarElem && profile.first_name) avatarElem.textContent = profile.first_name.charAt(0).toUpperCase();
  }
  if (appState.todayDate) {
    const dateBadge = document.getElementById("current-date-badge");
    if (dateBadge) dateBadge.textContent = `${appState.todayDate} (SGT)`;
  }
}

/**
 * Render Today's Calorie & Macro Progress Card
 */
function renderSummaryCard() {
  const target = appState.profile?.daily_target || 2000;
  const current = appState.todayTotals?.calories || 0;
  const remaining = target - current;

  const todayCalElem = document.getElementById("today-calories");
  const todayTargetElem = document.getElementById("today-target");
  if (todayCalElem) todayCalElem.textContent = current.toLocaleString();
  if (todayTargetElem) todayTargetElem.textContent = target.toLocaleString();

  const pct = Math.min(Math.round((current / target) * 100), 100);
  const fillBar = document.getElementById("calorie-bar-fill");
  if (fillBar) fillBar.style.width = `${pct}%`;

  const budgetBadge = document.getElementById("calorie-budget-badge");
  const remainingText = document.getElementById("calorie-remaining-text");

  if (budgetBadge && remainingText) {
    if (remaining >= 0) {
      budgetBadge.textContent = `${pct}% consumed`;
      budgetBadge.style.color = "var(--primary-accent)";
      budgetBadge.style.borderColor = "rgba(16, 185, 129, 0.3)";
      remainingText.textContent = `🍏 ${remaining.toLocaleString()} kcal left in daily budget`;
      if (fillBar) fillBar.classList.remove("over-target");
    } else {
      const over = Math.abs(remaining);
      budgetBadge.textContent = `${over} kcal OVER`;
      budgetBadge.style.color = "var(--danger-color)";
      budgetBadge.style.borderColor = "rgba(239, 68, 68, 0.3)";
      remainingText.textContent = `⚠️ Over budget by ${over.toLocaleString()} kcal`;
      if (fillBar) fillBar.classList.add("over-target");
    }
  }

  // Macronutrients
  const pTarget = appState.macroTargets?.protein || 150;
  const cTarget = appState.macroTargets?.carbs || 200;
  const fTarget = appState.macroTargets?.fat || 67;

  const pVal = appState.todayTotals?.protein || 0;
  const cVal = appState.todayTotals?.carbs || 0;
  const fVal = appState.todayTotals?.fat || 0;

  const pValElem = document.getElementById("macro-p-val");
  const pTargetElem = document.getElementById("macro-p-target");
  const pFillElem = document.getElementById("macro-p-fill");
  if (pValElem) pValElem.textContent = pVal;
  if (pTargetElem) pTargetElem.textContent = pTarget;
  if (pFillElem) pFillElem.style.width = `${Math.min(Math.round((pVal / pTarget) * 100), 100)}%`;

  const cValElem = document.getElementById("macro-c-val");
  const cTargetElem = document.getElementById("macro-c-target");
  const cFillElem = document.getElementById("macro-c-fill");
  if (cValElem) cValElem.textContent = cVal;
  if (cTargetElem) cTargetElem.textContent = cTarget;
  if (cFillElem) cFillElem.style.width = `${Math.min(Math.round((cVal / cTarget) * 100), 100)}%`;

  const fValElem = document.getElementById("macro-f-val");
  const fTargetElem = document.getElementById("macro-f-target");
  const fFillElem = document.getElementById("macro-f-fill");
  if (fValElem) fValElem.textContent = fVal;
  if (fTargetElem) fTargetElem.textContent = fTarget;
  if (fFillElem) fFillElem.style.width = `${Math.min(Math.round((fVal / fTarget) * 100), 100)}%`;
}

// ── FASTING TIMER COMPONENT ──────────────────────────────────────────────────

/**
 * Render Intermittent Fasting Card
 */
function renderFastingCard() {
  const activeView = document.getElementById("fasting-active-view");
  const idleView = document.getElementById("fasting-idle-view");
  const badge = document.getElementById("fasting-status-badge");

  if (!activeView || !idleView || !badge) return;

  if (fastingTimerInterval) {
    clearInterval(fastingTimerInterval);
    fastingTimerInterval = null;
  }

  const fast = appState.activeFast;
  if (fast && fast.status === "active") {
    activeView.style.display = "block";
    idleView.style.display = "none";
    badge.textContent = "🔥 Fasting Active";
    badge.style.color = "#f59e0b";
    badge.style.borderColor = "rgba(245, 158, 11, 0.4)";

    updateFastingRingUI();
    fastingTimerInterval = setInterval(updateFastingRingUI, 1000);
  } else {
    activeView.style.display = "none";
    idleView.style.display = "block";
    badge.textContent = "🍽️ Not Fasting";
    badge.style.color = "var(--hint-color)";
    badge.style.borderColor = "var(--card-border)";
  }
}

/**
 * Helper to determine metabolic fasting stage based on elapsed hours
 */
function getMetabolicStage(elapsedHours) {
  if (elapsedHours < 4) {
    return {
      emoji: "🥗",
      name: "Anabolic / Fed State",
      desc: "Digesting food, blood glucose & insulin elevated.",
      color: "#3b82f6"
    };
  } else if (elapsedHours < 12) {
    return {
      emoji: "📉",
      name: "Glycogen Depletion",
      desc: "Insulin drops, body switches to liver glycogen stores.",
      color: "#6366f1"
    };
  } else if (elapsedHours < 16) {
    return {
      emoji: "🔥",
      name: "Ketosis / Fat Burning",
      desc: "Accelerated lipolysis as body burns fat for energy.",
      color: "#f59e0b"
    };
  } else if (elapsedHours < 18) {
    return {
      emoji: "🧬",
      name: "Autophagy Induction",
      desc: "Cellular cleanup initiated, clearing damaged proteins.",
      color: "#10b981"
    };
  } else if (elapsedHours < 24) {
    return {
      emoji: "⚡",
      name: "Deep Autophagy",
      desc: "Growth hormone elevated, enhanced cellular renewal.",
      color: "#8b5cf6"
    };
  } else {
    return {
      emoji: "🛡️",
      name: "Extended Fasting",
      desc: "Maximum autophagy and stem cell regeneration.",
      color: "#ec4899"
    };
  }
}

/**
 * Helper to compute relative day label in Singapore Time (SGT)
 */
function getSGTRelativeDayStr(targetDate, nowDate = new Date()) {
  const getSGTStr = (d) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d instanceof Date ? d : new Date(d));

  const targetStr = getSGTStr(targetDate);
  const nowStr = getSGTStr(nowDate);

  const diffDays = Math.round(
    (Date.parse(targetStr + "T00:00:00Z") - Date.parse(nowStr + "T00:00:00Z")) / 86400000
  );

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";

  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short"
  }).format(targetDate instanceof Date ? targetDate : new Date(targetDate));
}

/**
 * Update Fasting Progress Ring & Countdown Values
 */
function updateFastingRingUI() {
  const fast = appState.activeFast;
  if (!fast || fast.status !== "active") return;

  const start = new Date(fast.start_time).getTime();
  const now = Date.now();
  const elapsedMs = Math.max(0, now - start);
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  const targetHours = Number(fast.target_hours) || 16;
  const targetEndMs = start + targetHours * 60 * 60 * 1000;
  const remainingMs = Math.max(0, targetEndMs - now);

  const elapsedH = Math.floor(elapsedHours);
  const elapsedM = Math.floor((elapsedMs % (1000 * 60 * 60)) / (1000 * 60));
  const elapsedS = Math.floor((elapsedMs % (1000 * 60)) / 1000);

  const remH = Math.floor(remainingMs / (1000 * 60 * 60));
  const remM = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

  const pct = Math.min(100, Math.round((elapsedHours / targetHours) * 100));
  const isGoalReached = now >= targetEndMs;

  const circle = document.getElementById("fasting-ring-circle");
  const circumference = 2 * Math.PI * 52;
  const offset = circumference - (pct / 100) * circumference;

  if (circle) {
    circle.style.strokeDashoffset = offset;
    circle.style.stroke = isGoalReached ? "#10b981" : "#f59e0b";
  }

  const elapsedElem = document.getElementById("fasting-elapsed-time");
  if (elapsedElem) {
    elapsedElem.textContent = `${elapsedH}h ${elapsedM}m ${elapsedS}s`;
  }

  const pctElem = document.getElementById("fasting-pct-text");
  if (pctElem) {
    pctElem.textContent = `${pct}% of ${targetHours}h`;
  }

  // Update Metabolic Stage Pill & Description
  const stage = getMetabolicStage(elapsedHours);
  const stagePill = document.getElementById("fasting-stage-pill");
  if (stagePill) {
    stagePill.textContent = `${stage.emoji} ${stage.name}`;
    stagePill.style.color = stage.color;
    stagePill.style.borderColor = `${stage.color}4d`;
    stagePill.style.backgroundColor = `${stage.color}1a`;
  }

  const stageDesc = document.getElementById("fasting-stage-desc");
  if (stageDesc) {
    stageDesc.textContent = stage.desc;
  }

  const goalElem = document.getElementById("fasting-goal-text");
  if (goalElem) {
    goalElem.textContent = isGoalReached ? "🎉 Fasting Target Achieved!" : `Target: ${targetHours} Hours`;
  }

  const finishElem = document.getElementById("fasting-finish-text");
  if (finishElem) {
    const endObj = new Date(targetEndMs);
    const timeStr = new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    }).format(endObj);
    const dayLabel = getSGTRelativeDayStr(endObj, new Date(now));

    finishElem.textContent = isGoalReached 
      ? `Completed ${dayLabel.toLowerCase() === "today" ? "today" : dayLabel} at ${timeStr} (SGT)` 
      : `End: ${dayLabel} at ${timeStr} (SGT) • ${remH}h ${remM}m left`;
  }
}

/**
 * Start Fasting via API
 */
async function handleStartFast(targetHours) {
  showLoading(true);
  try {
    const res = await callApi("start_fast", {
      method: "POST",
      body: { target_hours: targetHours }
    });

    if (!res.ok) throw new Error("Failed to start fast");
    const data = await res.json();
    appState.activeFast = data.fast;

    showLoading(false);
    showToast(`⏰ Started ${targetHours}h Fast! Stay hydrated.`);
    renderFastingCard();
  } catch (err) {
    showLoading(false);
    console.error("Error starting fast:", err);
    showToast("Failed to start fast", true);
  }
}

/**
 * Stop Fasting via API
 */
async function handleStopFast() {
  const proceed = async () => {
    showLoading(true);
    try {
      const res = await callApi("stop_fast", { method: "POST" });

      if (!res.ok) throw new Error("Failed to stop fast");
      appState.activeFast = null;

      showLoading(false);
      showToast("🎉 Fast Completed! Great discipline.");
      fetchDashboardData();
    } catch (err) {
      showLoading(false);
      console.error("Error stopping fast:", err);
      showToast("Failed to complete fast", true);
    }
  };

  if (tg?.showConfirm) {
    tg.showConfirm("Are you ready to end your fast?", (ok) => {
      if (ok) proceed();
    });
  } else if (confirm("Are you ready to end your fast?")) {
    proceed();
  }
}

/**
 * Cancel Fasting via API
 */
async function handleCancelFast() {
  showLoading(true);
  try {
    await callApi("cancel_fast", { method: "POST" });

    appState.activeFast = null;
    showLoading(false);
    showToast("Fast cancelled.");
    renderFastingCard();
  } catch (err) {
    showLoading(false);
    console.error("Error cancelling fast:", err);
  }
}

// ── BARCODE SCANNER COMPONENT ────────────────────────────────────────────────

/**
 * Open Barcode Scanner Modal & Launch Camera
 */
function openBarcodeScanner() {
  const modal = document.getElementById("scanner-modal");
  if (!modal) return;
  modal.style.display = "flex";
  isProcessingScan = false;

  if (window.Html5Qrcode) {
    try {
      html5QrCodeScanner = new Html5Qrcode("scanner-reader");
      const config = { fps: 10, qrbox: { width: 250, height: 180 }, aspectRatio: 1.0 };
      
      html5QrCodeScanner.start(
        { facingMode: "environment" },
        config,
        (decodedText) => {
          if (isProcessingScan) return;
          isProcessingScan = true;
          triggerHaptic("success");
          closeBarcodeScanner();
          lookupBarcodeProduct(decodedText);
        },
        () => {}
      ).then(() => {
        isScannerActive = true;
      }).catch((err) => {
        console.error("Camera access error:", err);
        showToast("Camera permission needed to scan barcodes", true);
      });
    } catch (scannerErr) {
      console.error("Scanner init error:", scannerErr);
    }
  }
}

/**
 * Close Barcode Scanner Modal & Stop Camera
 */
function closeBarcodeScanner() {
  const modal = document.getElementById("scanner-modal");
  if (modal) modal.style.display = "none";

  if (html5QrCodeScanner && isScannerActive) {
    html5QrCodeScanner.stop().then(() => {
      html5QrCodeScanner.clear();
      isScannerActive = false;
    }).catch((e) => console.error("Error stopping scanner:", e));
  }
}

/**
 * Lookup Barcode Product on Open Food Facts
 */
async function lookupBarcodeProduct(barcode) {
  showLoading(true);
  try {
    const res = await callApi("lookup_barcode", {
      params: { barcode: barcode }
    });

    if (!res.ok) {
      showLoading(false);
      showToast(`Product not found for barcode ${barcode}. Try manual logging!`, true);
      return;
    }

    const data = await res.json();
    currentScannedProduct = data.product;
    currentServingMultiplier = 1.0;

    showLoading(false);
    openProductResultModal(currentScannedProduct);
  } catch (err) {
    showLoading(false);
    console.error("Barcode lookup error:", err);
    showToast("Failed to lookup barcode", true);
  }
}

/**
 * Open Product Result Modal with Nutritional breakdown
 */
function openProductResultModal(product) {
  const modal = document.getElementById("barcode-result-modal");
  if (!modal || !product) return;

  const nameElem = document.getElementById("product-name");
  const servingElem = document.getElementById("product-serving-label");
  const imgWrap = document.getElementById("product-img-wrap");

  if (nameElem) nameElem.textContent = product.name;
  if (servingElem) servingElem.textContent = product.serving || "1 serving";

  if (imgWrap) {
    if (product.image) {
      imgWrap.innerHTML = `<img src="${escapeHtml(product.image)}" alt="Product">`;
    } else {
      imgWrap.innerHTML = `🥫`;
    }
  }

  // Reset portion multiplier pills
  document.querySelectorAll(".portion-pill").forEach((p) => {
    if (p.getAttribute("data-mul") === "1.0") p.classList.add("active");
    else p.classList.remove("active");
  });

  updateProductResultCalculations();
  modal.style.display = "flex";
}

/**
 * Close Product Result Modal
 */
function closeProductResultModal() {
  const modal = document.getElementById("barcode-result-modal");
  if (modal) modal.style.display = "none";
}

/**
 * Recalculate Nutrition Values in Result Modal based on multiplier
 */
function updateProductResultCalculations() {
  if (!currentScannedProduct) return;
  const mul = currentServingMultiplier;

  const cal = Math.round(currentScannedProduct.calories * mul);
  const p = Math.round(currentScannedProduct.protein * mul);
  const c = Math.round(currentScannedProduct.carbs * mul);
  const f = Math.round(currentScannedProduct.fat * mul);

  const calElem = document.getElementById("product-cal-val");
  const pElem = document.getElementById("product-p-val");
  const cElem = document.getElementById("product-c-val");
  const fElem = document.getElementById("product-f-val");

  if (calElem) calElem.textContent = `${cal} kcal`;
  if (pElem) pElem.textContent = `${p}g`;
  if (cElem) cElem.textContent = `${c}g`;
  if (fElem) fElem.textContent = `${f}g`;
}

/**
 * Log Scanned Barcode Product via API
 */
async function handleLogBarcodeProduct() {
  if (!currentScannedProduct) return;
  showLoading(true);

  const mul = currentServingMultiplier;
  const cal = Math.round(currentScannedProduct.calories * mul);
  const p = Math.round(currentScannedProduct.protein * mul);
  const c = Math.round(currentScannedProduct.carbs * mul);
  const f = Math.round(currentScannedProduct.fat * mul);
  const mealType = document.getElementById("select-meal-type")?.value || "Meal";

  try {
    const res = await callApi("log_barcode_meal", {
      method: "POST",
      body: {
        food_name: currentScannedProduct.name,
        calories: cal,
        protein: p,
        carbs: c,
        fat: f,
        meal_type: mealType,
        barcode: currentScannedProduct.barcode
      }
    });

    if (!res.ok) throw new Error("Failed to log barcode food");
    const data = await res.json().catch(() => ({}));

    closeProductResultModal();
    showLoading(false);

    if (data && data.stopped_fast) {
      appState.activeFast = null;
      renderFastingCard();
      const dur = data.stopped_fast.elapsed_minutes || 0;
      const h = Math.floor(dur / 60);
      const m = dur % 60;
      showToast(`Logged food & Fast concluded (${h}h ${m}m)! ⏱️`);
    } else {
      showToast(`Logged ${currentScannedProduct.name} (${cal} kcal)! ✅`);
    }

    triggerHaptic("success");
    fetchDashboardData();
  } catch (err) {
    showLoading(false);
    console.error("Error logging barcode item:", err);
    showToast("Failed to save food log", true);
  }
}

/**
 * Generate Weekly Visual Infographic Report Card via API
 */
async function handleGenerateWeeklyReport() {
  showLoading(true);
  try {
    const res = await callApi("generate_weekly_report", { method: "POST" });

    showLoading(false);
    if (res.ok) {
      showToast("📊 7-Day Visual Report Card sent to your Telegram chat!");
      triggerHaptic("success");
    } else {
      showToast("Failed to generate weekly report", true);
    }
  } catch (err) {
    showLoading(false);
    console.error("Weekly report error:", err);
    showToast("Failed to generate report", true);
  }
}

/**
 * Render Interactive 7-Day Chart
 */
function renderChart() {
  const ctx = document.getElementById("historyChart")?.getContext("2d");
  if (!ctx) return;

  if (appState.chartInstance) {
    appState.chartInstance.destroy();
  }

  const history = appState.history7d || [];
  const labels = history.map((d) => d.label || d.date.substring(5));
  const target = appState.profile?.daily_target || 2000;

  let datasets = [];

  if (appState.currentChartView === "calories") {
    const calorieData = history.map((d) => d.calories || 0);
    const targetData = history.map(() => target);

    datasets = [
      {
        label: "Calories (kcal)",
        data: calorieData,
        backgroundColor: history.map((d) => (d.date === appState.selectedDate ? "#10b981" : "rgba(16, 185, 129, 0.45)")),
        borderColor: "#10b981",
        borderWidth: 1.5,
        borderRadius: 6
      },
      {
        label: "Goal",
        type: "line",
        data: targetData,
        borderColor: "#ef4444",
        borderDash: [4, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false
      }
    ];
  } else {
    // Stacked Macros
    datasets = [
      {
        label: "Protein (g)",
        data: history.map((d) => d.protein || 0),
        backgroundColor: "#3b82f6",
        borderRadius: 4,
        stack: "macros"
      },
      {
        label: "Carbs (g)",
        data: history.map((d) => d.carbs || 0),
        backgroundColor: "#f59e0b",
        borderRadius: 4,
        stack: "macros"
      },
      {
        label: "Fat (g)",
        data: history.map((d) => d.fat || 0),
        backgroundColor: "#ec4899",
        borderRadius: 4,
        stack: "macros"
      }
    ];
  }

  if (window.Chart) {
    try {
      appState.chartInstance = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          onClick: (event, elements) => {
            if (elements && elements.length > 0) {
              const index = elements[0].index;
              const selected = history[index];
              if (selected) {
                setTimeout(() => {
                  selectDate(selected.date);
                  triggerHaptic("light");
                }, 0);
              }
            }
          },
          plugins: {
            legend: {
              display: appState.currentChartView === "macros",
              labels: { color: "#94a3b8", font: { size: 10 } }
            },
            tooltip: {
              backgroundColor: "rgba(15, 23, 42, 0.95)",
              titleColor: "#f8fafc",
              bodyColor: "#f8fafc",
              borderColor: "rgba(255, 255, 255, 0.1)",
              borderWidth: 1,
              padding: 8
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: "#94a3b8", font: { size: 10 } }
            },
            y: {
              grid: { color: "rgba(255, 255, 255, 0.05)" },
              ticks: { color: "#94a3b8", font: { size: 10 } }
            }
          }
        }
      });
    } catch (chartErr) {
      console.error("Chart render error:", chartErr);
    }
  }
}

/**
 * Render 7-Day Date Filter Pills
 */
function renderDatePills() {
  const container = document.getElementById("date-pills-container");
  if (!container) return;
  container.innerHTML = "";

  const history = appState.history7d || [];
  history.forEach((d) => {
    const pill = document.createElement("button");
    pill.className = `date-pill ${d.date === appState.selectedDate ? "active" : ""}`;
    pill.textContent = d.date === appState.todayDate ? "Today" : d.label || d.date.substring(5);
    pill.addEventListener("click", () => {
      selectDate(d.date);
      triggerHaptic("light");
    });
    container.appendChild(pill);
  });
}

/**
 * Select Date & Filter Meals
 */
function selectDate(dateStr) {
  appState.selectedDate = dateStr;
  renderDatePills();
  renderChart();
  renderMealsList();
}

/**
 * Render Itemized Meals List
 */
function renderMealsList() {
  const container = document.getElementById("meals-list");
  if (!container) return;
  const isToday = appState.selectedDate === appState.todayDate;
  
  const titleElem = document.getElementById("meals-card-title");
  if (titleElem) {
    titleElem.textContent = isToday 
      ? "🍽️ Today's Logged Meals" 
      : `🍽️ Meals on ${appState.selectedDate}`;
  }

  let logs = [];
  if (isToday) {
    logs = appState.todayLogs || [];
  } else {
    const dayData = (appState.history7d || []).find((h) => h.date === appState.selectedDate);
    logs = dayData?.logs || [];
  }

  const countBadge = document.getElementById("meals-count-badge");
  if (countBadge) countBadge.textContent = `${logs.length} meal${logs.length === 1 ? "" : "s"}`;
  container.innerHTML = "";

  if (logs.length === 0) {
    container.innerHTML = `<div class="empty-state">No meals logged for this date.</div>`;
    return;
  }

  logs.forEach((log) => {
    const card = document.createElement("div");
    card.className = "meal-item-card";
    card.id = `meal-log-${log.id}`;

    card.innerHTML = `
      <div class="meal-main-info">
        <div class="meal-title-row">
          <span class="meal-name">${escapeHtml(log.food_name)}</span>
          <span class="meal-badge">${escapeHtml(log.meal_type || "Meal")}</span>
        </div>
        <div class="meal-macros-row">
          P: ${log.protein || 0}g | C: ${log.carbs || 0}g | F: ${log.fat || 0}g
        </div>
      </div>
      <div class="meal-actions">
        <span class="meal-calories">${log.calories} kcal</span>
        <button class="btn-icon-delete" title="Delete Meal" data-id="${log.id}">🗑️</button>
      </div>
    `;

    card.querySelector(".btn-icon-delete")?.addEventListener("click", () => {
      confirmAndDeleteMeal(log.id, log.food_name);
    });

    container.appendChild(card);
  });
}

/**
 * Confirm and Delete Meal via API
 */
async function confirmAndDeleteMeal(logId, foodName) {
  const proceed = async () => {
    triggerHaptic("warning");
    const elem = document.getElementById(`meal-log-${logId}`);
    if (elem) elem.style.opacity = "0.3";

    try {
      const res = await callApi("delete_food", {
        method: "POST",
        body: { log_id: logId }
      });

      if (!res.ok) throw new Error("Delete failed");

      showToast(`Deleted ${foodName}`);
      triggerHaptic("success");
      fetchDashboardData();
    } catch (err) {
      console.error("Error deleting meal:", err);
      showToast("Failed to delete meal", true);
      if (elem) elem.style.opacity = "1";
    }
  };

  if (tg?.showConfirm) {
    tg.showConfirm(`Delete "${foodName}" from your food log?`, (ok) => {
      if (ok) proceed();
    });
  } else if (confirm(`Delete "${foodName}" from your food log?`)) {
    proceed();
  }
}

/**
 * Render Presets & Supplements List
 */
function renderPresetsList() {
  const container = document.getElementById("presets-list");
  if (!container) return;
  container.innerHTML = "";

  const presets = appState.presets || [];
  if (presets.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No presets saved yet!</p>
        <p style="margin-top: 6px; font-size: 11px;">When you log meals in Telegram, tap <strong>⭐ Save as Preset</strong> on the confirmation message to save items here.</p>
      </div>
    `;
    return;
  }

  presets.forEach((preset) => {
    const card = document.createElement("div");
    card.className = "preset-card";
    card.id = `preset-${preset.id}`;

    card.innerHTML = `
      <div class="preset-info">
        <h4>${escapeHtml(preset.food_name)}</h4>
        <p>${preset.calories} kcal • P:${preset.protein}g C:${preset.carbs}g F:${preset.fat}g</p>
      </div>
      <div class="preset-actions">
        <button class="btn-log-preset" data-id="${preset.id}">➕ Log</button>
        <button class="btn-delete-preset" data-id="${preset.id}">🗑️</button>
      </div>
    `;

    card.querySelector(".btn-log-preset")?.addEventListener("click", () => {
      logPresetToToday(preset.id, preset.food_name);
    });

    card.querySelector(".btn-delete-preset")?.addEventListener("click", () => {
      deletePreset(preset.id, preset.food_name);
    });

    container.appendChild(card);
  });
}

/**
 * Log Preset to Today's Food Log via API
 */
async function logPresetToToday(presetId, foodName) {
  triggerHaptic("medium");
  try {
    const res = await callApi("log_preset", {
      method: "POST",
      body: { preset_id: presetId }
    });

    if (!res.ok) throw new Error("Log preset failed");
    const data = await res.json().catch(() => ({}));

    if (data && data.stopped_fast) {
      appState.activeFast = null;
      renderFastingCard();
      const dur = data.stopped_fast.elapsed_minutes || 0;
      const h = Math.floor(dur / 60);
      const m = dur % 60;
      showToast(`Logged "${foodName}" & Fast concluded (${h}h ${m}m)! ⏱️`);
    } else {
      showToast(`Logged "${foodName}" to today! ✅`);
    }

    triggerHaptic("success");
    fetchDashboardData();
  } catch (err) {
    console.error("Error logging preset:", err);
    showToast("Failed to log preset", true);
  }
}

/**
 * Delete Preset via API
 */
async function deletePreset(presetId, foodName) {
  const proceed = async () => {
    triggerHaptic("warning");
    try {
      const res = await callApi("delete_preset", {
        method: "POST",
        body: { preset_id: presetId }
      });

      if (!res.ok) throw new Error("Delete preset failed");

      showToast(`Removed "${foodName}" preset`);
      triggerHaptic("success");
      fetchDashboardData();
    } catch (err) {
      console.error("Error deleting preset:", err);
      showToast("Failed to delete preset", true);
    }
  };

  if (tg?.showConfirm) {
    tg.showConfirm(`Delete preset "${foodName}"?`, (ok) => {
      if (ok) proceed();
    });
  } else if (confirm(`Delete preset "${foodName}"?`)) {
    proceed();
  }
}

/**
 * Render Settings, AI Coach, Macros & Logging Mode View
 */
function renderSettingsView() {
  // AI Coach Persona
  const persona = appState.profile?.persona || "sarcastic";
  document.querySelectorAll(".persona-card").forEach((card) => {
    const p = card.getAttribute("data-persona");
    if (p === persona) {
      card.classList.add("selected");
    } else {
      card.classList.remove("selected");
    }
  });

  // Logging Mode
  const mode = appState.profile?.logging_mode || "itemized";
  document.querySelectorAll(".mode-card").forEach((card) => {
    const m = card.getAttribute("data-mode");
    if (m === mode) {
      card.classList.add("selected");
    } else {
      card.classList.remove("selected");
    }
  });

  // Calorie Target
  const target = appState.profile?.daily_target || 2000;
  const targetInput = document.getElementById("input-daily-target");
  if (targetInput) targetInput.value = target;

  // Macro Targets
  const pInput = document.getElementById("input-target-p");
  const cInput = document.getElementById("input-target-c");
  const fInput = document.getElementById("input-target-f");

  if (pInput) pInput.value = appState.macroTargets?.protein || 150;
  if (cInput) cInput.value = appState.macroTargets?.carbs || 200;
  if (fInput) fInput.value = appState.macroTargets?.fat || 67;
}

/**
 * Update AI Persona via API
 */
async function updatePersona(newPersona) {
  document.querySelectorAll(".persona-card").forEach((c) => c.classList.remove("selected"));
  document.getElementById(`persona-${newPersona}`)?.classList.add("selected");

  try {
    const res = await callApi("update_persona", {
      method: "POST",
      body: { persona: newPersona }
    });

    if (!res.ok) throw new Error("Update persona failed");

    if (appState.profile) appState.profile.persona = newPersona;
    showToast("Coach style updated! 🤖");
    triggerHaptic("success");
  } catch (err) {
    console.error("Error updating persona:", err);
    showToast("Failed to update AI coach", true);
  }
}

/**
 * Update Meal Logging Mode via API
 */
async function updateLoggingMode(newMode) {
  document.querySelectorAll(".mode-card").forEach((c) => c.classList.remove("selected"));
  document.getElementById(`mode-${newMode}`)?.classList.add("selected");

  try {
    const res = await callApi("update_logging_mode", {
      method: "POST",
      body: { mode: newMode }
    });

    if (!res.ok) throw new Error("Update logging mode failed");

    if (appState.profile) appState.profile.logging_mode = newMode;
    const modeLabel = newMode === "combined" ? "Single Combined Meal" : "Itemized Ingredients";
    showToast(`Logging mode set to ${modeLabel}! 🍲`);
    triggerHaptic("success");
  } catch (err) {
    console.error("Error updating logging mode:", err);
    showToast("Failed to update logging mode", true);
  }
}

/**
 * Update Daily Calorie Target via API
 */
async function updateCalorieTarget(newTarget) {
  try {
    const res = await callApi("update_target", {
      method: "POST",
      body: { target: newTarget }
    });

    if (!res.ok) throw new Error("Update target failed");

    if (appState.profile) appState.profile.daily_target = newTarget;
    showToast(`Target set to ${newTarget} kcal! 🎯`);
    triggerHaptic("success");
    fetchDashboardData();
  } catch (err) {
    console.error("Error updating target:", err);
    showToast("Failed to update target", true);
  }
}

/**
 * Update Custom Macro Targets via API
 */
async function updateMacroTargets(protein, carbs, fat) {
  try {
    const res = await callApi("update_macros", {
      method: "POST",
      body: { protein, carbs, fat }
    });

    if (!res.ok) throw new Error("Update macros failed");

    appState.macroTargets = { protein, carbs, fat };
    showToast("Macro targets updated! 🥑");
    triggerHaptic("success");
    renderSummaryCard();
  } catch (err) {
    console.error("Error updating macros:", err);
    showToast("Failed to update macros", true);
  }
}

/**
 * Reset Macro Targets to Auto (30/40/30) via API
 */
async function resetToAutoMacros() {
  try {
    const res = await callApi("update_macros", {
      method: "POST",
      body: { is_auto: true }
    });

    if (!res.ok) throw new Error("Reset macros failed");

    showToast("Macro targets reset to Auto 30/40/30! ⚡");
    triggerHaptic("success");
    fetchDashboardData();
  } catch (err) {
    console.error("Error resetting macros:", err);
    showToast("Failed to reset macros", true);
  }
}

/**
 * Export Food Logs to CSV (Delivers directly to Telegram Chat or Downloads in Browser)
 */
async function exportFoodLogsCSV() {
  showLoading(true);
  try {
    const resChat = await callApi("export_csv_to_chat", { method: "POST" });
    if (resChat.ok) {
      showLoading(false);
      showToast("📥 CSV Export sent directly to your Telegram chat!");
      triggerHaptic("success");
      return;
    }

    // Fallback: Browser download
    let logs = [];
    const resAll = await callApi("export_all_logs", { method: "GET" });
    if (resAll.ok) {
      const data = await resAll.json();
      logs = data.logs || [];
    }

    if (logs.length === 0) {
      logs = appState.todayLogs || [];
      (appState.history7d || []).forEach(day => {
        if (day.logs && day.logs.length > 0) {
          logs = logs.concat(day.logs);
        }
      });
    }

    if (logs.length === 0) {
      showLoading(false);
      showToast("No food logs found to export", true);
      return;
    }

    const uniqueMap = new Map();
    logs.forEach(l => { if (l.id) uniqueMap.set(l.id, l); });
    const exportList = uniqueMap.size > 0 ? Array.from(uniqueMap.values()) : logs;

    let csv = "Date (SGT),Meal Type,Food Name,Calories (kcal),Protein (g),Carbs (g),Fat (g)\n";
    exportList.forEach(item => {
      const created = item.created_at ? new Date(item.created_at).toLocaleString("en-SG", { timeZone: "Asia/Singapore" }) : appState.todayDate;
      const meal = item.meal_type || "Meal";
      const name = `"${(item.food_name || "").replace(/"/g, '""')}"`;
      csv += `${created},${meal},${name},${item.calories || 0},${item.protein || 0},${item.carbs || 0},${item.fat || 0}\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const downloadLink = document.createElement("a");
    downloadLink.href = url;
    downloadLink.setAttribute("download", `calorie_tracker_export_${appState.todayDate || "data"}.csv`);
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);

    showLoading(false);
    showToast(`Exported ${exportList.length} logs as CSV! 📥`);
    triggerHaptic("success");
  } catch (err) {
    showLoading(false);
    console.error("Export error:", err);
    showToast("Failed to export CSV", true);
  }
}

/**
 * Utility: Telegram Haptic Feedback
 */
function triggerHaptic(type) {
  try {
    if (tg?.HapticFeedback) {
      if (type === "light" || type === "medium" || type === "heavy") {
        tg.HapticFeedback.impactOccurred(type);
      } else if (type === "success" || type === "warning" || type === "error") {
        tg.HapticFeedback.notificationOccurred(type);
      }
    }
  } catch (e) {}
}

/**
 * Utility: Show Toast Notification
 */
function showToast(msg, isError = false) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast show ${isError ? "toast-error" : ""}`;
  setTimeout(() => {
    toast.className = "toast";
  }, 2600);
}

/**
 * Utility: Show/Hide Loading Overlay
 */
function showLoading(show) {
  const overlay = document.getElementById("loading-spinner");
  if (!overlay) return;
  if (show) {
    overlay.style.display = "flex";
    overlay.classList.remove("hidden");
  } else {
    overlay.classList.add("hidden");
    overlay.style.display = "none";
  }
}

/**
 * Utility: HTML Escape
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
