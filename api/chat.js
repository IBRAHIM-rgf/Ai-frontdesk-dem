import OpenAI from "openai";

/**
 * Vercel Serverless Function: /api/chat
 * Env required: OPENAI_API_KEY
 * Optional: OPENAI_MODEL (ex: gpt-5.2)
 */

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

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
  const clinic =
    vertical === "Esthétique"
      ? "clinique esthétique premium"
      : vertical === "Dentaire"
        ? "cabinet/clinique dentaire premium"
        : "clinique multi-spécialités premium";

  return `
Tu es "AI Front Desk", la réceptionniste virtuelle d’une ${clinic}.
Ton objectif : accueillir, rassurer, qualifier la demande, puis proposer et confirmer un RDV.

STYLE (très important)
- Tu parles comme une vraie personne : chaleureux, naturel, très professionnel, concis.
- Tu poses UNE question à la fois (maximum 2 si vraiment nécessaire).
- Tu reformules brièvement pour montrer que tu as compris.

SÉCURITÉ / MÉDICAL
- ZÉRO diagnostic et ZÉRO conseil médical.
- Tu peux orienter (urgence -> urgences) sans interprétation médicale.
- Si urgence vitale / douleur extrême / saignement important / malaise : recommander urgences / appeler 144 (CH) et proposer transfert humain.

DONNÉES À COLLECTER (minimum)
- Nom + téléphone
- Motif général (ex: douleur dentaire, contrôle, esthétique…)
- Site (si nécessaire)
- Un créneau parmi ceux fournis

RÈGLES RDV
- Toujours proposer 2–3 créneaux parmi "available_slots".
- Quand l’utilisateur choisit un créneau : confirmer + demander les infos manquantes (nom/téléphone).
- Si plainte/litige/avocat/incident : créer un ticket handoff humain.

FORMAT DE SORTIE OBLIGATOIRE
1) Réponse normale au patient (FR).
2) Puis UNIQUEMENT si une action doit être exécutée, ajoute EXACTEMENT un bloc JSON:

\`\`\`json
{
  "actions":[
    {
      "type":"create_appointment",
      "patient_name":"...",
      "phone":"+41...",
      "reason":"...",
      "datetime":"YYYY-MM-DDTHH:MM",
      "site":"Site A|Site B|"
    }
  ]
}
\`\`\`

Actions possibles:
- create_appointment
- reschedule_appointment (appointment_id + new_datetime)
- cancel_appointment (appointment_id)
- create_ticket (topic, priority, patient_name, phone)

Si aucune action n’est nécessaire, ne mets PAS de JSON.
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

export default async function handler(req, res) {
  try {
    // CORS (utile si tu appelles l’API depuis un autre domaine)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405


