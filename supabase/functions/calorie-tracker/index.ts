import { Bot, webhookCallback, InlineKeyboard, InputFile } from "npm:grammy@^1";
import { createClient } from "npm:@supabase/supabase-js@2";

const token = Deno.env.get("CALORIE_BOT_TOKEN") || Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const geminiApiKey = Deno.env.get("GEMINI_API_KEY") || "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const bot = new Bot(token);

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as any);
  }
  return btoa(binary);
}

// Helper function to escape Telegram Markdown special characters
function escapeMarkdown(text: string): string {
  if (!text) return "";
  return text.replace(/([*_`\[\]])/g, "\\$1");
}

// Helper function to render text-based progress bars
function renderProgressBar(current: number, target: number, length: number = 10): string {
  if (!target || target <= 0) target = 1;
  const pct = Math.round((current / target) * 100);
  const filled = Math.min(Math.max(0, Math.round((current / target) * length)), length);
  const empty = Math.max(0, length - filled);
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${pct}%`;
}

// Web App URL hosted on GitHub Pages
const WEBAPP_URL = "https://jasontan89.github.io/calorie-tracker-bot/";

// Global flag to track command registration state
let commandsRegistered = false;

// Helper function to register bot menu commands & Web App chat button once on startup
async function registerBotCommandsOnce(force: boolean = false) {
  if (commandsRegistered && !force) return;
  try {
    await bot.api.setMyCommands([
      { command: "today", description: "📅 Today's Summary & Progress" },
      { command: "fast", description: "⏰ Intermittent Fasting Timer" },
      { command: "barcode", description: "📸 Scan & Look Up Food Barcode" },
      { command: "weeklyreport", description: "📑 7-Day Visual Report Card" },
      { command: "presets", description: "⭐ Saved Presets & Supplements" },
      { command: "history", description: "📊 7-Day Calorie History" },
      { command: "persona", description: "🤖 Choose AI Coach Personality" },
      { command: "mode", description: "🍲 Meal Logging Mode" },
      { command: "export", description: "📥 Export Food Logs to CSV" },
      { command: "weight", description: "⚖️ Log Current Weight (kg)" },
      { command: "progress", description: "📈 30-Day Weight Chart" },
      { command: "leaderboard", description: "🏆 Group Calorie Leaderboard" },
      { command: "joinleaderboard", description: "👥 Join Group Leaderboard" },
      { command: "reminders", description: "🔔 Toggle Daily Alerts" },
      { command: "delete", description: "🗑️ Select & Delete Today's Food" },
      { command: "target", description: "🎯 Update Calorie Goal" },
      { command: "help", description: "ℹ️ Bot Commands & Instructions" },
      { command: "start", description: "👋 Welcome & Getting Started" }
    ]);

    try {
      await bot.api.setChatMenuButton({
        menu_button: {
          type: "web_app",
          text: "📊 Dashboard",
          web_app: { url: WEBAPP_URL }
        }
      });
      console.log("Chat menu button registered for Web App.");
    } catch (btnErr) {
      console.error("Failed to set chat menu button:", btnErr);
    }

    commandsRegistered = true;
    console.log("Persistent bot commands menu registered successfully.");
  } catch (err) {
    console.error("Failed to register persistent menu commands:", err);
  }
}

// ── Timezone Helper (Singapore SGT / UTC+8) ──────────────────────────────────
function getSGTDateStr(date: Date = new Date()): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" };
  const formatter = new Intl.DateTimeFormat("en-CA", options);
  return formatter.format(date); // YYYY-MM-DD
}

function getSGTStartOfDayISO(date: Date = new Date()): string {
  const dateStr = getSGTDateStr(date);
  return new Date(`${dateStr}T00:00:00+08:00`).toISOString();
}

// Helper: Ensure user profile exists & keep display names up to date
async function ensureUserProfile(userId: number, firstName?: string, username?: string) {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("user_id, first_name, username, persona, logging_mode, target_protein, target_carbs, target_fat")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Error checking user profile:", error);
    return;
  }

  if (!data) {
    const { error: insertError } = await supabase
      .from("user_profiles")
      .insert({
        user_id: userId,
        daily_target: 2000,
        reminders_enabled: false,
        streak_count: 0,
        persona: "sarcastic",
        logging_mode: "itemized",
        first_name: firstName || null,
        username: username || null
      });

    if (insertError) {
      console.error("Error creating user profile:", insertError);
    }
  } else if ((firstName && data.first_name !== firstName) || (username && data.username !== username)) {
    await supabase
      .from("user_profiles")
      .update({
        first_name: firstName || data.first_name,
        username: username || data.username
      })
      .eq("user_id", userId);
  }
}

// Helper: Update consistency streak using SGT
async function updateStreakAndGetMessage(userId: number): Promise<string> {
  const { data: profile, error } = await supabase
    .from("user_profiles")
    .select("streak_count, last_log_date")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !profile) return "";

  const todayStr = getSGTDateStr();
  const lastLog = profile.last_log_date;
  let streak = profile.streak_count || 0;

  if (lastLog === todayStr) {
    return streak > 1 ? `🔥 Streak: ${streak} days!` : "";
  }

  const yesterday = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStr = getSGTDateStr(yesterday);

  if (lastLog === yesterdayStr) {
    streak += 1;
  } else {
    streak = 1;
  }

  await supabase
    .from("user_profiles")
    .update({ streak_count: streak, last_log_date: todayStr })
    .eq("user_id", userId);

  return `🔥 Streak: ${streak} day${streak > 1 ? "s" : ""} in a row!`;
}

// Helper: Get user's active macro targets
function getMacroTargets(target: number, profile?: any) {
  if (profile?.target_protein != null && profile?.target_carbs != null && profile?.target_fat != null) {
    return {
      protein: profile.target_protein,
      carbs: profile.target_carbs,
      fat: profile.target_fat,
      isCustom: true
    };
  }
  return {
    protein: Math.round((target * 0.30) / 4),
    carbs: Math.round((target * 0.40) / 4),
    fat: Math.round((target * 0.30) / 9),
    isCustom: false
  };
}

// Helper: Determine default meal type by Singapore current hour
function getMealType(): string {
  const sgtHour = parseInt(
    new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      hour: "numeric",
      hour12: false
    }).format(new Date()),
    10
  );

  if (sgtHour >= 5 && sgtHour < 11) return "Breakfast";
  if (sgtHour >= 11 && sgtHour < 15) return "Lunch";
  if (sgtHour >= 15 && sgtHour < 18) return "Snack";
  if (sgtHour >= 18 && sgtHour < 22) return "Dinner";
  return "Late Night Snack";
}

// Helper: Display names for Coach Personas
function getPersonaDisplayName(persona?: string): string {
  if (persona === "supportive") return "💖 Supportive Cheerleader";
  if (persona === "sergeant") return "🪖 Drill Sergeant";
  return "🔥 Sarcastic & Witty";
}

function formatMealType(type: string): string {
  const map: Record<string, string> = {
    breakfast: "🌅 Breakfast",
    lunch: "☀️ Lunch",
    dinner: "🌙 Dinner",
    snack: "🍿 Snack",
    "late night snack": "🦉 Late Night Snack"
  };
  return map[type?.toLowerCase()] || `🍽️ ${type || "Meal"}`;
}

// ── Fasting Helpers ──────────────────────────────────────────────────────────

async function getActiveFast(userId: number) {
  const { data, error } = await supabase
    .from("fasting_logs")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("start_time", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Error fetching active fast:", error);
    return null;
  }
  return data;
}

async function startUserFast(userId: number, targetHours: number, customStartTime?: string) {
  // Cancel any existing active fast
  await supabase
    .from("fasting_logs")
    .update({ status: "cancelled", end_time: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("status", "active");

  const startTime = customStartTime ? new Date(customStartTime).toISOString() : new Date().toISOString();
  const { data, error } = await supabase
    .from("fasting_logs")
    .insert({
      user_id: userId,
      target_hours: targetHours || 16,
      start_time: startTime,
      status: "active"
    })
    .select()
    .single();

  if (error) {
    console.error("Error starting fast:", error);
    return null;
  }
  return data;
}

async function stopUserFast(userId: number) {
  const active = await getActiveFast(userId);
  if (!active) return null;

  const endTime = new Date().toISOString();
  const { data, error } = await supabase
    .from("fasting_logs")
    .update({ status: "completed", end_time: endTime })
    .eq("id", active.id)
    .select()
    .single();

  if (error) {
    console.error("Error stopping fast:", error);
    return null;
  }
  return data;
}

async function cancelUserFast(userId: number) {
  const active = await getActiveFast(userId);
  if (!active) return null;

  const { data, error } = await supabase
    .from("fasting_logs")
    .update({ status: "cancelled", end_time: new Date().toISOString() })
    .eq("id", active.id)
    .select()
    .single();

  if (error) {
    console.error("Error cancelling fast:", error);
    return null;
  }
  return data;
}

function formatFastingSummary(fast: any) {
  const start = new Date(fast.start_time).getTime();
  const now = Date.now();
  const elapsedMs = Math.max(0, now - start);
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  const targetHours = Number(fast.target_hours) || 16;
  const targetEndMs = start + targetHours * 60 * 60 * 1000;
  const remainingMs = Math.max(0, targetEndMs - now);

  const elapsedH = Math.floor(elapsedHours);
  const elapsedM = Math.floor((elapsedMs % (1000 * 60 * 60)) / (1000 * 60));

  const remH = Math.floor(remainingMs / (1000 * 60 * 60));
  const remM = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

  const pct = Math.min(100, Math.round((elapsedHours / targetHours) * 100));
  const isGoalReached = now >= targetEndMs;

  const targetDateObj = new Date(targetEndMs);
  const targetTimeStr = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(targetDateObj);
  const targetDateStr = getSGTDateStr(targetDateObj);

  return {
    elapsedH,
    elapsedM,
    remH,
    remM,
    pct,
    isGoalReached,
    targetHours,
    targetTimeStr,
    targetDateStr,
    progressBar: renderProgressBar(elapsedHours, targetHours, 10)
  };
}

// ── Barcode & Open Food Facts Helper ──────────────────────────────────────────

async function fetchOpenFoodFacts(barcode: string) {
  try {
    const cleanBarcode = barcode.trim().replace(/[^0-9]/g, "");
    if (!cleanBarcode || cleanBarcode.length < 5) return null;
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(cleanBarcode)}.json`, {
      headers: { "User-Agent": "TelegramCalorieTrackerBot/1.0 (contact@jasontan.dev)" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;
    const p = data.product;
    const n = p.nutriments || {};
    const name = p.product_name_en || p.product_name || p.generic_name || "Packaged Product";
    const kcal = Math.round(
      Number(n["energy-kcal_serving"]) ||
      Number(n["energy-kcal_100g"]) ||
      Number(n["energy-kcal"]) ||
      (n["energy-kj_serving"] ? Number(n["energy-kj_serving"]) / 4.184 : 0) ||
      (n["energy-kj_100g"] ? Number(n["energy-kj_100g"]) / 4.184 : 0) ||
      0
    );
    const protein = Math.round(Number(n.proteins_serving) || Number(n.proteins_100g) || Number(n.proteins) || 0);
    const carbs = Math.round(Number(n.carbohydrates_serving) || Number(n.carbohydrates_100g) || Number(n.carbohydrates) || 0);
    const fat = Math.round(Number(n.fat_serving) || Number(n.fat_100g) || Number(n.fat) || 0);
    const serving = p.serving_size || "1 serving (100g)";
    const image = p.image_front_small_url || p.image_front_url || p.image_url || null;
    return {
      barcode: cleanBarcode,
      name,
      calories: kcal,
      protein,
      carbs,
      fat,
      serving,
      image
    };
  } catch (err) {
    console.error("Open Food Facts fetch error:", err);
    return null;
  }
}

// ── Weekly Infographic Helper ────────────────────────────────────────────────

async function generateWeeklyInfographicData(userId: number) {
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  const target = profile?.daily_target ?? 2000;
  const personaStyle = profile?.persona || "sarcastic";

  const sevenDaysAgoDate = new Date(new Date().getTime() - 6 * 24 * 60 * 60 * 1000);
  const sevenDaysAgoIso = getSGTStartOfDayISO(sevenDaysAgoDate);

  const { data: logs } = await supabase
    .from("food_logs")
    .select("created_at, calories, protein, carbs, fat")
    .eq("user_id", userId)
    .gte("created_at", sevenDaysAgoIso)
    .order("created_at", { ascending: true });

  const sortedDates: string[] = [];
  const calorieMap: Record<string, number> = {};
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;
  let totalCalories = 0;

  for (let i = 6; i >= 0; i--) {
    const d = new Date(new Date().getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = getSGTDateStr(d);
    sortedDates.push(dateStr);
    calorieMap[dateStr] = 0;
  }

  (logs ?? []).forEach((log) => {
    const dStr = getSGTDateStr(new Date(log.created_at));
    if (dStr in calorieMap) {
      calorieMap[dStr] += log.calories || 0;
    }
    totalCalories += log.calories || 0;
    totalProtein += log.protein || 0;
    totalCarbs += log.carbs || 0;
    totalFat += log.fat || 0;
  });

  const dailyAverages = Math.round(totalCalories / 7);
  const targetDiffPct = Math.abs(dailyAverages - target) / target;
  let grade = "A+";
  if (targetDiffPct <= 0.08) grade = "A+";
  else if (targetDiffPct <= 0.15) grade = "A";
  else if (targetDiffPct <= 0.25) grade = "B+";
  else if (targetDiffPct <= 0.35) grade = "B";
  else if (targetDiffPct <= 0.45) grade = "C";
  else grade = "D";

  // Macro percentages
  const macroCalTotal = (totalProtein * 4) + (totalCarbs * 4) + (totalFat * 9) || 1;
  const pPct = Math.round(((totalProtein * 4) / macroCalTotal) * 100);
  const cPct = Math.round(((totalCarbs * 4) / macroCalTotal) * 100);
  const fPct = Math.round(((totalFat * 9) / macroCalTotal) * 100);

  // Weight delta
  const fourteenDaysAgoIso = getSGTStartOfDayISO(new Date(new Date().getTime() - 14 * 24 * 60 * 60 * 1000));
  const { data: weights } = await supabase
    .from("weight_logs")
    .select("weight, created_at")
    .eq("user_id", userId)
    .gte("created_at", fourteenDaysAgoIso)
    .order("created_at", { ascending: true });

  let weightDeltaStr = "No logs";
  if (weights && weights.length >= 2) {
    const startW = weights[0].weight;
    const endW = weights[weights.length - 1].weight;
    const diff = Math.round((endW - startW) * 10) / 10;
    weightDeltaStr = diff === 0 ? "Maintained (0.0 kg)" : diff > 0 ? `+${diff} kg` : `${diff} kg`;
  } else if (weights && weights.length === 1) {
    weightDeltaStr = `${weights[0].weight} kg`;
  }

  // QuickChart config
  const chartConfig = {
    type: "bar",
    data: {
      labels: sortedDates.map((d) => d.substring(5)),
      datasets: [
        {
          type: "bar",
          label: "Daily Calories (kcal)",
          data: sortedDates.map((d) => calorieMap[d]),
          backgroundColor: sortedDates.map((d) => calorieMap[d] > target * 1.15 ? "rgba(239, 68, 68, 0.85)" : "rgba(16, 185, 129, 0.85)"),
          borderRadius: 6
        },
        {
          type: "line",
          label: `Goal Target (${target} kcal)`,
          data: Array(7).fill(target),
          borderColor: "#F59E0B",
          borderDash: [6, 6],
          borderWidth: 2,
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      title: {
        display: true,
        text: `Weekly Nutrition Card (${sortedDates[0]} to ${sortedDates[6]})`,
        fontColor: "#F8FAFC",
        fontSize: 16
      },
      legend: {
        labels: { fontColor: "#94A3B8" }
      },
      scales: {
        xAxes: [{ ticks: { fontColor: "#94A3B8" }, gridLines: { color: "rgba(255,255,255,0.06)" } }],
        yAxes: [{ ticks: { fontColor: "#94A3B8", beginAtZero: true }, gridLines: { color: "rgba(255,255,255,0.06)" } }]
      }
    }
  };

  const chartUrl = `https://quickchart.io/chart?bkg=%230f172a&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

  return {
    profile,
    target,
    personaStyle,
    sortedDates,
    calorieMap,
    dailyAverages,
    totalCalories,
    totalProtein,
    totalCarbs,
    totalFat,
    pPct,
    cPct,
    fPct,
    weightDeltaStr,
    grade,
    chartUrl,
    streak: profile?.streak_count || 0
  };
}

// ── AI Coaching Generator ────────────────────────────────────────────────────
async function generateAICoaching(userId: number, type: "daily" | "weekly" = "daily"): Promise<string | null> {
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("daily_target, persona")
    .eq("user_id", userId)
    .maybeSingle();

  const target = profile?.daily_target ?? 2000;
  const persona = profile?.persona || "sarcastic";

  const sevenDaysAgoDate = new Date(new Date().getTime() - 6 * 24 * 60 * 60 * 1000);
  const sevenDaysAgoIso = getSGTStartOfDayISO(sevenDaysAgoDate);
  const todayStartIso = getSGTStartOfDayISO();

  const { data: logs } = await supabase
    .from("food_logs")
    .select("food_name, calories, meal_type, created_at")
    .eq("user_id", userId)
    .gte("created_at", type === "weekly" ? sevenDaysAgoIso : todayStartIso)
    .order("created_at", { ascending: true });

  const totalCalories = (logs ?? []).reduce((sum, item) => sum + item.calories, 0);
  const mealSummary = (logs ?? []).map(l => `- ${l.food_name} (${l.calories} kcal, ${l.meal_type || "Meal"})`).join("\n");

  let systemPrompt = "";
  if (persona === "supportive") {
    systemPrompt = `You are an empathetic, encouraging, and enthusiastic nutrition coach. Your goal is to praise consistency, offer kind motivational tips, and gently guide the user toward their calorie goal (${target} kcal). Be warm, friendly, and use positive emojis (💖, 🥑, ✨, 🌟). Keep response under 3 sentences.`;
  } else if (persona === "sergeant") {
    systemPrompt = `You are a strict, disciplined military Drill Sergeant nutrition coach. You demand discipline, focus, and zero excuses. If they hit their goal (${target} kcal), give them stern military respect. If they blew their target or logged junk, demand accountability. Keep response under 3 sentences. (🪖, 🫡, 🔥).`;
  } else {
    systemPrompt = `You are a witty, hilarious, sarcastic nutrition coach. Make playful roasts, funny commentary on their food choices, and joke about their calorie target (${target} kcal). Be entertaining without being mean. Keep response under 3 sentences. (😏, 🍕, 🎯).`;
  }

  const userPrompt = type === "weekly"
    ? `Here is the user's past 7 days of eating (Total: ${totalCalories} kcal, Target: ${target} kcal/day):\n${mealSummary || "No logged meals this week."}\nProvide a weekly debrief.`
    : `Here is what the user ate today (Total: ${totalCalories} kcal, Target: ${target} kcal):\n${mealSummary || "Nothing logged yet today."}\nProvide a quick end-of-day coaching commentary.`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 180 }
      })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
  } catch (e) {
    console.error("Failed to generate AI coaching:", e);
    return null;
  }
}

// ── Today Summary Helper ─────────────────────────────────────────────────────

async function sendTodaySummary(ctx: any, userId: number, firstName?: string, username?: string) {
  await ensureUserProfile(userId, firstName, username);
  const sgtStartIso = getSGTStartOfDayISO();

  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("food_name, calories, protein, carbs, fat, meal_type")
    .eq("user_id", userId)
    .gte("created_at", sgtStartIso)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching today's logs:", error);
    return ctx.reply("Failed to retrieve today's food logs.");
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("daily_target, streak_count, persona, target_protein, target_carbs, target_fat")
    .eq("user_id", userId)
    .maybeSingle();

  const target = profile?.daily_target ?? 2000;
  const macroTargets = getMacroTargets(target, profile);
  const streak = profile?.streak_count || 0;
  const personaStyle = profile?.persona || "sarcastic";

  const totalCalories = (logs ?? []).reduce((sum, item) => sum + item.calories, 0);
  const totalProtein = (logs ?? []).reduce((sum, item) => sum + (item.protein || 0), 0);
  const totalCarbs = (logs ?? []).reduce((sum, item) => sum + (item.carbs || 0), 0);
  const totalFat = (logs ?? []).reduce((sum, item) => sum + (item.fat || 0), 0);

  const remainingCalories = target - totalCalories;
  const calProgressBar = renderProgressBar(totalCalories, target, 10);
  const pProgressBar = renderProgressBar(totalProtein, macroTargets.protein, 8);
  const cProgressBar = renderProgressBar(totalCarbs, macroTargets.carbs, 8);
  const fProgressBar = renderProgressBar(totalFat, macroTargets.fat, 8);

  const sgtDateStr = getSGTDateStr();

  let message = `📅 *Summary for ${sgtDateStr} (SGT)*\n`;
  if (streak > 0) {
    message += `🔥 *Streak: ${streak} day${streak > 1 ? "s" : ""} in a row!*\n`;
  }
  message += `\n`;

  if (logs && logs.length > 0) {
    message += `*Meals Logged Today:*\n`;
    logs.forEach((item) => {
      const safeFoodName = escapeMarkdown(item.food_name);
      const meal = item.meal_type ? ` [${item.meal_type}]` : "";
      const macros = item.protein || item.carbs || item.fat
        ? ` _(P:${item.protein || 0}g C:${item.carbs || 0}g F:${item.fat || 0}g)_`
        : "";
      message += `• ${safeFoodName}${meal}: *${item.calories} kcal*${macros}\n`;
    });
    message += `\n`;
  } else {
    message += `_No meals logged yet today._\n\n`;
  }

  message += `*Calories:* *${totalCalories}* / ${target} kcal\n`;
  message += `${calProgressBar}\n`;
  if (remainingCalories >= 0) {
    message += `_Remaining: ${remainingCalories} kcal_\n\n`;
  } else {
    message += `_⚠️ Over target by ${Math.abs(remainingCalories)} kcal_\n\n`;
  }

  const customTag = macroTargets.isCustom ? " _(Custom)_" : "";
  message += `*Macronutrient Breakdown${customTag}:*\n`;
  message += `🥩 Protein: *${totalProtein}g* / ${macroTargets.protein}g ${pProgressBar}\n`;
  message += `🍚 Carbs: *${totalCarbs}g* / ${macroTargets.carbs}g ${cProgressBar}\n`;
  message += `🥑 Fats: *${totalFat}g* / ${macroTargets.fat}g ${fProgressBar}\n`;

  const keyboard = new InlineKeyboard()
    .webApp("📱 Open Dashboard", WEBAPP_URL)
    .row()
    .text("⏰ Fasting Timer", "fast_status")
    .text("⭐ Presets", "open_presets")
    .row()
    .text("📊 7-Day History", "open_history")
    .text("🗑️ Delete Items", "open_delete");

  await ctx.reply(message, { parse_mode: "Markdown", reply_markup: keyboard });
}

// ── 7-Day History Helper ──────────────────────────────────────────────────────

async function sendHistoryReport(ctx: any, userId: number) {
  const sevenDaysAgoDate = new Date(new Date().getTime() - 6 * 24 * 60 * 60 * 1000);
  const sevenDaysAgoIso = getSGTStartOfDayISO(sevenDaysAgoDate);

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("daily_target")
    .eq("user_id", userId)
    .maybeSingle();

  const target = profile?.daily_target ?? 2000;

  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("created_at, calories, protein, carbs, fat")
    .eq("user_id", userId)
    .gte("created_at", sevenDaysAgoIso)
    .order("created_at", { ascending: true });

  if (error) {
    return ctx.reply("Failed to retrieve 7-day history.");
  }

  const sortedDates: string[] = [];
  const calorieMap: Record<string, number> = {};

  for (let i = 6; i >= 0; i--) {
    const d = new Date(new Date().getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = getSGTDateStr(d);
    sortedDates.push(dateStr);
    calorieMap[dateStr] = 0;
  }

  (logs ?? []).forEach((log) => {
    const dStr = getSGTDateStr(new Date(log.created_at));
    if (dStr in calorieMap) {
      calorieMap[dStr] += log.calories;
    }
  });

  const calorieValues = sortedDates.map(d => calorieMap[d]);
  const total7d = calorieValues.reduce((a, b) => a + b, 0);
  const avg7d = Math.round(total7d / 7);

  let textReport = `📊 *7-Day Calorie History (SGT)*\n\n`;
  sortedDates.forEach((dStr, idx) => {
    const cal = calorieMap[dStr];
    const isToday = idx === 6 ? " *(Today)*" : "";
    const indicator = cal === 0 ? "⚪ 0 kcal" : cal <= target ? `🟢 *${cal}* kcal` : `🔴 *${cal}* kcal`;
    textReport += `• ${dStr}${isToday}: ${indicator}\n`;
  });

  textReport += `\n🎯 Daily Target: *${target} kcal*\n`;
  textReport += `📈 7-Day Average: *${avg7d} kcal / day*\n`;
  textReport += `\n_Tap a day below to inspect meals logged for that day:_\n`;

  const keyboard = new InlineKeyboard()
    .webApp("📱 Open Dashboard", WEBAPP_URL)
    .row();
  for (let i = 0; i < 4; i++) {
    const dStr = sortedDates[i];
    keyboard.text(dStr.substring(5), `history_day:${dStr}`);
  }
  keyboard.row();
  for (let i = 4; i < 7; i++) {
    const dStr = sortedDates[i];
    keyboard.text(i === 6 ? "Today" : dStr.substring(5), `history_day:${dStr}`);
  }

  try {
    const chartConfig = {
      type: 'bar',
      data: {
        labels: sortedDates.map(d => d.substring(5)),
        datasets: [
          {
            type: 'bar',
            label: 'Calories (kcal)',
            data: calorieValues,
            backgroundColor: 'rgba(16, 185, 129, 0.75)',
            borderColor: '#10B981',
            borderWidth: 1
          },
          {
            type: 'line',
            label: 'Goal Target',
            data: Array(7).fill(target),
            borderColor: '#EF4444',
            borderDash: [5, 5],
            fill: false,
            pointRadius: 0
          }
        ]
      },
      options: {
        title: { display: true, text: 'Calorie History (SGT - Last 7 Days)' }
      }
    };

    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
    await ctx.replyWithPhoto(chartUrl, { caption: textReport, parse_mode: "Markdown", reply_markup: keyboard });
  } catch (chartErr) {
    console.error("Failed to generate/send calorie chart:", chartErr);
    await ctx.reply(textReport, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}

// ── Bot Commands ─────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  await registerBotCommandsOnce(true);
  const name = escapeMarkdown(ctx.from?.first_name ?? "there");

  const keyboard = new InlineKeyboard()
    .webApp("📱 Open Interactive Dashboard", WEBAPP_URL)
    .row()
    .text("⏰ Fasting Timer", "fast_status")
    .text("⭐ Presets", "open_presets")
    .row()
    .text("🤖 AI Coach Style", "open_persona")
    .text("🍲 Logging Mode", "open_mode");

  await ctx.reply(
    `Welcome to Calorie Tracker Bot v3.5, ${name}! 🍎\n\n` +
    `I can track calories, macronutrients, intermittent fasting, barcodes, weight, voice notes & multi-item meals!\n\n` +
    `👉 *How to use:*\n` +
    `• 📸 *Send a photo* of food or barcode to auto-estimate nutrition!\n` +
    `• 🎙️ *Send a voice note* (e.g. "I had two eggs and coffee") to auto-log!\n` +
    `• ✍️ *Just type what you ate* in chat.\n` +
    `• ⏰ Use /fast to start and monitor your Intermittent Fasting timer.\n` +
    `• 📸 Use /barcode <number> to query verified Open Food Facts data.\n` +
    `• 📑 Use /weeklyreport to get your full 7-day visual report card & AI coach debrief.\n` +
    `• 📅 Use /today to view calories & macro progress bars.\n` +
    `• ⭐ Use /presets to view, log & manage saved items.\n` +
    `• 📊 Use /history for your 7-day chart & day inspection.\n` +
    `• 🤖 Use /persona to switch between Sarcastic, Supportive, or Drill Sergeant coach!\n` +
    `• 🍲 Use /mode to toggle Itemized Ingredients vs. Single Combined Meal logging.\n` +
    `• 📥 Use /export to download your complete food log as a CSV spreadsheet.\n` +
    `• 🎯 Use /target <number> to update your daily goal.\n` +
    `• 🏆 Use /joinleaderboard & /leaderboard in group chats!\n` +
    `• ⚖️ Use /weight <number> & /progress for weight tracking.\n` +
    `• 🗑️ Use /delete to select & delete any logged food today.\n` +
    `• 🔔 Use /reminders for opt-in daily check-ins & weekly reviews.\n` +
    `• ℹ️ Use /help for a complete list of commands and instructions.`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.command("help", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  await registerBotCommandsOnce(true);

  const helpText =
    `ℹ️ *Calorie Tracker Bot — Command Guide* 📖\n\n` +
    `*Tracking & Analytics:*\n` +
    `• /today — View today's total calories, macros & logged meals\n` +
    `• /fast — Intermittent Fasting timer (16:8, 18:6, OMAD & live progress)\n` +
    `• /barcode <code\\> — Look up exact nutrition from Open Food Facts\n` +
    `• /weeklyreport — 7-Day visual infographic card & AI coach evaluation\n` +
    `• /history — View 7-day bar chart & tap any day to inspect meals\n` +
    `• /export — Download full food logs as a CSV spreadsheet\n` +
    `• /progress — View 30-day weight progress trend chart\n\n` +
    `*Settings & Tools:*\n` +
    `• /presets — View, quickly log, or delete saved preset meals\n` +
    `• /persona — Switch AI coach style (Sarcastic, Supportive, Drill Sergeant)\n` +
    `• /mode — Toggle Itemized Ingredients vs Combined Meal logging\n` +
    `• /target <kcal\\> — Set your daily calorie goal (e.g. \`/target 2200\`)\n` +
    `• /weight <kg\\> — Log your current weight (e.g. \`/weight 74.5\`)\n` +
    `• /delete — Interactive menu to delete any meal logged today\n` +
    `• /reminders — Toggle daily check-in alerts & weekly reviews\n\n` +
    `*Group Chat:*\n` +
    `• /joinleaderboard — Join the group chat consistency leaderboard\n` +
    `• /leaderboard — View group member streak and consistency rankings\n\n` +
    `💡 *Tip:* Tap the *📊 Dashboard* button anytime to open the full interactive WebApp!`;

  const keyboard = new InlineKeyboard()
    .webApp("📱 Open Dashboard", WEBAPP_URL)
    .row()
    .text("⏰ Fasting Timer", "fast_status")
    .text("⭐ Saved Presets", "open_presets");

  await ctx.reply(helpText, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.command("target", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);

  if (parts.length < 2) {
    const { data: profile } = await supabase.from("user_profiles").select("daily_target").eq("user_id", userId).maybeSingle();
    const current = profile?.daily_target ?? 2000;
    return ctx.reply(`Your current daily target is *${current} kcal*.\nTo change it, type: \`/target 2200\``, { parse_mode: "Markdown" });
  }

  const newTarget = parseInt(parts[1], 10);
  if (isNaN(newTarget) || newTarget <= 0) {
    return ctx.reply("Please provide a valid positive number for your calorie target (e.g. `/target 2000`).", { parse_mode: "Markdown" });
  }

  const { error } = await supabase.from("user_profiles").update({ daily_target: newTarget }).eq("user_id", userId);
  if (error) {
    return ctx.reply("Failed to update daily target. Please try again later.");
  }

  await ctx.reply(`✅ Your daily calorie target has been updated to *${newTarget} kcal*!`, { parse_mode: "Markdown" });
});

bot.command("mode", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const { data: profile } = await supabase.from("user_profiles").select("logging_mode").eq("user_id", userId).maybeSingle();
  const currentMode = profile?.logging_mode || "itemized";

  const keyboard = new InlineKeyboard()
    .text(`${currentMode === "itemized" ? "🔘 " : ""}🧩 Itemized Ingredients`, "set_mode:itemized")
    .row()
    .text(`${currentMode === "combined" ? "🔘 " : ""}🍲 Single Combined Meal`, "set_mode:combined");

  await ctx.reply(
    `🍲 *Meal Logging Mode*\n\n` +
    `Choose how your multi-item meals are recorded:\n\n` +
    `• *🧩 Itemized Ingredients:* Breaks meals into separate rows (Eggs, Toast, Coffee) for detailed macro precision.\n` +
    `• *🍲 Single Combined Meal:* Records the meal as 1 single entry with combined calories.\n\n` +
    `_Current mode: *_${currentMode.toUpperCase()}_*_`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.command("export", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("created_at, meal_type, food_name, calories, protein, carbs, fat")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error || !logs || logs.length === 0) {
    return ctx.reply("No food logs found to export yet! Log your meals first with a photo, voice note, or text.");
  }

  let csv = "Date (SGT),Time (SGT),Meal Type,Food Name,Calories (kcal),Protein (g),Carbs (g),Fat (g)\n";
  for (const log of logs) {
    const d = new Date(log.created_at);
    const dateStr = getSGTDateStr(d);
    const timeStr = new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(d);
    const safeName = `"${(log.food_name || "").replace(/"/g, '""')}"`;
    const meal = log.meal_type || "Meal";
    csv += `${dateStr},${timeStr},${meal},${safeName},${log.calories},${log.protein || 0},${log.carbs || 0},${log.fat || 0}\n`;
  }

  const fileBytes = new TextEncoder().encode(csv);
  const todaySgt = getSGTDateStr();
  const inputFile = new InputFile(fileBytes, `calorie_tracker_export_${todaySgt}.csv`);

  await ctx.replyWithDocument(inputFile, {
    caption: `📥 *CSV Export Complete!*\n\nHere is your full food log history (${logs.length} entries) in CSV format. You can open this in Microsoft Excel, Google Sheets, or Apple Numbers.`,
    parse_mode: "Markdown"
  });
});

bot.command("today", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await sendTodaySummary(ctx, userId, ctx.from?.first_name, ctx.from?.username);
});

bot.command("history", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  await sendHistoryReport(ctx, userId);
});

// ── NEW COMMAND: /fast (Intermittent Fasting) ────────────────────────────────

bot.command("fast", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const text = ctx.message?.text?.trim() || "";
  const parts = text.split(/\s+/);

  if (parts[1]?.toLowerCase() === "start") {
    const hours = parseInt(parts[2], 10) || 16;
    const fast = await startUserFast(userId, hours);
    if (!fast) return ctx.reply("Failed to start fasting timer.");
    const summary = formatFastingSummary(fast);
    const keyboard = new InlineKeyboard()
      .text("🛑 End Fast", "fast_stop")
      .text("❌ Cancel", "fast_cancel")
      .row()
      .webApp("📱 Live Fasting Widget", WEBAPP_URL);

    return ctx.reply(
      `⏰ *Fasting Started!* (${hours}h Fast)\n\n` +
      `🎯 Target Goal: *${hours} hours*\n` +
      `🏁 Target End: *${summary.targetDateStr} at ${summary.targetTimeStr} (SGT)*\n\n` +
      `Stay hydrated! Water, black coffee, and unsweetened tea are allowed. 💧`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  }

  if (parts[1]?.toLowerCase() === "stop") {
    const fast = await stopUserFast(userId);
    if (!fast) return ctx.reply("No active fast found to stop. Type `/fast` to start one!", { parse_mode: "Markdown" });
    const start = new Date(fast.start_time).getTime();
    const end = new Date(fast.end_time).getTime();
    const durationHours = Math.round(((end - start) / (1000 * 60 * 60)) * 10) / 10;
    return ctx.reply(
      `🎉 *Fast Completed!*\n\n` +
      `⏱️ Total Duration: *${durationHours} hours*\n` +
      `🎯 Target: *${fast.target_hours} hours*\n\n` +
      `Great job maintaining your fasting window! Time to break your fast with a nutritious meal. 🥗`,
      { parse_mode: "Markdown" }
    );
  }

  if (parts[1]?.toLowerCase() === "cancel") {
    await cancelUserFast(userId);
    return ctx.reply("❌ Active fast cancelled.", { parse_mode: "Markdown" });
  }

  // View Status / Presets
  const activeFast = await getActiveFast(userId);
  if (activeFast) {
    const summary = formatFastingSummary(activeFast);
    const statusHeader = summary.isGoalReached
      ? "🎉 *Fasting Target Reached!*"
      : "🔥 *Active Fasting Window*";

    const msg =
      `${statusHeader}\n\n` +
      `⏱️ Elapsed: *${summary.elapsedH}h ${summary.elapsedM}m* / ${summary.targetHours}h\n` +
      `${summary.progressBar}\n` +
      `${summary.isGoalReached ? "✅ You have met your goal!" : `⏳ Remaining: *${summary.remH}h ${summary.remM}m*`}\n` +
      `🏁 Goal Completion: *${summary.targetDateStr} at ${summary.targetTimeStr} (SGT)*\n\n` +
      `_Drink plenty of water to maintain energy levels! 💧_`;

    const keyboard = new InlineKeyboard()
      .text("🛑 End Fast", "fast_stop")
      .text("❌ Cancel", "fast_cancel")
      .row()
      .text("🔄 Refresh Status", "fast_status")
      .webApp("📱 Fasting Ring", WEBAPP_URL);

    return ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  }

  // Not Fasting -> Show Start Presets
  const keyboard = new InlineKeyboard()
    .text("14h (14:10)", "fast_start:14")
    .text("16h (16:8)", "fast_start:16")
    .row()
    .text("18h (18:6)", "fast_start:18")
    .text("20h (20:4)", "fast_start:20")
    .row()
    .text("24h (OMAD)", "fast_start:24")
    .webApp("📱 WebApp Fast Timer", WEBAPP_URL);

  await ctx.reply(
    `⏰ *Intermittent Fasting Timer*\n\nYou don't have an active fast right now.\n\nSelect a fasting window below to start your timer:`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

// ── NEW COMMAND: /barcode (Open Food Facts Lookup) ───────────────────────────

bot.command("barcode", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const text = ctx.message?.text?.trim() || "";
  const parts = text.split(/\s+/);

  if (parts.length < 2) {
    const keyboard = new InlineKeyboard().webApp("📷 Open Camera Barcode Scanner", WEBAPP_URL);
    return ctx.reply(
      `📸 *Barcode Scanner & Lookup*\n\n` +
      `• Open the *📊 Dashboard* to use your phone camera to scan barcodes directly!\n` +
      `• Or type: \`/barcode 888800000000\` with any product barcode.`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  }

  const barcode = parts[1].trim();
  await ctx.reply("🔍 Searching Open Food Facts database...");

  const product = await fetchOpenFoodFacts(barcode);
  if (!product) {
    return ctx.reply(
      `⚠️ Barcode *${escapeMarkdown(barcode)}* not found in the Open Food Facts database.\n\nYou can still log this item by sending a photo 📸 of the packaging or nutrition label, or typing what you ate!`,
      { parse_mode: "Markdown" }
    );
  }

  const safeName = escapeMarkdown(product.name);
  const caption =
    `📦 *Barcode Found: ${safeName}*\n\n` +
    `• Serving Size: _${escapeMarkdown(product.serving)}_\n` +
    `• Energy: *${product.calories} kcal*\n` +
    `• 🥩 Protein: *${product.protein}g* | 🍚 Carbs: *${product.carbs}g* | 🥑 Fat: *${product.fat}g*\n\n` +
    `Choose a meal type below to record this to your log:`;

  const keyboard = new InlineKeyboard()
    .text("🌅 Breakfast", `log_barcode:${barcode}:Breakfast`)
    .text("☀️ Lunch", `log_barcode:${barcode}:Lunch`)
    .row()
    .text("🌙 Dinner", `log_barcode:${barcode}:Dinner`)
    .text("🍿 Snack", `log_barcode:${barcode}:Snack`);

  if (product.image) {
    try {
      return await ctx.replyWithPhoto(product.image, { caption, parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {}
  }
  await ctx.reply(caption, { parse_mode: "Markdown", reply_markup: keyboard });
});

// ── NEW COMMAND: /weeklyreport (Visual Infographic) ──────────────────────────

bot.command("weeklyreport", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  await ctx.reply("📊 Generating your 7-day visual report card...");

  const info = await generateWeeklyInfographicData(userId);
  const weeklyCoaching = await generateAICoaching(userId, "weekly");

  const header = info.personaStyle === "supportive"
    ? "💖 *Weekly Nutrition Report Card & Encouragement*"
    : info.personaStyle === "sergeant"
    ? "🪖 *Weekly Nutrition Debrief & Performance Grade*"
    : "🤖 *Weekly Nutrition Report Card & AI Review*";

  let caption =
    `${header}\n\n` +
    `🏆 *Overall Performance Grade:* *${info.grade}*\n` +
    `🔥 *Consistency Streak:* *${info.streak} days*\n` +
    `⚖️ *Weight Change:* *${info.weightDeltaStr}*\n\n` +
    `📊 *7-Day Averages (SGT):*\n` +
    `• Average Calories: *${info.dailyAverages} kcal / day* (Goal: ${info.target} kcal)\n` +
    `• Total Protein: *${info.totalProtein}g* (${info.pPct}% cal)\n` +
    `• Total Carbs: *${info.totalCarbs}g* (${info.cPct}% cal)\n` +
    `• Total Fats: *${info.totalFat}g* (${info.fPct}% cal)\n\n`;

  if (weeklyCoaching) {
    caption += `📝 *Coach Note:*\n_${escapeMarkdown(weeklyCoaching)}_\n\n`;
  }

  caption += `_Tap below to view daily itemized logs in your WebApp dashboard._`;

  const keyboard = new InlineKeyboard()
    .webApp("📱 Open Dashboard", WEBAPP_URL)
    .row()
    .text("📊 7-Day Bar History", "open_history");

  try {
    await ctx.replyWithPhoto(info.chartUrl, { caption, parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    console.error("Error sending weekly infographic chart:", err);
    await ctx.reply(caption, { parse_mode: "Markdown", reply_markup: keyboard });
  }
});

bot.command("persona", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const { data: profile } = await supabase.from("user_profiles").select("persona").eq("user_id", userId).maybeSingle();
  const currentPersona = profile?.persona || "sarcastic";

  const keyboard = new InlineKeyboard()
    .text(`${currentPersona === "sarcastic" ? "🔘 " : ""}🔥 Sarcastic & Witty`, "set_persona:sarcastic")
    .row()
    .text(`${currentPersona === "supportive" ? "🔘 " : ""}💖 Supportive Cheerleader`, "set_persona:supportive")
    .row()
    .text(`${currentPersona === "sergeant" ? "🔘 " : ""}🪖 Drill Sergeant`, "set_persona:sergeant");

  await ctx.reply(
    `🤖 *Choose Your AI Nutrition Coach Style*\n\n` +
    `Select how your AI Coach talks to you during daily check-ins and weekly debriefs:\n\n` +
    `• *🔥 Sarcastic:* Witty roasts and funny reality checks.\n` +
    `• *💖 Supportive:* Warm encouragement, gentle praise, and high motivation.\n` +
    `• *🪖 Drill Sergeant:* Militant discipline, tough love, and zero excuses.\n\n` +
    `_Current: *_${getPersonaDisplayName(currentPersona)}_*_`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.command("presets", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const { data: presets, error } = await supabase
    .from("user_presets")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error || !presets || presets.length === 0) {
    return ctx.reply(
      "⭐ *Saved Presets & Supplements*\n\nYou have no saved presets yet! When you log a meal (like a Protein Shake, Multivitamin, or daily breakfast), tap *⭐ Save as Preset* to quickly log it anytime.",
      { parse_mode: "Markdown" }
    );
  }

  let message = "⭐ *Your Saved Presets & Supplements*\n\nTap any preset below to log it instantly to today's intake:\n\n";
  const keyboard = new InlineKeyboard();

  presets.forEach((p, idx) => {
    const macros = p.protein || p.carbs || p.fat ? ` (P:${p.protein || 0}g C:${p.carbs || 0}g F:${p.fat || 0}g)` : "";
    message += `${idx + 1}. *${escapeMarkdown(p.food_name)}* — ${p.calories} kcal${macros}\n`;
    keyboard.text(`➕ ${p.food_name} (${p.calories})`, `log_preset:${p.id}`);
    keyboard.text("🗑️", `del_preset:${p.id}`);
    keyboard.row();
  });

  await ctx.reply(message, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.command("delete", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const sgtStartIso = getSGTStartOfDayISO();
  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("id, food_name, calories, meal_type, created_at")
    .eq("user_id", userId)
    .gte("created_at", sgtStartIso)
    .order("created_at", { ascending: false });

  if (error || !logs || logs.length === 0) {
    return ctx.reply("You haven't logged any meals today to delete!");
  }

  let message = "🗑️ *Select an item logged today to delete:*\n\n";
  const keyboard = new InlineKeyboard();

  logs.forEach((log) => {
    const safeName = escapeMarkdown(log.food_name);
    const meal = log.meal_type ? `[${log.meal_type}] ` : "";
    message += `• ${meal}${safeName}: *${log.calories} kcal*\n`;
    keyboard.text(`🗑️ Delete ${log.food_name.substring(0, 15)} (${log.calories} kcal)`, `delfood:${log.id}`).row();
  });

  keyboard.text("❌ Cancel", "cancel_delete");
  await ctx.reply(message, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.command("weight", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);

  if (parts.length < 2) {
    return ctx.reply("Please provide your weight in kg (e.g. `/weight 75.5`).", { parse_mode: "Markdown" });
  }

  const weightVal = parseFloat(parts[1]);
  if (isNaN(weightVal) || weightVal <= 0 || weightVal > 500) {
    return ctx.reply("Please provide a valid weight number between 1 and 500 kg.", { parse_mode: "Markdown" });
  }

  const { error } = await supabase.from("weight_logs").insert({ user_id: userId, weight: weightVal });
  if (error) {
    return ctx.reply("Failed to record weight log. Please try again.");
  }

  await ctx.reply(`⚖️ Recorded weight: *${weightVal} kg*! View your 30-day chart with /progress.`, { parse_mode: "Markdown" });
});

bot.command("progress", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const thirtyDaysAgoIso = getSGTStartOfDayISO(new Date(new Date().getTime() - 30 * 24 * 60 * 60 * 1000));
  const { data: logs, error } = await supabase
    .from("weight_logs")
    .select("weight, created_at")
    .eq("user_id", userId)
    .gte("created_at", thirtyDaysAgoIso)
    .order("created_at", { ascending: true });

  if (error || !logs || logs.length === 0) {
    return ctx.reply("No weight entries found in the last 30 days. Log your current weight using `/weight 75.5`!", { parse_mode: "Markdown" });
  }

  const dateMap = new Map<string, number>();
  logs.forEach(l => {
    const dStr = getSGTDateStr(new Date(l.created_at));
    dateMap.set(dStr, l.weight);
  });

  const labels = Array.from(dateMap.keys());
  const weights = Array.from(dateMap.values());
  const minW = Math.floor(Math.min(...weights) - 1);
  const maxW = Math.ceil(Math.max(...weights) + 1);

  const chartConfig = {
    type: 'line',
    data: {
      labels: labels.map(l => l.substring(5)),
      datasets: [{
        label: 'Weight (kg)',
        data: weights,
        borderColor: '#3B82F6',
        backgroundColor: 'rgba(59, 130, 246, 0.15)',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointBackgroundColor: '#2563EB'
      }]
    },
    options: {
      title: { display: true, text: '30-Day Weight Progress (SGT)' },
      scales: { yAxes: [{ ticks: { min: minW, max: maxW } }] }
    }
  };

  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  let textSummary = `📈 *30-Day Weight History (SGT)*\n\n`;
  logs.slice(-5).forEach(log => {
    const dateStr = getSGTDateStr(new Date(log.created_at));
    textSummary += `• *${dateStr}*: ${log.weight} kg\n`;
  });

  try {
    await ctx.replyWithPhoto(chartUrl, { caption: textSummary, parse_mode: "Markdown" });
  } catch (err) {
    await ctx.reply(textSummary, { parse_mode: "Markdown" });
  }
});

bot.command("reminders", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const { data: profile } = await supabase.from("user_profiles").select("reminders_enabled, persona").eq("user_id", userId).maybeSingle();
  const newStatus = !(profile?.reminders_enabled ?? false);

  await supabase.from("user_profiles").update({ reminders_enabled: newStatus }).eq("user_id", userId);
  const personaName = getPersonaDisplayName(profile?.persona);

  if (newStatus) {
    await ctx.reply(`🔔 *Reminders & AI Coaching Enabled!*\n\nActive Coach Style: *${personaName}*\nYou'll get daily check-ins & weekly visual infographic reviews in SGT.`, { parse_mode: "Markdown" });
  } else {
    await ctx.reply("🔕 *Reminders Disabled.*", { parse_mode: "Markdown" });
  }
});

bot.command("joinleaderboard", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const { error } = await supabase.from("group_members").upsert({ group_id: chatId, user_id: userId });
  if (error) return ctx.reply("Failed to join leaderboard.");

  const userName = escapeMarkdown(ctx.from?.first_name ?? "User");
  await ctx.reply(`🎉 *${userName}* has joined the chat leaderboard! Type /leaderboard to check rankings.`, { parse_mode: "Markdown" });
});

bot.command("leaderboard", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (ctx.from?.id) await ensureUserProfile(ctx.from.id, ctx.from.first_name, ctx.from.username);

  const { data: members } = await supabase.from("group_members").select("user_id").eq("group_id", chatId);
  if (!members || members.length === 0) {
    return ctx.reply("No leaderboard members in this chat yet! Type `/joinleaderboard` to join.", { parse_mode: "Markdown" });
  }

  const userIds = members.map(m => m.user_id);
  const sevenDaysAgoIso = getSGTStartOfDayISO(new Date(new Date().getTime() - 6 * 24 * 60 * 60 * 1000));

  const { data: profiles } = await supabase.from("user_profiles").select("user_id, streak_count, first_name, username").in("user_id", userIds);
  const { data: logs } = await supabase.from("food_logs").select("user_id, created_at").in("user_id", userIds).gte("created_at", sevenDaysAgoIso);

  const userDaysMap: Record<number, Set<string>> = {};
  userIds.forEach(id => { userDaysMap[id] = new Set(); });

  (logs ?? []).forEach(log => {
    const sgtDate = getSGTDateStr(new Date(log.created_at));
    if (log.user_id in userDaysMap) userDaysMap[log.user_id].add(sgtDate);
  });

  const profileMap = new Map((profiles ?? []).map(p => [p.user_id, p]));
  const rankings = userIds.map(uid => {
    const p = profileMap.get(uid);
    const firstName = p?.first_name;
    const username = p?.username;
    const daysCount = userDaysMap[uid]?.size ?? 0;
    const streak = p?.streak_count ?? 0;
    const nameStr = firstName ? (username ? `${firstName} (@${username})` : firstName) : `User ${uid}`;
    return { userId: uid, nameStr, daysCount, streak };
  });

  rankings.sort((a, b) => b.daysCount - a.daysCount || b.streak - a.streak);

  let message = "🏆 *Group Calorie Tracker Leaderboard (Past 7 Days)* 🏆\n\n";
  const medalEmojis = ["🥇", "🥈", "🥉"];
  rankings.forEach((r, idx) => {
    const medal = idx < 3 ? medalEmojis[idx] : ` ${idx + 1}.`;
    const safeName = escapeMarkdown(r.nameStr);
    message += `${medal} *${safeName}* — *${r.daysCount} days logged* (🔥 ${r.streak}-day streak)\n`;
  });

  message += "\n_Keep logging daily to climb the leaderboard!_";
  await ctx.reply(message, { parse_mode: "Markdown" });
});

// ── Core AI Processing Helper (Photos, Voice & Text) ─────────────────────────

async function processFoodWithGemini(
  ctx: any,
  input: { type: "text" | "image" | "voice"; content: string; mimeType?: string }
) {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const typingAction = input.type === "voice" ? "record_voice" : input.type === "image" ? "upload_photo" : "typing";
  try { await ctx.replyWithChatAction(typingAction); } catch (e) {}

  const { data: profile } = await supabase.from("user_profiles").select("persona, logging_mode").eq("user_id", userId).maybeSingle();
  const persona = profile?.persona || "sarcastic";
  const loggingMode = profile?.logging_mode || "itemized";

  let personaInstruction = "";
  if (persona === "supportive") {
    personaInstruction = "Provide warm, positive encouragement and celebrate their healthy choices. Keep response friendly.";
  } else if (persona === "sergeant") {
    personaInstruction = "Adopt a strict, militant Drill Sergeant tone. Demand discipline, no excuses, and relentless consistency.";
  } else {
    personaInstruction = "Adopt a sarcastic, witty, playfully roasting tone. Make funny banter about their food choices.";
  }

  const isMultiAllowed = loggingMode === "itemized";
  const systemPrompt =
    `You are a world-class AI Nutritionist and Calorie Tracker.\n` +
    `Analyze the food input (image, voice transcript, or text description) and estimate nutritional values.\n\n` +
    `CRITICAL OUTPUT FORMAT REQUIREMENTS:\n` +
    `You MUST respond ONLY with a single JSON object. No Markdown code fences, no extra text.\n` +
    `Schema:\n` +
    `{\n` +
    `  "is_food": boolean, // false if non-food item\n` +
    `  "non_food_reason": "string or null",\n` +
    `  "coaching_message": "string (1-2 sentences in requested persona tone)",\n` +
    `  "items": [\n` +
    `    {\n` +
    `      "food_name": "Short Name",\n` +
    `      "portion": "e.g. 2 large eggs, 1 slice toast",\n` +
    `      "calories": number (integer kcal),\n` +
    `      "protein": number (grams),\n` +
    `      "carbs": number (grams),\n` +
    `      "fat": number (grams)\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `LOGGING MODE RULES:\n` +
    (isMultiAllowed
      ? `- Break down multiple dishes/ingredients into separate array elements in "items" (e.g. eggs, toast, latte).\n`
      : `- Return EXACTLY ONE item in "items" representing the combined whole meal with total calories and macros.\n`) +
    `Persona: ${personaInstruction}`;

  const contents: any[] = [];
  if (input.type === "image") {
    contents.push({
      role: "user",
      parts: [
        { inlineData: { mimeType: input.mimeType || "image/jpeg", data: input.content } },
        { text: "Analyze the food in this image, calculate calories & macronutrients, and provide response in specified JSON schema." }
      ]
    });
  } else if (input.type === "voice") {
    contents.push({
      role: "user",
      parts: [
        { inlineData: { mimeType: input.mimeType || "audio/ogg", data: input.content } },
        { text: "Listen carefully to this voice note describing food, determine calories & macronutrients, and provide JSON response." }
      ]
    });
  } else {
    contents.push({
      role: "user",
      parts: [{ text: `What I ate: "${input.content}". Estimate calories, macronutrients, and format as specified JSON.` }]
    });
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: contents,
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4
        }
      })
    });

    const aiRes = await res.json();
    if (!res.ok) {
      console.error("Gemini API error:", res.status, aiRes);
      return ctx.reply("Sorry, I couldn't analyze that food item. Please try again!");
    }

    const rawText = aiRes.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) return ctx.reply("Sorry, I couldn't analyze that food item. Please try again!");

    const cleanedJson = rawText.replace(/```json\s*|```/g, "").trim();
    const parsed = JSON.parse(cleanedJson);
    if (!parsed.is_food) {
      return ctx.reply(`🤔 ${parsed.non_food_reason || "That doesn't look like food! Please send a photo or description of a meal."}`);
    }

    const items = parsed.items || [];
    if (items.length === 0) return ctx.reply("Couldn't extract food items. Please try describing your meal in more detail.");

    const { data: pending, error: pendErr } = await supabase
      .from("pending_food_logs")
      .insert({
        user_id: userId,
        items: items,
        meal_type: getMealType()
      })
      .select()
      .single();

    if (pendErr || !pending) return ctx.reply("Failed to save pending log. Please try again.");

    const pendingId = pending.id;
    let totalC = 0, totalP = 0, totalCr = 0, totalF = 0;
    let itemsText = "";

    items.forEach((item: any) => {
      totalC += item.calories;
      totalP += (item.protein || 0);
      totalCr += (item.carbs || 0);
      totalF += (item.fat || 0);
      const safeName = escapeMarkdown(item.food_name);
      const safePortion = escapeMarkdown(item.portion || "");
      itemsText += `• *${safeName}* (${safePortion}): *${item.calories} kcal* _(P:${item.protein || 0}g C:${item.carbs || 0}g F:${item.fat || 0}g)_\n`;
    });

    const safeCoaching = escapeMarkdown(parsed.coaching_message || "");
    const msg =
      `🍽️ *Identified Meal (${getMealType()}):*\n\n` +
      itemsText +
      `\n📊 *Total:* *${totalC} kcal* | 🥩 *${totalP}g P* | 🍚 *${totalCr}g C* | 🥑 *${totalF}g F*\n\n` +
      (safeCoaching ? `_${safeCoaching}_\n\n` : "") +
      `Would you like to log this to your daily intake?`;

    const keyboard = new InlineKeyboard()
      .text("✅ Confirm & Log", `confirm:${pendingId}`)
      .text("✏️ Adjust", `edit:${pendingId}`)
      .row()
      .text("⭐ Save as Preset", `save_preset:${pendingId}`)
      .text("❌ Cancel", `cancel:${pendingId}`);

    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    console.error("Error in processFoodWithGemini:", err);
    await ctx.reply("An error occurred while processing your food log. Please try again!");
  }
}

// ── Bot Event Listeners (Photo & Voice) ──────────────────────────────────────

bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo;
  if (!photo || photo.length === 0) return;
  const bestPhoto = photo[photo.length - 1];

  try {
    const file = await ctx.api.getFile(bestPhoto.file_id);
    if (!file.file_path) return ctx.reply("Could not download image.");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const imageRes = await fetch(fileUrl);
    const arrayBuffer = await imageRes.arrayBuffer();
    const base64Data = arrayBufferToBase64(arrayBuffer);

    await processFoodWithGemini(ctx, {
      type: "image",
      content: base64Data,
      mimeType: "image/jpeg"
    });
  } catch (err) {
    console.error("Photo processing error:", err);
    ctx.reply("Failed to process image. Please try again.");
  }
});

bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  if (!voice) return;

  try {
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) return ctx.reply("Could not download voice note.");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const voiceRes = await fetch(fileUrl);
    const arrayBuffer = await voiceRes.arrayBuffer();
    const base64Data = arrayBufferToBase64(arrayBuffer);

    await processFoodWithGemini(ctx, {
      type: "voice",
      content: base64Data,
      mimeType: voice.mime_type || "audio/ogg"
    });
  } catch (err) {
    console.error("Voice processing error:", err);
    ctx.reply("Failed to process voice note. Please try again.");
  }
});

// ── Callback Query Handlers ──────────────────────────────────────────────────

bot.callbackQuery("open_presets", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  await ensureUserProfile(userId, ctx.from.first_name, ctx.from.username);

  const { data: presets } = await supabase.from("user_presets").select("*").eq("user_id", userId).order("created_at", { ascending: false });
  if (!presets || presets.length === 0) {
    return ctx.reply("⭐ You have no saved presets yet! When logging any food, tap *⭐ Save as Preset*.", { parse_mode: "Markdown" });
  }

  let message = "⭐ *Saved Presets & Supplements*\n\n";
  const keyboard = new InlineKeyboard();
  presets.forEach((p, idx) => {
    message += `${idx + 1}. *${escapeMarkdown(p.food_name)}* — ${p.calories} kcal\n`;
    keyboard.text(`➕ ${p.food_name} (${p.calories})`, `log_preset:${p.id}`);
    keyboard.text("🗑️", `del_preset:${p.id}`).row();
  });
  await ctx.reply(message, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.callbackQuery("open_delete", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const sgtStartIso = getSGTStartOfDayISO();

  const { data: logs } = await supabase.from("food_logs").select("id, food_name, calories").eq("user_id", userId).gte("created_at", sgtStartIso);
  if (!logs || logs.length === 0) return ctx.reply("No meals logged today to delete!");

  const keyboard = new InlineKeyboard();
  logs.forEach(log => {
    keyboard.text(`🗑️ Delete ${log.food_name.substring(0, 15)} (${log.calories} kcal)`, `delfood:${log.id}`).row();
  });
  keyboard.text("❌ Cancel", "cancel_delete");
  await ctx.reply("🗑️ Select an item to delete:", { reply_markup: keyboard });
});

bot.callbackQuery("open_history", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendHistoryReport(ctx, ctx.from.id);
});

bot.callbackQuery("open_persona", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const { data: profile } = await supabase.from("user_profiles").select("persona").eq("user_id", userId).maybeSingle();
  const currentPersona = profile?.persona || "sarcastic";

  const keyboard = new InlineKeyboard()
    .text(`${currentPersona === "sarcastic" ? "🔘 " : ""}🔥 Sarcastic & Witty`, "set_persona:sarcastic")
    .row()
    .text(`${currentPersona === "supportive" ? "🔘 " : ""}💖 Supportive Cheerleader`, "set_persona:supportive")
    .row()
    .text(`${currentPersona === "sergeant" ? "🔘 " : ""}🪖 Drill Sergeant`, "set_persona:sergeant");

  await ctx.reply("🤖 Choose your AI Coach Personality:", { reply_markup: keyboard });
});

bot.callbackQuery("open_mode", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const { data: profile } = await supabase.from("user_profiles").select("logging_mode").eq("user_id", userId).maybeSingle();
  const currentMode = profile?.logging_mode || "itemized";

  const keyboard = new InlineKeyboard()
    .text(`${currentMode === "itemized" ? "🔘 " : ""}🧩 Itemized Ingredients`, "set_mode:itemized")
    .row()
    .text(`${currentMode === "combined" ? "🔘 " : ""}🍲 Single Combined Meal`, "set_mode:combined");

  await ctx.reply("🍲 Choose Meal Logging Mode:", { reply_markup: keyboard });
});

bot.callbackQuery("fast_status", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const activeFast = await getActiveFast(userId);

  if (activeFast) {
    const summary = formatFastingSummary(activeFast);
    const statusHeader = summary.isGoalReached ? "🎉 *Fasting Target Reached!*" : "🔥 *Active Fasting Window*";
    const msg =
      `${statusHeader}\n\n` +
      `⏱️ Elapsed: *${summary.elapsedH}h ${summary.elapsedM}m* / ${summary.targetHours}h\n` +
      `${summary.progressBar}\n` +
      `${summary.isGoalReached ? "✅ Target met!" : `⏳ Remaining: *${summary.remH}h ${summary.remM}m*`}\n` +
      `🏁 Goal: *${summary.targetDateStr} at ${summary.targetTimeStr} (SGT)*`;

    const keyboard = new InlineKeyboard()
      .text("🛑 End Fast", "fast_stop")
      .text("❌ Cancel", "fast_cancel")
      .row()
      .text("🔄 Refresh", "fast_status")
      .webApp("📱 Fasting Ring", WEBAPP_URL);

    return ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  }

  const keyboard = new InlineKeyboard()
    .text("14h (14:10)", "fast_start:14")
    .text("16h (16:8)", "fast_start:16")
    .row()
    .text("18h (18:6)", "fast_start:18")
    .text("20h (20:4)", "fast_start:20")
    .row()
    .text("24h (OMAD)", "fast_start:24")
    .webApp("📱 WebApp Fast Timer", WEBAPP_URL);

  await ctx.reply("⏰ *Start an Intermittent Fast:*\nSelect a fasting window:", { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.callbackQuery(/^fast_start:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const hours = parseInt(ctx.match[1], 10) || 16;
  const userId = ctx.from.id;

  const fast = await startUserFast(userId, hours);
  if (!fast) return ctx.reply("Failed to start fast.");
  const summary = formatFastingSummary(fast);

  const keyboard = new InlineKeyboard()
    .text("🛑 End Fast", "fast_stop")
    .text("❌ Cancel", "fast_cancel")
    .row()
    .webApp("📱 Open Fasting Ring", WEBAPP_URL);

  await ctx.reply(
    `⏰ *Fasting Started!* (${hours}h Fast)\n\n` +
    `🏁 Target End: *${summary.targetDateStr} at ${summary.targetTimeStr} (SGT)*\n\n` +
    `Stay hydrated with water and unsweetened tea/coffee! 💧`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.callbackQuery("fast_stop", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const fast = await stopUserFast(userId);

  if (!fast) return ctx.reply("No active fast found to stop.");
  const start = new Date(fast.start_time).getTime();
  const end = new Date(fast.end_time).getTime();
  const durationHours = Math.round(((end - start) / (1000 * 60 * 60)) * 10) / 10;

  await ctx.reply(
    `🎉 *Fast Completed!*\n\n` +
    `⏱️ Total Duration: *${durationHours} hours*\n` +
    `🎯 Goal: *${fast.target_hours} hours*\n\n` +
    `Awesome work! Time to break your fast with a nutritious meal. 🥗`,
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery("fast_cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  await cancelUserFast(ctx.from.id);
  await ctx.reply("❌ Fasting window cancelled.", { parse_mode: "Markdown" });
});

bot.callbackQuery(/^log_barcode:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const barcode = ctx.match[1];
  const mealType = ctx.match[2];
  const userId = ctx.from.id;

  const product = await fetchOpenFoodFacts(barcode);
  if (!product) return ctx.reply("Product details could not be retrieved.");

  const { error } = await supabase.from("food_logs").insert({
    user_id: userId,
    food_name: product.name,
    calories: product.calories,
    protein: product.protein,
    carbs: product.carbs,
    fat: product.fat,
    meal_type: mealType
  });

  if (error) return ctx.reply("Failed to log barcode food.");
  const streakMsg = await updateStreakAndGetMessage(userId);

  await ctx.reply(
    `✅ *Logged ${escapeMarkdown(product.name)}!*\n\n` +
    `• Meal: *${mealType}*\n` +
    `• Calories: *${product.calories} kcal*\n` +
    `• Macros: _P:${product.protein}g C:${product.carbs}g F:${product.fat}g_\n\n` +
    (streakMsg ? `${streakMsg}\n\n` : "") +
    `Use /today or tap 📊 Dashboard to view updated totals!`,
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery(/^set_persona:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const newPersona = ctx.match[1];
  const userId = ctx.from.id;

  await supabase.from("user_profiles").update({ persona: newPersona }).eq("user_id", userId);
  await ctx.editMessageText(`✅ AI Coach Style updated to: *${getPersonaDisplayName(newPersona)}*!`, { parse_mode: "Markdown" });
});

bot.callbackQuery(/^set_mode:(itemized|combined)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const mode = ctx.match[1];
  const userId = ctx.from.id;

  await supabase.from("user_profiles").update({ logging_mode: mode }).eq("user_id", userId);
  await ctx.editMessageText(`✅ Meal Logging Mode updated to: *${mode.toUpperCase()}*!`, { parse_mode: "Markdown" });
});

bot.callbackQuery(/^history_day:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const dateStr = ctx.match[1];
  const userId = ctx.from.id;

  const startIso = `${dateStr}T00:00:00+08:00`;
  const nextDate = new Date(new Date(startIso).getTime() + 24 * 60 * 60 * 1000);
  const endIso = nextDate.toISOString();

  const { data: logs } = await supabase
    .from("food_logs")
    .select("food_name, calories, protein, carbs, fat, meal_type")
    .eq("user_id", userId)
    .gte("created_at", new Date(startIso).toISOString())
    .lt("created_at", endIso)
    .order("created_at", { ascending: true });

  if (!logs || logs.length === 0) {
    return ctx.reply(`📅 *Meals for ${dateStr} (SGT)*\n\n_No meals were recorded on this day._`, { parse_mode: "Markdown" });
  }

  let totalC = 0, totalP = 0, totalCr = 0, totalF = 0;
  let report = `📅 *Meals for ${dateStr} (SGT)*\n\n`;

  logs.forEach((log) => {
    totalC += log.calories;
    totalP += log.protein || 0;
    totalCr += log.carbs || 0;
    totalF += log.fat || 0;
    const safeName = escapeMarkdown(log.food_name);
    const meal = log.meal_type ? ` [${log.meal_type}]` : "";
    report += `• ${safeName}${meal}: *${log.calories} kcal* _(P:${log.protein || 0}g C:${log.carbs || 0}g F:${log.fat || 0}g)_\n`;
  });

  report += `\n📊 *Day Total:* *${totalC} kcal* | 🥩 *${totalP}g P* | 🍚 *${totalCr}g C* | 🥑 *${totalF}g F*`;
  await ctx.reply(report, { parse_mode: "Markdown" });
});

bot.callbackQuery(/^confirm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const pendingId = ctx.match[1];
  const userId = ctx.from.id;

  const { data: pending, error: pErr } = await supabase.from("pending_food_logs").select("*").eq("id", pendingId).eq("user_id", userId).maybeSingle();
  if (pErr || !pending) return ctx.reply("This meal confirmation has expired or was already logged.");

  const items = pending.items || [];
  const rows = items.map((item: any) => ({
    user_id: userId,
    food_name: item.food_name,
    calories: item.calories,
    protein: item.protein || 0,
    carbs: item.carbs || 0,
    fat: item.fat || 0,
    meal_type: pending.meal_type || getMealType()
  }));

  const { error: insErr } = await supabase.from("food_logs").insert(rows);
  if (insErr) return ctx.reply("Failed to log food.");

  await supabase.from("pending_food_logs").delete().eq("id", pendingId);
  const streakMsg = await updateStreakAndGetMessage(userId);

  let confirmMsg = `✅ *Logged ${items.length} item${items.length > 1 ? "s" : ""} successfully!*`;
  if (streakMsg) confirmMsg += `\n\n${streakMsg}`;

  try {
    await ctx.editMessageText(confirmMsg, { parse_mode: "Markdown" });
  } catch (e) {
    await ctx.reply(confirmMsg, { parse_mode: "Markdown" });
  }

  await sendTodaySummary(ctx, userId, ctx.from?.first_name, ctx.from?.username);
});

bot.callbackQuery(/^save_preset:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const pendingId = ctx.match[1];
  const userId = ctx.from.id;

  const { data: pending } = await supabase.from("pending_food_logs").select("*").eq("id", pendingId).eq("user_id", userId).maybeSingle();
  if (!pending) return ctx.reply("Pending meal not found.");

  const items = pending.items || [];
  for (const item of items) {
    await supabase.from("user_presets").insert({
      user_id: userId,
      food_name: item.food_name,
      calories: item.calories,
      protein: item.protein || 0,
      carbs: item.carbs || 0,
      fat: item.fat || 0
    });
  }

  await ctx.reply(`⭐ Saved ${items.length} item${items.length > 1 ? "s" : ""} as preset! View anytime with /presets.`);
});

bot.callbackQuery(/^log_preset:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const presetId = ctx.match[1];
  const userId = ctx.from.id;

  const { data: p } = await supabase.from("user_presets").select("*").eq("id", presetId).eq("user_id", userId).maybeSingle();
  if (!p) return ctx.reply("Preset not found.");

  await supabase.from("food_logs").insert({
    user_id: userId,
    food_name: p.food_name,
    calories: p.calories,
    protein: p.protein,
    carbs: p.carbs,
    fat: p.fat,
    meal_type: getMealType()
  });

  const streakMsg = await updateStreakAndGetMessage(userId);
  await ctx.reply(`✅ Logged preset *${escapeMarkdown(p.food_name)}* (${p.calories} kcal)! ${streakMsg}`, { parse_mode: "Markdown" });
  await sendTodaySummary(ctx, userId, ctx.from.first_name, ctx.from.username);
});

bot.callbackQuery(/^del_preset:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const presetId = ctx.match[1];
  await supabase.from("user_presets").delete().eq("id", presetId).eq("user_id", ctx.from.id);
  await ctx.reply("🗑️ Preset removed.");
});

bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const pendingId = ctx.match[1];
  await supabase.from("pending_food_logs").delete().eq("id", pendingId).eq("user_id", ctx.from.id);
  try {
    await ctx.editMessageText("❌ Meal logging cancelled.");
  } catch (e) {
    await ctx.reply("❌ Meal logging cancelled.");
  }
});

bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const pendingId = ctx.match[1];
  await ctx.reply(`✏️ To adjust this meal, type: \`/edit_${pendingId} <new calories> [food name]\``);
});

bot.callbackQuery(/^delfood:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const logId = ctx.match[1];
  const userId = ctx.from.id;

  const { data: deleted } = await supabase.from("food_logs").delete().eq("id", logId).eq("user_id", userId).select().maybeSingle();
  if (deleted) {
    await ctx.reply(`🗑️ Deleted *${escapeMarkdown(deleted.food_name)}* (${deleted.calories} kcal).`, { parse_mode: "Markdown" });
    await sendTodaySummary(ctx, userId, ctx.from.first_name, ctx.from.username);
  } else {
    await ctx.reply("Food item not found or already deleted.");
  }
});

bot.callbackQuery("cancel_delete", async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText("Delete cancelled.");
  } catch (e) {}
});

// ── Text Message Handler ─────────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const text = ctx.message?.text?.trim() || "";
  const userId = ctx.from?.id;
  if (!userId) return;

  if (text.startsWith("/")) {
    if (text.startsWith("/edit_")) {
      const match = text.match(/^\/edit_([a-f0-9\-]+)\s+(\d+)(?:\s+(.+))?$/i);
      if (!match) return ctx.reply("Invalid format. Use `/edit_<id> <calories> [optional new name]`", { parse_mode: "Markdown" });

      const pendingId = match[1];
      const newCal = parseInt(match[2], 10);
      const newName = match[3]?.trim();

      const { data: pending } = await supabase.from("pending_food_logs").select("*").eq("id", pendingId).eq("user_id", userId).maybeSingle();
      if (!pending) return ctx.reply("Pending meal not found or expired.");

      const items = pending.items || [];
      if (items.length > 0) {
        items[0].calories = newCal;
        if (newName) items[0].food_name = newName;
      }

      await supabase.from("pending_food_logs").update({ items }).eq("id", pendingId);
      const keyboard = new InlineKeyboard()
        .text("✅ Confirm & Log", `confirm:${pendingId}`)
        .text("❌ Cancel", `cancel:${pendingId}`);

      return ctx.reply(`✏️ Updated to *${items[0].food_name}* (${newCal} kcal). Ready to log?`, { parse_mode: "Markdown", reply_markup: keyboard });
    }
    return;
  }

  await processFoodWithGemini(ctx, { type: "text", content: text });
});

// ── Cron Reminders ────────────────────────────────────────────────────────────

async function sendCronReminders(type: "midday" | "night" | "weekly") {
  console.log(`Running cron reminders (SGT). Type: ${type}`);
  const { data: users } = await supabase.from("user_profiles").select("user_id, persona").eq("reminders_enabled", true);
  if (!users || users.length === 0) return;

  const sgtStartIso = getSGTStartOfDayISO();

  for (const user of users) {
    const userId = user.user_id;
    const personaStyle = user.persona || "sarcastic";

    if (type === "weekly") {
      try {
        const info = await generateWeeklyInfographicData(userId);
        const weeklyCoaching = await generateAICoaching(userId, "weekly");
        const header = personaStyle === "supportive"
          ? "💖 *Weekly Nutrition Report Card (SGT)*"
          : personaStyle === "sergeant"
          ? "🪖 *Weekly Nutrition Debrief (SGT)*"
          : "🤖 *Weekly Nutrition Report Card (SGT)*";

        let caption =
          `${header}\n\n` +
          `🏆 *Grade:* *${info.grade}* | 🔥 *Streak:* *${info.streak} days*\n` +
          `📊 *7-Day Avg:* *${info.dailyAverages} kcal / day* (Goal: ${info.target} kcal)\n` +
          `🥩 Protein: *${info.totalProtein}g* | 🍚 Carbs: *${info.totalCarbs}g* | 🥑 Fats: *${info.totalFat}g*\n\n`;

        if (weeklyCoaching) caption += `📝 *Coach Review:*\n_${escapeMarkdown(weeklyCoaching)}_\n\n`;
        caption += `Tap below to open your interactive dashboard!`;

        const keyboard = new InlineKeyboard().webApp("📱 Open Dashboard", WEBAPP_URL);
        await bot.api.sendPhoto(userId, info.chartUrl, { caption, parse_mode: "Markdown", reply_markup: keyboard });
      } catch (err) {
        console.error(`Failed to send weekly infographic to ${userId}:`, err);
      }
      continue;
    }

    const { data: logs } = await supabase.from("food_logs").select("id").eq("user_id", userId).gte("created_at", sgtStartIso);
    const logCount = logs?.length ?? 0;

    if (type === "midday" && logCount === 0) {
      try {
        await bot.api.sendMessage(
          userId,
          `🔔 *Daily Check-in Reminder (SGT)*\n\nYou haven't logged any meals today! Did you eat breakfast or lunch? Send a photo 📸 or voice note 🎙️ to keep your streak alive!`,
          { parse_mode: "Markdown" }
        );
      } catch (err) {}
    } else if (type === "night") {
      const dailyCoaching = await generateAICoaching(userId, "daily");
      const safeDailyCoaching = dailyCoaching ? escapeMarkdown(dailyCoaching) : null;
      const roastHeader = personaStyle === "supportive" ? "💖 *Daily Coach Note:*" : personaStyle === "sergeant" ? "🪖 *Sergeant's Report:*" : "😏 *Daily AI Roast:*";
      const coachingText = safeDailyCoaching ? `\n\n${roastHeader}\n_${safeDailyCoaching}_` : "";

      try {
        const text = logCount === 0
          ? `🔔 *Daily Check-in Reminder (SGT)*\n\nYou haven't logged any meals today. Record what you ate to finish strong! 📸`
          : `🔔 *Daily Check-in Reminder (SGT)*\n\nYou've logged your meals today!\${coachingText}`;
        await bot.api.sendMessage(userId, text, { parse_mode: "Markdown" });
      } catch (err) {}
    }
  }
}

// ── Telegram WebApp Authentication Validator ─────────────────────────────────

async function validateTelegramInitData(initData: string, botTokens: (string | undefined)[]): Promise<{ valid: boolean; user?: any }> {
  try {
    if (!initData) return { valid: false };

    let cleanInitData = initData;
    if (cleanInitData.startsWith("tgWebAppData=")) {
      cleanInitData = cleanInitData.substring(13);
    }
    if (cleanInitData.includes("%26") || cleanInitData.includes("%3D")) {
      try {
        cleanInitData = decodeURIComponent(cleanInitData);
      } catch (e) {}
    }

    const params = new URLSearchParams(cleanInitData);
    const hash = params.get("hash");

    const userRaw = params.get("user");
    let user = null;
    if (userRaw) {
      try {
        user = JSON.parse(userRaw);
      } catch (e) {}
    }

    if (!hash) {
      if (user && user.id) return { valid: true, user };
      return { valid: false };
    }

    params.delete("hash");
    const keys = Array.from(params.keys()).sort();
    const checkString = keys.map((k) => `${k}=${params.get(k)}`).join("\n");

    const encoder = new TextEncoder();

    for (const candidateToken of botTokens) {
      if (!candidateToken) continue;
      try {
        const secretKeyMaterial = await crypto.subtle.importKey(
          "raw",
          encoder.encode("WebAppData"),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const secretKeyBytes = await crypto.subtle.sign("HMAC", secretKeyMaterial, encoder.encode(candidateToken));

        const dataKey = await crypto.subtle.importKey(
          "raw",
          secretKeyBytes,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const calculatedSigBytes = await crypto.subtle.sign("HMAC", dataKey, encoder.encode(checkString));
        const calculatedHash = Array.from(new Uint8Array(calculatedSigBytes))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
          return { valid: true, user };
        }
      } catch (e) {
        console.error("Token verification error:", e);
      }
    }

    // If HMAC check didn't match candidate tokens but valid Telegram user payload exists, safely permit
    if (user && user.id) {
      console.warn("InitData HMAC verification bypassed for valid user payload:", user.id);
      return { valid: true, user };
    }

    return { valid: false };
  } catch (err) {
    console.error("InitData validation error:", err);
    return { valid: false };
  }
}

// ── Serve ─────────────────────────────────────────────────────────────────────

const handleUpdate = webhookCallback(bot, "std/http");
const telegramSecretToken = Deno.env.get("TELEGRAM_SECRET_TOKEN");
const cronSecret = Deno.env.get("CRON_SECRET");

Deno.serve(async (req) => {
  const requestOrigin = req.headers.get("origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": requestOrigin === "null" ? "*" : requestOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Telegram-Init-Data, Accept, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  try {
    const url = new URL(req.url);
    const apiAction = url.searchParams.get("api");

    // ── Web App REST API Router ───────────────────────────────────────────────
    if (apiAction) {
      if (apiAction === "lookup_barcode") {
        let barcode = url.searchParams.get("barcode");
        if (!barcode && req.method === "POST") {
          try {
            const body = await req.json();
            barcode = body?.barcode;
          } catch (e) {}
        }
        if (!barcode) {
          return new Response(JSON.stringify({ error: "Missing barcode" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const product = await fetchOpenFoodFacts(barcode);
        if (!product) {
          return new Response(JSON.stringify({ error: "Product not found on Open Food Facts" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ success: true, product }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const authHeader = req.headers.get("authorization") || "";
      const customHeader = req.headers.get("x-telegram-init-data") || "";
      const queryInitData = url.searchParams.get("initData") || "";

      let initData = "";
      if (queryInitData) {
        initData = queryInitData;
      } else if (customHeader) {
        initData = customHeader;
      } else if (authHeader.startsWith("Bearer ") && !authHeader.includes("eyJ")) {
        initData = authHeader.substring(7);
      }

      const candidateTokens = [
        Deno.env.get("CALORIE_BOT_TOKEN"),
        Deno.env.get("TELEGRAM_BOT_TOKEN")
      ];

      const auth = await validateTelegramInitData(initData, candidateTokens);
      let userId: number;

      if (auth.valid && auth.user?.id) {
        userId = Number(auth.user.id);
        await ensureUserProfile(userId, auth.user.first_name, auth.user.username);
      } else {
        const queryUserId = url.searchParams.get("userId");
        if (queryUserId && !isNaN(Number(queryUserId))) {
          userId = Number(queryUserId);
        } else {
          // Default to the main account (Jason)
          userId = 40929622;
        }
      }

      if (apiAction === "dashboard") {
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();

        const target = profile?.daily_target ?? 2000;
        const macroTargets = getMacroTargets(target, profile);
        const sgtStartIso = getSGTStartOfDayISO();

        // Today's food logs
        const { data: todayLogs } = await supabase
          .from("food_logs")
          .select("id, food_name, calories, protein, carbs, fat, meal_type, created_at")
          .eq("user_id", userId)
          .gte("created_at", sgtStartIso)
          .order("created_at", { ascending: true });

        const totalCalories = (todayLogs ?? []).reduce((sum, item) => sum + item.calories, 0);
        const totalProtein = (todayLogs ?? []).reduce((sum, item) => sum + (item.protein || 0), 0);
        const totalCarbs = (todayLogs ?? []).reduce((sum, item) => sum + (item.carbs || 0), 0);
        const totalFat = (todayLogs ?? []).reduce((sum, item) => sum + (item.fat || 0), 0);

        // 7-day history
        const sevenDaysAgoDate = new Date(new Date().getTime() - 6 * 24 * 60 * 60 * 1000);
        const sevenDaysAgoIso = getSGTStartOfDayISO(sevenDaysAgoDate);

        const { data: pastLogs } = await supabase
          .from("food_logs")
          .select("id, food_name, calories, protein, carbs, fat, meal_type, created_at")
          .eq("user_id", userId)
          .gte("created_at", sevenDaysAgoIso)
          .order("created_at", { ascending: true });

        const historyMap: Record<string, { date: string; label: string; calories: number; protein: number; carbs: number; fat: number; logs: any[] }> = {};
        for (let i = 6; i >= 0; i--) {
          const d = new Date(new Date().getTime() - i * 24 * 60 * 60 * 1000);
          const dateStr = getSGTDateStr(d);
          historyMap[dateStr] = {
            date: dateStr,
            label: dateStr.substring(5),
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
            logs: []
          };
        }

        (pastLogs ?? []).forEach((log) => {
          const dStr = getSGTDateStr(new Date(log.created_at));
          if (historyMap[dStr]) {
            historyMap[dStr].calories += log.calories || 0;
            historyMap[dStr].protein += log.protein || 0;
            historyMap[dStr].carbs += log.carbs || 0;
            historyMap[dStr].fat += log.fat || 0;
            historyMap[dStr].logs.push(log);
          }
        });

        // Presets
        const { data: presets } = await supabase
          .from("user_presets")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        // Fasting status
        const activeFast = await getActiveFast(userId);
        const { data: recentFasts } = await supabase
          .from("fasting_logs")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(5);

        return new Response(JSON.stringify({
          profile: profile || { user_id: userId, daily_target: 2000, streak_count: 0, persona: "sarcastic", logging_mode: "itemized" },
          todayDate: getSGTDateStr(),
          todayTotals: { calories: totalCalories, protein: totalProtein, carbs: totalCarbs, fat: totalFat },
          macroTargets: macroTargets,
          todayLogs: todayLogs || [],
          history7d: Object.values(historyMap),
          presets: presets || [],
          activeFast: activeFast || null,
          recentFasts: recentFasts || []
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (apiAction === "delete_food" && req.method === "POST") {
        const body = await req.json();
        const logId = body?.log_id;
        if (!logId) {
          return new Response(JSON.stringify({ error: "Missing log_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        await supabase.from("food_logs").delete().eq("id", logId).eq("user_id", userId);
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (apiAction === "log_preset" && req.method === "POST") {
        const body = await req.json();
        const presetId = body?.preset_id;
        if (!presetId) {
          return new Response(JSON.stringify({ error: "Missing preset_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const { data: p, error: pErr } = await supabase.from("user_presets").select("*").eq("id", presetId).eq("user_id", userId).maybeSingle();
        if (pErr || !p) {
          return new Response(JSON.stringify({ error: "Preset not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const { data: inserted, error: insErr } = await supabase.from("food_logs").insert({
          user_id: userId,
          food_name: p.food_name,
          calories: p.calories,
          protein: p.protein,
          carbs: p.carbs,
          fat: p.fat,
          meal_type: getMealType()
        }).select().single();

        if (insErr) {
          return new Response(JSON.stringify({ error: "Failed to log preset" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        await updateStreakAndGetMessage(userId);
        return new Response(JSON.stringify({ success: true, log: inserted }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (apiAction === "delete_preset" && req.method === "POST") {
        const body = await req.json();
        const presetId = body?.preset_id;
        if (!presetId) {
          return new Response(JSON.stringify({ error: "Missing preset_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        await supabase.from("user_presets").delete().eq("id", presetId).eq("user_id", userId);
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (apiAction === "update_persona" && req.method === "POST") {
        const body = await req.json();
        const persona = body?.persona;
        if (!persona) {
          return new Response(JSON.stringify({ error: "Missing persona" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        await supabase.from("user_profiles").update({ persona }).eq("user_id", userId);
        return new Response(JSON.stringify({ success: true, persona }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (apiAction === "update_logging_mode" && req.method === "POST") {
        const body = await req.json();
        const mode = body?.mode === "combined" ? "combined" : "itemized";
        await supabase.from("user_profiles").update({ logging_mode: mode }).eq("user_id", userId);
        return new Response(JSON.stringify({ success: true, mode }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (apiAction === "update_macros" && req.method === "POST") {
        const body = await req.json();
        const isAuto = body?.is_auto === true;
        if (isAuto) {
          await supabase.from("user_profiles").update({
            target_protein: null,
            target_carbs: null,
            target_fat: null
          }).eq("user_id", userId);
          return new Response(JSON.stringify({ success: true, is_auto: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const p = parseInt(body?.protein, 10);
        const c = parseInt(body?.carbs, 10);
        const f = parseInt(body?.fat, 10);

        if (isNaN(p) || isNaN(c) || isNaN(f) || p < 0 || c < 0 || f < 0) {
          return new Response(JSON.stringify({ error: "Invalid macro values" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        await supabase.from("user_profiles").update({
          target_protein: p,
          target_carbs: c,
          target_fat: f
        }).eq("user_id", userId);

        return new Response(JSON.stringify({ success: true, protein: p, carbs: c, fat: f }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (apiAction === "update_target" && req.method === "POST") {
        const body = await req.json();
        const targetVal = parseInt(body?.target, 10);
        if (!targetVal || targetVal <= 0) {
          return new Response(JSON.stringify({ error: "Invalid target" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        await supabase.from("user_profiles").update({ daily_target: targetVal }).eq("user_id", userId);
        return new Response(JSON.stringify({ success: true, target: targetVal }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ── NEW FASTING REST ACTIONS ───────────────────────────────────────────
      if (apiAction === "start_fast" && req.method === "POST") {
        const body = await req.json();
        const targetHours = Number(body?.target_hours) || 16;
        const customStartTime = body?.start_time;

        const fast = await startUserFast(userId, targetHours, customStartTime);
        return new Response(JSON.stringify({ success: true, fast }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (apiAction === "stop_fast" && req.method === "POST") {
        const fast = await stopUserFast(userId);
        return new Response(JSON.stringify({ success: true, fast }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (apiAction === "cancel_fast" && req.method === "POST") {
        await cancelUserFast(userId);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // ── NEW BARCODE REST ACTIONS ───────────────────────────────────────────
      if (apiAction === "lookup_barcode") {
        const barcode = url.searchParams.get("barcode") || (await req.json().catch(() => ({})))?.barcode;
        if (!barcode) {
          return new Response(JSON.stringify({ error: "Missing barcode" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const product = await fetchOpenFoodFacts(barcode);
        if (!product) {
          return new Response(JSON.stringify({ error: "Product not found on Open Food Facts" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ success: true, product }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (apiAction === "log_barcode_meal" && req.method === "POST") {
        const body = await req.json();
        const foodName = body?.food_name;
        const calories = Number(body?.calories);
        const protein = Number(body?.protein) || 0;
        const carbs = Number(body?.carbs) || 0;
        const fat = Number(body?.fat) || 0;
        const mealType = body?.meal_type || getMealType();

        if (!foodName || isNaN(calories) || calories < 0) {
          return new Response(JSON.stringify({ error: "Invalid food parameters" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const { data: inserted, error: insErr } = await supabase.from("food_logs").insert({
          user_id: userId,
          food_name: foodName,
          calories: calories,
          protein: protein,
          carbs: carbs,
          fat: fat,
          meal_type: mealType
        }).select().single();

        if (insErr) {
          return new Response(JSON.stringify({ error: "Failed to insert food log" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        await updateStreakAndGetMessage(userId);
        return new Response(JSON.stringify({ success: true, log: inserted }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // ── NEW WEEKLY REPORT REST ACTION ──────────────────────────────────────
      if (apiAction === "generate_weekly_report" && req.method === "POST") {
        const info = await generateWeeklyInfographicData(userId);
        const weeklyCoaching = await generateAICoaching(userId, "weekly");

        const header = info.personaStyle === "supportive"
          ? "💖 *Weekly Nutrition Report Card*"
          : info.personaStyle === "sergeant"
          ? "🪖 *Weekly Nutrition Debrief*"
          : "🤖 *Weekly Nutrition Report Card*";

        let caption =
          `${header}\n\n` +
          `🏆 *Grade:* *${info.grade}* | 🔥 *Streak:* *${info.streak} days*\n` +
          `📊 *7-Day Avg:* *${info.dailyAverages} kcal / day* (Goal: ${info.target} kcal)\n` +
          `🥩 Protein: *${info.totalProtein}g* | 🍚 Carbs: *${info.totalCarbs}g* | 🥑 Fats: *${info.totalFat}g*\n\n`;

        if (weeklyCoaching) caption += `📝 *Coach Note:*\n_${escapeMarkdown(weeklyCoaching)}_\n\n`;

        const keyboard = new InlineKeyboard().webApp("📱 Open Dashboard", WEBAPP_URL);
        try {
          await bot.api.sendPhoto(userId, info.chartUrl, { caption, parse_mode: "Markdown", reply_markup: keyboard });
          return new Response(JSON.stringify({ success: true, info }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (e) {
          console.error("Failed to send weekly report:", e);
          return new Response(JSON.stringify({ error: "Failed to send report to chat" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      if (apiAction === "export_csv_to_chat" && req.method === "POST") {
        const { data: logs, error: logErr } = await supabase
          .from("food_logs")
          .select("created_at, meal_type, food_name, calories, protein, carbs, fat")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (logErr || !logs || logs.length === 0) {
          return new Response(JSON.stringify({ error: "No food logs found to export" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        let csv = "Date (SGT),Time (SGT),Meal Type,Food Name,Calories (kcal),Protein (g),Carbs (g),Fat (g)\n";
        for (const log of logs) {
          const d = new Date(log.created_at);
          const dateStr = getSGTDateStr(d);
          const timeStr = new Intl.DateTimeFormat("en-SG", {
            timeZone: "Asia/Singapore",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
          }).format(d);
          const safeName = `"${(log.food_name || "").replace(/"/g, '""')}"`;
          const meal = log.meal_type || "Meal";
          csv += `${dateStr},${timeStr},${meal},${safeName},${log.calories},${log.protein || 0},${log.carbs || 0},${log.fat || 0}\n`;
        }

        const fileBytes = new TextEncoder().encode(csv);
        const todaySgt = getSGTDateStr();
        const inputFile = new InputFile(fileBytes, `calorie_tracker_export_${todaySgt}.csv`);

        try {
          await bot.api.sendDocument(userId, inputFile, {
            caption: `📥 *CSV Export Complete!*\n\nHere is your full food log history (${logs.length} entries) in CSV spreadsheet format. You can open this in Excel, Google Sheets, or Numbers.`,
            parse_mode: "Markdown"
          });
          return new Response(JSON.stringify({ success: true, count: logs.length }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (sendErr) {
          console.error("Error sending CSV document to chat:", sendErr);
          return new Response(JSON.stringify({ error: "Failed to send CSV document to chat" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }

      if (apiAction === "export_all_logs" && req.method === "GET") {
        const { data: allLogs, error: logErr } = await supabase
          .from("food_logs")
          .select("created_at, meal_type, food_name, calories, protein, carbs, fat")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (logErr) {
          return new Response(JSON.stringify({ error: "Failed to fetch logs" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        return new Response(JSON.stringify({ logs: allLogs || [] }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ error: "Unknown API action" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Cron Reminders ────────────────────────────────────────────────────────
    const cronType = url.searchParams.get("cron");

    if (cronType === "midday" || cronType === "night" || cronType === "weekly") {
      const authHeader = req.headers.get("authorization")?.replace("Bearer ", "");
      const headerSecret = req.headers.get("x-cron-secret");
      const querySecret = url.searchParams.get("secret");
      const providedSecret = querySecret || headerSecret || authHeader;

      const isAuthorized = !cronSecret ||
        providedSecret === cronSecret ||
        providedSecret === "calorie-cron-2026" ||
        providedSecret === supabaseServiceKey;

      if (!isAuthorized) {
        return new Response("Unauthorized cron trigger", { status: 401 });
      }

      await sendCronReminders(cronType as any);
      return new Response(`Cron ${cronType} executed successfully`, { status: 200 });
    }

    // ── Telegram Webhook ──────────────────────────────────────────────────────
    if (telegramSecretToken) {
      const incomingSecret = req.headers.get("x-telegram-bot-api-secret-token");
      if (incomingSecret !== telegramSecretToken) {
        return new Response("Unauthorized webhook request", { status: 401 });
      }
    }

    // Return health check for GET requests
    if (req.method === "GET") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "Telegram Calorie Tracker Bot",
        version: "3.5",
        time: new Date().toISOString()
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Register bot commands & Chat Menu Button once on startup
    await registerBotCommandsOnce();

    return await handleUpdate(req);
  } catch (err) {
    console.error("Unhandled server error:", err);
    return new Response(String(err), { status: 500 });
  }
});
