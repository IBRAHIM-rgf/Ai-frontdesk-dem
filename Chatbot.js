import OpenAI from "openai";

/**
 * Vercel Serverless Function: /api/chat
 * Stateless demo: the browser sends the current state (appointments/tickets/patient).
 * IMPORTANT: set OPENAI_API_KEY in Vercel project environment variables.
 */

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

function makeSlots(vertical) {
  const now = new Date();
  const base = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  base.setMinutes(0, 0, 0);

  const hours =
    vertical === "Dentaire" ? [9, 11, 15, 17, 10, 16] :
    vertical === "Esthétique" ? [12, 14, 18, 11, 16, 19] :
    [10, 13, 15, 9, 11, 17];

  const slots = [];
  for (let i = 0; i < hours.length; i++) {
    const d = new Date(base.getTime() + Math.floor(i / 2) * 24 * 60 * 60 * 1000);
    d.setHours(hours[i], 0, 0, 0);
    slots.push({
      id: `S${i + 1}`,
      datetime: d.toISOString().slice(0, 16),
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
  return `
Tu es "AI Front Desk" pour une ${
    vertical === "Esthétique"
      ? "clinique esthétique"
      : vertical === "Dentaire"
        ? "clinique/cabinet dentaire"
        : "clinique multi-spécialités"
  }.

Objectif: convertir une demande en RDV, replanifier/annuler, ou escalader à un humain.

RÈGLES (obligatoires):
- AUCUN diagnostic, AUCUN conseil médical. Tu peux seulement orienter et réserver.
- Collecte de données minimale: nom, téléphone, motif général, site (si multi), créneau.
- Si urgence vitale ou symptômes graves: recommander de contacter les urgences / l'équipe immédiatement (sans diagnostic) et proposer transfert.
- Si plainte/litige/avocat/incident grave: créer un ticket "handoff humain".
- Toujours proposer 2–3 créneaux (fourni par le système) et demander un choix.
- Ton style: clair, court, premium.

FORMAT DE SORTIE (très important):
1) D'abord une réponse normale pour le patient (FR par défaut).
2) Ensuite, SI et seulement si une action doit être exécutée, ajoute un bloc de code JSON EXACTEMENT comme ci-dessous:

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

Si aucune action n'est nécessaire, ne mets PAS de JSON.
`.trim();
}

function extractJsonBlock(text) {
  const re = /```json\s*([\s\S]*?)\s*```/g;
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) last = match[1];
  if (!last) return null;
  try { return JSON.parse(last); } catch { return null; }
}

function stripJsonBlock(text) {
  return (text || "").replace(/```json[\s\S]*?```/g, "").trim();
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "method_not_allowed" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "missing_env",
        message: "Missing OPENAI_API_KEY. Add it in Vercel Project Settings → Environment Variables.",
      });
    }

    const body = req.body || {};
    const message = String(body.message || "");
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
      instructions: "Pour déplacer/annuler, demande à l'utilisateur de copier l'ID depuis la colonne 'ID' (Agenda).",
    };

    const response = await client.responses.create({
      model: MODEL,
      reasoning: { effort: "low" },
      input: [
        { role: "developer", content: systemPrompt(vertical) },
        { role: "user", content: JSON.stringify(userPayload, null, 2) },
      ],
    });

    const raw = response.output_text || "";
    const json = extractJsonBlock(raw);
    const reply = stripJsonBlock(raw);

    return res.status(200).json({
      reply,
      actions: json?.actions || [],
      slots,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "server_error", message: String(err?.message || err) });
  }
}
