# Mobil NC — V2 IA

Configurateur d'huile moteur Mobil pour le marche Nouvelle-Caledonie, **avec couche IA (Claude)** qui recupere les preconisations constructeur, encadree par une **table de validation deterministe** cote serveur.

Fork de [`deploy/`](../deploy) (V1, regles JS locales).

## Architecture

```
                  Navigateur client
                         |
                         | POST /api/recommend  { marque, modele, annee, energie, ... }
                         v
              +---------------------------+
              |  Vercel Serverless        |
              |  /api/recommend.js        |
              |                           |
              |  1. validateInput()       |   <-- refus immediat si input absurde
              |  2. classifyVehicle()     |   <-- profil deterministe (energie reelle)
              |  3. court-circuits :      |
              |     - electrique pur      |
              |     - energie inconnue    |
              |  4. appel Claude API      |
              |  5. validateAIResponse()  |   <-- garde-fou catalogue + coherence
              |  6. fallback humain si KO |
              +---------------------------+
                         |
                         v
                Reponse JSON typee
```

### Pourquoi pas juste l'IA toute seule ?

Parce que les LLM hallucinent. Sur un configurateur d'huile moteur, recommander une huile diesel a un client essence peut **casser son moteur**. La couche de validation deterministe (`CATALOGUE` + `validateAIResponse` dans `api/recommend.js`) garantit que **meme si Claude se trompe**, on ne sortira jamais une recommandation incoherente.

Les regles bloquantes incluses :
- Energie du moteur prime sur tout (jamais d'huile diesel sur essence, ou l'inverse).
- Une camionnette (CTTE) est traitee comme une voiture, pas comme un poids lourd.
- Diesel post-2012 -> obligation Low SAPS (ACEA C2/C3), Super FF interdit.
- Produit obligatoirement dans le catalogue Mobil NC 2026.
- Si Claude declare `confidence: "low"` -> fallback humain automatique.

Tout cas qui echoue une regle est redirige vers **"Contactez nos conseillers"** plutot que vers une mauvaise reco.

## Setup local

```bash
npm install
cp .env.example .env.local
# editer .env.local et coller ta cle ANTHROPIC_API_KEY
npx vercel dev
# -> http://localhost:3000
```

## Deploiement Vercel

1. Pousser le code sur GitHub (nouveau repo, **distinct** de `BLACKLETCHI/mobil-nc`).
2. Sur [vercel.com/new](https://vercel.com/new), importer le repo.
3. Dans **Settings > Environment Variables**, ajouter :
   - `ANTHROPIC_API_KEY` = ta cle (visible sur https://console.anthropic.com/settings/keys)
   - `ANTHROPIC_MODEL` = `claude-haiku-4-5-20251001` (optionnel)
4. Deployer. L'URL finale sera quelque chose comme `mobil-nc-ai.vercel.app`.

## Couts estimes (Claude Haiku 4.5)

| Appels / mois | Cout approximatif |
|---|---|
| 100 | < 0,05 USD |
| 1 000 | ~ 0,30 USD |
| 10 000 | ~ 3 USD |
| 100 000 | ~ 30 USD |

(Calcul : ~800 tokens d'entree + ~300 tokens de sortie par appel.)

## Maintenance du catalogue

Si Mobil ajoute / retire un produit du catalogue NC, editer l'objet `CATALOGUE` dans `api/recommend.js`. La structure :

```js
"Nom Produit Exact": {
  grades: ["10W-40", "15W-40"],          // grades autorises
  usages: ["essence", "diesel_ancien"],  // usages valides
  interdits: ["moto", "camion"],         // contextes interdits
}
```

## Suite a faire

- [ ] Suite de tests automatises (les 20 cas du test initial + 30 cas additionnels)
- [ ] Logging des recos en base (Vercel Postgres ou KV) pour audit
- [ ] Cache des reponses identiques (meme marque/modele/annee -> evite de re-payer l'IA)
- [ ] Page admin pour voir les fallbacks et identifier les vehicules a ajouter au catalogue
