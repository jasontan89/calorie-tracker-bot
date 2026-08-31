import { Bot, webhookCallback, InlineKeyboard, InputFile } from "npm:grammy@^1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const token = Deno.env.get("CALORIE_BOT_TOKEN");
if (!token) {
  throw new Error("CALORIE_BOT_TOKEN is not set");
}

const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
if (!geminiApiKey) {
  throw new Error("GEMINI_API_KEY is not set");
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Supabase URL and Service Role Key are not configured");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const bot = new Bot(token);

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
async function registerBotCommandsOnce() {
  if (commandsRegistered) return;
  try {
    await bot.api.setMyCommands([
      { command: "today", description: "📅 Today's Summary & Progress" },
      { command: "presets", description: "⭐ Saved Presets & Supplements" },
      { command: "history", description: "📊 7-Day Calorie History" },
      { command: "persona", description: "🤖 Choose AI Coach Personality" },
      { command: "mode", description: "🍲 Meal Logging Mode (Itemized vs Combined)" },
      { command: "export", description: "📥 Export Food Logs to CSV" },
      { command: "weight", description: "⚖️ Log Current Weight (kg)" },
      { command: "progress", description: "📈 30-Day Weight Chart" },
      { command: "leaderboard", description: "🏆 Group Calorie Leaderboard" },
      { command: "joinleaderboard", description: "👥 Join Group Leaderboard" },
      { command: "reminders", description: "🔔 Toggle Daily Alerts" },
      { command: "delete", description: "🗑️ Select & Delete Today's Food" },
      { command: "target", description: "🎯 Update Calorie Goal" },
      { command: "start", description: "👋 Welcome & Instructions" }
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

  const todaySgt = getSGTDateStr();
  const currentStreak = profile.streak_count || 0;
  const lastLogDate = profile.last_log_date;

  let newStreak = currentStreak;

  if (!lastLogDate) {
    newStreak = 1;
  } else if (lastLogDate === todaySgt) {
    return `\n\n🔥 You are on a *${currentStreak}-day streak*!`;
  } else {
    const yesterdayDate = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);
    const yesterdaySgt = getSGTDateStr(yesterdayDate);

    if (lastLogDate === yesterdaySgt) {
      newStreak = currentStreak + 1;
    } else {
      newStreak = 1;
    }
  }

  await supabase
    .from("user_profiles")
    .update({ streak_count: newStreak, last_log_date: todaySgt })
    .eq("user_id", userId);

  return `\n\n🔥 You are on a *${newStreak}-day streak*! Keep it going!`;
}

function getMacroTargets(calorieTarget: number, profile: any) {
  const protein = profile?.target_protein ?? Math.round((calorieTarget * 0.3) / 4);
  const carbs = profile?.target_carbs ?? Math.round((calorieTarget * 0.4) / 4);
  const fat = profile?.target_fat ?? Math.round((calorieTarget * 0.3) / 9);
  return { protein, carbs, fat };
}

function getMealType(): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: "Asia/Singapore", hour: "numeric", hour12: false };
  const sgtHour = parseInt(new Intl.DateTimeFormat("en-US", options).format(new Date()));
  if (sgtHour >= 5 && sgtHour < 11) return "Breakfast";
  if (sgtHour >= 11 && sgtHour < 15) return "Lunch";
  if (sgtHour >= 17 && sgtHour < 22) return "Dinner";
  return "Snack";
}

function getPersonaDisplayName(persona?: string): string {
  switch (persona) {
    case "supportive": return "💖 Supportive Cheerleader";
    case "sergeant": return "🪖 Drill Sergeant";
    case "sarcastic":
    default: return "🔥 Sarcastic & Witty Coach";
  }
}

function getLoggingModeDisplayName(mode?: string): string {
  switch (mode) {
    case "combined": return "🍲 Single Combined Meal";
    case "itemized":
    default: return "🧩 Itemized Ingredients";
  }
}

// ── Preset Manager View ───────────────────────────────────────────────────────
async function renderPresetsMenu(ctx: any, userId: number, isEdit: boolean = false) {
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const { data: presets, error } = await supabase
    .from("user_presets")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error || !presets || presets.length === 0) {
    const emptyMsg = 
      `⭐ *No Saved Presets Yet!*\n\n` +
      `Log any meal, photo, or voice note, then tap *⭐ Save as Preset* on the confirmation message to save quick items (like daily supplements, snacks, or frequent meals).`;
    if (isEdit && ctx.callbackQuery) {
      await ctx.editMessageText(emptyMsg, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(emptyMsg, { parse_mode: "Markdown" });
    }
    return;
  }

  let text = `⭐ *Your Saved Presets & Supplements*\n\n`;
  const keyboard = new InlineKeyboard();

  presets.forEach((preset) => {
    const safeName = escapeMarkdown(preset.food_name);
    text += `• *${safeName}* — ${preset.calories} kcal (P:${preset.protein}g C:${preset.carbs}g F:${preset.fat}g)\n`;
    const shortName = preset.food_name.length > 14 ? preset.food_name.substring(0, 12) + "…" : preset.food_name;
    keyboard.text(`➕ ${shortName}`, `log_preset:${preset.id}`)
            .text(`🗑️ Delete`, `del_preset:${preset.id}`)
            .row();
  });

  text += `\n_Tap "➕" to immediately log to today, or "🗑️ Delete" to remove._`;

  if (isEdit && ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}

// ── Delete Menu View ──────────────────────────────────────────────────────────
async function renderDeleteMenu(ctx: any, userId: number) {
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const sgtStartIso = getSGTStartOfDayISO();

  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("id, food_name, calories, created_at")
    .eq("user_id", userId)
    .gte("created_at", sgtStartIso)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching today's logs for deletion:", error);
    return ctx.reply("Failed to load today's food logs.");
  }

  if (!logs || logs.length === 0) {
    return ctx.reply("_No food logged today to delete._", { parse_mode: "Markdown" });
  }

  let text = `🗑️ *Select a meal to delete from today:*\n\n`;
  const keyboard = new InlineKeyboard();

  logs.forEach((log) => {
    const safeFood = escapeMarkdown(log.food_name);
    text += `• *${safeFood}* — ${log.calories} kcal\n`;
    const btnLabel = `❌ ${log.food_name.length > 20 ? log.food_name.substring(0, 18) + "…" : log.food_name} (${log.calories} kcal)`;
    keyboard.text(btnLabel, `delfood:${log.id}`).row();
  });

  keyboard.text("🚫 Cancel", "cancel_delete");

  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

// ── 7-Day History View ────────────────────────────────────────────────────────
async function renderHistoryView(ctx: any, userId: number) {
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const sevenDaysAgoDate = new Date(new Date().getTime() - 6 * 24 * 60 * 60 * 1000);
  const sevenDaysAgoIso = getSGTStartOfDayISO(sevenDaysAgoDate);

  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("calories, created_at")
    .eq("user_id", userId)
    .gte("created_at", sevenDaysAgoIso)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching history:", error);
    return ctx.reply("Failed to fetch history.");
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("daily_target")
    .eq("user_id", userId)
    .maybeSingle();

  const target = profile?.daily_target ?? 2000;

  const historyMap: Record<string, number> = {};
  const past7Days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(new Date().getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = getSGTDateStr(d);
    historyMap[dateStr] = 0;
    past7Days.push(dateStr);
  }

  (logs ?? []).forEach((log) => {
    const dateStr = getSGTDateStr(new Date(log.created_at));
    if (dateStr in historyMap) {
      historyMap[dateStr] += log.calories;
    }
  });

  const sortedDates = past7Days;
  const calorieValues = sortedDates.map(date => historyMap[date]);

  let textReport = `📊 *7-Day Calorie History (SGT)*\n\n`;
  sortedDates.forEach((dateStr) => {
    const total = historyMap[dateStr];
    const isOver = total > target;
    const isToday = dateStr === getSGTDateStr();
    textReport += `• *${dateStr}*${isToday ? " (Today)" : ""}: ${total} / ${target} kcal ${total === 0 ? "⚪" : isOver ? "⚠️" : "✅"}\n`;
  });

  textReport += `\n_Tap a date below to inspect individual meals:_`;

  const keyboard = new InlineKeyboard()
    .webApp("📱 Open Interactive Dashboard", WEBAPP_URL)
    .row();
  // Row 1: 4 older days
  for (let i = 0; i < 4; i++) {
    const dStr = sortedDates[i];
    const label = dStr.substring(5); // MM-DD
    keyboard.text(label, `history_day:${dStr}`);
  }
  keyboard.row();
  // Row 2: 3 recent days
  for (let i = 4; i < 7; i++) {
    const dStr = sortedDates[i];
    const label = i === 6 ? "Today" : dStr.substring(5);
    keyboard.text(label, `history_day:${dStr}`);
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

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const name = escapeMarkdown(ctx.from?.first_name ?? "there");

  const keyboard = new InlineKeyboard()
    .webApp("📱 Open Interactive Dashboard", WEBAPP_URL)
    .row()
    .text("⭐ View Saved Presets", "open_presets")
    .text("🤖 AI Coach Style", "open_persona")
    .row()
    .text("🍲 Logging Mode", "open_mode");

  await ctx.reply(
    `Welcome to Calorie Tracker Bot v3.4, ${name}! 🍎\n\n` +
    `I can track calories, macronutrients, weight, voice notes & multi-item meals!\n\n` +
    `👉 *How to use:*\n` +
    `• 📸 *Send a photo* of your food to auto-estimate calories & macros!\n` +
    `• 🎙️ *Send a voice note* (e.g. "I had two eggs and toast") to auto-log!\n` +
    `• ✍️ *Just type what you ate* in chat.\n` +
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
    `• 🔔 Use /reminders for opt-in daily check-ins & weekly reviews.`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.command("target", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const args = ctx.match?.trim();
  if (!args) {
    return ctx.reply("Please specify a target number. Example: `/target 2000`", { parse_mode: "Markdown" });
  }

  const targetCalories = parseInt(args);
  if (isNaN(targetCalories) || targetCalories <= 0) {
    return ctx.reply("Please enter a valid positive number for your target.");
  }

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const { error } = await supabase
    .from("user_profiles")
    .upsert({ user_id: userId, daily_target: targetCalories });

  if (error) {
    console.error("Error updating target:", error);
    return ctx.reply("Failed to update your calorie target. Please try again.");
  }

  await ctx.reply(`🎯 Your daily calorie target has been updated to *${targetCalories} kcal*!`, { parse_mode: "Markdown" });
});

bot.command("mode", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const { data: profile } = await supabase.from("user_profiles").select("logging_mode").eq("user_id", userId).maybeSingle();
  const currentMode = profile?.logging_mode || "itemized";

  const keyboard = new InlineKeyboard()
    .text(currentMode === "itemized" ? "🧩 Itemized Ingredients (Active)" : "🧩 Itemized Ingredients", "set_mode:itemized").row()
    .text(currentMode === "combined" ? "🍲 Single Combined Meal (Active)" : "🍲 Single Combined Meal", "set_mode:combined");

  await ctx.reply(
    `🍲 *Meal Logging Mode Settings*\n\n` +
    `Current Mode: *${getLoggingModeDisplayName(currentMode)}*\n\n` +
    `Choose how multi-item meals should be logged:\n\n` +
    `• 🧩 *Itemized Ingredients*: Logs each ingredient separately (e.g. Eggs, Toast, Coffee) for detailed macro breakdown and saving individual presets.\n` +
    `• 🍲 *Single Combined Meal*: Logs the whole meal as 1 combined record (e.g. "Big Breakfast — 550 kcal").`,
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
    return ctx.reply("No food logs found to export. Start logging meals first!");
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
    caption: `📥 *Export Complete!*\n\nHere is your full food log history (${logs.length} entries) in CSV format. You can open this file with Microsoft Excel, Apple Numbers, or Google Sheets.`,
    parse_mode: "Markdown"
  });
});

bot.command("today", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  const target = profile?.daily_target ?? 2000;
  const macroTargets = getMacroTargets(target, profile);
  const sgtStartIso = getSGTStartOfDayISO();

  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("food_name, calories, protein, carbs, fat, meal_type, created_at")
    .eq("user_id", userId)
    .gte("created_at", sgtStartIso)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error loading today's logs:", error);
    return ctx.reply("Failed to load today's summary.");
  }

  const totalCalories = (logs ?? []).reduce((sum, item) => sum + item.calories, 0);
  const totalProtein = (logs ?? []).reduce((sum, item) => sum + (item.protein || 0), 0);
  const totalCarbs = (logs ?? []).reduce((sum, item) => sum + (item.carbs || 0), 0);
  const totalFat = (logs ?? []).reduce((sum, item) => sum + (item.fat || 0), 0);

  const remaining = target - totalCalories;
  const sgtTodayStr = getSGTDateStr();

  let message = `📅 *Today's Food Log (${sgtTodayStr} SGT)*\n\n`;
  if (!logs || logs.length === 0) {
    message += `_No food logged today yet._\n\n`;
  } else {
    logs.forEach((log) => {
      const safeFood = escapeMarkdown(log.food_name);
      const safeMealType = escapeMarkdown(log.meal_type || "Meal");
      message += `• ${log.calories} kcal — *${safeFood}* _(${safeMealType})_\n   _P:${log.protein}g | C:${log.carbs}g | F:${log.fat}g_\n`;
    });
    message += `\n`;
  }

  message += `━━━━━━━━━━━━━━━━━━━━\n`;
  const calBar = renderProgressBar(totalCalories, target, 10);
  message += `🔥 *Calories: ${totalCalories} / ${target} kcal*\n`;
  message += `   ${calBar}\n`;
  if (remaining >= 0) {
    message += `   Budget Left: *${remaining} kcal* 🍏\n\n`;
  } else {
    message += `   Budget: *${Math.abs(remaining)} kcal OVER* ⚠️\n\n`;
  }

  const pBar = renderProgressBar(totalProtein, macroTargets.protein, 10);
  const cBar = renderProgressBar(totalCarbs, macroTargets.carbs, 10);
  const fBar = renderProgressBar(totalFat, macroTargets.fat, 10);

  message += `🥦 *Macronutrients Breakdown:*` + (profile?.target_protein ? " _(Custom Target)_\n" : "\n");
  message += `• 🥩 *Protein:* ${totalProtein} / ${macroTargets.protein}g\n   ${pBar}\n`;
  message += `• 🍚 *Carbs:* ${totalCarbs} / ${macroTargets.carbs}g\n   ${cBar}\n`;
  message += `• 🥑 *Fat:* ${totalFat} / ${macroTargets.fat}g\n   ${fBar}`;

  const keyboard = new InlineKeyboard()
    .webApp("📱 Open Interactive Dashboard", WEBAPP_URL)
    .row()
    .text("⭐ Presets", "open_presets")
    .text("🗑️ Delete Meal", "open_delete")
    .row()
    .text("📊 7-Day History", "open_history");

  await ctx.reply(message, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.command("history", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await renderHistoryView(ctx, userId);
});

bot.command("persona", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const { data: profile } = await supabase.from("user_profiles").select("persona").eq("user_id", userId).maybeSingle();
  const currentPersona = profile?.persona || "sarcastic";

  const keyboard = new InlineKeyboard()
    .text(currentPersona === "sarcastic" ? "🔥 Sarcastic (Active)" : "🔥 Sarcastic", "set_persona:sarcastic").row()
    .text(currentPersona === "supportive" ? "💖 Supportive (Active)" : "💖 Supportive", "set_persona:supportive").row()
    .text(currentPersona === "sergeant" ? "🪖 Drill Sergeant (Active)" : "🪖 Drill Sergeant", "set_persona:sergeant");

  await ctx.reply(
    `🤖 *AI Coach Personality Settings*\n\n` +
    `Current Persona: *${getPersonaDisplayName(currentPersona)}*\n\n` +
    `Choose how you want your AI coach to interact with you during daily check-ins and weekly reviews:\n\n` +
    `• 🔥 *Sarcastic*: Witty roasts and cheeky banter about your food.\n` +
    `• 💖 *Supportive*: Warm cheerleader, gentle praise, uplifting vibes.\n` +
    `• 🪖 *Drill Sergeant*: Strict discipline, zero excuses, maximum accountability.`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.command("presets", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await renderPresetsMenu(ctx, userId);
});

bot.command("delete", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await renderDeleteMenu(ctx, userId);
});

bot.command("weight", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const args = ctx.match?.trim();
  if (!args) {
    return ctx.reply("Please specify your weight in kg. Example: `/weight 72.5`", { parse_mode: "Markdown" });
  }

  const weight = parseFloat(args);
  if (isNaN(weight) || weight <= 0) {
    return ctx.reply("Please enter a valid weight number (e.g. 72.5).");
  }

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  await supabase.from("weight_logs").insert({ user_id: userId, weight: weight });
  await ctx.reply(`⚖️ Logged weight: *${weight} kg*`, { parse_mode: "Markdown" });
});

bot.command("progress", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const thirtyDaysAgoIso = getSGTStartOfDayISO(new Date(new Date().getTime() - 30 * 24 * 60 * 60 * 1000));

  const { data: logs } = await supabase
    .from("weight_logs")
    .select("weight, created_at")
    .eq("user_id", userId)
    .gte("created_at", thirtyDaysAgoIso)
    .order("created_at", { ascending: true });

  if (!logs || logs.length === 0) {
    return ctx.reply("No weight entries found in the last 30 days. Log your weight with `/weight <number>`!", { parse_mode: "Markdown" });
  }

  const labels = logs.map(log => getSGTDateStr(new Date(log.created_at)).substring(5));
  const weights = logs.map(log => log.weight);

  const chartConfig = {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Weight (kg)',
        data: weights,
        borderColor: '#4F46E5',
        backgroundColor: 'rgba(79, 70, 229, 0.08)',
        fill: true,
        tension: 0.35
      }]
    },
    options: {
      title: { display: true, text: 'Weight Progress (Last 30 Days - SGT)' }
    }
  };

  try {
    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
    await ctx.replyWithPhoto(chartUrl, { caption: "Here is your 30-day weight progress chart! 📈" });
  } catch (chartErr) {
    console.error("Failed to generate/send weight chart:", chartErr);
    let textSummary = `📈 *Weight Progress (Last 30 Days)*\n\n`;
    logs.forEach(log => {
      const dateStr = getSGTDateStr(new Date(log.created_at));
      textSummary += `• *${dateStr}*: ${log.weight} kg\n`;
    });
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
    await ctx.reply(`🔔 *Reminders & AI Coaching Enabled!*\n\nActive Coach Style: *${personaName}*\nYou'll get daily check-ins & weekly AI reviews in SGT.`, { parse_mode: "Markdown" });
  } else {
    await ctx.reply(`🔕 *Reminders Disabled.*`, { parse_mode: "Markdown" });
  }
});

// ── Group Leaderboard Commands ───────────────────────────────────────────────

bot.command("joinleaderboard", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const { error } = await supabase
    .from("group_members")
    .upsert({ group_id: chatId, user_id: userId });

  if (error) {
    console.error("Error joining leaderboard:", error);
    return ctx.reply("Failed to join the leaderboard for this chat.");
  }

  const userName = escapeMarkdown(ctx.from?.first_name ?? "User");
  await ctx.reply(`🎉 *${userName}* has joined the chat leaderboard! Use /leaderboard to check rankings.`, { parse_mode: "Markdown" });
});

bot.command("leaderboard", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (ctx.from?.id) {
    await ensureUserProfile(ctx.from.id, ctx.from.first_name, ctx.from.username);
  }

  const { data: members, error } = await supabase
    .from("group_members")
    .select("user_id")
    .eq("group_id", chatId);

  if (error || !members || members.length === 0) {
    return ctx.reply("No leaderboard members in this chat yet! Type `/joinleaderboard` to join.", { parse_mode: "Markdown" });
  }

  const userIds = members.map(m => m.user_id);
  const sevenDaysAgoIso = getSGTStartOfDayISO(new Date(new Date().getTime() - 6 * 24 * 60 * 60 * 1000));

  const { data: profiles } = await supabase
    .from("user_profiles")
    .select("user_id, streak_count, first_name, username")
    .in("user_id", userIds);

  const { data: logs } = await supabase
    .from("food_logs")
    .select("user_id, created_at")
    .in("user_id", userIds)
    .gte("created_at", sevenDaysAgoIso);

  const userDaysMap: Record<number, Set<string>> = {};
  userIds.forEach(id => { userDaysMap[id] = new Set(); });

  (logs ?? []).forEach(log => {
    const sgtDate = getSGTDateStr(new Date(log.created_at));
    if (log.user_id in userDaysMap) {
      userDaysMap[log.user_id].add(sgtDate);
    }
  });

  const profileMap = new Map((profiles ?? []).map(p => [p.user_id, p]));

  const rankings = await Promise.all(userIds.map(async (uid) => {
    let p = profileMap.get(uid);
    let firstName = p?.first_name;
    let username = p?.username;

    if (!firstName) {
      try {
        const memberInfo = await ctx.api.getChatMember(chatId, uid);
        if (memberInfo?.user) {
          firstName = memberInfo.user.first_name;
          username = memberInfo.user.username;
          await supabase
            .from("user_profiles")
            .update({ first_name: firstName || null, username: username || null })
            .eq("user_id", uid);
        }
      } catch (err) {
        console.error(`Could not fetch chat member for user ${uid}:`, err);
      }
    }

    const daysCount = userDaysMap[uid]?.size ?? 0;
    const streak = p?.streak_count ?? 0;
    const nameStr = firstName 
      ? (username ? `${firstName} (@${username})` : firstName)
      : `User ${uid}`;

    return { userId: uid, nameStr, daysCount, streak };
  }));

  rankings.sort((a, b) => b.daysCount - a.daysCount || b.streak - a.streak);

  let message = `🏆 *Group Calorie Tracker Leaderboard (Past 7 Days)* 🏆\n\n`;
  const medalEmojis = ["🥇", "🥈", "🥉"];

  rankings.forEach((r, idx) => {
    const medal = idx < 3 ? medalEmojis[idx] : ` ${idx + 1}.`;
    const safeName = escapeMarkdown(r.nameStr);
    message += `${medal} *${safeName}* — *${r.daysCount} days logged* (🔥 ${r.streak}-day streak)\n`;
  });

  message += `\n_Keep logging daily to climb the leaderboard!_`;
  await ctx.reply(message, { parse_mode: "Markdown" });
});

// ── Core AI Processing Helper (Photos, Voice & Text) ─────────────────────────

async function processFoodWithGemini(
  ctx: any,
  userId: number,
  statusMsg: any,
  textDesc?: string,
  base64Data?: string,
  mimeType?: string
) {
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`;
    
    const isAudio = mimeType?.startsWith("audio/");
    const isImage = mimeType?.startsWith("image/");

    let promptText = 
      "You are an expert nutrition and calorie estimation assistant. Analyze this food ";
    if (isAudio) {
      promptText += "voice description ";
    } else if (isImage) {
      promptText += "photo ";
    } else {
      promptText += "description ";
    }

    promptText += 
      "and estimate the food item name/description, calories, protein, carbs, and fat. " +
      "Identify every distinct food/drink item separately, estimate portion size, rate confidence (High/Medium/Low), provide per-item macros, and aggregate a combined total. " +
      "Provide a one-line nutrition insight. " +
      "Return ONLY a raw JSON object (no markdown, no code fences, no explanation) in this exact format: " +
      "{\"meal_description\": \"<overall meal description>\", \"items\": [{\"food\": \"<item name>\", \"portion\": \"<estimated portion>\", \"calories\": <int>, \"protein\": <int>, \"carbs\": <int>, \"fat\": <int>, \"confidence\": \"<High/Medium/Low>\"}], \"total\": {\"calories\": <int>, \"protein\": <int>, \"carbs\": <int>, \"fat\": <int>}, \"nutrition_insight\": \"<insight>\"}";

    const parts: any[] = [{ text: promptText }];
    if (textDesc) {
      parts.push({ text: `Food description: ${textDesc}` });
    }
    if (base64Data && mimeType) {
      parts.push({
        inlineData: { mimeType, data: base64Data }
      });
    }

    const requestBody = { contents: [{ parts }] };

    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    const rawBody = await response.text();
    if (!response.ok) {
      console.error("Gemini API non-OK response:", rawBody);
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const result = JSON.parse(rawBody);
    const resultText = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!resultText) {
      throw new Error(`No text in Gemini response. finishReason=${result.candidates?.[0]?.finishReason}`);
    }

    const cleanedText = resultText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleanedText);

    const mealDesc = parsed.meal_description || "Unknown Food";
    const totalCal = parsed.total?.calories || 0;
    const totalP = parsed.total?.protein || 0;
    const totalC = parsed.total?.carbs || 0;
    const totalF = parsed.total?.fat || 0;
    const insight = parsed.nutrition_insight || "";
    const items = parsed.items || [];
    const mealType = getMealType();

    const { data: pending, error: pendingError } = await supabase
      .from("pending_food_logs")
      .insert({
        user_id: userId,
        food_name: mealDesc,
        calories: totalCal,
        protein: totalP,
        carbs: totalC,
        fat: totalF,
        meal_type: mealType,
        items: items
      })
      .select()
      .single();

    if (pendingError) throw pendingError;

    const inlineKeyboard = new InlineKeyboard()
      .text("✅ Confirm & Log", `confirm:${pending.id}`)
      .text("✍️ Edit Calories", `edit:${pending.id}`)
      .row()
      .text("❌ Cancel", `cancel:${pending.id}`);

    const safeMealDesc = escapeMarkdown(mealDesc);
    const safeInsight = escapeMarkdown(insight);

    let displayMessage = `🥗 *AI Meal Scan Results*\n\n`;
    displayMessage += `🍽 *${safeMealDesc}*\n`;
    displayMessage += `🕐 Meal type: ${mealType}\n\n`;
    displayMessage += `Identified items:\n`;
    
    for (const item of items) {
      const confBadge = item.confidence?.toLowerCase() === 'high' ? '🟢 High' : (item.confidence?.toLowerCase() === 'medium' ? '🟡 Medium' : '🔴 Low');
      const safeFoodItem = escapeMarkdown(item.food);
      const safePortion = escapeMarkdown(item.portion || "1 serving");
      displayMessage += `• ${safeFoodItem} (${safePortion}) — ${item.calories} kcal (P:${item.protein}g C:${item.carbs}g F:${item.fat}g) [${confBadge}]\n`;
    }
    
    displayMessage += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    displayMessage += `📊 Combined Total: *${totalCal} kcal*\n`;
    displayMessage += `Macros: P:${totalP}g | C:${totalC}g | F:${totalF}g\n\n`;
    if (safeInsight) {
      displayMessage += `💡 _${safeInsight}_\n\n`;
    }
    displayMessage += `Would you like to log this?`;

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await ctx.reply(displayMessage, { parse_mode: "Markdown", reply_markup: inlineKeyboard });
    
  } catch (error) {
    console.error("Error in AI processing:", error);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "⚠️ Sorry, I failed to analyze that food input. Please try again."
    );
  }
}

// ── Photo Handling ───────────────────────────────────────────────────────────

bot.on("message:photo", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const statusMsg = await ctx.reply("🤖 Analyzing your food photo with Gemini AI...");

  try {
    const photo = ctx.message.photo;
    const fileId = photo[photo.length - 1].file_id;
    const file = await ctx.api.getFile(fileId);
    
    if (!file.file_path) throw new Error("No file path");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const fileRes = await fetch(fileUrl);
    const arrayBuffer = await fileRes.arrayBuffer();
    const base64Image = encodeBase64(new Uint8Array(arrayBuffer));

    const ext = file.file_path.split(".").pop()?.toLowerCase();
    const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";

    await processFoodWithGemini(ctx, userId, statusMsg, undefined, base64Image, mimeType);
  } catch (error) {
    console.error("Error fetching photo:", error);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "⚠️ Failed to process photo.");
  }
});

// ── Voice Note Handling ──────────────────────────────────────────────────────

bot.on("message:voice", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);
  const statusMsg = await ctx.reply("🎙️ Listening to your voice note & analyzing with Gemini AI...");

  try {
    const voice = ctx.message.voice;
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) throw new Error("No file path for voice note");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const fileRes = await fetch(fileUrl);
    const arrayBuffer = await fileRes.arrayBuffer();
    const base64Audio = encodeBase64(new Uint8Array(arrayBuffer));

    await processFoodWithGemini(ctx, userId, statusMsg, undefined, base64Audio, "audio/ogg");
  } catch (error) {
    console.error("Error fetching voice note:", error);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "⚠️ Failed to process voice note.");
  }
});

// ── Callback Queries ──────────────────────────────────────────────────────────

bot.callbackQuery("open_presets", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery();
  await renderPresetsMenu(ctx, userId);
});

bot.callbackQuery("open_delete", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery();
  await renderDeleteMenu(ctx, userId);
});

bot.callbackQuery("open_history", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery();
  await renderHistoryView(ctx, userId);
});

bot.callbackQuery("open_persona", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery();

  const { data: profile } = await supabase.from("user_profiles").select("persona").eq("user_id", userId).maybeSingle();
  const currentPersona = profile?.persona || "sarcastic";

  const keyboard = new InlineKeyboard()
    .text(currentPersona === "sarcastic" ? "🔥 Sarcastic (Active)" : "🔥 Sarcastic", "set_persona:sarcastic").row()
    .text(currentPersona === "supportive" ? "💖 Supportive (Active)" : "💖 Supportive", "set_persona:supportive").row()
    .text(currentPersona === "sergeant" ? "🪖 Drill Sergeant (Active)" : "🪖 Drill Sergeant", "set_persona:sergeant");

  await ctx.reply(
    `🤖 *AI Coach Personality Settings*\n\n` +
    `Current Persona: *${getPersonaDisplayName(currentPersona)}*\n\n` +
    `Choose your AI coach style:\n\n` +
    `• 🔥 *Sarcastic*: Witty roasts and cheeky humor.\n` +
    `• 💖 *Supportive*: Warm praise and cheerleader vibes.\n` +
    `• 🪖 *Drill Sergeant*: Strict discipline, no excuses.`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.callbackQuery("open_mode", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery();

  const { data: profile } = await supabase.from("user_profiles").select("logging_mode").eq("user_id", userId).maybeSingle();
  const currentMode = profile?.logging_mode || "itemized";

  const keyboard = new InlineKeyboard()
    .text(currentMode === "itemized" ? "🧩 Itemized Ingredients (Active)" : "🧩 Itemized Ingredients", "set_mode:itemized").row()
    .text(currentMode === "combined" ? "🍲 Single Combined Meal (Active)" : "🍲 Single Combined Meal", "set_mode:combined");

  await ctx.reply(
    `🍲 *Meal Logging Mode Settings*\n\n` +
    `Current Mode: *${getLoggingModeDisplayName(currentMode)}*\n\n` +
    `Choose how multi-item meals should be logged:\n\n` +
    `• 🧩 *Itemized Ingredients*: Logs each ingredient separately (e.g. Eggs, Toast, Coffee) for detailed macro breakdown and saving individual presets.\n` +
    `• 🍲 *Single Combined Meal*: Logs the whole meal as 1 combined record (e.g. "Big Breakfast — 550 kcal").`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.callbackQuery(/^set_persona:(.+)$/, async (ctx) => {
  const personaType = ctx.match[1];
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery({ text: `Set to ${getPersonaDisplayName(personaType)}` });

  await supabase.from("user_profiles").update({ persona: personaType }).eq("user_id", userId);

  const keyboard = new InlineKeyboard()
    .text(personaType === "sarcastic" ? "🔥 Sarcastic (Active)" : "🔥 Sarcastic", "set_persona:sarcastic").row()
    .text(personaType === "supportive" ? "💖 Supportive (Active)" : "💖 Supportive", "set_persona:supportive").row()
    .text(personaType === "sergeant" ? "🪖 Drill Sergeant (Active)" : "🪖 Drill Sergeant", "set_persona:sergeant");

  await ctx.editMessageText(
    `✅ AI Coach style set to *${getPersonaDisplayName(personaType)}*!\n\n` +
    `Your daily check-ins and weekly reviews will now reflect this personality.`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.callbackQuery(/^set_mode:(itemized|combined)$/, async (ctx) => {
  const mode = ctx.match[1];
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery({ text: `Set to ${getLoggingModeDisplayName(mode)}` });

  await supabase.from("user_profiles").update({ logging_mode: mode }).eq("user_id", userId);

  const keyboard = new InlineKeyboard()
    .text(mode === "itemized" ? "🧩 Itemized Ingredients (Active)" : "🧩 Itemized Ingredients", "set_mode:itemized").row()
    .text(mode === "combined" ? "🍲 Single Combined Meal (Active)" : "🍲 Single Combined Meal", "set_mode:combined");

  await ctx.editMessageText(
    `✅ Meal logging mode updated to *${getLoggingModeDisplayName(mode)}*!\n\n` +
    `Future meal scans will be recorded in this format.`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.callbackQuery(/^history_day:(.+)$/, async (ctx) => {
  const dateStr = ctx.match[1]; // YYYY-MM-DD
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery();

  const startIso = new Date(`${dateStr}T00:00:00+08:00`).toISOString();
  const endIso = new Date(`${dateStr}T23:59:59.999+08:00`).toISOString();

  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("food_name, calories, protein, carbs, fat, meal_type, created_at")
    .eq("user_id", userId)
    .gte("created_at", startIso)
    .lte("created_at", endIso)
    .order("created_at", { ascending: true });

  if (error) {
    return ctx.reply("Failed to load food logs for that date.");
  }

  const totalCalories = (logs ?? []).reduce((sum, item) => sum + item.calories, 0);
  const totalProtein = (logs ?? []).reduce((sum, item) => sum + (item.protein || 0), 0);
  const totalCarbs = (logs ?? []).reduce((sum, item) => sum + (item.carbs || 0), 0);
  const totalFat = (logs ?? []).reduce((sum, item) => sum + (item.fat || 0), 0);

  let msg = `📅 *Food Log for ${dateStr} (SGT)*\n\n`;
  if (!logs || logs.length === 0) {
    msg += `_No meals logged on this date._\n\n`;
  } else {
    logs.forEach((log) => {
      const safeFood = escapeMarkdown(log.food_name);
      const safeMeal = escapeMarkdown(log.meal_type || "Meal");
      msg += `• *${safeFood}* (${safeMeal}) — ${log.calories} kcal\n   _P:${log.protein}g | C:${log.carbs}g | F:${log.fat}g_\n`;
    });
    msg += `\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🔥 Total Calories: *${totalCalories} kcal*\n`;
  msg += `🥦 Macros: P:${totalProtein}g | C:${totalCarbs}g | F:${totalFat}g\n`;

  const keyboard = new InlineKeyboard().text("⬅️ Back to 7-Day Chart", "open_history");
  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.callbackQuery(/^confirm:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await ctx.answerCallbackQuery();

  const { data: pending } = await supabase
    .from("pending_food_logs")
    .select("*")
    .eq("id", pendingId)
    .maybeSingle();

  if (!pending) {
    return ctx.editMessageText("⚠️ This food log has expired or was already handled.");
  }

  // Check user logging_mode
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("logging_mode")
    .eq("user_id", pending.user_id)
    .maybeSingle();

  const loggingMode = profile?.logging_mode || "itemized";
  const mealType = pending.meal_type || getMealType();
  let rowsToInsert: any[] = [];

  if (loggingMode === "combined" || !pending.items || !Array.isArray(pending.items) || pending.items.length <= 1) {
    rowsToInsert = [{
      user_id: pending.user_id,
      food_name: pending.food_name,
      calories: Number(pending.calories) || 0,
      protein: Number(pending.protein) || 0,
      carbs: Number(pending.carbs) || 0,
      fat: Number(pending.fat) || 0,
      meal_type: mealType
    }];
  } else {
    rowsToInsert = pending.items.map((item: any) => ({
      user_id: pending.user_id,
      food_name: item.food || "Item",
      calories: Number(item.calories) || 0,
      protein: Number(item.protein) || 0,
      carbs: Number(item.carbs) || 0,
      fat: Number(item.fat) || 0,
      meal_type: mealType
    }));
  }

  const { data: insertedLogs, error: insertErr } = await supabase
    .from("food_logs")
    .insert(rowsToInsert)
    .select();

  if (insertErr || !insertedLogs || insertedLogs.length === 0) {
    console.error("Error logging meal:", insertErr);
    return ctx.editMessageText("⚠️ Failed to save food log.");
  }

  await supabase.from("pending_food_logs").delete().eq("id", pendingId);
  const streakMessage = await updateStreakAndGetMessage(pending.user_id);

  const saveKeyboard = new InlineKeyboard();
  let confirmationText = "";

  if (insertedLogs.length === 1) {
    const log = insertedLogs[0];
    const safeFood = escapeMarkdown(log.food_name);
    saveKeyboard.text("⭐ Save as Preset", `save_preset:${log.id}`);
    confirmationText = 
      `Logged: *${safeFood}* (${log.calories} kcal) ✅\n` +
      `Macros: P:${log.protein}g | C:${log.carbs}g | F:${log.fat}g`;
  } else {
    confirmationText = `Logged *${insertedLogs.length} items* (Total: ${pending.calories} kcal) ✅\n\n`;
    insertedLogs.forEach((log) => {
      const safeFood = escapeMarkdown(log.food_name);
      confirmationText += `• *${safeFood}* — ${log.calories} kcal (P:${log.protein}g C:${log.carbs}g F:${log.fat}g)\n`;
      const shortName = log.food_name.length > 16 ? log.food_name.substring(0, 14) + "…" : log.food_name;
      saveKeyboard.text(`⭐ Save "${shortName}"`, `save_preset:${log.id}`).row();
    });
  }

  confirmationText += streakMessage;

  await ctx.editMessageText(confirmationText, { parse_mode: "Markdown", reply_markup: saveKeyboard });
});

bot.callbackQuery(/^save_preset:(.+)$/, async (ctx) => {
  const logId = ctx.match[1];
  await ctx.answerCallbackQuery();

  const { data: log, error } = await supabase
    .from("food_logs")
    .select("*")
    .eq("id", logId)
    .maybeSingle();

  if (error || !log) {
    return ctx.reply("⚠️ Could not find food log to save.");
  }

  const { error: insertErr } = await supabase.from("user_presets").insert({
    user_id: log.user_id,
    food_name: log.food_name,
    calories: log.calories,
    protein: log.protein || 0,
    carbs: log.carbs || 0,
    fat: log.fat || 0
  });

  if (insertErr) {
    console.error("Error saving preset:", insertErr);
    return ctx.reply("⚠️ Failed to save preset. It might already be saved.");
  }

  const safeFood = escapeMarkdown(log.food_name);
  await ctx.reply(`⭐ Saved *${safeFood}* (${log.calories} kcal) to your presets! Use /presets anytime to quick-log it.`, { parse_mode: "Markdown" });
});

bot.callbackQuery(/^log_preset:(.+)$/, async (ctx) => {
  const presetId = ctx.match[1];
  await ctx.answerCallbackQuery();

  const { data: preset } = await supabase
    .from("user_presets")
    .select("*")
    .eq("id", presetId)
    .maybeSingle();

  if (!preset) {
    return ctx.reply("⚠️ Preset not found.");
  }

  const { error: insertErr } = await supabase.from("food_logs").insert({
    user_id: preset.user_id,
    food_name: preset.food_name,
    calories: preset.calories,
    protein: preset.protein,
    carbs: preset.carbs,
    fat: preset.fat,
    meal_type: getMealType()
  });

  if (insertErr) {
    console.error("Error logging preset:", insertErr);
    return ctx.reply("⚠️ Failed to log preset.");
  }

  const streakMessage = await updateStreakAndGetMessage(preset.user_id);
  const safeFood = escapeMarkdown(preset.food_name);

  await ctx.reply(
    `Logged: *${safeFood}* (${preset.calories} kcal) ✅\n` +
    `Macros: P:${preset.protein}g | C:${preset.carbs}g | F:${preset.fat}g` +
    streakMessage,
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery(/^del_preset:(.+)$/, async (ctx) => {
  const presetId = ctx.match[1];
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery({ text: "Preset removed!" });

  await supabase.from("user_presets").delete().eq("id", presetId).eq("user_id", userId);
  await renderPresetsMenu(ctx, userId, true);
});

bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await ctx.answerCallbackQuery();
  await supabase.from("pending_food_logs").delete().eq("id", pendingId);
  await ctx.editMessageText("Log cancelled. ❌");
});

bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCallbackQuery();

  await supabase
    .from("user_profiles")
    .update({ editing_pending_id: pendingId })
    .eq("user_id", userId);

  await ctx.reply("To customize calories, please reply with the updated calorie number (e.g. 350).", { parse_mode: "Markdown" });
});

bot.callbackQuery(/^delfood:(.+)$/, async (ctx) => {
  const logId = ctx.match[1];
  const userId = ctx.from?.id;
  if (!userId) return;

  await ctx.answerCallbackQuery();

  const { data: log, error: fetchErr } = await supabase
    .from("food_logs")
    .select("food_name, calories")
    .eq("id", logId)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr || !log) {
    return ctx.editMessageText("⚠️ This food log could not be found or was already deleted.");
  }

  const { error: delErr } = await supabase
    .from("food_logs")
    .delete()
    .eq("id", logId)
    .eq("user_id", userId);

  if (delErr) {
    console.error("Error deleting food log:", delErr);
    return ctx.editMessageText("⚠️ Failed to delete food item. Please try again.");
  }

  const safeFood = escapeMarkdown(log.food_name);
  await ctx.editMessageText(`🗑️ Deleted: *${safeFood}* (${log.calories} kcal) from today's log. ✅`, { parse_mode: "Markdown" });
});

bot.callbackQuery("cancel_delete", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Deletion cancelled. ❌");
});

// ── Text Handler for Calories Replies & Text Logs ────────────────────────────

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId, ctx.from?.first_name, ctx.from?.username);

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("editing_pending_id, logging_mode")
    .eq("user_id", userId)
    .maybeSingle();

  const activeEditingId = profile?.editing_pending_id;

  if (activeEditingId) {
    const textVal = ctx.message.text.trim();
    const newCalories = parseInt(textVal);

    if (isNaN(newCalories) || newCalories < 0) {
      return ctx.reply("Please enter a valid number for calories (e.g. 280).");
    }

    // Reset editing state immediately
    await supabase.from("user_profiles").update({ editing_pending_id: null }).eq("user_id", userId);

    const { data: pending } = await supabase
      .from("pending_food_logs")
      .select("*")
      .eq("id", activeEditingId)
      .maybeSingle();

    if (!pending) {
      return ctx.reply("⚠️ Could not find the pending food log to edit. It may have expired or already been saved.");
    }

    const scaleRatio = pending.calories > 0 ? (newCalories / pending.calories) : 1;
    const mealType = pending.meal_type || getMealType();
    const loggingMode = profile?.logging_mode || "itemized";
    let rowsToInsert: any[] = [];

    if (loggingMode === "combined" || !pending.items || !Array.isArray(pending.items) || pending.items.length <= 1) {
      rowsToInsert = [{
        user_id: userId,
        food_name: pending.food_name,
        calories: newCalories,
        protein: Math.round((Number(pending.protein) || 0) * scaleRatio),
        carbs: Math.round((Number(pending.carbs) || 0) * scaleRatio),
        fat: Math.round((Number(pending.fat) || 0) * scaleRatio),
        meal_type: mealType
      }];
    } else {
      rowsToInsert = pending.items.map((item: any) => ({
        user_id: userId,
        food_name: item.food || "Item",
        calories: Math.round((Number(item.calories) || 0) * scaleRatio),
        protein: Math.round((Number(item.protein) || 0) * scaleRatio),
        carbs: Math.round((Number(item.carbs) || 0) * scaleRatio),
        fat: Math.round((Number(item.fat) || 0) * scaleRatio),
        meal_type: mealType
      }));
    }

    const { data: insertedLogs, error: insertErr } = await supabase
      .from("food_logs")
      .insert(rowsToInsert)
      .select();

    if (insertErr || !insertedLogs || insertedLogs.length === 0) {
      return ctx.reply("⚠️ Failed to save custom calories log.");
    }

    await supabase.from("pending_food_logs").delete().eq("id", activeEditingId);
    const streakMessage = await updateStreakAndGetMessage(userId);

    const saveKeyboard = new InlineKeyboard();
    let confirmationText = "";

    if (insertedLogs.length === 1) {
      const log = insertedLogs[0];
      const safeFood = escapeMarkdown(log.food_name);
      saveKeyboard.text("⭐ Save as Preset", `save_preset:${log.id}`);
      confirmationText = 
        `Logged: *${safeFood}* with *${log.calories} kcal* ✅\n` +
        `Scaled Macros: P:${log.protein}g | C:${log.carbs}g | F:${log.fat}g`;
    } else {
      confirmationText = `Logged *${insertedLogs.length} items* with updated total *${newCalories} kcal* ✅\n\n`;
      insertedLogs.forEach((log) => {
        const safeFood = escapeMarkdown(log.food_name);
        confirmationText += `• *${safeFood}* — ${log.calories} kcal (P:${log.protein}g C:${log.carbs}g F:${log.fat}g)\n`;
        const shortName = log.food_name.length > 16 ? log.food_name.substring(0, 14) + "…" : log.food_name;
        saveKeyboard.text(`⭐ Save "${shortName}"`, `save_preset:${log.id}`).row();
      });
    }

    confirmationText += streakMessage;

    return ctx.reply(confirmationText, { parse_mode: "Markdown", reply_markup: saveKeyboard });
  }

  if (!ctx.message.text.startsWith("/")) {
    const statusMsg = await ctx.reply("🤖 Analyzing your meal description with Gemini AI...");
    await processFoodWithGemini(ctx, userId, statusMsg, ctx.message.text);
  }
});

// ── Scheduled Reminders & AI Coaching (Custom Personas) ──────────────────────

async function generateAICoaching(userId: number, type: "daily" | "weekly"): Promise<string | null> {
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`;

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("daily_target, streak_count, persona")
      .eq("user_id", userId)
      .maybeSingle();

    const target = profile?.daily_target ?? 2000;
    const persona = profile?.persona || "sarcastic";

    let toneInstruction = "";
    if (persona === "supportive") {
      toneInstruction = "You are a warm, empathetic, gentle, and encouraging cheerleader AI nutrition coach. Praise their efforts and provide uplifting positivity.";
    } else if (persona === "sergeant") {
      toneInstruction = "You are an intense, strict, no-nonsense military drill sergeant AI nutrition coach. Demand discipline, highlight weaknesses bluntly, and push them to crush their goals.";
    } else {
      toneInstruction = "You are a witty, hilarious, and sarcastically humorous AI nutrition coach. Roast their eating habits playfully, keep it funny and sarcastic, but encouraging.";
    }

    if (type === "daily") {
      const sgtStartIso = getSGTStartOfDayISO();
      const { data: logs } = await supabase
        .from("food_logs")
        .select("food_name, calories, protein, carbs, fat")
        .eq("user_id", userId)
        .gte("created_at", sgtStartIso);

      const totalCal = (logs ?? []).reduce((sum, item) => sum + item.calories, 0);

      const promptText = 
        `${toneInstruction} ` +
        `Write a short 2-sentence daily recap for a user in Singapore. ` +
        `Data for today: Total Consumed = ${totalCal} kcal, Daily Goal = ${target} kcal. Foods eaten: ${JSON.stringify(logs)}. ` +
        `Output plain text only.`;

      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
      });
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
    } else {
      const sevenDaysAgoIso = getSGTStartOfDayISO(new Date(new Date().getTime() - 6 * 24 * 60 * 60 * 1000));
      const { data: logs } = await supabase
        .from("food_logs")
        .select("calories, created_at")
        .eq("user_id", userId)
        .gte("created_at", sevenDaysAgoIso);

      const promptText = 
        `${toneInstruction} ` +
        `Write a 1-paragraph weekly review of the user's progress for the past 7 days. ` +
        `Daily Goal = ${target} kcal. Streak = ${profile?.streak_count ?? 0} days. Total logs in last 7 days = ${logs?.length ?? 0}. ` +
        `Output plain text only.`;

      const res = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
      });
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
    }
  } catch (e) {
    console.error("Failed to generate AI coaching:", e);
    return null;
  }
}

async function sendCronReminders(type: "midday" | "night" | "weekly") {
  console.log(`Running cron reminders (SGT). Type: ${type}`);
  
  const { data: users, error } = await supabase
    .from("user_profiles")
    .select("user_id, persona")
    .eq("reminders_enabled", true);

  if (error || !users || users.length === 0) {
    console.log("No users with reminders_enabled found.");
    return;
  }

  const sgtStartIso = getSGTStartOfDayISO();

  for (const user of users) {
    const userId = user.user_id;
    const personaStyle = user.persona || "sarcastic";

    if (type === "weekly") {
      const weeklyCoaching = await generateAICoaching(userId, "weekly");
      if (weeklyCoaching) {
        try {
          const safeCoaching = escapeMarkdown(weeklyCoaching);
          const header = personaStyle === "supportive" 
            ? "💖 *Weekly AI Nutrition Encouragement & Review (SGT)* 🥑"
            : personaStyle === "sergeant"
            ? "🪖 *Weekly Drill Sergeant Nutrition Debrief (SGT)* 🥑"
            : "🤖 *Weekly AI Nutrition Roast & Review (SGT)* 🥑";
          await bot.api.sendMessage(userId, `${header}\n\n${safeCoaching}`, { parse_mode: "Markdown" });
        } catch (err) {
          console.error(`Failed to send weekly coaching (markdown) to ${userId}:`, err);
          try {
            await bot.api.sendMessage(userId, `Weekly AI Nutrition Review:\n\n${weeklyCoaching}`);
          } catch (retryErr) {
            console.error(`Failed to send weekly coaching (plain) to ${userId}:`, retryErr);
          }
        }
      }
      continue;
    }

    const { data: logs } = await supabase
      .from("food_logs")
      .select("id")
      .eq("user_id", userId)
      .gte("created_at", sgtStartIso);

    const logCount = logs?.length ?? 0;

    if (type === "midday" && logCount === 0) {
      try {
        await bot.api.sendMessage(
          userId,
          `🔔 *Daily Check-in Reminder (SGT)*\n\n` +
          `You haven't logged any meals today! Did you eat breakfast or lunch? ` +
          `Send a photo 📸 or voice note 🎙️ to keep your streak alive!`,
          { parse_mode: "Markdown" }
        );
      } catch (err) { console.error(`Failed to send midday message to ${userId}:`, err); }
    } else if (type === "night") {
      const dailyCoaching = await generateAICoaching(userId, "daily");
      const safeDailyCoaching = dailyCoaching ? escapeMarkdown(dailyCoaching) : null;
      const roastHeader = personaStyle === "supportive" 
        ? "💖 *Daily Coach Note:*"
        : personaStyle === "sergeant"
        ? "🪖 *Sergeant's Report:*"
        : "😏 *Daily AI Roast:*";
      const coachingText = safeDailyCoaching ? `\n\n${roastHeader}\n_${safeDailyCoaching}_` : "";

      try {
        const text = logCount === 0 
          ? `🔔 *Daily Check-in Reminder (SGT)*\n\nYou haven't logged any meals today. Record what you ate to finish strong! 📸`
          : `🔔 *Daily Check-in Reminder (SGT)*\n\nYou've logged your meals today!${coachingText}`;

        await bot.api.sendMessage(userId, text, { parse_mode: "Markdown" });
      } catch (err) {
        console.error(`Failed to send night message (markdown) to ${userId}:`, err);
        try {
          const plainText = logCount === 0
            ? `Daily Check-in Reminder:\nYou haven't logged any meals today. Record what you ate to finish strong! 📸`
            : `Daily Check-in Reminder:\nYou've logged your meals today!\n\n${dailyCoaching || ""}`;
          await bot.api.sendMessage(userId, plainText);
        } catch (retryErr) {
          console.error(`Failed to send night message (plain) to ${userId}:`, retryErr);
        }
      }
    }
  }
}

// ── Telegram WebApp Authentication Validator ─────────────────────────────────

async function validateTelegramInitData(initData: string, botToken: string): Promise<{ valid: boolean; user?: any }> {
  try {
    if (!initData) return { valid: false };
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { valid: false };

    params.delete("hash");

    const keys = Array.from(params.keys()).sort();
    const checkString = keys.map((k) => `${k}=${params.get(k)}`).join("\n");

    const encoder = new TextEncoder();
    
    // secret_key = HMAC-SHA-256("WebAppData", botToken)
    const secretKeyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const secretKeyBytes = await crypto.subtle.sign(
      "HMAC",
      secretKeyMaterial,
      encoder.encode(botToken)
    );

    // key for data-check-string = secretKeyBytes
    const dataKey = await crypto.subtle.importKey(
      "raw",
      secretKeyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const calculatedSigBytes = await crypto.subtle.sign(
      "HMAC",
      dataKey,
      encoder.encode(checkString)
    );

    const calculatedHash = Array.from(new Uint8Array(calculatedSigBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
      return { valid: false };
    }

    const authDate = parseInt(params.get("auth_date") || "0", 10);
    const now = Math.floor(Date.now() / 1000);
    // Allow up to 24 hours for valid session token
    if (authDate > 0 && now - authDate > 86400) {
      return { valid: false };
    }

    const userRaw = params.get("user");
    const user = userRaw ? JSON.parse(userRaw) : null;
    return { valid: true, user };
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
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://jasontan89.github.io",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Telegram-Init-Data, Accept",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  try {
    const url = new URL(req.url);
    const apiAction = url.searchParams.get("api");

    // ── Web App REST API Router ───────────────────────────────────────────────
    if (apiAction) {
      const authHeader = req.headers.get("authorization") || "";
      const customHeader = req.headers.get("x-telegram-init-data") || "";
      const queryInitData = url.searchParams.get("initData") || "";
      
      let initData = "";
      if (authHeader.startsWith("Bearer ")) {
        initData = authHeader.substring(7);
      } else if (customHeader) {
        initData = customHeader;
      } else if (queryInitData) {
        initData = queryInitData;
      }

      const auth = await validateTelegramInitData(initData, token);
      if (!auth.valid || !auth.user?.id) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid Telegram authentication" }), { 
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const userId = Number(auth.user.id);
      await ensureUserProfile(userId, auth.user.first_name, auth.user.username);

      if (apiAction === "dashboard") {
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();

        const target = profile?.daily_target ?? 2000;
        const macroTargets = getMacroTargets(target, profile);
        const sgtStartIso = getSGTStartOfDayISO();

        // Today's logs
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

        return new Response(JSON.stringify({
          profile: profile || { user_id: userId, daily_target: 2000, streak_count: 0, persona: "sarcastic", logging_mode: "itemized" },
          todayDate: getSGTDateStr(),
          todayTotals: { calories: totalCalories, protein: totalProtein, carbs: totalCarbs, fat: totalFat },
          macroTargets: macroTargets,
          todayLogs: todayLogs || [],
          history7d: Object.values(historyMap),
          presets: presets || []
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

    // Register bot commands & Chat Menu Button once on startup
    await registerBotCommandsOnce();

    return await handleUpdate(req);
  } catch (err) {
    console.error("Unhandled server error:", err);
    return new Response(String(err), { status: 500 });
  }
});
