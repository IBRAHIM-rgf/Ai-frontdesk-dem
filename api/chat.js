// api/chat.js
// POST /api/chat
// Env: OPENAI_API_KEY
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
      id: "S" + (i + 1),
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

function extractJsonBlock(text) {
  const re = /```json\s*([\s\S]*?)\s*```/g;
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) last = match[1];
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch (e) {
    return null;
  }
}

function stripJsonBlock(text) {
  return String(text || "").replace(/```json[\s\S]*?```/g, "").trim();
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        resolve({ message: data });
      }
    });
    req.on("error", reject);
  });
}

function buildSystemPrompt(vertical) {
  const brand =
    vertical === "Esthétique"
      ? "une clinique esthétique"
      : vertical === "Dentaire"
      ? "un cabinet dentaire"
      : "une clinique multi-spécialités";

  const jsonExample = [
    "```json",
    "{",
    '  "actions":[',
    '    {"type":"create_appointment","patient_name":"...","phone":"+41...","reason":"...","datetime":"YYYY-MM-DDTHH:MM","site":"Site A|Site B|"}',
    "  ]",
    "}",
    "```",
  ].join("\n");

  return [
    'Tu es "AI Front Desk", concierge d’accueil chaleureux et premium, comme une vraie personne, pour ' +
      brand +
      ".",
    "",
    "OBJECTIF: convertir en RDV, replanifier/annuler, ou escalader à un humain.",
    "",
    "RÈGLES:",
    "- Aucun diagnostic, aucun conseil médical, aucun traitement.",
    "- Collecte minimale: nom, téléphone, motif général, site (si multi), créneau.",
    "- Si urgence vitale/symptômes graves: recommander urgences + créer un ticket humain.",
    "- Litige/avocat/incident grave: créer un ticket humain.",
    "- Toujours proposer 2–3 créneaux (ceux fournis), demander un choix.",
    "",
    "FORMAT DE SORTIE:",
    "1) Réponse patient (FR), courte, empathique, premium.",
    "2) Si et seulement si une action est nécessaire, ajoute EXACTEMENT un bloc JSON comme ci-dessous:",
    jsonExample,
    "",
    "Actions possibles: create_appointment, reschedule_appointment, cancel_appointment, create_ticket.",
  ].join("\n");
}

export default async function handler(req, res) {
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
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    const vertical = String(body.vertical || "Dentaire");
    const state = body.state || {};
    const patient = state.patient || { name: "", phone: "" };
    const appointments = Array.isArray(state.appointments) ? state.appointments : [];
    const tickets = Array.isArray(state.tickets) ? state.tickets : [];

    const slots = makeSlots(vertical);

    const payload = {
      vertical: vertical,
      patient_known: patient,
      available_slots: slots,
      existing_appointments: appointments,
      existing_tickets: tickets,
      user_message: message,
      instructions:
        "Pour déplacer/annuler, demande à l'utilisateur de copier l'ID depuis la colonne 'ID' (Agenda).",
    };

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        temperature: 0.45,
        messages: [
          { role: "system", content: buildSystemPrompt(vertical) },
          { role: "user", content: JSON.stringify(payload, null, 2) },
        ],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "openai_error", status: r.status, message: t });
    }

    const data = await r.json();
    const raw = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";

    const json = extractJsonBlock(raw);
    const reply = stripJsonBlock(raw);

    return res.status(200).json({
      reply: reply,
      actions: (json && json.actions) ? json.actions : [],
      slots: slots,
    });
  } catch (err) {
    return res.status(500).json({ error: "server_error", message: String(err && err.message ? err.message : err) });
  }
}

