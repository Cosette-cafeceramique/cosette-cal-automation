// app/api/cal-webhook/route.js
import crypto from "crypto";
import { NextResponse } from "next/server";

/**
 * === ENV à définir sur Vercel ===
 * CAL_API_KEY         -> Cal.com > Settings > Developer > API Keys
 * CAL_WEBHOOK_SECRET  -> le "Secret" que tu as mis dans Cal.com lors de la création du webhook
 */
const CAL_API_KEY = process.env.CAL_API_KEY;
const CAL_WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET;
// Garde une version API Cal récente (celle-ci fonctionne très bien)
const CAL_API_VERSION = "2024-08-13";

/* ------------------------- Utils ------------------------- */

function verifySignature(rawBody, header) {
  if (!CAL_WEBHOOK_SECRET || !header) return false;
  const digest = crypto.createHmac("sha256", CAL_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return header === digest;
}
function normEvt(evt) {
  return (evt || "").toString().toLowerCase().replace(/_/g, ".");
}
function toInt(v, d = 1) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

/**
 * Essaie de lire la quantité directement dans l’objet "booking"
 * en couvrant plusieurs formats possibles.
 */
function extractQtyFromBooking(b) {
  let val =
    b?.bookingFieldsResponses?.places ??
    b?.bookingFieldsResponses?.nombre_de_participants;

  // Parfois bookingFieldsResponses est un objet aux clés variées
  if (val == null && b?.bookingFieldsResponses && !Array.isArray(b.bookingFieldsResponses)) {
    const obj = b.bookingFieldsResponses;
    const k = Object.keys(obj).find((k) => k.toLowerCase().includes("place"));
    if (k) val = obj[k];
  }

  // D’autres tenants renvoient des tableaux de réponses
  const arrays = [];
  if (Array.isArray(b?.responses)) arrays.push(b.responses);
  if (Array.isArray(b?.formResponses)) arrays.push(b.formResponses);
  if (Array.isArray(b?.answers)) arrays.push(b.answers);
  if (Array.isArray(b?.attendees?.[0]?.responses)) arrays.push(b.attendees[0].responses);

  for (const arr of arrays) {
    const hit = arr.find((f) =>
      (
        (f?.key || f?.slug || f?.id || f?.name || f?.label || f?.question || "") + ""
      )
        .toLowerCase()
        .includes("place")
    );
    if (hit) {
      val =
        hit.value ??
        hit.answer ??
        hit.response ??
        hit.number ??
        hit.text ??
        val;
      break;
    }
  }

  const qty = Math.max(1, Math.min(15, toInt(val, 1)));
  return qty;
}

/**
 * Recherche "profonde" de secours : scanne l’objet et prend
 * la 1ère valeur numérique trouvée sur une clé contenant
 * 'place' ou 'participant'.
 */
function deepFindQty(obj) {
  let found = null;
  const stack = [obj];
  while (stack.length && found == null) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const [k, v] of Object.entries(cur)) {
        const key = (k || "").toLowerCase();
        if (typeof v !== "object" && (key.includes("place") || key.includes("participant"))) {
          const n = parseInt(v, 10);
          if (Number.isFinite(n)) {
            found = n;
            break;
          }
        }
        stack.push(v);
      }
    }
  }
  if (found == null) return null;
  return Math.max(1, Math.min(15, found));
}

/**
 * Récupère les détails d’une réservation Cal.com par UID/ID.
 * Déballe proprement { data: { booking: {...} } }, { booking: {...} }, { data: {...} }, ou {...}.
 */
async function fetchBookingDetails(uidOrId) {
  const url = `https://api.cal.com/v2/bookings/${encodeURIComponent(uidOrId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${CAL_API_KEY}`,
      "cal-api-version": CAL_API_VERSION,
    },
  });
  const txt = await res.text();
  if (!res.ok) {
    console.error("CAL ▶ details failed", res.status, txt);
    return null;
  }
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    j = txt;
  }

  const detail = j?.data?.booking ?? j?.booking ?? j?.data ?? j;

  // Log shape pour diagnostiquer si besoin
  try {
    console.log("CAL ▶ details shape", {
      topKeys: j && typeof j === "object" ? Object.keys(j) : typeof j,
      dataKeys: j?.data && typeof j.data === "object" ? Object.keys(j.data) : null,
      detailKeys: detail && typeof detail === "object" ? Object.keys(detail) : typeof detail,
    });
  } catch {}

  return detail && typeof detail === "object" ? detail : null;
}

/* --------------------- Healthchecks ---------------------- */

export async function GET() {
  return NextResponse.json({ ok: true, source: "cal-webhook" });
}
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

/* --------------------- Webhook handler ------------------- */

export async function POST(req) {
  try {
    const raw = await req.text();
    const sig = req.headers.get("x-cal-signature-256");
    if (!verifySignature(raw, sig)) {
      return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
    }

    const body = JSON.parse(raw || "{}");
    const evt = normEvt(body?.triggerEvent || body?.type);
    if (!evt.includes("booking.created")) {
      // on ne traite que la création
      return NextResponse.json({ ok: true, skipped: evt || "unknown-event" });
    }

    // Réservation "primaire" envoyée par le webhook
    const b = body?.payload || body?.data || {};
    const uid = b?.uid || b?.id;

    // Évite de retraiter les réservations "enfant" que nous créons nous-mêmes
    if (b?.metadata?.multiParentUid) {
      return NextResponse.json({ ok: true, skipped: "child booking" });
    }

    // 1) Essaye de lire la quantité directement
    let qty = extractQtyFromBooking(b);

    // 2) Si toujours 1 → va chercher les détails via l’API et re-essaie
    if (qty === 1 && uid && CAL_API_KEY) {
      const detail = await fetchBookingDetails(uid);
      if (detail) {
        const fromDetail = extractQtyFromBooking(detail) ?? deepFindQty(detail);
        if (fromDetail && fromDetail > 1) qty = fromDetail;

        console.log("CAL ▶ booking.details snapshot", {
          uid,
          hasBFR: !!detail?.bookingFieldsResponses,
          keys: Object.keys(detail || {}),
          responsesLen: Array.isArray(detail?.responses) ? detail.responses.length : 0,
          formResponsesLen: Array.isArray(detail?.formResponses) ? detail.formResponses.length : 0,
          answersLen: Array.isArray(detail?.answers) ? detail.answers.length : 0,
        });
      }
    }

    const extra = qty - 1;

    // Infos nécessaires pour recréer N-1 réservations sur le même slot
    const eventTypeId = b?.eventTypeId || b?.eventType?.id;
    const startISO = b?.start || b?.startTime || b?.when?.startTime || b?.when?.start;
    const attendee =
      (Array.isArray(b?.attendees) && b.attendees[0]) ||
      b?.attendee || { name: "Invité", email: "no-reply@cosette.fr", timeZone: "Europe/Paris" };

    console.log("CAL ▶ booking.created", {
      qty,
      extra,
      eventTypeId,
      startISO,
      attendeeEmail: attendee?.email,
      bookingFieldsResponses: b?.bookingFieldsResponses,
      responsesArrLen: Array.isArray(b?.responses) ? b.responses.length : 0,
      formResponsesArrLen: Array.isArray(b?.formResponses) ? b.formResponses.length : 0,
    });

    if (!CAL_API_KEY) {
      return NextResponse.json({ ok: false, error: "missing CAL_API_KEY" }, { status: 500 });
    }
    if (!eventTypeId || !startISO || !attendee?.email) {
      console.error("CAL ▶ missing data", {
        eventTypeId,
        startISO,
        attendeeEmail: attendee?.email,
      });
      return NextResponse.json(
        { ok: false, error: "missing eventTypeId/start/attendee" },
        { status: 400 }
      );
    }

    // Si l’utilisateur a choisi 1 place → rien à créer en plus
    if (extra <= 0) {
      return NextResponse.json({ ok: true, info: "single seat", qty });
    }

    // Prépare la création des N-1 réservations
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CAL_API_KEY}`,
      "cal-api-version": CAL_API_VERSION,
    };

    let created = 0;
    for (let i = 0; i < extra; i++) {
      const r = await fetch("https://api.cal.com/v2/bookings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          eventTypeId,
          start: startISO, // même slot (UTC)
          timeZone: attendee.timeZone || "Europe/Paris",
          attendees: [
            {
              name: attendee.name || "Invité",
              email: attendee.email,
              timeZone: attendee.timeZone || "Europe/Paris",
            },
          ],
          // Marqueur pour ne pas re-traiter nos propres créations
          metadata: { multiParentUid: b?.uid || b?.id || "primary" },
          // Pour garder la trace de la demande initiale
          bookingFieldsResponses: { places: qty },
        }),
      });

      if (!r.ok) {
        const txt = await r.text();
        console.error("CAL ▶ create failed", r.status, txt);
        return NextResponse.json(
          { ok: false, error: "create failed", status: r.status, details: txt },
          { status: 400 }
        );
      }
      await r.json();
      created++;
    }

    console.log("CAL ▶ created extra bookings:", created);
    return NextResponse.json({ ok: true, qty, extra, created });
  } catch (e) {
    console.error("CAL ▶ error", e);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
