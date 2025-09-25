// app/api/cal-webhook/route.js
import crypto from "crypto";
import { NextResponse } from "next/server";

/**
 * ENV (Vercel → Project → Settings → Environment Variables)
 * - CAL_API_KEY          : Cal.com > Settings > Developer > API Keys
 * - CAL_WEBHOOK_SECRET   : Secret du webhook "Developers > Webhooks" (si tu l'utilises)
 * - WORKFLOW_TOKEN       : jeton partagé pour les Workflows (une chaîne longue au hasard)
 */
const CAL_API_KEY = process.env.CAL_API_KEY;
const CAL_WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET || "";
const WORKFLOW_TOKEN = process.env.WORKFLOW_TOKEN || "";
const CAL_API_VERSION = "2024-08-13";

// ---------- utils ----------
function verifySignature(rawBody, header) {
  if (!CAL_WEBHOOK_SECRET || !header) return false;
  const digest = crypto.createHmac("sha256", CAL_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return header === digest;
}
function normEvt(evt) { return (evt || "").toLowerCase().replace(/_/g, "."); }
function clampQty(n) {
  const q = parseInt(n, 10);
  if (!Number.isFinite(q)) return 1;
  return Math.max(1, Math.min(15, q));
}

// ---------- healthchecks ----------
export async function GET() { return NextResponse.json({ ok: true, source: "cal-webhook" }); }
export async function HEAD() { return new NextResponse(null, { status: 200 }); }

// ---------- handler ----------
export async function POST(req) {
  const url = new URL(req.url);
  const wfToken = url.searchParams.get("wftoken"); // pour appels Workflow
  const hasWorkflowToken = wfToken && WORKFLOW_TOKEN && wfToken === WORKFLOW_TOKEN;

  try {
    // 1) Lecture du body (texte si webhook signé, json si workflow)
    const raw = await req.text();

    // 2) Détection du mode
    const sig = req.headers.get("x-cal-signature-256");
    const isSignedWebhook = !!sig && !!CAL_WEBHOOK_SECRET && verifySignature(raw, sig);

    // Sécurité minimale : si ni signature valide ni token workflow valide -> refuse
    if (!isSignedWebhook && !hasWorkflowToken) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    // 3) Parse JSON (dans les 2 cas)
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { body = {}; }

    // -------- MODE WORKFLOW (recommandé) --------
    if (hasWorkflowToken) {
      // On attend un JSON contenant au minimum: qty, eventTypeId, start, attendee(email|name|timeZone), uid
      const qty = clampQty(body.qty ?? body.places ?? body.count ?? 1);
      const eventTypeId = body.eventTypeId ?? body.eventType?.id;
      const startISO = body.start ?? body.when?.start ?? body.startTime;
      const attendee = body.attendee || {};
      const email = attendee.email || body.email;

      console.log("CAL ▶ workflow payload", { qty, eventTypeId, startISO, email, uid: body.uid });

      if (!CAL_API_KEY) return NextResponse.json({ ok:false, error:"missing CAL_API_KEY" }, { status:500 });
      if (!eventTypeId || !startISO || !email) {
        return NextResponse.json({ ok:false, error:"missing eventTypeId/start/email" }, { status:400 });
      }

      const extra = qty - 1;
      if (extra <= 0) return NextResponse.json({ ok:true, info:"single seat (workflow)", qty });

      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CAL_API_KEY}`,
        "cal-api-version": CAL_API_VERSION
      };

      let created = 0;
      for (let i = 0; i < extra; i++) {
        const r = await fetch("https://api.cal.com/v2/bookings", {
          method: "POST",
          headers,
          body: JSON.stringify({
            eventTypeId,
            start: startISO,
            timeZone: attendee.timeZone || "Europe/Paris",
            attendees: [{ name: attendee.name || "Invité", email, timeZone: attendee.timeZone || "Europe/Paris" }],
            metadata: { multiParentUid: body.uid || "primary" },
            bookingFieldsResponses: { places: qty }
          })
        });
        if (!r.ok) {
          const txt = await r.text();
          console.error("CAL ▶ create failed (workflow)", r.status, txt);
          return NextResponse.json({ ok:false, error:"create failed", status:r.status, details:txt }, { status:400 });
        }
        await r.json();
        created++;
      }
      console.log("CAL ▶ created extra bookings (workflow):", created);
      return NextResponse.json({ ok:true, mode:"workflow", qty, created });
    }

    // -------- MODE WEBHOOK SIGNÉ (optionnel) --------
    const evt = normEvt(body?.triggerEvent || body?.type);
    if (!evt.includes("booking.created")) {
      return NextResponse.json({ ok: true, skipped: evt || "unknown-event" });
    }
    // Ici, on ne connaît pas la quantité (Cal ne l’envoie pas dans ton tenant),
    // donc on ne tente rien pour éviter les doublons. On log juste.
    console.log("CAL ▶ signed webhook received, skipping quantity logic (use workflow).");
    return NextResponse.json({ ok: true, mode: "signed-webhook", info: "skipped; use workflow" });

  } catch (e) {
    console.error("CAL ▶ error", e);
    return NextResponse.json({ ok:false, error: e?.message || String(e) }, { status:500 });
  }
}
