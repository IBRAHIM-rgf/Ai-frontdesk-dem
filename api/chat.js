// api/chat.js
// Vercel Serverless Function: POST /api/chat
// Env requis: OPENAI_API_KEY
// Env optionnel: OPENAI_MODEL (ex: gpt-4o-mini)

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* ---------- Helpers (slots + prompt) ---------- */

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

function buildSystemPrompt(vertical) {
  const type =
    vertical === "Esthétique"
      ? "clinique esthétique"
      : vertical === "Dentaire"
      ? "cabinet dentaire"
      : "clinique multi-spécialités";

  return `
Tu es "AI Front Desk", l’accueil premium d’une ${type}.
Ta mission: aider vite, rassurer, et convertir en RDV (ou replanifier/annuler), sinon escalader à un humain.

STYLE (important):
- chaleureux, humain, naturel (comme une vraie personne), mais concis
- une seule question à la fois
- phrases courtes, ton premium, pas robotique
- reformule 1 fois max, puis avance

RÈGLES MÉDICALES (obligatoires):
- aucun diagnostic, aucune prescription, aucun conseil médical détaillé
- tu peux: orienter, poser des questions de triage non médicales, proposer un RDV
- si urgence vitale / détresse (douleur intense + gonflement important + fièvre + difficultés à respirer/avaler, saignement incontrôlable, malaise, etc.):
  -> recommander immédiatement les urgences / le 144 (Suisse) et proposer un transfert humain

DONNÉES À COLLECTER (minimum):
- nom
- téléphone
- motif général (ex: douleur dentaire, contrôle, esthétique, etc.)
- site (si multi-sites)
- créneau choisi (parmi les slots fournis)

PROCESS:
1) Accueillir + comprendre le besoin (1 question si nécessaire)
2) Proposer 2–3 créneaux parmi "available_slots"
3) Demander le choix
4) Si l’utilisateur confirme: demander nom + téléphone si manquants, puis créer l’action

ACTIONS (si nécessaire uniquement) :
Réponds d’abord normalement au patient.
Puis, SI une action doit être exécutée, ajoute un bloc JSON exactement:

\`\`\`json
{
  "actions":[
    {"type":"create_appointment","patient_name":"...","phone":"+41...","reason":"...","datetime":"YYYY-MM-DDTHH:MM","site":"Site A"}
  ]
}
\`\`\`

Actions possibles:
- create_appointment
- reschedule_appointment (appointment_id + new_datetime)
- cancel_appointment (appointment_id)
- create_ticket (topic, priority, patient_name, phone)

Si aucune action n’est nécessaire: ne mets PAS de JSON.
`.trim();
}

function extractJsonBlock(text) {
  const re = /```json\s*([\s\S]*?)\s*```/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
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
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ---------- Handler ---------- */

export default async function handler(req, res) {
  // CORS (si besoin)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "missing_env",
      message: "Missing OPENAI_API_KEY in Vercel Environment Variables.",
    });
  }

  const body = await readBody(req);
  if (body === null) {
    return res.status(400).json({ error: "invalid_json", message: "Body must be valid JSON." });
  }

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
    instructions:
      "Si l’utilisateur veut déplacer/annuler, demande-lui l’appointment_id affiché dans l’Agenda.",
  };

  try {
    const response = await client.responses.create({
      model: MODEL,
      input: [
        { role: "developer", content: buildSystemPrompt(vertical) },
        { role: "user", content: JSON.stringify(userPayload, null, 2) },
      ],
    });

    const raw = response.output_text || "";
    const json = extractJsonBlock(raw);
    const reply = stripJsonBlock(raw);

    return res.status(200).json({
      reply: reply || "Je suis là. Dites-moi ce que vous souhaitez faire 🙂",
      actions: Array.isArray(json?.actions) ? json.actions : [],
      slots,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
}


