import crypto from "crypto";
import { NextResponse } from "next/server";

// Réglages
const CAL_API_KEY = process.env.CAL_API_KEY;               // Cal.com → Settings → Developer → API Keys
const CAL_WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET; // Tu le définis en créant le webhook (étape 4)
const CAL_API_VERSION = "2024-08-13";                      // Garde cette valeur

// Vérif HMAC (signature Cal)
function verifySignature(rawBody, header) {
  if (!CAL_WEBHOOK_SECRET || !header) return false;
  const digest = crypto.createHmac("sha256", CAL_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return header === digest;
}

// Pour tests/healthcheck
export async function GET() {
  return NextResponse.json({ ok: true, source: "cal-webhook" });
}
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

// Réception réelle
export async function POST(req) {
  try {
    const raw = await req.text();
    const sig = req.headers.get("x-cal-signature-256");
    if (!verifySignature(raw, sig)) {
      return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
    }

    const body = JSON.parse(raw || "{}");
    // Le type d’événement
    const evt = body?.triggerEvent || body?.type || "";
    if (!`${evt}`.toLowerCase().includes("booking.created")) {
      return NextResponse.json({ ok: true, skipped: "not booking.created" });
    }

    // Cal envoie l’objet réservation dans payload/data
    const b = body?.payload || body?.data || {};
    // Anti-boucle : si c’est une résa que NOUS avons créée en plus, on stoppe
    if (b?.metadata?.multiParentUid) {
      return NextResponse.json({ ok: true, skipped: "child booking" });
    }

    // On récupère la quantité demandée par le client (champ "Nombre de places")
    const qtyRaw =
      b?.bookingFieldsResponses?.places ??
      b?.responses?.places ??
      b?.formResponses?.places ??
      1;

    const qty = Math.max(1, Math.min(15, parseInt(qtyRaw || 1, 10)));
    const extra = qty - 1; // car 1 place est déjà prise par cette réservation

    if (extra <= 0) {
      return NextResponse.json({ ok: true, info: "single seat" });
    }

    // Infos de base pour dupliquer
    const eventTypeId = b?.eventTypeId || b?.eventType?.id;
    const startISO = b?.start || b?.when?.startTime;   // ex: "2025-11-20T09:00:00Z"
    const primaryAttendee =
      (b?.attendees && b.attendees[0]) ||
      b?.attendee || { name: "Invité", email: "no-reply@cosette.fr", timeZone: "Europe/Paris" };

    if (!eventTypeId || !startISO || !primaryAttendee?.email) {
      return NextResponse.json(
        { ok: false, error: "missing data (eventTypeId/start/attendee)" },
        { status: 400 }
      );
    }
    if (!CAL_API_KEY) {
      return NextResponse.json({ ok: false, error: "missing CAL_API_KEY" }, { status: 500 });
    }

    // Création des N–1 résas supplémentaires
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CAL_API_KEY}`,
      "cal-api-version": CAL_API_VERSION
    };

    const created = [];
    for (let i = 0; i < extra; i++) {
      const res = await fetch("https://api.cal.com/v2/bookings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          eventTypeId,
          start: startISO,                  // la même heure/slot
          timeZone: primaryAttendee.timeZone || "Europe/Paris",
          attendees: [
            {
              name: primaryAttendee.name,
              email: primaryAttendee.email,
              timeZone: primaryAttendee.timeZone || "Europe/Paris"
            }
          ],
          // Marqueur pour éviter de re-traiter nos propres créations
          metadata: {
            multiParentUid: b?.uid || b?.id || "primary"
          },
          // Optionnel : garder trace de la quantité totale demandée
          bookingFieldsResponses: {
            places: qty
          }
        })
      });

      if (!res.ok) {
        const t = await res.text();
        // On arrête proprement si la capacité est dépassée, etc.
        return NextResponse.json(
          { ok: false, error: `create booking failed: ${res.status} ${t}` },
          { status: 400 }
        );
      }
      created.push(await res.json());
    }

    return NextResponse.json({ ok: true, created: created.length, qty, extra });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
