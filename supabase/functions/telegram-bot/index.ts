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

// Register Persistent Menu commands
try {
  await bot.api.setMyCommands([
    { command: "today", description: "📅 Today's Summary & Macros" },
    { command: "history", description: "📊 7-Day Calorie Chart" },
    { command: "presets", description: "⭐ Saved Presets & Supplements" },
    { command: "weight", description: "⚖️ Log Current Weight (kg)" },
    { command: "progress", description: "📈 30-Day Weight Chart" },
    { command: "leaderboard", description: "🏆 Group Calorie Leaderboard" },
    { command: "joinleaderboard", description: "👥 Join Group Leaderboard" },
    { command: "reminders", description: "🔔 Toggle Daily Alerts" },
    { command: "delete", description: "❌ Delete Last Logged Item" },
    { command: "target", description: "🎯 Update Calorie Goal" },
    { command: "start", description: "👋 Welcome & Instructions" }
  ]);
  console.log("Persistent bot commands menu registered successfully.");
} catch (err) {
  console.error("Failed to register persistent menu commands:", err);
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

// Helper: Ensure user profile exists
async function ensureUserProfile(userId: number) {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Error checking user profile:", error);
    return;
  }

  if (!data) {
    const { error: insertError } = await supabase
      .from("user_profiles")
      .insert({ user_id: userId, daily_target: 2000, reminders_enabled: false, streak_count: 0 });
    
    if (insertError) {
      console.error("Error creating user profile:", insertError);
    }
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
    // Calculate yesterday in SGT
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

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId);
  const name = ctx.from?.first_name ?? "there";

  await ctx.reply(
    `Welcome to Calorie Tracker Bot v3.1, ${name}! 🍎\n\n` +
    `I can track calories, macronutrients, weight, voice notes & saved presets!\n\n` +
    `👉 *How to use:*\n` +
    `• 📸 *Send a photo* of your food to auto-estimate calories & macros!\n` +
    `• 🎙️ *Send a voice note* (e.g. "I had two eggs and toast") to auto-log!\n` +
    `• ✍️ *Just type what you ate* in chat.\n` +
    `• ⭐ Use /presets to view & 1-tap log saved supplements or meals.\n` +
    `• 📅 Use /today to view calories & macro balances.\n` +
    `• 🎯 Use /target <number> to update your daily goal.\n` +
    `• 📊 Use /history for your 7-day calorie chart.\n` +
    `• 🏆 Use /joinleaderboard & /leaderboard in group chats!\n` +
    `• ⚖️ Use /weight <number> & /progress for weight tracking.\n` +
    `• 🔔 Use /reminders for opt-in AI coaching & reminders.`,
    { parse_mode: "Markdown" }
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

  await ensureUserProfile(userId);

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

  await ensureUserProfile(userId);

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
    .select("food_name, calories, protein, carbs, fat, created_at")
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
    message += `_No food logged today._\n\n`;
  } else {
    logs.forEach((log) => {
      message += `• ${log.calories} kcal - _${log.food_name}_ (P:${log.protein}g C:${log.carbs}g F:${log.fat}g)\n`;
    });
    message += `\n`;
  }

  message += `━━━━━━━━━━━━━━━━━━━━\n`;
  message += `Total Consumed: *${totalCalories} kcal*\n`;
  message += `Daily Goal: *${target} kcal*\n`;

  if (remaining >= 0) {
    message += `Remaining Budget: *${remaining} kcal* 🍏\n\n`;
  } else {
    message += `Remaining Budget: *${remaining} kcal* ⚠️ (Over goal)\n\n`;
  }

  message += `🥦 *Macronutrients Summary:*\n`;
  message += `• Protein: *${totalProtein}g* / ${macroTargets.protein}g\n`;
  message += `• Carbs: *${totalCarbs}g* / ${macroTargets.carbs}g\n`;
  message += `• Fat: *${totalFat}g* / ${macroTargets.fat}g`;

  await ctx.reply(message, { parse_mode: "Markdown" });
});

bot.command("history", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId);

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
  for (let i = 0; i < 7; i++) {
    const d = new Date(new Date().getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = getSGTDateStr(d);
    historyMap[dateStr] = 0;
  }

  (logs ?? []).forEach((log) => {
    const dateStr = getSGTDateStr(new Date(log.created_at));
    if (dateStr in historyMap) {
      historyMap[dateStr] += log.calories;
    }
  });

  const sortedDates = Object.keys(historyMap).sort();
  const calorieValues = sortedDates.map(date => historyMap[date]);

  let textReport = `📊 *Weekly Calorie History (SGT)*\n\n`;
  sortedDates.forEach((dateStr) => {
    const total = historyMap[dateStr];
    const isOver = total > target;
    textReport += `• *${dateStr}*: ${total} / ${target} kcal ${isOver ? "⚠️" : "✅"}\n`;
  });

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
    await ctx.replyWithPhoto(chartUrl, { caption: textReport, parse_mode: "Markdown" });
  } catch (chartErr) {
    console.error("Failed to generate/send calorie chart:", chartErr);
    await ctx.reply(textReport, { parse_mode: "Markdown" });
  }
});

bot.command("presets", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId);

  const { data: presets, error } = await supabase
    .from("user_presets")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error || !presets || presets.length === 0) {
    return ctx.reply(
      `⭐ *No Saved Presets Yet!*\n\n` +
      `Log any meal, photo, or voice note, then tap *⭐ Save as Preset* on the log confirmation message to save quick items (like daily supplements or frequent meals).`,
      { parse_mode: "Markdown" }
    );
  }

  let text = `⭐ *Your Saved Presets & Supplements*\n\n`;
  const keyboard = new InlineKeyboard();

  presets.forEach((preset) => {
    text += `• *${preset.food_name}* — ${preset.calories} kcal (P:${preset.protein}g C:${preset.carbs}g F:${preset.fat}g)\n`;
    keyboard.text(`➕ Log ${preset.food_name}`, `log_preset:${preset.id}`)
            .text(`🗑️ Delete`, `del_preset:${preset.id}`)
            .row();
  });

  text += `\n_Tap "➕ Log" to immediately add an item to today's intake!_`;
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.command("delete", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const { data: lastLog, error } = await supabase
    .from("food_logs")
    .select("id, food_name, calories")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !lastLog) {
    return ctx.reply("No logged foods to delete.");
  }

  await supabase.from("food_logs").delete().eq("id", lastLog.id);
  await ctx.reply(`🗑️ Deleted: *${lastLog.food_name}* (${lastLog.calories} kcal).`, { parse_mode: "Markdown" });
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

  await ensureUserProfile(userId);
  await supabase.from("weight_logs").insert({ user_id: userId, weight: weight });
  await ctx.reply(`⚖️ Logged weight: *${weight} kg*`, { parse_mode: "Markdown" });
});

bot.command("progress", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId);
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

  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  await ctx.replyWithPhoto(chartUrl, { caption: "Here is your 30-day weight progress chart! 📈" });
});

bot.command("reminders", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId);
  const { data: profile } = await supabase.from("user_profiles").select("reminders_enabled").eq("user_id", userId).maybeSingle();
  const newStatus = !(profile?.reminders_enabled ?? false);

  await supabase.from("user_profiles").update({ reminders_enabled: newStatus }).eq("user_id", userId);

  if (newStatus) {
    await ctx.reply(`🔔 *Reminders & Sarcastic AI Coaching Enabled!*\n\nYou'll get daily check-ins & weekly AI reviews in SGT.`, { parse_mode: "Markdown" });
  } else {
    await ctx.reply(`🔕 *Reminders Disabled.*`, { parse_mode: "Markdown" });
  }
});

// ── Group Leaderboard Commands ───────────────────────────────────────────────

bot.command("joinleaderboard", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) return;

  await ensureUserProfile(userId);

  const { error } = await supabase
    .from("group_members")
    .upsert({ group_id: chatId, user_id: userId });

  if (error) {
    console.error("Error joining leaderboard:", error);
    return ctx.reply("Failed to join the leaderboard for this chat.");
  }

  const userName = ctx.from?.first_name ?? "User";
  await ctx.reply(`🎉 *${userName}* has joined the chat leaderboard! Use /leaderboard to check rankings.`, { parse_mode: "Markdown" });
});

bot.command("leaderboard", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

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
    .select("user_id, streak_count")
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

  const rankings = userIds.map(uid => {
    const p = profileMap.get(uid);
    const daysCount = userDaysMap[uid]?.size ?? 0;
    const streak = p?.streak_count ?? 0;
    return { userId: uid, daysCount, streak };
  }).sort((a, b) => b.daysCount - a.daysCount || b.streak - a.streak);

  let message = `🏆 *Group Calorie Tracker Leaderboard (Past 7 Days)* 🏆\n\n`;
  const medalEmojis = ["🥇", "🥈", "🥉"];

  rankings.forEach((r, idx) => {
    const medal = idx < 3 ? medalEmojis[idx] : ` ${idx + 1}.`;
    message += `${medal} *User ${r.userId}* — *${r.daysCount} days logged* (🔥 ${r.streak}-day streak)\n`;
  });

  message += `\n_Keep logging daily to climb the leaderboard!_`;
  await ctx.reply(message, { parse_mode: "Markdown" });
});

// ── Core AI Processing Helper (Photos & Voice Notes) ─────────────────────────

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

    const { data: pending, error: pendingError } = await supabase
      .from("pending_food_logs")
      .insert({
        user_id: userId,
        food_name: mealDesc,
        calories: totalCal,
        protein: totalP,
        carbs: totalC,
        fat: totalF
      })
      .select()
      .single();

    if (pendingError) throw pendingError;

    const inlineKeyboard = new InlineKeyboard()
      .text("✅ Confirm & Log", `confirm:${pending.id}`)
      .text("✍️ Edit Calories", `edit:${pending.id}`)
      .row()
      .text("❌ Cancel", `cancel:${pending.id}`);

    const mealType = getMealType();
    
    let displayMessage = `🥗 *AI Meal Scan Results*\n\n`;
    displayMessage += `🍽 *${mealDesc}*\n`;
    displayMessage += `🕐 Meal type: ${mealType}\n\n`;
    displayMessage += `Identified items:\n`;
    
    for (const item of items) {
      const confBadge = item.confidence?.toLowerCase() === 'high' ? '🟢 High' : (item.confidence?.toLowerCase() === 'medium' ? '🟡 Medium' : '🔴 Low');
      displayMessage += `• ${item.food} (${item.portion}) — ${item.calories} kcal (P:${item.protein}g C:${item.carbs}g F:${item.fat}g) [${confBadge}]\n`;
    }
    
    displayMessage += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    displayMessage += `📊 Combined Total: *${totalCal} kcal*\n`;
    displayMessage += `Macros: P:${totalP}g | C:${totalC}g | F:${totalF}g\n\n`;
    displayMessage += `💡 _${insight}_\n\n`;
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

  await ensureUserProfile(userId);
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

  await ensureUserProfile(userId);
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

  const { data: insertedLog, error: insertErr } = await supabase.from("food_logs").insert({
    user_id: pending.user_id,
    food_name: pending.food_name,
    calories: pending.calories,
    protein: pending.protein || 0,
    carbs: pending.carbs || 0,
    fat: pending.fat || 0
  }).select().single();

  if (insertErr || !insertedLog) {
    console.error("Error logging meal:", insertErr);
    return ctx.editMessageText("⚠️ Failed to save food log.");
  }

  await supabase.from("pending_food_logs").delete().eq("id", pendingId);
  const streakMessage = await updateStreakAndGetMessage(pending.user_id);

  const saveKeyboard = new InlineKeyboard().text("⭐ Save as Preset", `save_preset:${insertedLog.id}`);

  await ctx.editMessageText(
    `Logged: *${pending.food_name}* (${pending.calories} kcal) ✅\n` +
    `Macros: P:${pending.protein}g | C:${pending.carbs}g | F:${pending.fat}g` +
    streakMessage,
    { parse_mode: "Markdown", reply_markup: saveKeyboard }
  );
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

  await ctx.reply(`⭐ Saved *${log.food_name}* (${log.calories} kcal) to your presets! Use /presets anytime to quick-log it.`, { parse_mode: "Markdown" });
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
    fat: preset.fat
  });

  if (insertErr) {
    console.error("Error logging preset:", insertErr);
    return ctx.reply("⚠️ Failed to log preset.");
  }

  const streakMessage = await updateStreakAndGetMessage(preset.user_id);

  await ctx.reply(
    `Logged: *${preset.food_name}* (${preset.calories} kcal) ✅\n` +
    `Macros: P:${preset.protein}g | C:${preset.carbs}g | F:${preset.fat}g` +
    streakMessage,
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery(/^del_preset:(.+)$/, async (ctx) => {
  const presetId = ctx.match[1];
  await ctx.answerCallbackQuery();

  const { data: preset } = await supabase
    .from("user_presets")
    .select("food_name")
    .eq("id", presetId)
    .maybeSingle();

  await supabase.from("user_presets").delete().eq("id", presetId);

  await ctx.reply(`🗑️ Deleted preset: *${preset?.food_name || "Item"}*`, { parse_mode: "Markdown" });
});

bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await ctx.answerCallbackQuery();
  await supabase.from("pending_food_logs").delete().eq("id", pendingId);
  await ctx.editMessageText("Log cancelled. ❌");
});

bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("To customize calories, please reply directly to *this message* with the number of calories.", { parse_mode: "Markdown" });
});

// ── Text Handler for Calories Replies & Text Logs ────────────────────────────

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const replyTo = ctx.message.reply_to_message;
  
  if (replyTo && replyTo.text?.includes("please reply directly to this message")) {
    const newCalories = parseInt(ctx.message.text.trim());
    if (isNaN(newCalories) || newCalories < 0) {
      return ctx.reply("Please reply with a valid number (e.g. 280).");
    }

    const { data: pending } = await supabase
      .from("pending_food_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!pending) {
      return ctx.reply("⚠️ Could not find a pending food log to edit.");
    }

    const scaleRatio = pending.calories > 0 ? (newCalories / pending.calories) : 1;
    const scaledProtein = Math.round((pending.protein || 0) * scaleRatio);
    const scaledCarbs = Math.round((pending.carbs || 0) * scaleRatio);
    const scaledFat = Math.round((pending.fat || 0) * scaleRatio);

    const { data: insertedLog, error: insertErr } = await supabase.from("food_logs").insert({
      user_id: userId,
      food_name: pending.food_name,
      calories: newCalories,
      protein: scaledProtein,
      carbs: scaledCarbs,
      fat: scaledFat
    }).select().single();

    if (insertErr || !insertedLog) {
      return ctx.reply("⚠️ Failed to save custom calories log.");
    }

    await supabase.from("pending_food_logs").delete().eq("id", pending.id);
    const streakMessage = await updateStreakAndGetMessage(userId);

    const saveKeyboard = new InlineKeyboard().text("⭐ Save as Preset", `save_preset:${insertedLog.id}`);

    return ctx.reply(
      `Logged: *${pending.food_name}* with *${newCalories} kcal* ✅\n` +
      `Scaled Macros: P:${scaledProtein}g | C:${scaledCarbs}g | F:${scaledFat}g` +
      streakMessage,
      { parse_mode: "Markdown", reply_markup: saveKeyboard }
    );
  }

  if (!ctx.message.text.startsWith("/")) {
    const statusMsg = await ctx.reply("🤖 Analyzing your meal description with Gemini AI...");
    await processFoodWithGemini(ctx, userId, statusMsg, ctx.message.text);
  }
});

// ── Scheduled Reminders & Sarcastic AI Coaching ──────────────────────────────

async function generateSarcasticAICoaching(userId: number, type: "daily" | "weekly"): Promise<string | null> {
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`;

    if (type === "daily") {
      const sgtStartIso = getSGTStartOfDayISO();
      const { data: logs } = await supabase
        .from("food_logs")
        .select("food_name, calories, protein, carbs, fat")
        .eq("user_id", userId)
        .gte("created_at", sgtStartIso);

      const { data: profile } = await supabase.from("user_profiles").select("daily_target").eq("user_id", userId).maybeSingle();
      const target = profile?.daily_target ?? 2000;
      const totalCal = (logs ?? []).reduce((sum, item) => sum + item.calories, 0);

      const promptText = 
        `You are a witty, hilarious, and sarcastically humorous AI nutrition coach. ` +
        `Write a short 2-sentence cheeky daily recap for a user in Singapore. ` +
        `Data for today: Total Consumed = ${totalCal} kcal, Daily Goal = ${target} kcal. Foods eaten: ${JSON.stringify(logs)}. ` +
        `Keep it funny, slightly sarcastic, but encouraging! Output plain text only.`;

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

      const { data: profile } = await supabase.from("user_profiles").select("daily_target, streak_count").eq("user_id", userId).maybeSingle();
      const target = profile?.daily_target ?? 2000;

      const promptText = 
        `You are a witty, hilarious, and sarcastically humorous AI nutrition coach. ` +
        `Write a 1-paragraph humorous weekly review of the user's progress. ` +
        `Daily Goal = ${target} kcal. Streak = ${profile?.streak_count ?? 0} days. Total logs in last 7 days = ${logs?.length ?? 0}. ` +
        `Keep it witty, funny, and engaging! Output plain text only.`;

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
    .select("user_id")
    .eq("reminders_enabled", true);

  if (error || !users || users.length === 0) return;

  const sgtStartIso = getSGTStartOfDayISO();

  for (const user of users) {
    const userId = user.user_id;

    if (type === "weekly") {
      const weeklyCoaching = await generateSarcasticAICoaching(userId, "weekly");
      if (weeklyCoaching) {
        try {
          await bot.api.sendMessage(userId, `🤖 *Weekly AI Nutrition Roast & Review (SGT)* 🥑\n\n${weeklyCoaching}`, { parse_mode: "Markdown" });
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
      const dailyCoaching = await generateSarcasticAICoaching(userId, "daily");
      const coachingText = dailyCoaching ? `\n\n😏 *Daily AI Roast:*\n_${dailyCoaching}_` : "";

      try {
        const text = logCount === 0 
          ? `🔔 *Daily Check-in Reminder (SGT)*\n\nYou haven't logged any meals today. Record what you ate to finish strong! 📸`
          : `🔔 *Daily Check-in Reminder (SGT)*\n\nYou've logged your meals today!${coachingText}`;

        await bot.api.sendMessage(userId, text, { parse_mode: "Markdown" });
      } catch (err) { console.error(`Failed to send night message to ${userId}:`, err); }
    }
  }
}

// ── Serve ─────────────────────────────────────────────────────────────────────

const handleUpdate = webhookCallback(bot, "std/http");

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const cronType = url.searchParams.get("cron");

    if (cronType === "midday" || cronType === "night" || cronType === "weekly") {
      await sendCronReminders(cronType as any);
      return new Response(`Cron ${cronType} executed successfully`, { status: 200 });
    }

    return await handleUpdate(req);
  } catch (err) {
    console.error(err);
    return new Response(String(err), { status: 500 });
  }
});
