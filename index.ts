// =====================================================
// GREEN EVERSHINE LIBRARY — Supabase Edge Function
// Function Name: fee-reminder
// Schedule: Daily (set via Supabase dashboard or pg_cron)
// =====================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Environment variables (set in Supabase dashboard → Edge Functions → Secrets) ──
    const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const TELEGRAM_BOT_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN) {
      throw new Error("Missing required environment variables.");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── 1. Get Telegram Chat ID from admin_settings ──
    const { data: settings, error: settingsErr } = await supabase
      .from("admin_settings")
      .select("telegram_chat_id")
      .eq("id", 1)
      .single();

    if (settingsErr || !settings?.telegram_chat_id) {
      return new Response(
        JSON.stringify({ success: false, error: "Telegram chat_id not configured in admin_settings." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const CHAT_ID = settings.telegram_chat_id;

    // ── 2. Get current date info ──
    const today         = new Date();
    const currentYear   = today.getFullYear();
    const currentMonth  = today.getMonth() + 1;

    // ── 3. Fetch all students for current year ──
    const { data: students, error: studentsErr } = await supabase
      .from("students")
      .select("id, name, joining_date, seat_number")
      .eq("year", currentYear);

    if (studentsErr) throw studentsErr;
    if (!students || students.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No students found for current year.", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 4. Check overdue fees (joining_date + 30 days < today) ──
    const overdueStudents: Array<{ name: string; seat: string; daysOverdue: number; unpaidMonths: number[] }> = [];

    for (const student of students) {
      const joining    = new Date(student.joining_date);
      const daysActive = Math.floor((today.getTime() - joining.getTime()) / (1000 * 60 * 60 * 24));

      // Only notify if student has been enrolled for more than 30 days
      if (daysActive < 30) continue;

      // Fetch unpaid months for this student
      const { data: payments } = await supabase
        .from("payments")
        .select("month, status")
        .eq("student_id", student.id)
        .eq("year", currentYear)
        .eq("status", "unpaid")
        .lte("month", currentMonth); // Only past/current months

      if (payments && payments.length > 0) {
        const daysOverdue = daysActive - 30;
        overdueStudents.push({
          name:         student.name,
          seat:         student.seat_number || "N/A",
          daysOverdue:  daysOverdue > 0 ? daysOverdue : 0,
          unpaidMonths: payments.map((p) => p.month),
        });
      }
    }

    // ── 5. Send Telegram notifications ──
    let sentCount = 0;

    if (overdueStudents.length === 0) {
      // Send a "all clear" message
      await sendTelegram(
        TELEGRAM_BOT_TOKEN,
        CHAT_ID,
        `✅ *Green Evershine Library*\n\nAll fees are up to date! No pending payments as of ${today.toDateString()}.`
      );
    } else {
      // Send summary message
      const summaryLines = overdueStudents.map((s) => {
        const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const months = s.unpaidMonths.map((m) => monthNames[m - 1]).join(", ");
        return `• *${s.name}* (Seat ${s.seat})\n  Unpaid: ${months} | Overdue: ${s.daysOverdue} days`;
      });

      const message =
        `🔔 *Green Evershine Library — Fee Alert*\n` +
        `📅 Date: ${today.toDateString()}\n\n` +
        `⚠️ *${overdueStudents.length} student(s) have pending fees:*\n\n` +
        summaryLines.join("\n\n");

      await sendTelegram(TELEGRAM_BOT_TOKEN, CHAT_ID, message);
      sentCount = overdueStudents.length;

      // Optionally send individual messages for critical cases (>60 days overdue)
      for (const s of overdueStudents) {
        if (s.daysOverdue > 60) {
          const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const months = s.unpaidMonths.map((m) => monthNames[m - 1]).join(", ");
          await sendTelegram(
            TELEGRAM_BOT_TOKEN,
            CHAT_ID,
            `🚨 *URGENT — Fee Overdue*\n\nStudent *${s.name}* (Seat ${s.seat}) fee pending.\n` +
            `Unpaid months: ${months}\n` +
            `*${s.daysOverdue} days overdue.*\n\nPlease follow up immediately.`
          );
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Notifications sent for ${overdueStudents.length} students.`,
        overdueStudents: overdueStudents.length,
        sent: sentCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ── Helper: Send Telegram message ──
async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id:    chatId,
      text:       text,
      parse_mode: "Markdown",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Telegram API error:", err);
    throw new Error(`Telegram error: ${err}`);
  }
}
