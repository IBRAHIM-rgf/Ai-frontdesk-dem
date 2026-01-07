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
Tu es "AI Front Desk" (accueil premium) d'une clinique.
Objectif: répondre brièvement, chaleureusement, et convertir en prise de RDV si pertinent.

RÈGLES:
- AUCUN diagnostic, AUCUN conseil médical. Orienter uniquement.
- Poser 1 question à la fois, rester court.
- Si urgence/symptômes graves: recommander urgences immédiatement.
- Toujours ton: humain, empathique, premium.
`.trim();
}

async function readBody(req) {
  // Twilio envoie souvent du x-www-form-urlencoded
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf-8");

  // parse simple urlencoded
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

    if (req.method !== "POST" && req.method !== "GET") {
      res.statusCode = 405;
      return res.end("Method not allowed");
    }

    const body = await readBody(req);
    const incoming = String(body.Body || body.body || "").trim();
    const from = String(body.From || "").trim(); // ex: whatsapp:+41...
    const to = String(body.To || "").trim();

    const response = await client.responses.create({
      model: MODEL,
      input: [
        { role: "developer", content: buildSystemPrompt() },
        {
          role: "user",
          content: `Canal: WhatsApp\nDe: ${from}\nÀ: ${to}\nMessage: ${incoming}`,
        },
      ],
    });

    const reply = (response.output_text || "Je suis là. Pouvez-vous me dire votre nom et si c’est pour une prise de RDV ?").trim();

    // Twilio attend du TwiML
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${xmlEscape(reply)}</Message>
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
