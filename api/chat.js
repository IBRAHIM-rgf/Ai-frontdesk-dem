import OpenAI from "openai";

export default async function handler(req, res) {
  // Autorise CORS simple (utile si un jour tu appelles depuis un autre domaine)
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
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const body = req.body || {};
    const message = String(body.message || "");
    const vertical = String(body.vertical || "Dentaire");

    // Modèle fiable & économique pour une démo
    const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const system = `
Tu es "AI Front Desk" pour une clinique (${vertical}).
Objectif: répondre clairement + proposer un rendez-vous.
Règles:
- Pas de diagnostic, pas de conseils médicaux.
- Si urgence (douleur intense + gonflement + fièvre, saignement important, détresse) => recommander urgences.
Style: clair, court, premium.
`.trim();

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message },
      ],
    });

    const reply = (completion.choices?.[0]?.message?.content || "").trim();

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("OpenAI error:", err);

    // Pour voir l’erreur exacte dans les logs Vercel
    const msg =
      err?.error?.message ||
      err?.message ||
      "Unknown error while calling OpenAI";

    return res.status(500).json({
      error: "openai_error",
      message: String(msg),
    });
  }
}
