import OpenAI from "openai";

/**
 * Vercel Serverless Function: /api/chat
 * Env required: OPENAI_API_KEY
 * Optional: OPENAI_MODEL
 */

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/** Robust JSON body parsing for Vercel functions */
async function readJson(req) {
  if (req?.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

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
  const label =
    vertical === "Esthétique"
      ? "clinique esthétique"
      : vertical === "Dentaire"
        ? "cabinet/clinique dentaire"
        : "clinique multi-spécialités";

  return `
Tu es "AI Front Desk", l'assistante d'accueil d'une ${label}.
Objectif: répondre comme une vraie personne (chaleureuse, pro, premium) et convertir en RDV, ou replanifier/annuler, ou escalader à un humain.

STYLE (important):
- Naturel, humain, empathique (comme une réceptionniste).
- Phrases courtes. 1 question à la fois.
- Tu peux utiliser le prénom si connu.
- Tu reformules brièvement pour montrer que tu as compris.

RÈGLES MÉDICALES (obligatoires):
- AUCUN diagnostic. AUCUN conseil médical/traitement.
- Tu peux seulement: orienter, proposer un RDV, expliquer les étapes, demander des infos administratives.
- Si l'utilisateur mentionne symptômes graves/urgence vitale (détresse respiratoire, malaise sévère, saignement incontrôlable, douleur extrême + signes inquiétants, etc.): recommander de contacter immédiatement les urgences/112 (ou le service d'urgence local) et proposer un transfert humain.
- Si plainte/litige/avocat/incident grave: créer un ticket "handoff humain" (priorité élevée) et rester factuel.

DONNÉES À COLLECTER (minimal):
- Nom + téléphone (si pas déjà connu)
- Motif général (ex: douleur dentaire, contrôle, esthétique…)
- Site (si multi-sites)
- Créneau choisi (parmi ceux fournis)

LOGIQUE RDV:
- Si demande de RDV: propose 2–3 créneaux parmi "available_slots".
- Si l'utilisateur hésite: propose 2 créneaux + demande préférence (matin/après-midi).
- Si l'utilisateur donne un créneau hors liste: propose le plus proche.
- Toujours confirmer: "Je récapitule: … C'est ok pour vous ?"

FORMAT DE SORTIE (très important):
1) D'abord une réponse normale pour le patient (FR par défaut).
2) Ensuite, SEULEMENT si une action doit être exécutée, ajoute un bloc code JSON EXACT:

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
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

function stripJsonBlock(text) {
  return (text || "").replace(/```json[\s\S]*?```/g, "").trim();
}

export default async function handler(req, res) {
  // CORS (safe even if same-domain)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "missing_env",
      message: "Missing OPENAI_API_KEY. Add it in Vercel → Project → Settings → Environment Variables.",
    });
  }

  try {
    const body = await readJson(req);

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
        "Pour déplacer/annuler, demande à l'utilisateur de copier l'ID depuis la colonne 'ID' (Agenda).",
    };

    const response = await client.responses.create({
      model: MODEL,
      input: [
        { role: "developer", content: systemPrompt(vertical) },
        { role: "user", content: JSON.stringify(userPayload, null, 2) },
      ],
      max_output_tokens: 500,
    });

    const raw = response.output_text || "";
    const parsed = extractJsonBlock(raw);
    const reply = stripJsonBlock(raw);

    return res.status(200).json({
      reply: reply || "D’accord — dites-moi simplement ce que vous souhaitez faire (prendre un RDV, déplacer, annuler, ou une question) 🙂",
      actions: parsed?.actions || [],
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
