import { Bot, webhookCallback, InlineKeyboard } from "npm:grammy@^1";
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
    .select("user_id, first_name, username, persona")
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
    .text("🤖 AI Coach Style", "open_persona");

  await ctx.reply(
    `Welcome to Calorie Tracker Bot v3.3, ${name}! 🍎\n\n` +
    `I can track calories, macronutrients, weight, voice notes & multi-item meals!\n\n` +
    `👉 *How to use:*\n` +
    `• 📸 *Send a photo* of your food to auto-estimate calories & macros!\n` +
    `• 🎙️ *Send a voice note* (e.g. "I had two eggs and toast") to auto-log!\n` +
    `• ✍️ *Just type what you ate* in chat.\n` +
    `• 📅 Use /today to view calories & macro progress bars.\n` +
    `• ⭐ Use /presets to view, log & manage saved items.\n` +
    `• 📊 Use /history for your 7-day chart & day inspection.\n` +
    `• 🤖 Use /persona to switch between Sarcastic, Supportive, or Drill Sergeant coach!\n` +
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

  message += `🥦 *Macronutrients Breakdown:*\n`;
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

  const items: any[] = pending.items && Array.isArray(pending.items) && pending.items.length > 0
    ? pending.items
    : [{ food: pending.food_name, calories: pending.calories, protein: pending.protein, carbs: pending.carbs, fat: pending.fat }];

  const mealType = pending.meal_type || getMealType();
  const rowsToInsert = items.map((item) => ({
    user_id: pending.user_id,
    food_name: item.food || "Item",
    calories: Number(item.calories) || 0,
    protein: Number(item.protein) || 0,
    carbs: Number(item.carbs) || 0,
    fat: Number(item.fat) || 0,
    meal_type: mealType
  }));

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
    .select("editing_pending_id")
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
    
    const items: any[] = pending.items && Array.isArray(pending.items) && pending.items.length > 0
      ? pending.items
      : [{ food: pending.food_name, calories: pending.calories, protein: pending.protein, carbs: pending.carbs, fat: pending.fat }];

    const rowsToInsert = items.map((item) => ({
      user_id: userId,
      food_name: item.food || "Item",
      calories: Math.round((Number(item.calories) || 0) * scaleRatio),
      protein: Math.round((Number(item.protein) || 0) * scaleRatio),
      carbs: Math.round((Number(item.carbs) || 0) * scaleRatio),
      fat: Math.round((Number(item.fat) || 0) * scaleRatio),
      meal_type: mealType
    }));

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

  if (error || !users || users.length === 0) return;

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
        } catch (err) { console.error(`Failed to send weekly coaching to ${userId}:`, err); }
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
      } catch (err) { console.error(`Failed to send night message to ${userId}:`, err); }
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
    // Allow up to 48 hours for valid session token
    if (authDate > 0 && now - authDate > 86400 * 2) {
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


// ── Standalone Telegram Web App HTML ──────────────────────────────────────────
const WEBAPP_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">\n  <title>Calorie Tracker Dashboard</title>\n  <style>\n/* ── Telegram Web App Theme Variables & CSS Reset ────────────────────────── */\n:root {\n  --bg-color: var(--tg-theme-bg-color, #0f172a);\n  --secondary-bg-color: var(--tg-theme-secondary-bg-color, #1e293b);\n  --text-color: var(--tg-theme-text-color, #f8fafc);\n  --hint-color: var(--tg-theme-hint-color, #94a3b8);\n  --link-color: var(--tg-theme-link-color, #38bdf8);\n  --button-color: var(--tg-theme-button-color, #10b981);\n  --button-text-color: var(--tg-theme-button-text-color, #ffffff);\n  \n  --primary-accent: #10b981;\n  --protein-color: #3b82f6;\n  --carbs-color: #f59e0b;\n  --fat-color: #ec4899;\n  --danger-color: #ef4444;\n  --card-border: rgba(255, 255, 255, 0.08);\n  --card-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);\n  --radius-lg: 16px;\n  --radius-md: 12px;\n  --radius-sm: 8px;\n}\n\n* {\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n  -webkit-tap-highlight-color: transparent;\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\n}\n\nbody {\n  background-color: var(--bg-color);\n  color: var(--text-color);\n  min-height: 100vh;\n  padding: 12px 14px 60px 14px;\n  overflow-x: hidden;\n  user-select: none;\n}\n\n/* ── Container ─────────────────────────────────────────────────────────────── */\n.app-container {\n  max-width: 520px;\n  margin: 0 auto;\n  display: flex;\n  flex-direction: column;\n  gap: 14px;\n}\n\n/* ── App Header ────────────────────────────────────────────────────────────── */\n.app-header {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  padding: 6px 4px 10px 4px;\n}\n\n.user-info {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n}\n\n.avatar {\n  width: 42px;\n  height: 42px;\n  border-radius: 50%;\n  background: linear-gradient(135deg, #10b981, #065f46);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 20px;\n  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);\n}\n\n.user-details h2 {\n  font-size: 17px;\n  font-weight: 700;\n  line-height: 1.2;\n}\n\n.date-badge {\n  font-size: 11px;\n  color: var(--hint-color);\n}\n\n.header-badges {\n  display: flex;\n  gap: 6px;\n}\n\n.badge {\n  font-size: 12px;\n  font-weight: 600;\n  padding: 4px 9px;\n  border-radius: 20px;\n  background: var(--secondary-bg-color);\n  border: 1px solid var(--card-border);\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.streak-badge {\n  background: rgba(245, 158, 11, 0.15);\n  color: #f59e0b;\n  border-color: rgba(245, 158, 11, 0.3);\n}\n\n.target-badge {\n  background: rgba(16, 185, 129, 0.15);\n  color: #10b981;\n  border-color: rgba(16, 185, 129, 0.3);\n}\n\n/* ── Navigation Tabs ───────────────────────────────────────────────────────── */\n.nav-tabs {\n  display: flex;\n  background: var(--secondary-bg-color);\n  padding: 4px;\n  border-radius: var(--radius-md);\n  border: 1px solid var(--card-border);\n  gap: 4px;\n}\n\n.nav-tab {\n  flex: 1;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  background: transparent;\n  border: none;\n  color: var(--hint-color);\n  padding: 8px 12px;\n  border-radius: var(--radius-sm);\n  font-size: 13px;\n  font-weight: 600;\n  cursor: pointer;\n  transition: all 0.2s ease;\n}\n\n.nav-tab.active {\n  background: var(--bg-color);\n  color: var(--text-color);\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);\n}\n\n.tab-icon {\n  font-size: 14px;\n}\n\n/* ── Tab Content ───────────────────────────────────────────────────────────── */\n.tab-content {\n  display: none;\n  flex-direction: column;\n  gap: 14px;\n}\n\n.tab-content.active {\n  display: flex;\n}\n\n/* ── Cards ─────────────────────────────────────────────────────────────────── */\n.card {\n  background: var(--secondary-bg-color);\n  border-radius: var(--radius-lg);\n  border: 1px solid var(--card-border);\n  padding: 16px;\n  box-shadow: var(--card-shadow);\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n.card-header {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n}\n\n.card-header h3 {\n  font-size: 15px;\n  font-weight: 700;\n}\n\n.card-subtitle {\n  font-size: 12px;\n  color: var(--hint-color);\n  margin-top: -6px;\n}\n\n/* ── Calorie Summary Card ──────────────────────────────────────────────────── */\n.calorie-progress-container {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 4px 0;\n}\n\n.calorie-numbers {\n  display: flex;\n  align-items: baseline;\n  gap: 6px;\n}\n\n.current-calories {\n  font-size: 32px;\n  font-weight: 800;\n  color: var(--text-color);\n}\n\n.target-calories {\n  font-size: 16px;\n  color: var(--hint-color);\n}\n\n.progress-bar-bg {\n  width: 100%;\n  height: 12px;\n  background: rgba(255, 255, 255, 0.08);\n  border-radius: 6px;\n  overflow: hidden;\n}\n\n.progress-bar-fill {\n  height: 100%;\n  background: linear-gradient(90deg, #10b981, #059669);\n  border-radius: 6px;\n  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);\n}\n\n.progress-bar-fill.over-target {\n  background: linear-gradient(90deg, #ef4444, #b91c1c);\n}\n\n.calorie-subtext {\n  font-size: 12px;\n  font-weight: 500;\n  color: var(--hint-color);\n}\n\n/* ── Macros Grid ───────────────────────────────────────────────────────────── */\n.macros-grid {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 8px;\n  margin-top: 4px;\n}\n\n.macro-card {\n  background: var(--bg-color);\n  padding: 10px 8px;\n  border-radius: var(--radius-md);\n  border: 1px solid var(--card-border);\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.macro-header {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.macro-icon {\n  font-size: 13px;\n}\n\n.macro-title {\n  font-size: 11px;\n  font-weight: 600;\n  color: var(--hint-color);\n}\n\n.macro-value {\n  font-size: 12px;\n  font-weight: 700;\n}\n\n.macro-bar-bg {\n  width: 100%;\n  height: 6px;\n  background: rgba(255, 255, 255, 0.08);\n  border-radius: 3px;\n  overflow: hidden;\n  margin-top: 2px;\n}\n\n.macro-bar-fill {\n  height: 100%;\n  border-radius: 3px;\n  transition: width 0.5s ease;\n}\n\n.protein-fill { background: var(--protein-color); }\n.carbs-fill { background: var(--carbs-color); }\n.fat-fill { background: var(--fat-color); }\n\n/* ── Chart Section ─────────────────────────────────────────────────────────── */\n.chart-toggles {\n  display: flex;\n  background: var(--bg-color);\n  border-radius: var(--radius-sm);\n  padding: 2px;\n}\n\n.toggle-btn {\n  background: transparent;\n  border: none;\n  color: var(--hint-color);\n  font-size: 11px;\n  font-weight: 600;\n  padding: 4px 8px;\n  border-radius: 6px;\n  cursor: pointer;\n}\n\n.toggle-btn.active {\n  background: var(--secondary-bg-color);\n  color: var(--text-color);\n}\n\n.chart-container {\n  position: relative;\n  height: 190px;\n  width: 100%;\n}\n\n.date-pills-row {\n  display: flex;\n  gap: 6px;\n  overflow-x: auto;\n  padding: 4px 2px 2px 2px;\n  scrollbar-width: none;\n}\n\n.date-pills-row::-webkit-scrollbar {\n  display: none;\n}\n\n.date-pill {\n  flex: 0 0 auto;\n  background: var(--bg-color);\n  border: 1px solid var(--card-border);\n  padding: 5px 9px;\n  border-radius: 20px;\n  font-size: 11px;\n  font-weight: 600;\n  color: var(--hint-color);\n  cursor: pointer;\n  transition: all 0.2s ease;\n}\n\n.date-pill.active {\n  background: var(--primary-accent);\n  color: #ffffff;\n  border-color: var(--primary-accent);\n}\n\n/* ── Meal Logs List ────────────────────────────────────────────────────────── */\n.meals-list {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.meal-item-card {\n  background: var(--bg-color);\n  border: 1px solid var(--card-border);\n  border-radius: var(--radius-md);\n  padding: 10px 12px;\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  animation: fadeIn 0.25s ease;\n}\n\n.meal-main-info {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.meal-title-row {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.meal-name {\n  font-size: 13px;\n  font-weight: 700;\n  color: var(--text-color);\n}\n\n.meal-badge {\n  font-size: 10px;\n  padding: 2px 6px;\n  border-radius: 10px;\n  background: rgba(255, 255, 255, 0.08);\n  color: var(--hint-color);\n}\n\n.meal-macros-row {\n  font-size: 11px;\n  color: var(--hint-color);\n}\n\n.meal-actions {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.meal-calories {\n  font-size: 13px;\n  font-weight: 700;\n  color: var(--primary-accent);\n}\n\n.btn-icon-delete {\n  background: rgba(239, 68, 68, 0.12);\n  color: #ef4444;\n  border: none;\n  width: 32px;\n  height: 32px;\n  border-radius: 8px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  cursor: pointer;\n  font-size: 14px;\n  transition: background 0.2s ease;\n}\n\n.btn-icon-delete:active {\n  background: rgba(239, 68, 68, 0.3);\n}\n\n/* ── Presets List ──────────────────────────────────────────────────────────── */\n.presets-list {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.preset-card {\n  background: var(--bg-color);\n  border: 1px solid var(--card-border);\n  border-radius: var(--radius-md);\n  padding: 12px;\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n}\n\n.preset-info h4 {\n  font-size: 14px;\n  font-weight: 700;\n  margin-bottom: 2px;\n}\n\n.preset-info p {\n  font-size: 11px;\n  color: var(--hint-color);\n}\n\n.preset-actions {\n  display: flex;\n  gap: 6px;\n}\n\n.btn-log-preset {\n  background: var(--primary-accent);\n  color: #ffffff;\n  border: none;\n  padding: 6px 12px;\n  border-radius: var(--radius-sm);\n  font-size: 12px;\n  font-weight: 600;\n  cursor: pointer;\n}\n\n.btn-delete-preset {\n  background: rgba(239, 68, 68, 0.12);\n  color: #ef4444;\n  border: none;\n  padding: 6px 10px;\n  border-radius: var(--radius-sm);\n  font-size: 12px;\n  cursor: pointer;\n}\n\n/* ── Settings & AI Coach ──────────────────────────────────────────────────── */\n.persona-options {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.persona-card {\n  background: var(--bg-color);\n  border: 1.5px solid var(--card-border);\n  border-radius: var(--radius-md);\n  padding: 12px 14px;\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  cursor: pointer;\n  transition: all 0.2s ease;\n}\n\n.persona-card.selected {\n  border-color: var(--primary-accent);\n  background: rgba(16, 185, 129, 0.08);\n}\n\n.persona-radio {\n  width: 18px;\n  height: 18px;\n  border-radius: 50%;\n  border: 2px solid var(--hint-color);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-shrink: 0;\n}\n\n.persona-card.selected .persona-radio {\n  border-color: var(--primary-accent);\n  background: var(--primary-accent);\n}\n\n.persona-card.selected .persona-radio::after {\n  content: \"\";\n  width: 6px;\n  height: 6px;\n  background: #ffffff;\n  border-radius: 50%;\n}\n\n.persona-body h4 {\n  font-size: 14px;\n  font-weight: 700;\n  margin-bottom: 2px;\n}\n\n.persona-body p {\n  font-size: 11px;\n  color: var(--hint-color);\n  line-height: 1.3;\n}\n\n.target-form {\n  display: flex;\n  gap: 8px;\n}\n\n.target-form input {\n  flex: 1;\n  background: var(--bg-color);\n  border: 1px solid var(--card-border);\n  border-radius: var(--radius-sm);\n  padding: 10px 12px;\n  color: var(--text-color);\n  font-size: 14px;\n  font-weight: 600;\n  outline: none;\n}\n\n.target-form input:focus {\n  border-color: var(--primary-accent);\n}\n\n.btn-primary {\n  background: var(--button-color);\n  color: var(--button-text-color);\n  border: none;\n  padding: 10px 16px;\n  border-radius: var(--radius-sm);\n  font-weight: 700;\n  font-size: 13px;\n  cursor: pointer;\n}\n\n/* ── UI States, Toast & Spinners ───────────────────────────────────────────── */\n.empty-state {\n  text-align: center;\n  padding: 24px 12px;\n  color: var(--hint-color);\n  font-size: 12px;\n}\n\n.loading-overlay {\n  position: fixed;\n  top: 0; left: 0; right: 0; bottom: 0;\n  background: rgba(15, 23, 42, 0.85);\n  display: flex;\n  flex-direction: column;\n  justify-content: center;\n  align-items: center;\n  gap: 12px;\n  z-index: 100;\n  backdrop-filter: blur(4px);\n  transition: opacity 0.3s ease;\n}\n\n.loading-overlay.hidden {\n  opacity: 0;\n  pointer-events: none;\n}\n\n.spinner {\n  width: 36px;\n  height: 36px;\n  border: 3px solid rgba(255, 255, 255, 0.15);\n  border-top-color: var(--primary-accent);\n  border-radius: 50%;\n  animation: spin 0.8s linear infinite;\n}\n\n.toast {\n  position: fixed;\n  bottom: 20px;\n  left: 50%;\n  transform: translateX(-50%) translateY(100px);\n  background: rgba(16, 185, 129, 0.95);\n  color: #ffffff;\n  padding: 8px 18px;\n  border-radius: 20px;\n  font-size: 12px;\n  font-weight: 600;\n  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);\n  transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);\n  z-index: 1000;\n  pointer-events: none;\n}\n\n.toast.show {\n  transform: translateX(-50%) translateY(0);\n}\n\n.toast.toast-error {\n  background: rgba(239, 68, 68, 0.95);\n}\n\n.error-banner {\n  background: rgba(239, 68, 68, 0.15);\n  border: 1px solid rgba(239, 68, 68, 0.3);\n  color: #ef4444;\n  padding: 10px 14px;\n  border-radius: var(--radius-sm);\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  font-size: 12px;\n}\n\n.btn-sm {\n  background: #ef4444;\n  color: #fff;\n  border: none;\n  padding: 4px 8px;\n  border-radius: 4px;\n  font-size: 11px;\n  cursor: pointer;\n}\n\n@keyframes spin {\n  to { transform: rotate(360deg); }\n}\n\n@keyframes fadeIn {\n  from { opacity: 0; transform: translateY(4px); }\n  to { opacity: 1; transform: translateY(0); }\n}\n\n</style>\n  <!-- Telegram Web App SDK -->\n  <script src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n  <!-- Chart.js CDN -->\n  <script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js\"></script>\n</head>\n<body>\n  <div id=\"app\" class=\"app-container\">\n    <!-- Header Section -->\n    <header class=\"app-header\">\n      <div class=\"user-info\">\n        <div class=\"avatar\" id=\"user-avatar\">👤</div>\n        <div class=\"user-details\">\n          <h2 id=\"user-name\">Calorie Tracker</h2>\n          <span class=\"date-badge\" id=\"current-date-badge\">SGT Timezone</span>\n        </div>\n      </div>\n      <div class=\"header-badges\">\n        <div class=\"badge streak-badge\" id=\"streak-badge\" title=\"Consistency Streak\">\n          🔥 <span id=\"streak-count\">0</span>\n        </div>\n        <div class=\"badge target-badge\" id=\"target-badge\" title=\"Daily Calorie Goal\">\n          🎯 <span id=\"header-target\">2000</span> kcal\n        </div>\n      </div>\n    </header>\n\n    <!-- Navigation Tabs -->\n    <nav class=\"nav-tabs\">\n      <button class=\"nav-tab active\" data-tab=\"tab-dashboard\" id=\"btn-tab-dashboard\">\n        <span class=\"tab-icon\">📊</span>\n        <span class=\"tab-label\">Dashboard</span>\n      </button>\n      <button class=\"nav-tab\" data-tab=\"tab-presets\" id=\"btn-tab-presets\">\n        <span class=\"tab-icon\">⭐</span>\n        <span class=\"tab-label\">Presets</span>\n      </button>\n      <button class=\"nav-tab\" data-tab=\"tab-settings\" id=\"btn-tab-settings\">\n        <span class=\"tab-icon\">🤖</span>\n        <span class=\"tab-label\">AI Coach</span>\n      </button>\n    </nav>\n\n    <!-- Loading State Overlay -->\n    <div id=\"loading-spinner\" class=\"loading-overlay\">\n      <div class=\"spinner\"></div>\n      <p>Loading your nutrition data...</p>\n    </div>\n\n    <!-- Error Banner -->\n    <div id=\"error-banner\" class=\"error-banner\" style=\"display: none;\">\n      <span id=\"error-text\">⚠️ Connection error</span>\n      <button id=\"retry-btn\" class=\"btn-sm\">Retry</button>\n    </div>\n\n    <!-- TAB 1: DASHBOARD -->\n    <section id=\"tab-dashboard\" class=\"tab-content active\">\n      <!-- Today's Calorie & Macro Card -->\n      <div class=\"card summary-card\">\n        <div class=\"card-header\">\n          <h3>🔥 Today's Calories</h3>\n          <span class=\"badge\" id=\"calorie-budget-badge\">Budget Left</span>\n        </div>\n        \n        <div class=\"calorie-progress-container\">\n          <div class=\"calorie-numbers\">\n            <span class=\"current-calories\" id=\"today-calories\">0</span>\n            <span class=\"target-calories\">/ <span id=\"today-target\">2000</span> kcal</span>\n          </div>\n          <div class=\"progress-bar-bg\">\n            <div class=\"progress-bar-fill\" id=\"calorie-bar-fill\" style=\"width: 0%;\"></div>\n          </div>\n          <div class=\"calorie-subtext\" id=\"calorie-remaining-text\">2000 kcal remaining</div>\n        </div>\n\n        <div class=\"macros-grid\">\n          <div class=\"macro-card protein-card\">\n            <div class=\"macro-header\">\n              <span class=\"macro-icon\">🥩</span>\n              <span class=\"macro-title\">Protein</span>\n            </div>\n            <div class=\"macro-value\"><span id=\"macro-p-val\">0</span> / <span id=\"macro-p-target\">150</span>g</div>\n            <div class=\"macro-bar-bg\"><div class=\"macro-bar-fill protein-fill\" id=\"macro-p-fill\" style=\"width: 0%;\"></div></div>\n          </div>\n\n          <div class=\"macro-card carbs-card\">\n            <div class=\"macro-header\">\n              <span class=\"macro-icon\">🍚</span>\n              <span class=\"macro-title\">Carbs</span>\n            </div>\n            <div class=\"macro-value\"><span id=\"macro-c-val\">0</span> / <span id=\"macro-c-target\">200</span>g</div>\n            <div class=\"macro-bar-bg\"><div class=\"macro-bar-fill carbs-fill\" id=\"macro-c-fill\" style=\"width: 0%;\"></div></div>\n          </div>\n\n          <div class=\"macro-card fat-card\">\n            <div class=\"macro-header\">\n              <span class=\"macro-icon\">🥑</span>\n              <span class=\"macro-title\">Fats</span>\n            </div>\n            <div class=\"macro-value\"><span id=\"macro-f-val\">0</span> / <span id=\"macro-f-target\">67</span>g</div>\n            <div class=\"macro-bar-bg\"><div class=\"macro-bar-fill fat-fill\" id=\"macro-f-fill\" style=\"width: 0%;\"></div></div>\n          </div>\n        </div>\n      </div>\n\n      <!-- Interactive 7-Day Chart Card -->\n      <div class=\"card chart-card\">\n        <div class=\"card-header\">\n          <h3>📈 7-Day Trends (SGT)</h3>\n          <div class=\"chart-toggles\">\n            <button class=\"toggle-btn active\" id=\"btn-chart-cal\">Calories</button>\n            <button class=\"toggle-btn\" id=\"btn-chart-macros\">Macros</button>\n          </div>\n        </div>\n        <p class=\"card-subtitle\">Tap any day on the chart or buttons below to inspect meals.</p>\n        <div class=\"chart-container\">\n          <canvas id=\"historyChart\"></canvas>\n        </div>\n        <!-- 7-Day Date Filter Pills -->\n        <div class=\"date-pills-row\" id=\"date-pills-container\">\n          <!-- Populated dynamically via JS -->\n        </div>\n      </div>\n\n      <!-- Itemized Meal Log List Card -->\n      <div class=\"card meals-card\">\n        <div class=\"card-header\">\n          <h3 id=\"meals-card-title\">🍽️ Today's Logged Meals</h3>\n          <span class=\"badge\" id=\"meals-count-badge\">0 meals</span>\n        </div>\n        <div id=\"meals-list\" class=\"meals-list\">\n          <!-- Meal items dynamically injected here -->\n        </div>\n      </div>\n    </section>\n\n    <!-- TAB 2: PRESETS & SUPPLEMENTS -->\n    <section id=\"tab-presets\" class=\"tab-content\">\n      <div class=\"card\">\n        <div class=\"card-header\">\n          <h3>⭐ Saved Presets & Supplements</h3>\n        </div>\n        <p class=\"card-subtitle\">Tap <strong>➕ Log</strong> to instantly record to today's log, or <strong>🗑️</strong> to delete.</p>\n        <div id=\"presets-list\" class=\"presets-list\">\n          <!-- Presets dynamically injected here -->\n        </div>\n      </div>\n    </section>\n\n    <!-- TAB 3: SETTINGS & AI COACH -->\n    <section id=\"tab-settings\" class=\"tab-content\">\n      <div class=\"card\">\n        <div class=\"card-header\">\n          <h3>🤖 AI Nutrition Coach Style</h3>\n        </div>\n        <p class=\"card-subtitle\">Choose how your AI coach interacts during daily check-ins and weekly Sunday debriefs.</p>\n        \n        <div class=\"persona-options\">\n          <div class=\"persona-card\" data-persona=\"sarcastic\" id=\"persona-sarcastic\">\n            <div class=\"persona-radio\"></div>\n            <div class=\"persona-body\">\n              <h4>🔥 Sarcastic & Witty</h4>\n              <p>Cheeky roasts, humorous banter, and funny reality checks on your snacks.</p>\n            </div>\n          </div>\n\n          <div class=\"persona-card\" data-persona=\"supportive\" id=\"persona-supportive\">\n            <div class=\"persona-radio\"></div>\n            <div class=\"persona-body\">\n              <h4>💖 Supportive Cheerleader</h4>\n              <p>Empathetic motivation, gentle praise, positive reinforcement, and warm encouragement.</p>\n            </div>\n          </div>\n\n          <div class=\"persona-card\" data-persona=\"sergeant\" id=\"persona-sergeant\">\n            <div class=\"persona-radio\"></div>\n            <div class=\"persona-body\">\n              <h4>🪖 Drill Sergeant</h4>\n              <p>Strict discipline, zero excuses, blunt accountability, and militant consistency.</p>\n            </div>\n          </div>\n        </div>\n      </div>\n\n      <div class=\"card\">\n        <div class=\"card-header\">\n          <h3>🎯 Daily Calorie Target</h3>\n        </div>\n        <p class=\"card-subtitle\">Adjust your daily calorie goal.</p>\n        <div class=\"target-form\">\n          <input type=\"number\" id=\"input-daily-target\" min=\"500\" max=\"10000\" step=\"50\" placeholder=\"2000\">\n          <button id=\"btn-save-target\" class=\"btn-primary\">Save Target</button>\n        </div>\n      </div>\n    </section>\n\n    <!-- Toast Notification Popup -->\n    <div id=\"toast\" class=\"toast\">Action completed</div>\n  </div>\n\n  <script>\n/**\n * Calorie Tracker Bot - Telegram Mini App (Web App)\n * Interacts with Supabase Edge Function API using authenticated Telegram WebApp initData.\n */\n\nconst API_BASE_URL = \"https://blcsjvifiytbznwesmyx.supabase.co/functions/v1/telegram-bot\";\n\n// Global App State\nlet appState = {\n  user: null,\n  profile: null,\n  todayDate: \"\",\n  selectedDate: \"\",\n  todayTotals: { calories: 0, protein: 0, carbs: 0, fat: 0 },\n  macroTargets: { protein: 150, carbs: 200, fat: 67 },\n  todayLogs: [],\n  history7d: [],\n  presets: [],\n  currentChartView: \"calories\", // \"calories\" or \"macros\"\n  chartInstance: null\n};\n\n// Telegram WebApp Object Reference\nconst tg = window.Telegram?.WebApp;\n\n// Initialize on DOM load\ndocument.addEventListener(\"DOMContentLoaded\", () => {\n  initTelegramWebApp();\n  setupEventListeners();\n  fetchDashboardData();\n});\n\n/**\n * Initialize Telegram WebApp SDK\n */\nfunction initTelegramWebApp() {\n  if (tg) {\n    tg.ready();\n    tg.expand();\n    try {\n      tg.enableClosingConfirmation();\n    } catch (e) {}\n\n    // Apply header & background color based on Telegram theme\n    if (tg.themeParams) {\n      if (tg.themeParams.bg_color) {\n        document.documentElement.style.setProperty(\"--bg-color\", tg.themeParams.bg_color);\n      }\n      if (tg.themeParams.secondary_bg_color) {\n        document.documentElement.style.setProperty(\"--secondary-bg-color\", tg.themeParams.secondary_bg_color);\n      }\n      if (tg.themeParams.text_color) {\n        document.documentElement.style.setProperty(\"--text-color\", tg.themeParams.text_color);\n      }\n      if (tg.themeParams.button_color) {\n        document.documentElement.style.setProperty(\"--button-color\", tg.themeParams.button_color);\n      }\n    }\n\n    // Set User details from Telegram\n    if (tg.initDataUnsafe?.user) {\n      const u = tg.initDataUnsafe.user;\n      document.getElementById(\"user-name\").textContent = u.first_name + (u.last_name ? ` ${u.last_name}` : \"\");\n      if (u.first_name) {\n        document.getElementById(\"user-avatar\").textContent = u.first_name.charAt(0).toUpperCase();\n      }\n    }\n  }\n}\n\n/**\n * Setup Event Listeners for Tabs, Toggles, and Forms\n */\nfunction setupEventListeners() {\n  // Tab Switching\n  document.querySelectorAll(\".nav-tab\").forEach((btn) => {\n    btn.addEventListener(\"click\", (e) => {\n      const tabId = btn.getAttribute(\"data-tab\");\n      switchTab(tabId);\n      triggerHaptic(\"light\");\n    });\n  });\n\n  // Chart View Toggle (Calories vs Macros)\n  document.getElementById(\"btn-chart-cal\").addEventListener(\"click\", () => {\n    appState.currentChartView = \"calories\";\n    document.getElementById(\"btn-chart-cal\").classList.add(\"active\");\n    document.getElementById(\"btn-chart-macros\").classList.remove(\"active\");\n    renderChart();\n    triggerHaptic(\"light\");\n  });\n\n  document.getElementById(\"btn-chart-macros\").addEventListener(\"click\", () => {\n    appState.currentChartView = \"macros\";\n    document.getElementById(\"btn-chart-macros\").classList.add(\"active\");\n    document.getElementById(\"btn-chart-cal\").classList.remove(\"active\");\n    renderChart();\n    triggerHaptic(\"light\");\n  });\n\n  // Persona Selection Cards\n  document.querySelectorAll(\".persona-card\").forEach((card) => {\n    card.addEventListener(\"click\", () => {\n      const persona = card.getAttribute(\"data-persona\");\n      updatePersona(persona);\n      triggerHaptic(\"medium\");\n    });\n  });\n\n  // Target Goal Save Button\n  document.getElementById(\"btn-save-target\").addEventListener(\"click\", () => {\n    const input = document.getElementById(\"input-daily-target\");\n    const val = parseInt(input.value, 10);\n    if (!val || val <= 0) {\n      showToast(\"Please enter a valid positive number\", true);\n      return;\n    }\n    updateCalorieTarget(val);\n    triggerHaptic(\"medium\");\n  });\n\n  // Retry Button\n  document.getElementById(\"retry-btn\").addEventListener(\"click\", () => {\n    document.getElementById(\"error-banner\").style.display = \"none\";\n    fetchDashboardData();\n  });\n}\n\n/**\n * Switch Navigation Tab\n */\nfunction switchTab(tabId) {\n  document.querySelectorAll(\".nav-tab\").forEach((t) => t.classList.remove(\"active\"));\n  document.querySelectorAll(\".tab-content\").forEach((c) => c.classList.remove(\"active\"));\n\n  const targetTabBtn = document.querySelector(`[data-tab=\"${tabId}\"]`);\n  const targetContent = document.getElementById(tabId);\n\n  if (targetTabBtn) targetTabBtn.classList.add(\"active\");\n  if (targetContent) targetContent.classList.add(\"active\");\n}\n\n/**\n * Fetch Main Dashboard Data from Backend API\n */\nasync function fetchDashboardData() {\n  showLoading(true);\n  try {\n    const initData = tg?.initData || \"\";\n    const headers = {\n      \"Content-Type\": \"application/json\"\n    };\n\n    if (initData) {\n      headers[\"Authorization\"] = `Bearer ${initData}`;\n      headers[\"X-Telegram-Init-Data\"] = initData;\n    }\n\n    const response = await fetch(`${API_BASE_URL}?api=dashboard`, {\n      method: \"GET\",\n      headers: headers\n    });\n\n    if (!response.ok) {\n      throw new Error(`API error: ${response.status} ${response.statusText}`);\n    }\n\n    const data = await response.json();\n    appState = {\n      ...appState,\n      ...data,\n      selectedDate: data.todayDate\n    };\n\n    renderAllViews();\n    showLoading(false);\n  } catch (err) {\n    console.error(\"Failed to load dashboard data:\", err);\n    showLoading(false);\n    \n    // If running in development without Telegram initData, populate mock data for preview\n    if (!tg?.initData) {\n      loadMockDataForPreview();\n      showToast(\"Showing demo preview (open inside Telegram for live data)\");\n      return;\n    }\n\n    document.getElementById(\"error-banner\").style.display = \"flex\";\n    document.getElementById(\"error-text\").textContent = \"Failed to connect to backend.\";\n  }\n}\n\n/**\n * Render All UI Components\n */\nfunction renderAllViews() {\n  renderHeader();\n  renderSummaryCard();\n  renderChart();\n  renderDatePills();\n  renderMealsList();\n  renderPresetsList();\n  renderSettingsView();\n}\n\n/**\n * Render Header Badges\n */\nfunction renderHeader() {\n  const profile = appState.profile;\n  if (profile) {\n    document.getElementById(\"streak-count\").textContent = profile.streak_count || 0;\n    document.getElementById(\"header-target\").textContent = profile.daily_target || 2000;\n    if (profile.first_name) {\n      document.getElementById(\"user-name\").textContent = profile.first_name;\n      document.getElementById(\"user-avatar\").textContent = profile.first_name.charAt(0).toUpperCase();\n    }\n  }\n  if (appState.todayDate) {\n    document.getElementById(\"current-date-badge\").textContent = `${appState.todayDate} (SGT)`;\n  }\n}\n\n/**\n * Render Today's Calorie & Macro Progress Card\n */\nfunction renderSummaryCard() {\n  const target = appState.profile?.daily_target || 2000;\n  const current = appState.todayTotals.calories || 0;\n  const remaining = target - current;\n\n  document.getElementById(\"today-calories\").textContent = current.toLocaleString();\n  document.getElementById(\"today-target\").textContent = target.toLocaleString();\n\n  const pct = Math.min(Math.round((current / target) * 100), 100);\n  const fillBar = document.getElementById(\"calorie-bar-fill\");\n  fillBar.style.width = `${pct}%`;\n\n  const budgetBadge = document.getElementById(\"calorie-budget-badge\");\n  const remainingText = document.getElementById(\"calorie-remaining-text\");\n\n  if (remaining >= 0) {\n    budgetBadge.textContent = `${pct}% consumed`;\n    budgetBadge.style.color = \"var(--primary-accent)\";\n    budgetBadge.style.borderColor = \"rgba(16, 185, 129, 0.3)\";\n    remainingText.textContent = `🍏 ${remaining.toLocaleString()} kcal left in daily budget`;\n    fillBar.classList.remove(\"over-target\");\n  } else {\n    const over = Math.abs(remaining);\n    budgetBadge.textContent = `${over} kcal OVER`;\n    budgetBadge.style.color = \"var(--danger-color)\";\n    budgetBadge.style.borderColor = \"rgba(239, 68, 68, 0.3)\";\n    remainingText.textContent = `⚠️ Over budget by ${over.toLocaleString()} kcal`;\n    fillBar.classList.add(\"over-target\");\n  }\n\n  // Macronutrients\n  const pTarget = appState.macroTargets.protein || 150;\n  const cTarget = appState.macroTargets.carbs || 200;\n  const fTarget = appState.macroTargets.fat || 67;\n\n  const pVal = appState.todayTotals.protein || 0;\n  const cVal = appState.todayTotals.carbs || 0;\n  const fVal = appState.todayTotals.fat || 0;\n\n  document.getElementById(\"macro-p-val\").textContent = pVal;\n  document.getElementById(\"macro-p-target\").textContent = pTarget;\n  document.getElementById(\"macro-p-fill\").style.width = `${Math.min(Math.round((pVal / pTarget) * 100), 100)}%`;\n\n  document.getElementById(\"macro-c-val\").textContent = cVal;\n  document.getElementById(\"macro-c-target\").textContent = cTarget;\n  document.getElementById(\"macro-c-fill\").style.width = `${Math.min(Math.round((cVal / cTarget) * 100), 100)}%`;\n\n  document.getElementById(\"macro-f-val\").textContent = fVal;\n  document.getElementById(\"macro-f-target\").textContent = fTarget;\n  document.getElementById(\"macro-f-fill\").style.width = `${Math.min(Math.round((fVal / fTarget) * 100), 100)}%`;\n}\n\n/**\n * Render Interactive 7-Day Chart\n */\nfunction renderChart() {\n  const ctx = document.getElementById(\"historyChart\")?.getContext(\"2d\");\n  if (!ctx) return;\n\n  if (appState.chartInstance) {\n    appState.chartInstance.destroy();\n  }\n\n  const history = appState.history7d || [];\n  const labels = history.map((d) => d.label || d.date.substring(5));\n  const target = appState.profile?.daily_target || 2000;\n\n  let datasets = [];\n\n  if (appState.currentChartView === \"calories\") {\n    const calorieData = history.map((d) => d.calories || 0);\n    const targetData = history.map(() => target);\n\n    datasets = [\n      {\n        label: \"Calories (kcal)\",\n        data: calorieData,\n        backgroundColor: history.map((d) => (d.date === appState.selectedDate ? \"#10b981\" : \"rgba(16, 185, 129, 0.45)\")),\n        borderColor: \"#10b981\",\n        borderWidth: 1.5,\n        borderRadius: 6\n      },\n      {\n        label: \"Goal\",\n        type: \"line\",\n        data: targetData,\n        borderColor: \"#ef4444\",\n        borderDash: [4, 4],\n        borderWidth: 1.5,\n        pointRadius: 0,\n        fill: false\n      }\n    ];\n  } else {\n    // Stacked Macros\n    datasets = [\n      {\n        label: \"Protein (g)\",\n        data: history.map((d) => d.protein || 0),\n        backgroundColor: \"#3b82f6\",\n        borderRadius: 4,\n        stack: \"macros\"\n      },\n      {\n        label: \"Carbs (g)\",\n        data: history.map((d) => d.carbs || 0),\n        backgroundColor: \"#f59e0b\",\n        borderRadius: 4,\n        stack: \"macros\"\n      },\n      {\n        label: \"Fat (g)\",\n        data: history.map((d) => d.fat || 0),\n        backgroundColor: \"#ec4899\",\n        borderRadius: 4,\n        stack: \"macros\"\n      }\n    ];\n  }\n\n  appState.chartInstance = new Chart(ctx, {\n    type: \"bar\",\n    data: { labels, datasets },\n    options: {\n      responsive: true,\n      maintainAspectRatio: false,\n      onClick: (event, elements) => {\n        if (elements && elements.length > 0) {\n          const index = elements[0].index;\n          const selected = history[index];\n          if (selected) {\n            selectDate(selected.date);\n            triggerHaptic(\"light\");\n          }\n        }\n      },\n      plugins: {\n        legend: {\n          display: appState.currentChartView === \"macros\",\n          labels: { color: \"#94a3b8\", font: { size: 10 } }\n        },\n        tooltip: {\n          backgroundColor: \"rgba(15, 23, 42, 0.95)\",\n          titleColor: \"#f8fafc\",\n          bodyColor: \"#f8fafc\",\n          borderColor: \"rgba(255, 255, 255, 0.1)\",\n          borderWidth: 1,\n          padding: 8\n        }\n      },\n      scales: {\n        x: {\n          grid: { display: false },\n          ticks: { color: \"#94a3b8\", font: { size: 10 } }\n        },\n        y: {\n          grid: { color: \"rgba(255, 255, 255, 0.05)\" },\n          ticks: { color: \"#94a3b8\", font: { size: 10 } }\n        }\n      }\n    }\n  });\n}\n\n/**\n * Render 7-Day Date Filter Pills\n */\nfunction renderDatePills() {\n  const container = document.getElementById(\"date-pills-container\");\n  container.innerHTML = \"\";\n\n  const history = appState.history7d || [];\n  history.forEach((d) => {\n    const pill = document.createElement(\"button\");\n    pill.className = `date-pill ${d.date === appState.selectedDate ? \"active\" : \"\"}`;\n    pill.textContent = d.date === appState.todayDate ? \"Today\" : d.label || d.date.substring(5);\n    pill.addEventListener(\"click\", () => {\n      selectDate(d.date);\n      triggerHaptic(\"light\");\n    });\n    container.appendChild(pill);\n  });\n}\n\n/**\n * Select Date & Filter Meals\n */\nfunction selectDate(dateStr) {\n  appState.selectedDate = dateStr;\n  renderDatePills();\n  renderChart();\n  renderMealsList();\n}\n\n/**\n * Render Itemized Meals List\n */\nfunction renderMealsList() {\n  const container = document.getElementById(\"meals-list\");\n  const isToday = appState.selectedDate === appState.todayDate;\n  \n  document.getElementById(\"meals-card-title\").textContent = isToday \n    ? \"🍽️ Today's Logged Meals\" \n    : `🍽️ Meals on ${appState.selectedDate}`;\n\n  let logs = [];\n  if (isToday) {\n    logs = appState.todayLogs || [];\n  } else {\n    const dayData = (appState.history7d || []).find((h) => h.date === appState.selectedDate);\n    logs = dayData?.logs || [];\n  }\n\n  document.getElementById(\"meals-count-badge\").textContent = `${logs.length} meal${logs.length === 1 ? \"\" : \"s\"}`;\n  container.innerHTML = \"\";\n\n  if (logs.length === 0) {\n    container.innerHTML = `<div class=\"empty-state\">No meals logged for this date.</div>`;\n    return;\n  }\n\n  logs.forEach((log) => {\n    const card = document.createElement(\"div\");\n    card.className = \"meal-item-card\";\n    card.id = `meal-log-${log.id}`;\n\n    card.innerHTML = `\n      <div class=\"meal-main-info\">\n        <div class=\"meal-title-row\">\n          <span class=\"meal-name\">${escapeHtml(log.food_name)}</span>\n          <span class=\"meal-badge\">${escapeHtml(log.meal_type || \"Meal\")}</span>\n        </div>\n        <div class=\"meal-macros-row\">\n          P: ${log.protein || 0}g | C: ${log.carbs || 0}g | F: ${log.fat || 0}g\n        </div>\n      </div>\n      <div class=\"meal-actions\">\n        <span class=\"meal-calories\">${log.calories} kcal</span>\n        <button class=\"btn-icon-delete\" title=\"Delete Meal\" data-id=\"${log.id}\">🗑️</button>\n      </div>\n    `;\n\n    card.querySelector(\".btn-icon-delete\").addEventListener(\"click\", () => {\n      confirmAndDeleteMeal(log.id, log.food_name);\n    });\n\n    container.appendChild(card);\n  });\n}\n\n/**\n * Confirm and Delete Meal via API\n */\nasync function confirmAndDeleteMeal(logId, foodName) {\n  const proceed = async () => {\n    triggerHaptic(\"warning\");\n    // Optimistic UI Removal\n    const elem = document.getElementById(`meal-log-${logId}`);\n    if (elem) elem.style.opacity = \"0.3\";\n\n    try {\n      const initData = tg?.initData || \"\";\n      const res = await fetch(`${API_BASE_URL}?api=delete_food`, {\n        method: \"POST\",\n        headers: {\n          \"Content-Type\": \"application/json\",\n          \"Authorization\": `Bearer ${initData}`,\n          \"X-Telegram-Init-Data\": initData\n        },\n        body: JSON.stringify({ log_id: logId })\n      });\n\n      if (!res.ok) throw new Error(\"Delete failed\");\n\n      showToast(`Deleted ${foodName}`);\n      triggerHaptic(\"success\");\n      // Refresh dashboard data\n      fetchDashboardData();\n    } catch (err) {\n      console.error(\"Error deleting meal:\", err);\n      showToast(\"Failed to delete meal\", true);\n      if (elem) elem.style.opacity = \"1\";\n    }\n  };\n\n  if (tg?.showConfirm) {\n    tg.showConfirm(`Delete \"${foodName}\" from your food log?`, (ok) => {\n      if (ok) proceed();\n    });\n  } else if (confirm(`Delete \"${foodName}\" from your food log?`)) {\n    proceed();\n  }\n}\n\n/**\n * Render Presets & Supplements List\n */\nfunction renderPresetsList() {\n  const container = document.getElementById(\"presets-list\");\n  container.innerHTML = \"\";\n\n  const presets = appState.presets || [];\n  if (presets.length === 0) {\n    container.innerHTML = `\n      <div class=\"empty-state\">\n        <p>No presets saved yet!</p>\n        <p style=\"margin-top: 6px; font-size: 11px;\">When you log meals in Telegram, tap <strong>⭐ Save as Preset</strong> on the confirmation message to save items here.</p>\n      </div>\n    `;\n    return;\n  }\n\n  presets.forEach((preset) => {\n    const card = document.createElement(\"div\");\n    card.className = \"preset-card\";\n    card.id = `preset-${preset.id}`;\n\n    card.innerHTML = `\n      <div class=\"preset-info\">\n        <h4>${escapeHtml(preset.food_name)}</h4>\n        <p>${preset.calories} kcal • P:${preset.protein}g C:${preset.carbs}g F:${preset.fat}g</p>\n      </div>\n      <div class=\"preset-actions\">\n        <button class=\"btn-log-preset\" data-id=\"${preset.id}\">➕ Log</button>\n        <button class=\"btn-delete-preset\" data-id=\"${preset.id}\">🗑️</button>\n      </div>\n    `;\n\n    card.querySelector(\".btn-log-preset\").addEventListener(\"click\", () => {\n      logPresetToToday(preset.id, preset.food_name);\n    });\n\n    card.querySelector(\".btn-delete-preset\").addEventListener(\"click\", () => {\n      deletePreset(preset.id, preset.food_name);\n    });\n\n    container.appendChild(card);\n  });\n}\n\n/**\n * Log Preset to Today's Food Log via API\n */\nasync function logPresetToToday(presetId, foodName) {\n  triggerHaptic(\"medium\");\n  try {\n    const initData = tg?.initData || \"\";\n    const res = await fetch(`${API_BASE_URL}?api=log_preset`, {\n      method: \"POST\",\n      headers: {\n        \"Content-Type\": \"application/json\",\n        \"Authorization\": `Bearer ${initData}`,\n        \"X-Telegram-Init-Data\": initData\n      },\n      body: JSON.stringify({ preset_id: presetId })\n    });\n\n    if (!res.ok) throw new Error(\"Log preset failed\");\n\n    showToast(`Logged \"${foodName}\" to today! ✅`);\n    triggerHaptic(\"success\");\n    fetchDashboardData();\n  } catch (err) {\n    console.error(\"Error logging preset:\", err);\n    showToast(\"Failed to log preset\", true);\n  }\n}\n\n/**\n * Delete Preset via API\n */\nasync function deletePreset(presetId, foodName) {\n  const proceed = async () => {\n    triggerHaptic(\"warning\");\n    try {\n      const initData = tg?.initData || \"\";\n      const res = await fetch(`${API_BASE_URL}?api=delete_preset`, {\n        method: \"POST\",\n        headers: {\n          \"Content-Type\": \"application/json\",\n          \"Authorization\": `Bearer ${initData}`,\n          \"X-Telegram-Init-Data\": initData\n        },\n        body: JSON.stringify({ preset_id: presetId })\n      });\n\n      if (!res.ok) throw new Error(\"Delete preset failed\");\n\n      showToast(`Removed \"${foodName}\" preset`);\n      triggerHaptic(\"success\");\n      fetchDashboardData();\n    } catch (err) {\n      console.error(\"Error deleting preset:\", err);\n      showToast(\"Failed to delete preset\", true);\n    }\n  };\n\n  if (tg?.showConfirm) {\n    tg.showConfirm(`Delete preset \"${foodName}\"?`, (ok) => {\n      if (ok) proceed();\n    });\n  } else if (confirm(`Delete preset \"${foodName}\"?`)) {\n    proceed();\n  }\n}\n\n/**\n * Render Settings & AI Coach View\n */\nfunction renderSettingsView() {\n  const persona = appState.profile?.persona || \"sarcastic\";\n  document.querySelectorAll(\".persona-card\").forEach((card) => {\n    const p = card.getAttribute(\"data-persona\");\n    if (p === persona) {\n      card.classList.add(\"selected\");\n    } else {\n      card.classList.remove(\"selected\");\n    }\n  });\n\n  const target = appState.profile?.daily_target || 2000;\n  document.getElementById(\"input-daily-target\").value = target;\n}\n\n/**\n * Update AI Persona via API\n */\nasync function updatePersona(newPersona) {\n  // Optimistic UI\n  document.querySelectorAll(\".persona-card\").forEach((c) => c.classList.remove(\"selected\"));\n  document.getElementById(`persona-${newPersona}`)?.classList.add(\"selected\");\n\n  try {\n    const initData = tg?.initData || \"\";\n    const res = await fetch(`${API_BASE_URL}?api=update_persona`, {\n      method: \"POST\",\n      headers: {\n        \"Content-Type\": \"application/json\",\n        \"Authorization\": `Bearer ${initData}`,\n        \"X-Telegram-Init-Data\": initData\n      },\n      body: JSON.stringify({ persona: newPersona })\n    });\n\n    if (!res.ok) throw new Error(\"Update persona failed\");\n\n    if (appState.profile) appState.profile.persona = newPersona;\n    showToast(`Coach style updated! 🤖`);\n    triggerHaptic(\"success\");\n  } catch (err) {\n    console.error(\"Error updating persona:\", err);\n    showToast(\"Failed to update AI coach\", true);\n  }\n}\n\n/**\n * Update Daily Calorie Target via API\n */\nasync function updateCalorieTarget(newTarget) {\n  try {\n    const initData = tg?.initData || \"\";\n    const res = await fetch(`${API_BASE_URL}?api=update_target`, {\n      method: \"POST\",\n      headers: {\n        \"Content-Type\": \"application/json\",\n        \"Authorization\": `Bearer ${initData}`,\n        \"X-Telegram-Init-Data\": initData\n      },\n      body: JSON.stringify({ target: newTarget })\n    });\n\n    if (!res.ok) throw new Error(\"Update target failed\");\n\n    if (appState.profile) appState.profile.daily_target = newTarget;\n    showToast(`Target set to ${newTarget} kcal! 🎯`);\n    triggerHaptic(\"success\");\n    fetchDashboardData();\n  } catch (err) {\n    console.error(\"Error updating target:\", err);\n    showToast(\"Failed to update target\", true);\n  }\n}\n\n/**\n * Utility: Telegram Haptic Feedback\n */\nfunction triggerHaptic(type) {\n  try {\n    if (tg?.HapticFeedback) {\n      if (type === \"light\" || type === \"medium\" || type === \"heavy\") {\n        tg.HapticFeedback.impactOccurred(type);\n      } else if (type === \"success\" || type === \"warning\" || type === \"error\") {\n        tg.HapticFeedback.notificationOccurred(type);\n      }\n    }\n  } catch (e) {}\n}\n\n/**\n * Utility: Show Toast Notification\n */\nfunction showToast(msg, isError = false) {\n  const toast = document.getElementById(\"toast\");\n  toast.textContent = msg;\n  toast.className = `toast show ${isError ? \"toast-error\" : \"\"}`;\n  setTimeout(() => {\n    toast.className = \"toast\";\n  }, 2600);\n}\n\n/**\n * Utility: Show/Hide Loading Overlay\n */\nfunction showLoading(show) {\n  const overlay = document.getElementById(\"loading-spinner\");\n  if (show) {\n    overlay.classList.remove(\"hidden\");\n  } else {\n    overlay.classList.add(\"hidden\");\n  }\n}\n\n/**\n * Utility: HTML Escape\n */\nfunction escapeHtml(str) {\n  if (!str) return \"\";\n  return String(str)\n    .replace(/&/g, \"&amp;\")\n    .replace(/</g, \"&lt;\")\n    .replace(/>/g, \"&gt;\")\n    .replace(/\"/g, \"&quot;\");\n}\n\n/**\n * Fallback Mock Data for Browser / Dev Preview\n */\nfunction loadMockDataForPreview() {\n  const today = new Date().toISOString().substring(0, 10);\n  appState = {\n    profile: {\n      user_id: 12345,\n      first_name: \"Demo User\",\n      daily_target: 2000,\n      streak_count: 5,\n      persona: \"sarcastic\"\n    },\n    todayDate: today,\n    selectedDate: today,\n    todayTotals: { calories: 1450, protein: 110, carbs: 160, fat: 42 },\n    macroTargets: { protein: 150, carbs: 200, fat: 67 },\n    todayLogs: [\n      { id: 1, food_name: \"2 Scrambled Eggs & Whole Wheat Toast\", calories: 360, protein: 18, carbs: 26, fat: 20, meal_type: \"Breakfast\" },\n      { id: 2, food_name: \"Chicken Rice & Steamed Greens\", calories: 650, protein: 45, carbs: 75, fat: 18, meal_type: \"Lunch\" },\n      { id: 3, food_name: \"Whey Protein Shake & Banana\", calories: 240, protein: 30, carbs: 28, fat: 2, meal_type: \"Snack\" },\n      { id: 4, food_name: \"Greek Yogurt & Berries\", calories: 200, protein: 17, carbs: 31, fat: 2, meal_type: \"Dinner\" }\n    ],\n    history7d: [\n      { date: \"2026-08-24\", label: \"08-24\", calories: 1920, protein: 130, carbs: 190, fat: 62, logs: [] },\n      { date: \"2026-08-25\", label: \"08-25\", calories: 2150, protein: 145, carbs: 220, fat: 70, logs: [] },\n      { date: \"2026-08-26\", label: \"08-26\", calories: 1850, protein: 125, carbs: 180, fat: 60, logs: [] },\n      { date: \"2026-08-27\", label: \"08-27\", calories: 1980, protein: 135, carbs: 195, fat: 64, logs: [] },\n      { date: \"2026-08-28\", label: \"08-28\", calories: 1750, protein: 120, carbs: 170, fat: 58, logs: [] },\n      { date: \"2026-08-29\", label: \"08-29\", calories: 2050, protein: 140, carbs: 210, fat: 68, logs: [] },\n      { date: today, label: \"Today\", calories: 1450, protein: 110, carbs: 160, fat: 42, logs: [] }\n    ],\n    presets: [\n      { id: \"p1\", food_name: \"Whey Protein Shake (1 Scoop)\", calories: 130, protein: 25, carbs: 3, fat: 2 },\n      { id: \"p2\", food_name: \"Creatine Monohydrate (5g)\", calories: 0, protein: 0, carbs: 0, fat: 0 },\n      { id: \"p3\", food_name: \"Black Coffee / Americano\", calories: 5, protein: 0, carbs: 1, fat: 0 }\n    ],\n    currentChartView: \"calories\",\n    chartInstance: null\n  };\n  renderAllViews();\n}\n\n</script>\n</body>\n</html>\n";

// ── Serve ─────────────────────────────────────────────────────────────────────

const handleUpdate = webhookCallback(bot, "std/http");
const telegramSecretToken = Deno.env.get("TELEGRAM_SECRET_TOKEN");
const cronSecret = Deno.env.get("CRON_SECRET");

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Telegram-Init-Data, Accept",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  try {
    const url = new URL(req.url);
    const apiAction = url.searchParams.get("api");

    // ── Serve Web App HTML Directly (Zero-404 Hosting) ───────────────────────
    if (url.searchParams.get("app") === "1" || url.searchParams.get("app") === "true" || url.pathname.endsWith("/app")) {
      return new Response(WEBAPP_HTML, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache"
        }
      });
    }


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
          profile: profile || { user_id: userId, daily_target: 2000, streak_count: 0, persona: "sarcastic" },
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

      if (apiAction === "update_target" && req.method === "POST") {
        const body = await req.json();
        const targetVal = parseInt(body?.target, 10);
        if (!targetVal || targetVal <= 0) {
          return new Response(JSON.stringify({ error: "Invalid target" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        await supabase.from("user_profiles").update({ daily_target: targetVal }).eq("user_id", userId);
        return new Response(JSON.stringify({ success: true, target: targetVal }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ error: "Unknown API action" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Cron Reminders ────────────────────────────────────────────────────────
    const cronType = url.searchParams.get("cron");

    if (cronType === "midday" || cronType === "night" || cronType === "weekly") {
      const reqSecret = url.searchParams.get("secret");
      if (cronSecret && reqSecret !== cronSecret) {
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
