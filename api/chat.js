import OpenAI from "openai";

/**
 * /api/chat (Vercel)
 * Env requis: OPENAI_API_KEY
 * Env optionnel: OPENAI_MODEL (ex: gpt-4o-mini)
 */

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/** Créneaux démo (remplaçables plus tard par un vrai agenda) */
function makeSlots(vertical) {
  const now = new Date();
  const base = new Date(now.getTime() + 24 * 60 * 60 * 1000); // demain
  base.setMinutes(0, 0, 0);

  const hours =
    vertical === "Dentaire" ? [9, 11, 15, 17, 10, 16] :
    vertical === "Esthétique" ? [12, 14, 18, 11, 16, 19] :
    [9, 11, 14, 16, 10, 17];

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

/** Prompt ultra premium + humain */
function systemPrompt(vertical) {
  const type =
    vertical === "Dentaire" ? "cabinet dentaire" :
    vertical === "Esthétique" ? "clinique esthétique" :
    "clinique privée";

  return `
Tu es "AI Front Desk", l'assistant(e) d'accueil d'un ${type} haut de gamme en Suisse.

BUT:
- Accueillir comme une vraie personne (chaleureux, naturel, premium), puis convertir en RDV.
- Gérer: prise de RDV / replanification / annulation / transfert humain.

STYLE (ultra important):
- Son humain: phrases courtes, polies, naturelles. Pas robotique. Pas de listes longues.
- 3 à 7 lignes max. Une seule question à la fois.
- Tu peux utiliser 1 petite formule empathique ("Je comprends", "D’accord") mais sans dramatiser.
- Vouvoyer toujours. Ton premium: sobre, rassurant, efficace.
- Jamais de jargon.

RÈGLES SÉCURITÉ:
- ZÉRO diagnostic, ZÉRO conseil médical. Tu peux seulement orienter + organiser.
- Si urgence potentielle (douleur extrême + gonflement important, fièvre élevée, saignement abondant, gêne respiratoire, traumatisme sévère):
  => recommander de contacter les urgences / la clinique immédiatement + proposer transfert humain.
- Si plainte/litige/avocat/incident grave:
  => créer un ticket "handoff humain".

LOGIQUE RDV (très important):
- Toujours proposer 2–3 créneaux parmi "available_slots" (ne jamais inventer).
- Objectif: obtenir exactement ces infos (minimales):
  1) Nom complet
  2) Téléphone
  3) Motif général (1 phrase)
  4) Créneau choisi (par ID ou par le libellé)
- Si l'utilisateur a déjà donné une info, ne la redemande pas.
- Une seule question à la fois:
  - d'abord: proposer créneaux + demander lequel
  - ensuite: nom
  - ensuite: téléphone
  - ensuite: motif (si manquant)
- Quand tout est prêt: confirmer brièvement et déclencher create_appointment.

FORMAT DE SORTIE (obligatoire):
1) Réponse patient (texte).
2) Ensuite, SEULEMENT si action à exécuter, ajouter un bloc JSON EXACT:

\`\`\`json
{
  "actions":[
    {"type":"create_appointment","patient_name":"...","phone":"+41...","reason":"...","datetime":"YYYY-MM-DDTHH:MM","site":""}
  ]
}
\`\`\`

Actions possibles:
- create_appointment
- reschedule_appointment (requires appointment_id + new_datetime)
- cancel_appointment (requires appointment_id)
- create_ticket (requires topic, priority, patient_name, phone)

Si aucune action n’est nécessaire => PAS de JSON.
`.trim();
}

function extractJsonBlock(text) {
  const re = /```json\s*([\s\S]*?)\s*```/g;
  let match, last = null;
  while ((match = re.exec(text)) !== null) last = match[1];
  if (!last) return null;
  try { return JSON.parse(last); } catch { return null; }
}

function stripJsonBlock(text) {
  return (text || "").replace(/```json[\s\S]*?```/g, "").trim();
}

export default async function handler(req, res) {
  // CORS simple (démo)
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

  try {
    const body = req.body || {};
    const message = String(body.message || "");
    const vertical = String(body.vertical || "Dentaire"); // "Dentaire" | "Esthétique" | "Clinique"
    const state = body.state || {};
    const patient = state.patient || { name: "", phone: "" };
    const appointments = Array.isArray(state.appointments) ? state.appointments : [];
    const tickets = Array.isArray(state.tickets) ? state.tickets : [];

    const slots = makeSlots(vertical);

    const payload = {
      vertical,
      patient_known: patient,
      available_slots: slots,
      existing_appointments: appointments,
      existing_tickets: tickets,
      user_message: message,
      reminder: "Propose 2–3 créneaux (avec ID). Pose 1 seule question à la fois. Ton premium et humain.",
    };

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.35, // plus naturel, sans perdre la structure
      messages: [
        { role: "system", content: systemPrompt(vertical) },
        { role: "user", content: JSON.stringify(payload, null, 2) },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "";
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
