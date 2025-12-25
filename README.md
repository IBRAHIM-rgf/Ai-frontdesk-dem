# AI Front Desk Demo — Vercel (Cyber Swiss IA style)

✅ Compatible Vercel : UI statique + Serverless Function /api/chat (stateless).

## 1) Local
```bash
npm install
# ajoute ta clé (mac/linux)
export OPENAI_API_KEY="..."
npm run dev
```
> Pour tester en local Vercel: `npx vercel dev` (recommandé).

## 2) Deploy sur Vercel
1. Pousse ce repo sur GitHub
2. Vercel → New Project → Import GitHub
3. Settings → Environment Variables → ajoute `OPENAI_API_KEY`
4. Deploy

Variables optionnelles:
- OPENAI_MODEL (ex: gpt-5.2)

## Démo rapide
- Dentaire: "J'ai mal à une dent"
- Esthétique: "Je veux une consultation botox"
- Clinique: "RDV dermato site A"

⚠️ IMPORTANT: Ne mets jamais la clé OpenAI dans le front (JS). Elle doit rester côté serveur (Vercel /api).
