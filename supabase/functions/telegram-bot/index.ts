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

// Create a Supabase Client using the service role key to bypass RLS policies
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const bot = new Bot(token);

// Register Persistent Menu commands with Telegram (runs during function spin-up)
try {
  await bot.api.setMyCommands([
    { command: "today", description: "📅 Today's Summary & Macros" },
    { command: "history", description: "📊 7-Day Calorie Chart" },
    { command: "weight", description: "⚖️ Log Current Weight (kg)" },
    { command: "progress", description: "📈 30-Day Weight Chart" },
    { command: "reminders", description: "🔔 Toggle Daily Alerts" },
    { command: "delete", description: "❌ Delete Last Logged Item" },
    { command: "target", description: "🎯 Update Calorie Goal" },
    { command: "start", description: "👋 Welcome & Instructions" }
  ]);
  console.log("Persistent bot commands menu registered successfully.");
} catch (err) {
  console.error("Failed to register persistent menu commands:", err);
}

// Helper: Ensure user profile exists in database
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
    // Create new profile with default target 2000
    const { error: insertError } = await supabase
      .from("user_profiles")
      .insert({ user_id: userId, daily_target: 2000, reminders_enabled: false, streak_count: 0 });
    
    if (insertError) {
      console.error("Error creating user profile:", insertError);
    }
  }
}

// Helper: Update consistency streak for a user
async function updateStreakAndGetMessage(userId: number): Promise<string> {
  const { data: profile, error } = await supabase
    .from("user_profiles")
    .select("streak_count, last_log_date")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !profile) return "";

  const todayStr = new Date().toISOString().split("T")[0];
  const currentStreak = profile.streak_count || 0;
  const lastLogDate = profile.last_log_date;

  let newStreak = currentStreak;

  if (!lastLogDate) {
    newStreak = 1;
  } else if (lastLogDate === todayStr) {
    // Already logged today, streak stays the same
    return `\n\n🔥 You are on a *${currentStreak}-day streak*!`;
  } else {
    // Check if yesterday was the last log date
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    if (lastLogDate === yesterdayStr) {
      newStreak = currentStreak + 1;
    } else {
      // Streak broken
      newStreak = 1;
    }
  }

  // Update profile
  await supabase
    .from("user_profiles")
    .update({ streak_count: newStreak, last_log_date: todayStr })
    .eq("user_id", userId);

  return `\n\n🔥 You are on a *${newStreak}-day streak*! Keep it going!`;
}

// Helper: Calculate macronutrient targets based on calorie goals (30% Protein, 40% Carbs, 30% Fat)
function getMacroTargets(calorieTarget: number, profile: any) {
  const protein = profile?.target_protein ?? Math.round((calorieTarget * 0.3) / 4);
  const carbs = profile?.target_carbs ?? Math.round((calorieTarget * 0.4) / 4);
  const fat = profile?.target_fat ?? Math.round((calorieTarget * 0.3) / 9);
  return { protein, carbs, fat };
}

// Helper: Get meal type from hour (UTC+8 / SGT)
function getMealType(utcHour: number): string {
  const sgtHour = (utcHour + 8) % 24;
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
    `Welcome to Calorie Tracker Bot v2, ${name}! 🍎\n\n` +
    `I can track calories, macronutrients, and your weight trends.\n\n` +
    `👉 *How to use:*\n` +
    `• 📸 *Send a photo* of your food to auto-estimate calories & macros using AI!\n` +
    `• ✍️ *Just type what you ate* (e.g. "2 boiled eggs") and I will log it.\n` +
    `• 📅 Use /today to view calories & macro balances.\n` +
    `• 🎯 Use /target <number> to update your daily calorie limit.\n` +
    `• 📊 Use /history to view your calorie history chart.\n` +
    `• ❌ Use /delete to remove your last logged food item.\n` +
    `• ⚖️ Use /weight <number> to record your weight in kg.\n` +
    `• 📈 Use /progress to view your 30-day weight progress chart.\n` +
    `• 🔔 Use /reminders to toggle opt-in daily meal reminders.`,
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

bot.command("add", async (ctx) => {
  return ctx.reply("The `/add` command is deprecated! 🚀\n\nYou can now just type what you ate directly in the chat, for example:\n> `I had a bowl of chicken rice and a coke`\n\nTry it now!", { parse_mode: "Markdown" });
});

bot.command("today", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId);

  // Get user profile
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  const target = profile?.daily_target ?? 2000;
  const macroTargets = getMacroTargets(target, profile);

  // Get today's logs
  const todayDate = new Date();
  todayDate.setUTCHours(0, 0, 0, 0);

  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("food_name, calories, protein, carbs, fat, created_at")
    .eq("user_id", userId)
    .gte("created_at", todayDate.toISOString())
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

  let message = `📅 *Today's Food Log (UTC)*\n\n`;
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

  // Query logs from past 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
  sevenDaysAgo.setUTCHours(0, 0, 0, 0);

  const { data: logs, error } = await supabase
    .from("food_logs")
    .select("calories, created_at")
    .eq("user_id", userId)
    .gte("created_at", sevenDaysAgo.toISOString())
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

  // Group by date (UTC YYYY-MM-DD)
  const historyMap: Record<string, number> = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    historyMap[dateStr] = 0;
  }

  (logs ?? []).forEach((log) => {
    const dateStr = new Date(log.created_at).toISOString().split("T")[0];
    if (dateStr in historyMap) {
      historyMap[dateStr] += log.calories;
    }
  });

  const sortedDates = Object.keys(historyMap).sort();
  const calorieValues = sortedDates.map(date => historyMap[date]);

  let textReport = `📊 *Weekly Calorie History*\n\n`;
  sortedDates.forEach((dateStr) => {
    const total = historyMap[dateStr];
    const isOver = total > target;
    textReport += `• *${dateStr}*: ${total} / ${target} kcal ${isOver ? "⚠️" : "✅"}\n`;
  });

  try {
    // Generate Calorie Chart via QuickChart.io
    const chartConfig = {
      type: 'bar',
      data: {
        labels: sortedDates.map(d => d.substring(5)), // Show 'MM-DD' instead of 'YYYY-MM-DD'
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
        title: { display: true, text: 'Calorie History (Last 7 Days)' },
        scales: {
          yAxes: [{
            ticks: {
              suggestedMin: Math.max(0, Math.min(...calorieValues) - 200),
              suggestedMax: Math.max(...calorieValues, target) + 200
            }
          }]
        }
      }
    };

    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
    await ctx.replyWithPhoto(chartUrl, { caption: textReport, parse_mode: "Markdown" });
  } catch (chartErr) {
    console.error("Failed to generate/send calorie chart:", chartErr);
    await ctx.reply(textReport, { parse_mode: "Markdown" });
  }
});

bot.command("delete", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Find the most recent food log
  const { data: lastLog, error } = await supabase
    .from("food_logs")
    .select("id, food_name, calories")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Error fetching last log for deletion:", error);
    return ctx.reply("Failed to retrieve your last log.");
  }

  if (!lastLog) {
    return ctx.reply("You have no logged foods to delete.");
  }

  const { error: deleteError } = await supabase
    .from("food_logs")
    .delete()
    .eq("id", lastLog.id);

  if (deleteError) {
    console.error("Error deleting log:", deleteError);
    return ctx.reply("Failed to delete the food log.");
  }

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

  const { error } = await supabase
    .from("weight_logs")
    .insert({ user_id: userId, weight: weight });

  if (error) {
    console.error("Error logging weight:", error);
    return ctx.reply("Failed to save your weight. Please try again.");
  }

  await ctx.reply(`⚖️ Logged weight: *${weight} kg*`, { parse_mode: "Markdown" });
});

bot.command("progress", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

  const { data: logs, error } = await supabase
    .from("weight_logs")
    .select("weight, created_at")
    .eq("user_id", userId)
    .gte("created_at", thirtyDaysAgo.toISOString())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching weight logs:", error);
    return ctx.reply("Failed to load weight progress.");
  }

  if (!logs || logs.length === 0) {
    return ctx.reply("No weight entries found in the last 30 days. Log your first weight with `/weight <number>`!", { parse_mode: "Markdown" });
  }

  // Format chart labels and values
  const labels = logs.map(log => new Date(log.created_at).toISOString().split("T")[0].substring(5)); // Show MM-DD
  const weights = logs.map(log => log.weight);

  try {
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
        title: { display: true, text: 'Weight Progress (Last 30 Days)' },
        scales: {
          yAxes: [{
            ticks: {
              suggestedMin: Math.min(...weights) - 1,
              suggestedMax: Math.max(...weights) + 1
            }
          }]
        }
      }
    };

    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
    await ctx.replyWithPhoto(chartUrl, { caption: "Here is your 30-day weight progress chart! 📈" });
  } catch (chartErr) {
    console.error("Failed to generate weight progress chart:", chartErr);
    // Fallback text report
    let textReport = `📈 *Weight Progress (Last 30 Days):*\n\n`;
    logs.forEach(log => {
      const dateStr = new Date(log.created_at).toISOString().split("T")[0];
      textReport += `• *${dateStr}*: ${log.weight} kg\n`;
    });
    await ctx.reply(textReport, { parse_mode: "Markdown" });
  }
});

bot.command("reminders", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId);

  const { data: profile, error } = await supabase
    .from("user_profiles")
    .select("reminders_enabled")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Error reading reminders status:", error);
    return ctx.reply("Failed to update reminder settings.");
  }

  const currentStatus = profile?.reminders_enabled ?? false;
  const newStatus = !currentStatus;

  const { error: updateError } = await supabase
    .from("user_profiles")
    .update({ reminders_enabled: newStatus })
    .eq("user_id", userId);

  if (updateError) {
    console.error("Error updating reminders status:", updateError);
    return ctx.reply("Failed to update reminder settings.");
  }

  if (newStatus) {
    await ctx.reply(
      `🔔 *Reminders Enabled!*\n\n` +
      `I will check in on you at lunch and dinner times if you forget to log your meals.`,
      { parse_mode: "Markdown" }
    );
  } else {
    await ctx.reply(`🔕 *Reminders Disabled.* You will no longer receive daily check-in alerts.`, { parse_mode: "Markdown" });
  }
});

// ── Core AI Processing Helper ────────────────────────────────────────────────
async function processFoodWithGemini(
  ctx: any,
  userId: number,
  statusMsg: any,
  textDesc?: string,
  base64Image?: string,
  mimeType?: string
) {
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`;
    
    // Construct the prompt and parts
    const promptText = 
      "You are a calorie estimation assistant. Analyze this food " + 
      (base64Image ? "photo" : "description") + 
      " and estimate the food item name/description, calories, protein, carbs, and fat. " +
      "Identify every distinct food/drink item separately, estimate portion size visually (or based on text), rate confidence (High/Medium/Low), provide per-item macros, and aggregate a combined total. " +
      "Provide a one-line nutrition insight. " +
      "Return ONLY a raw JSON object (no markdown, no code fences, no explanation) in this exact format: " +
      "{\"meal_description\": \"<overall meal description>\", \"items\": [{\"food\": \"<item name>\", \"portion\": \"<estimated portion>\", \"calories\": <int>, \"protein\": <int>, \"carbs\": <int>, \"fat\": <int>, \"confidence\": \"<High/Medium/Low>\"}], \"total\": {\"calories\": <int>, \"protein\": <int>, \"carbs\": <int>, \"fat\": <int>}, \"nutrition_insight\": \"<insight>\"}";
      
    const parts: any[] = [{ text: promptText }];
    if (textDesc) {
      parts.push({ text: `Food description: ${textDesc}` });
    }
    if (base64Image && mimeType) {
      parts.push({
        inlineData: { mimeType, data: base64Image }
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

    // Save to pending food logs
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

    const mealType = getMealType(new Date().getUTCHours());
    
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
      "⚠️ Sorry, I failed to analyze that food. Please try again or rephrase."
    );
  }
}

// ── Photo Handling & AI Analysis ─────────────────────────────────────────────

bot.on("message:photo", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ensureUserProfile(userId);

  const statusMsg = await ctx.reply("🤖 Analyzing your food photo with Gemini AI...");

  try {
    const photo = ctx.message.photo;
    const fileId = photo[photo.length - 1].file_id; // Largest photo size
    const file = await ctx.api.getFile(fileId);
    
    if (!file.file_path) {
      throw new Error("Telegram did not return a file path");
    }

    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const fileRes = await fetch(fileUrl);
    const arrayBuffer = await fileRes.arrayBuffer();
    const base64Image = encodeBase64(new Uint8Array(arrayBuffer));

    // Detect the image mime type from the file extension (.jpg/.jpeg/.png/.webp)
    const ext = file.file_path.split(".").pop()?.toLowerCase();
    const mimeType = ext === "png" ? "image/png"
      : ext === "webp" ? "image/webp"
      : "image/jpeg";

    await processFoodWithGemini(ctx, userId, statusMsg, undefined, base64Image, mimeType);
  } catch (error) {
    console.error("Error fetching photo:", error);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "⚠️ Sorry, I failed to process that photo."
    );
  }
});

// ── Callback Queries ──────────────────────────────────────────────────────────

bot.callbackQuery(/^confirm:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await ctx.answerCallbackQuery();

  const { data: pending, error: fetchError } = await supabase
    .from("pending_food_logs")
    .select("*")
    .eq("id", pendingId)
    .maybeSingle();

  if (fetchError || !pending) {
    return ctx.editMessageText("⚠️ This food log has expired or was already handled.");
  }

  // Insert into permanent logs
  const { error: insertError } = await supabase
    .from("food_logs")
    .insert({
      user_id: pending.user_id,
      food_name: pending.food_name,
      calories: pending.calories,
      protein: pending.protein || 0,
      carbs: pending.carbs || 0,
      fat: pending.fat || 0
    });

  if (insertError) {
    console.error("Error confirming log:", insertError);
    return ctx.editMessageText("⚠️ Failed to save food log.");
  }

  // Delete from pending
  await supabase.from("pending_food_logs").delete().eq("id", pendingId);

  // Update streak
  const streakMessage = await updateStreakAndGetMessage(pending.user_id);

  await ctx.editMessageText(
    `Logged: *${pending.food_name}* (${pending.calories} kcal) ✅\n` +
    `Macros: P:${pending.protein}g | C:${pending.carbs}g | F:${pending.fat}g` +
    streakMessage,
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await ctx.answerCallbackQuery();

  await supabase.from("pending_food_logs").delete().eq("id", pendingId);
  await ctx.editMessageText("Log cancelled. ❌");
});

bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "To customize the calories, please reply directly to *this specific message* with the correct number of calories.\n\n" +
    "Example reply: `320`",
    { parse_mode: "Markdown" }
  );
});

// ── Text Handler for Calories Replies ─────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const replyTo = ctx.message.reply_to_message;
  
  // If it's a reply to the bot message instructing to customize calories
  if (replyTo && replyTo.text?.includes("please reply directly to this specific message")) {
    const newCalories = parseInt(ctx.message.text.trim());
    if (isNaN(newCalories) || newCalories < 0) {
      return ctx.reply("Please reply with a valid number (e.g. 280).");
    }

    // Get the most recent pending log for this user
    const { data: pending, error: pendingError } = await supabase
      .from("pending_food_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingError || !pending) {
      return ctx.reply("⚠️ Could not find a pending food log to edit. Please upload a new image.");
    }

    // Scale macros proportionally based on the new calorie amount compared to estimated calories
    const scaleRatio = pending.calories > 0 ? (newCalories / pending.calories) : 1;
    const scaledProtein = Math.round((pending.protein || 0) * scaleRatio);
    const scaledCarbs = Math.round((pending.carbs || 0) * scaleRatio);
    const scaledFat = Math.round((pending.fat || 0) * scaleRatio);

    // Move to permanent food log with custom calories and scaled macros
    const { error: insertError } = await supabase
      .from("food_logs")
      .insert({
        user_id: userId,
        food_name: pending.food_name,
        calories: newCalories,
        protein: scaledProtein,
        carbs: scaledCarbs,
        fat: scaledFat
      });

    if (insertError) {
      console.error("Error inserting custom calories log:", insertError);
      return ctx.reply("⚠️ Failed to save food log.");
    }

    // Clean up pending log
    await supabase.from("pending_food_logs").delete().eq("id", pending.id);

    // Update streak
    const streakMessage = await updateStreakAndGetMessage(userId);

    return ctx.reply(
      `Logged: *${pending.food_name}* with *${newCalories} kcal* ✅\n` +
      `Scaled Macros: P:${scaledProtein}g | C:${scaledCarbs}g | F:${scaledFat}g` +
      streakMessage,
      { parse_mode: "Markdown" }
    );
  }

  // Fallback default message if it's not a slash command or a reply
  if (!ctx.message.text.startsWith("/")) {
    const statusMsg = await ctx.reply("🤖 Analyzing your meal description with Gemini AI...");
    await processFoodWithGemini(ctx, userId, statusMsg, ctx.message.text);
  }
});

// ── Scheduled Reminders Execution ────────────────────────────────────────────

async function sendCronReminders(type: "midday" | "night") {
  console.log(`Running cron reminders. Type: ${type}`);
  
  // 1. Fetch all users with reminders enabled
  const { data: users, error } = await supabase
    .from("user_profiles")
    .select("user_id")
    .eq("reminders_enabled", true);

  if (error) {
    console.error("Error fetching reminder-enabled users:", error);
    return;
  }

  if (!users || users.length === 0) {
    console.log("No users have reminders enabled.");
    return;
  }

  const todayDate = new Date();
  todayDate.setUTCHours(0, 0, 0, 0);

  for (const user of users) {
    const userId = user.user_id;

    // 2. Fetch today's food log count for the user
    const { data: logs, error: logError } = await supabase
      .from("food_logs")
      .select("id")
      .eq("user_id", userId)
      .gte("created_at", todayDate.toISOString());

    if (logError) {
      console.error(`Error checking logs for user ${userId}:`, logError);
      continue;
    }

    const logCount = logs?.length ?? 0;

    // Midday check (0 logs means they forgot breakfast/lunch)
    if (type === "midday" && logCount === 0) {
      try {
        await bot.api.sendMessage(
          userId,
          `🔔 *Daily Check-in Reminder*\n\n` +
          `You haven't logged any meals today! Did you eat breakfast or lunch? ` +
          `Send me a photo 📸 or log manually using /add. Keep your streak active!`,
          { parse_mode: "Markdown" }
        );
        console.log(`Sent midday reminder to user ${userId}`);
      } catch (err) {
        console.error(`Failed to send midday message to user ${userId}:`, err);
      }
    } 
    // Night check (< 2 logs means they likely skipped dinner or other meals)
    else if (type === "night" && logCount < 2) {
      try {
        const text = logCount === 0 
          ? `🔔 *Daily Check-in Reminder*\n\n` +
            `You haven't logged any meals today. Make sure to record what you ate to keep up your health tracking. 📸`
          : `🔔 *Daily Check-in Reminder*\n\n` +
            `You've only logged one meal today. Did you forget to record dinner or other snacks? Log them now to finish the day strong! 🍽️`;

        await bot.api.sendMessage(userId, text, { parse_mode: "Markdown" });
        console.log(`Sent night reminder to user ${userId}`);
      } catch (err) {
        console.error(`Failed to send night message to user ${userId}:`, err);
      }
    }
  }
}

// ── Serve ─────────────────────────────────────────────────────────────────────

const handleUpdate = webhookCallback(bot, "std/http");

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const cronType = url.searchParams.get("cron");

    // Handle incoming scheduled requests
    if (cronType === "midday" || cronType === "night") {
      await sendCronReminders(cronType);
      return new Response("Cron reminders executed successfully", { status: 200 });
    }

    return await handleUpdate(req);
  } catch (err) {
    console.error(err);
    return new Response(String(err), { status: 500 });
  }
});
