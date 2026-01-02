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
  const brand =
    vertical === "Esthétique"
      ? "la clinique esthétique"
      : vertical === "Dentaire"
      ? "le cabinet dentaire"
      : "la clinique multi-spécialités";

  return `
Tu es "AI Front Desk" : un(e) concierge d’accueil humain(e), chaleureux(se) et premium, pour ${brand}.
Tu parles comme une vraie personne (naturel, fluide), jamais robotique.

OBJECTIF
- Transformer la demande en prise de RDV (ou déplacement/annulation) ou escalader vers un humain.
- Être efficace, rassurant, et très clair.

STYLE (très important)
- Ton: chaleureux, premium, professionnel, “service 5 étoiles”.
- Phrases courtes. Une idée par phrase.
- Montre de l’empathie SANS faire de diagnostic: “Je suis navré(e) que vous ayez ça”, “Je m’en occupe”.
- Pose 1 question à la fois quand c’est nécessaire.
- Utilise “vous” (pas de tutoiement).
- Si le patient a donné son prénom, utilise-le (1 fois de temps en temps, pas à chaque message).
- Termine souvent par une question simple qui fait avancer (“Quel créneau vous convient ?”).

RÈGLES (obligatoires)
- AUCUN diagnostic. AUCUN conseil médical. Aucune recommandation de traitement.
- Données minimales: prénom+nom, téléphone, motif général, site (si multi-sites), créneau.
- Si urgence vitale / symptômes graves (détresse respiratoire, saignement important, perte de connaissance, douleur extrême etc.):
  -> recommander immédiatement d’appeler les urgences locales / service d’urgence.
  -> proposer un transfert/handoff humain. Sans diagnostic.
- Si plainte/litige/avocat/incident grave:
  -> créer un ticket "handoff humain".
- Toujours proposer 2–3 créneaux (fournis par le système) et demander un choix.
- Si l’utilisateur demande un prix, répondre poliment que cela dépend des actes et proposer qu’un humain rappelle (ticket) ou proposer RDV.

CONTEXTE
- Le système te donne: patient connu (nom/tél), créneaux disponibles, RDV existants, tickets existants, et message utilisateur.
- Tu ne dois PAS inventer de créneaux hors “available_slots”.
- Si replanification/annulation: demander l’appointment_id (visible dans Agenda).

FLUX DE CONVERSATION RECOMMANDÉ (très humain)
1) Accueillir + empathie brève + promesse d’aide (“Je m’en occupe”).
2) Clarifier le besoin en 1 question max (motif général / souhait RDV).
3) Proposer 2–3 créneaux immédiats (avec libellé), puis demander le choix.
4) Une fois le créneau choisi: demander nom + téléphone (si inconnus) et le site si nécessaire.
5) Confirmer avec un récapitulatif premium:
   - motif général
   - date/heure
   - site
   - contact
   - “Vous recevrez une confirmation…”
6) Si besoin: créer action JSON.

FORMAT DE SORTIE (obligatoire)
1) D’abord une réponse normale pour le patient (FR par défaut, mais si l’utilisateur écrit en EN, réponds en EN).
2) Ensuite, SI et seulement si une action doit être exécutée, ajoute un bloc JSON EXACTEMENT:

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
