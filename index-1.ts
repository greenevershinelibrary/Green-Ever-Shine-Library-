// =====================================================
// GREEN EVERSHINE LIBRARY — Supabase Edge Function
// Function Name: fee-reminder
// Schedule: Daily via Supabase pg_cron or dashboard scheduler
// =====================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const TELEGRAM_BOT_TOKEN   = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN) {
      throw new Error("Missing required environment variables.");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1. Get Telegram Chat ID from admin_settings
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

    // 2. Get current date info
    const today        = new Date();
    const currentYear  = today.getFullYear();

    const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    // 3. Fetch all students for current year
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

    // 4. Check fees using 30-day rolling cycle from joining date
    // Cycle N is due when daysActive >= N*30
    // e.g. cycle 1 due after 30 days, cycle 2 after 60 days, etc.
    type DueStudent = {
      name: string;
      seat: string;
      daysLate: number;
      dueMonths: string[];  // human-readable labels like "Cycle 1 (due 15 Feb)"
      isDueToday: boolean;
    };

    const dueStudents: DueStudent[] = [];

    for (const student of students) {
      if (!student.joining_date) continue;
      const joining    = new Date(student.joining_date);
      const daysActive = Math.floor((today.getTime() - joining.getTime()) / (1000 * 60 * 60 * 24));

      // How many 30-day cycles have elapsed?
      const cyclesElapsed = Math.floor(daysActive / 30);
      if (cyclesElapsed < 1) continue; // Not even first cycle yet

      // Fetch all unpaid payments for this student this year
      const { data: payments } = await supabase
        .from("payments")
        .select("month, status")
        .eq("student_id", student.id)
        .eq("year", currentYear)
        .eq("status", "unpaid");

      if (!payments || payments.length === 0) continue;

      // Only flag months whose 30-day due date has already passed
      // Month i+1 is due on day (i+1)*30 from joining
      const dueCycles = payments.filter(p => {
        const cycleDueDay = p.month * 30; // days from joining
        return daysActive >= cycleDueDay;
      });

      if (dueCycles.length === 0) continue;

      // Calculate days late based on the earliest unpaid due cycle
      const earliestCycle = Math.min(...dueCycles.map(p => p.month));
      const earliestDueDay = earliestCycle * 30;
      const daysLate = daysActive - earliestDueDay;
      const isDueToday = daysLate === 0;

      // Build human-readable labels with actual due dates
      const dueMonths = dueCycles.map(p => {
        const dueDate = new Date(joining.getTime() + p.month * 30 * 24 * 60 * 60 * 1000);
        const label = `${MONTH_NAMES[dueDate.getMonth()]} ${dueDate.getFullYear()}`;
        return `Cycle ${p.month} (due ${dueDate.getDate()} ${label})`;
      });

      dueStudents.push({
        name:      student.name,
        seat:      student.seat_number || "N/A",
        daysLate,
        dueMonths,
        isDueToday,
      });
    }

    // 5. Send Telegram notifications
    let sentCount = 0;

    if (dueStudents.length === 0) {
      await sendTelegram(
        TELEGRAM_BOT_TOKEN,
        CHAT_ID,
        `\u2705 *Green Evershine Library*\n\nAll fees are up to date! No pending payments as of ${today.toDateString()}.`
      );
    } else {
      const dueToday = dueStudents.filter(s => s.isDueToday);
      const overdue  = dueStudents.filter(s => !s.isDueToday);

      const lines: string[] = [];

      if (dueToday.length > 0) {
        lines.push(`\uD83D\uDCC5 *Fee Due Today (${dueToday.length} student${dueToday.length > 1 ? "s" : ""}):`);
        dueToday.forEach(s => {
          const months = s.dueMonths.join(", ");
          lines.push(`\u2022 *${s.name}* (Seat ${s.seat}) \u2014 Due: ${months}`);
        });
        lines.push("");
      }

      if (overdue.length > 0) {
        lines.push(`\u26A0\uFE0F *Overdue Fees (${overdue.length} student${overdue.length > 1 ? "s" : ""}):`);
        overdue.forEach(s => {
          const months    = s.dueMonths.join(", ");
          const lateLabel = s.daysLate === 1 ? "1 day late" : `${s.daysLate} days late`;
          lines.push(`\u2022 *${s.name}* (Seat ${s.seat})\n  Due: ${months} | \uD83D\uDD34 ${lateLabel}`);
        });
      }

      const message =
        `\uD83D\uDD14 *Green Evershine Library \u2014 Fee Alert*\n` +
        `\uD83D\uDCC5 ${today.toDateString()}\n\n` +
        lines.join("\n");

      await sendTelegram(TELEGRAM_BOT_TOKEN, CHAT_ID, message);
      sentCount = dueStudents.length;

      // Urgent alerts for students >60 days late
      for (const s of overdue) {
        if (s.daysLate > 60) {
          const months = s.dueMonths.join(", ");
          await sendTelegram(
            TELEGRAM_BOT_TOKEN,
            CHAT_ID,
            `\uD83D\uDEA8 *URGENT \u2014 Fee Critically Overdue*\n\nStudent *${s.name}* (Seat ${s.seat}) has not paid fees.\n` +
            `Due cycles: ${months}\n` +
            `*${s.daysLate} days late.*\n\nPlease follow up immediately.`
          );
        }
      }
    }

    return new Response(
      JSON.stringify({
        success:  true,
        message:  `Notifications sent for ${dueStudents.length} students.`,
        dueToday: dueStudents.filter(s => s.isDueToday).length,
        overdue:  dueStudents.filter(s => !s.isDueToday).length,
        sent:     sentCount,
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

// Helper: Send Telegram message
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
