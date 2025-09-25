import crypto from "crypto";
import { NextResponse } from "next/server";

const CAL_API_KEY = process.env.CAL_API_KEY;
const CAL_WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET;
const CAL_API_VERSION = "2024-08-13";

function verifySignature(rawBody, header) {
  if (!CAL_WEBHOOK_SECRET || !header) return false;
  const digest = crypto.createHmac("sha256", CAL_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return header === digest;
}

function normEvt(evt){ return (evt||"").toLowerCase().replace(/_/g,"."); }
function toInt(v,d=1){ const n=parseInt(v,10); return Number.isFinite(n)?n:d; }

// 1) extraction "classique"
function extractQty(payload){
  let val = payload?.bookingFieldsResponses?.places
         ?? payload?.bookingFieldsResponses?.nombre_de_participants;

  if (val==null && payload?.bookingFieldsResponses && !Array.isArray(payload.bookingFieldsResponses)){
    const obj = payload.bookingFieldsResponses;
    const k = Object.keys(obj).find(k=>k.toLowerCase().includes("place"));
    if (k) val = obj[k];
  }

  const arrays=[];
  if (Array.isArray(payload?.responses)) arrays.push(payload.responses);
  if (Array.isArray(payload?.formResponses)) arrays.push(payload.formResponses);
  for(const arr of arrays){
    const hit = arr.find(f=>((f?.key||f?.id||f?.name||f?.label||"")+"").toLowerCase().includes("place"));
    if (hit){ val = hit.value ?? hit.answer ?? hit.response ?? hit.number ?? val; break; }
  }

  return Math.max(1, Math.min(15, toInt(val,1)));
}

// 2) extraction "au cas où" (cherche partout une clé/label contenant 'place' ou 'participant')
function deepFindQty(obj){
  let found = null;
  const stack = [obj];
  while (stack.length && found == null){
    const cur = stack.pop();
    if (cur && typeof cur === "object"){
      if (Array.isArray(cur)){
        for (const v of cur) stack.push(v);
      } else {
        for (const [k,v] of Object.entries(cur)){
          const key = (k||"").toLowerCase();
          if (typeof v !== "object" && (key.includes("place") || key.includes("participant"))){
            const n = parseInt(v,10);
            if (Number.isFinite(n)) { found = n; break; }
          }
          stack.push(v);
        }
      }
    }
  }
  if (found==null) return null;
  return Math.max(1, Math.min(15, found));
}

// Healthcheck
export async function GET(){ return NextResponse.json({ok:true,source:"cal-webhook"}); }
export async function HEAD(){ return new NextResponse(null,{status:200}); }

export async function POST(req){
  try{
    const raw = await req.text();
    const sig = req.headers.get("x-cal-signature-256");
    if(!verifySignature(raw,sig)) return NextResponse.json({ok:false,error:"invalid signature"},{status:401});

    const body = JSON.parse(raw||"{}");
    const evt = normEvt(body?.triggerEvent || body?.type);
    if(!evt.includes("booking.created")) return NextResponse.json({ok:true,skipped:evt||"unknown"});

    const b = body?.payload || body?.data || {};

    // ignorer les "enfants" qu'on crée nous-mêmes
    if (b?.metadata?.multiParentUid) return NextResponse.json({ok:true,skipped:"child booking"});

    // --- qty
    let qty = extractQty(b);
    if (qty===1) {
      const alt = deepFindQty(b);
      if (alt!=null) qty = alt;
    }
    const extra = qty - 1;

    // --- infos slot & attendee
    const eventTypeId = b?.eventTypeId || b?.eventType?.id;
    const startISO = b?.start || b?.startTime || b?.when?.startTime || b?.when?.start;
    const attendee =
      (Array.isArray(b?.attendees) && b.attendees[0]) ||
      b?.attendee || { name:"Invité", email:"no-reply@cosette.fr", timeZone:"Europe/Paris" };

    // LOGS DIAGNOSTIC (visible dans Vercel → Logs)
    console.log("CAL ▶ booking.created", {
      qty, extra, eventTypeId, startISO,
      attendeeEmail: attendee?.email,
      bookingFieldsResponses: b?.bookingFieldsResponses,
      responsesArrLen: Array.isArray(b?.responses) ? b.responses.length : 0,
      formResponsesArrLen: Array.isArray(b?.formResponses) ? b.formResponses.length : 0
    });

    if(!CAL_API_KEY) return NextResponse.json({ok:false,error:"missing CAL_API_KEY"},{status:500});
    if(!eventTypeId || !startISO || !attendee?.email){
      console.error("CAL ▶ missing data", { eventTypeId, startISO, attendeeEmail: attendee?.email });
      return NextResponse.json({ok:false,error:"missing eventTypeId/start/attendee"},{status:400});
    }

    if (extra<=0) return NextResponse.json({ok:true,info:"single seat",qty});

    const headers = {
      "Content-Type":"application/json",
      "Authorization":`Bearer ${CAL_API_KEY}`,
      "cal-api-version":CAL_API_VERSION
    };

    let created = 0;
    for (let i=0;i<extra;i++){
      const r = await fetch("https://api.cal.com/v2/bookings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          eventTypeId,
          start: startISO,
          timeZone: attendee.timeZone || "Europe/Paris",
          attendees: [{
            name: attendee.name || "Invité",
            email: attendee.email,
            timeZone: attendee.timeZone || "Europe/Paris"
          }],
          metadata: { multiParentUid: b?.uid || b?.id || "primary" },
          bookingFieldsResponses: { places: qty }
        })
      });
      if(!r.ok){
        const txt = await r.text();
        console.error("CAL ▶ create failed", r.status, txt);
        return NextResponse.json(
          { ok:false, error:"create failed", status:r.status, details:txt },
          { status:400 }
        );
      }
      await r.json();
      created++;
    }

    console.log("CAL ▶ created extra bookings:", created);
    return NextResponse.json({ ok:true, qty, extra, created });

  } catch (e){
    console.error("CAL ▶ error", e);
    return NextResponse.json({ ok:false, error:e?.message || String(e) }, { status:500 });
  }
}
