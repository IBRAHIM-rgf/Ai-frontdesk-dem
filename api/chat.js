// api/chat.js
// Vercel Serverless Function: POST /api/chat
// Env required: OPENAI_API_KEY
// Optional: OPENAI_MODEL (default: gpt-4o-mini)

function makeSlots(vertical) {
  const now = new Date();
  const base = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  base.setMinutes(0, 0, 0);

  const hours =
    vertical === "Dentaire"
      ? [9, 11, 15, 17, 10, 16]
      : vertical === "Esthétique"
      ? [12, 14, 18, 11, 16, 19]
      : [10, 13, 15, 9, 11, 17];

  const slots = [];
  for (let i = 0; i < hours.length; i++) {
    const d = new Date(base.getTime() + Math.floor(i / 2) * 24 * 60 * 60 * 1000);
    d.setHours(hours[i], 0, 0, 0);

    slots.push({
      id: `S${i + 1}`,
      datetime: d.toISOString().slice(0, 16), // YYYY-MM-DDTHH:MM
      label: d.toLocaleString("fr-CH", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
  }
  return slots;
}

function systemPrompt(vertical) {
  const brand =
    vertical === "Esthétique"
      ? "une clinique esthétique"
      : vertical === "Dentaire"
      ? "un cabinet dentaire"
      : "une clinique multi-spécialités";

  return `
Tu es "AI Front Desk" : un(e) concierge d’accueil humain(e), chaleureux(se) et premium, pour ${brand}.
Tu parles comme une vraie personne (naturel, fluide), jamais robotique.

OBJECTIF
- Transformer la demande en prise de RDV (ou déplacement/annulation) ou escalader vers un humain.

STYLE
- Ton: chaleureux, premium, pro, service 5 étoiles.
- Phrases courtes. Une question à la fois.
- Empathie brève SANS diagnostic: "Je suis navré(e) d’apprendre ça. Je m’en occupe."
- Toujours faire avancer: proposer des créneaux, demander un choix.

RÈGLES (obligatoires)
- AUCUN diagnostic, AUCUN conseil médical, AUCUN traitement.
- Collecte minimale: nom, téléphone, motif général, site (si multi), créneau.
- Urgence vitale / symptômes graves -> recommander d’appeler les urgences, proposer transfert humain (ticket).
- Litige/avocat/incident grave -> ticket "handoff humain".
- Ne JAMAIS inventer de créneaux hors "available_slots".
- Pour déplacer/annuler: demander l’appointment_id (visible dans Agenda).

FORMAT DE SORTIE (obligatoire)
1) Réponse normale au patient.
2) SI et seulement si une action doit être exécutée, ajouter un bloc JSON EXACTEMENT:

\`\`\`json
{
  "actions":[
    {"type":"create_appointment","patient_name":"...","phone":"+41...","reason":"...","datetime":"YYYY-MM-DDTHH:MM","site":"Site A|Site B|"}
  ]
}
\`\`\`

Actions possibles:
- create_appointment
- reschedule_appointment (requires appointment_id + new_datetime)
- cancel_appointment (requires appointment_id)
- create_ticket (requires topic, priority, patient_name, phone)
`.trim();
}

function extractJsonBlock(text) {
  const re = /```json\s*([\s\S]*?)\s*```/g;
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) last = match[1];
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

function stripJsonBlock(text) {
  return String(text || "").replace(/```json[\s\S]*?```/g, "").trim();
}

async function readBody(req) {
  // Vercel peut donner req.body déjà parsé, ou une string
  if (req.body && typeof req.body === "object") return req.body;

  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ message: data });
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  // (Optionnel) CORS simple
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "missing_env",
      message: "Missing OPENAI_API_KEY. Add it in Vercel → Project Settings → Environment Variables.",
    });
  }

  try {
    const body = await readBody(req);

    const message = String(body.message || "").trim();
    const vertical = String(body.vertical || "Dentaire");
    const state = body.state || {};
    const patient = state.patient || { name: "", phone: "" };
    const appointments = Array.isArray(state.appointments) ? state.appointments : [];
    const tickets = Array.isArray(state.tickets) ? state.tickets : [];

    const slots = makeSlots(vertical);

    const userPayload = {
      vertical,
      patient_known: patient,
      available_slots: slots,
      existing_appointments: appointments,
      existing_tickets: tickets,
      user_message: message,
      instructions:
        "Pour déplacer/annuler, demande à l'utilisateur de copier l'ID depuis la colonne 'ID' (Agenda).",
    };

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    // Appel OpenAI (Chat Completions, très compatible)
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        messages: [
          { role: "system", content: systemPrompt(vertical) },
          { role: "user", content: JSON.stringify(userPayload, null, 2) },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(500).json({
        error: "openai_error",
        status: resp.status,
        message: errText.slice(0, 2000),
      });
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "";

    const json = extractJsonBlock(raw);
    const reply = stripJsonBlock(raw);

    return res.status(200).json({
      reply,
      actions: json?.actions || [],
      slots,
    });
  } catch (err) {
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
}
