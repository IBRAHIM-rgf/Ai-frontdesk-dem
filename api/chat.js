import OpenAI from "openai";

/**
 * /api/chat (Vercel)
 * Env requis: OPENAI_API_KEY
 * Env optionnel: OPENAI_MODEL (ex: gpt-4o-mini)
 */

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Créneaux "démo" (tu pourras remplacer par un vrai agenda plus tard)
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

function systemPrompt(vertical) {
  const type =
    vertical === "Dentaire"
      ? "cabinet dentaire"
      : vertical === "Esthétique"
      ? "clinique esthétique"
      : "clinique privée";

  return `
Tu es "AI Front Desk" pour un ${type} en Suisse.

OBJECTIF:
Convertir chaque demande en prise de RDV (ou replanifier/annuler) avec un ton premium, clair et court.

RÈGLES (obligatoires):
- ZÉRO diagnostic, ZÉRO conseils médicaux. Tu peux seulement orienter + organiser.
- Questions minimales: (1) Nom complet (2) Téléphone (3) Motif général (1 phrase) (4) Choix d’un créneau.
- Toujours proposer 2–3 créneaux parmi ceux fournis (ne pas inventer).
- Si urgence potentielle (douleur extrême + gonflement important, fièvre, saignement abondant, gêne respiratoire, trauma sévère):
  => recommander d’appeler les urgences / contacter la clinique immédiatement, puis proposer un rappel humain.
- Style: 3–6 lignes max. Pas de blabla. Tutoiement interdit. FR par défaut.

FORMAT DE SORTIE (très important):
1) Réponse patient (texte).
2) Ensuite, SEULEMENT si une action doit être exécutée, ajoute un bloc JSON:

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

Si aucune action n’est nécessaire, PAS de JSON.
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

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

    const slots = makeSlots(vertical);

    // On donne au modèle un contexte structuré + les créneaux
    const payload = {
      vertical,
      patient_known: patient,
      available_slots: slots,
      user_message: message,
      instruction: "Toujours proposer 2–3 créneaux (par label + ID). Demander ensuite: nom + téléphone + motif si pas déjà connus.",
    };

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
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
    return res.status(500).json({
      error: "server_error",
      message: String(err?.message || err),
    });
  }
}
