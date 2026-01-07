import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function xmlEscape(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildSystemPrompt() {
  return `
Tu es "AI Front Desk" au téléphone (voix). Ton rôle: accueil premium, empathique, très naturel.
- Réponses très courtes (1–2 phrases).
- AUCUN diagnostic ni conseil médical.
- Si urgence: dire d'appeler les urgences immédiatement.
- Toujours finir par une question simple (ex: "Quel est votre nom ?" / "Vous préférez quel créneau ?").
`.trim();
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf-8");

  const obj = {};
  raw.split("&").forEach((pair) => {
    const [k, v] = pair.split("=");
    if (!k) return;
    obj[decodeURIComponent(k)] = decodeURIComponent((v || "").replaceAll("+", " "));
  });
  return obj;
}

export default async function handler(req, res) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      return res.end("Missing OPENAI_API_KEY");
    }

    const body = await readBody(req);

    // Twilio <Gather> renvoie souvent SpeechResult
    const speech = String(body.SpeechResult || "").trim();
    const digits = String(body.Digits || "").trim();

    let userText = speech || (digits ? `Le client a tapé: ${digits}` : "");

    // Si c'est le tout premier hit (pas encore de SpeechResult), on lance un Gather
    if (!userText) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Lea" language="fr-FR">${xmlEscape(
    "Bonjour, ici l’accueil. Dites-moi en quelques mots ce que je peux faire pour vous."
  )}</Say>
  <Gather input="speech" language="fr-FR" action="/api/voice" method="POST" timeout="5" speechTimeout="auto">
    <Say voice="Polly.Lea" language="fr-FR">${xmlEscape("Je vous écoute.")}</Say>
  </Gather>
  <Say voice="Polly.Lea" language="fr-FR">${xmlEscape("Je n’ai pas bien entendu. Pouvez-vous répéter ?")}</Say>
</Response>`;

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/xml");
      return res.end(twiml);
    }

    const ai = await client.responses.create({
      model: MODEL,
      input: [
        { role: "developer", content: buildSystemPrompt() },
        { role: "user", content: `Appel téléphone. Message client: ${userText}` },
      ],
    });

    let reply = (ai.output_text || "").trim();
    if (!reply) reply = "Merci. Quel est votre nom, s’il vous plaît ?";

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Lea" language="fr-FR">${xmlEscape(reply)}</Say>
  <Gather input="speech" language="fr-FR" action="/api/voice" method="POST" timeout="5" speechTimeout="auto">
    <Say voice="Polly.Lea" language="fr-FR">${xmlEscape("Je vous écoute.")}</Say>
  </Gather>
</Response>`;

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/xml");
    return res.end(twiml);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain");
    return res.end(String(e?.message || e));
  }
}
