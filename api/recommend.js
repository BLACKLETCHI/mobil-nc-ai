/**
 * /api/recommend
 *
 * Endpoint serverless Vercel — appelle Claude API pour recommander
 * une huile Mobil adaptee au vehicule, AVEC garde-fous deterministes.
 *
 * Architecture :
 *   1. Validation de l'entree (refuse les inputs absurdes)
 *   2. Appel Claude (Haiku par defaut, rapide et peu cher)
 *   3. Validation de la sortie (verifie coherence energie/produit)
 *   4. Si l'IA echoue ou produit une reco incoherente -> fallback humain
 *
 * Variables d'environnement requises :
 *   ANTHROPIC_API_KEY : ta cle API Anthropic
 *   ANTHROPIC_MODEL   : (optionnel) modele a utiliser, defaut "claude-haiku-4-5-20251001"
 *
 * Body attendu (JSON, POST) :
 *   {
 *     marque: string,       // ex: "PEUGEOT"
 *     modele: string,       // ex: "208 1.2 PURETECH"
 *     annee: number,        // ex: 2019
 *     energie: string,      // code: "ES", "GO", "EL", "EH", "EE", "GH", ...
 *     energieLabel: string, // ex: "Essence"
 *     cylindree: number,    // cm3
 *     genreLabel: string,   // ex: "VP", "CTTE", "MTL", "CAM"
 *     genreCode: string     // ex: "VP"
 *   }
 *
 * Reponse (JSON, 200) :
 *   {
 *     product, grade, type, vidange, reason,
 *     alternatives: string[], specs, explain,
 *     _meta: { source: "ai" | "fallback", confidence: "high"|"medium"|"low" }
 *   }
 */

import { Anthropic } from "@anthropic-ai/sdk";

// ============================================================================
// 1) CATALOGUE PRODUITS AUTORISES (source de verite Mobil NC 2026)
// ============================================================================
// L'IA ne peut recommander QUE des produits de cette liste. Toute sortie
// avec un produit hors catalogue -> rejetee -> fallback humain.

const CATALOGUE = {
  "Mobil 1 ESP": {
    grades: ["5W-30"],
    usages: ["essence_moderne", "diesel_fap", "hybride"],
    interdits: ["moto", "camion", "electrique"],
  },
  "Mobil Super FF": {
    grades: ["10W-40", "15W-40"],
    usages: ["essence", "diesel_ancien"],
    interdits: ["moto", "camion", "electrique", "diesel_fap_recent"],
  },
  "Mobil Super Moto 4T": {
    grades: ["10W-40"],
    usages: ["moto_4t"],
    interdits: ["voiture", "camion", "moto_2t", "electrique"],
  },
  "Mobil 1 Racing 4T": {
    grades: ["15W-50"],
    usages: ["moto_4t_sport"],
    interdits: ["voiture", "camion", "moto_2t", "electrique"],
  },
  "Mobil 1 Racing 2T": {
    grades: ["TC"],
    usages: ["moto_2t"],
    interdits: ["voiture", "camion", "moto_4t", "electrique"],
  },
  "Mobil Extra 2T": {
    grades: ["TC"],
    usages: ["moto_2t"],
    interdits: ["voiture", "camion", "moto_4t", "electrique"],
  },
  "Delvac XHP ESP": {
    grades: ["10W-40"],
    usages: ["camion_moderne", "diesel_industriel_euro5_6"],
    interdits: ["voiture_essence", "moto", "electrique"],
  },
  "Delvac Moderne": {
    grades: ["15W-40"],
    usages: ["camion", "diesel_industriel"],
    interdits: ["voiture_essence", "moto", "electrique"],
  },
  "Delvac 1": {
    grades: ["5W-40"],
    usages: ["camion_severe", "diesel_industriel_premium"],
    interdits: ["voiture_essence", "moto", "electrique"],
  },
  "Mobil ATF 220": {
    grades: ["—"],
    usages: ["transmission_automatique"],
    interdits: ["moteur"],
  },
  "Pas d'huile moteur": {
    grades: ["—"],
    usages: ["electrique_pur"],
    interdits: [],
  },
};

// ============================================================================
// 2) VALIDATION DE L'ENTREE
// ============================================================================

function validateInput(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Body manquant ou invalide" };
  }
  // Marque + modele sont les seuls champs strictement requis.
  // Le reste peut etre absent (vehicule mal renseigne dans le registre NC).
  if (!body.marque || typeof body.marque !== "string") {
    return { ok: false, error: "Marque manquante" };
  }
  if (!body.modele || typeof body.modele !== "string") {
    return { ok: false, error: "Modele manquant" };
  }
  // Annee plausible
  if (body.annee !== undefined && body.annee !== null) {
    const y = Number(body.annee);
    if (!Number.isFinite(y) || y < 1950 || y > new Date().getFullYear() + 1) {
      return { ok: false, error: "Annee implausible" };
    }
  }
  return { ok: true };
}

// ============================================================================
// 3) CLASSIFICATION DU VEHICULE (deterministe, basee sur les codes officiels)
// ============================================================================
// On extrait ici un "profil" simple qui sera ensuite utilise pour valider
// la sortie de l'IA. C'est NOTRE source de verite sur l'energie du vehicule.

function classifyVehicle(v) {
  const code = String(v.energie || "").toUpperCase();
  const genreCode = String(v.genreCode || "").toUpperCase();
  const modele = String(v.modele || "").toLowerCase();

  // Energie -- codes officiels carte grise francaise / NC
  const ESSENCE_CODES = ["ES", "EG", "EM", "EP", "EQ", "ER", "ET", "EE", "EH"];
  const DIESEL_CODES = ["GO", "GA", "GH", "GE", "GL", "GN", "GP", "GQ"];
  const ELECTRIQUE_CODES = ["EL"];

  let energie = "inconnue";
  if (ELECTRIQUE_CODES.includes(code)) energie = "electrique";
  else if (DIESEL_CODES.includes(code)) energie = "diesel";
  else if (ESSENCE_CODES.includes(code)) energie = "essence";

  // Hybrides (essence + electrique le plus souvent)
  const isHybride = ["EE", "EH", "GH"].includes(code);

  // Cas particulier : si l'energie est inconnue mais le modele crie "diesel"
  // (HDi, TDi, dCi, CRDi, D-4D...) on infere diesel.
  if (energie === "inconnue") {
    if (/\b(hdi|tdi|dci|cdi|crdi|d-?4d|bluedci|bluehdi|tdci|jtd|cdti|tdv|sdi)\b/i.test(modele)) {
      energie = "diesel";
    }
  }

  // Genre
  const isMoto = /^(MTL|MTT|CL|MTM)$/.test(genreCode);
  const isCamion = /^(CAM|TRA|TCP|VASP)$/.test(genreCode);
  const isCamionnette = /^(CTTE|DERIV-VP)$/.test(genreCode);
  // Une CTTE est une derivee VP -> elle suit l'energie de sa motorisation,
  // PAS la regle "camion -> Delvac" (c'etait le bug initial).

  return {
    energie,         // "essence" | "diesel" | "electrique" | "inconnue"
    isHybride,
    isMoto,
    isCamion,        // vrai camion / poids lourd
    isCamionnette,   // vehicule utilitaire leger (VUL) -- suit regles voiture
    annee: Number(v.annee) || null,
    cylindree: Number(v.cylindree) || null,
  };
}

// ============================================================================
// 4) PROMPT CLAUDE
// ============================================================================

function buildPrompt(vehicle, profile) {
  const catalogueDesc = Object.entries(CATALOGUE)
    .map(([nom, info]) => `- "${nom}" (grades: ${info.grades.join(", ")}) -- usages: ${info.usages.join(", ")}`)
    .join("\n");

  return `Tu es expert lubrifiants Mobil pour le marche Nouvelle-Caledonie.

ROLE : recommander UN seul produit Mobil parmi le catalogue ci-dessous, pour le vehicule decrit. Tu dois t'appuyer sur les preconisations OFFICIELLES du constructeur (normes ACEA, API, et homologations OEM type BMW LL-04, MB 229.51, VW 504/507, etc.) que tu connais.

VEHICULE A EQUIPER :
- Marque  : ${vehicle.marque}
- Modele  : ${vehicle.modele}
- Annee   : ${vehicle.annee ?? "inconnue"}
- Energie : ${profile.energie} (code carte grise: ${vehicle.energie || "?"})${profile.isHybride ? " [HYBRIDE]" : ""}
- Genre   : ${vehicle.genreLabel || vehicle.genreCode || "?"} ${profile.isMoto ? "[MOTO]" : ""}${profile.isCamion ? "[CAMION]" : ""}${profile.isCamionnette ? "[VUL]" : ""}
- Cylindree : ${profile.cylindree ? profile.cylindree + " cm3" : "?"}

CATALOGUE DISPONIBLE (tu DOIS choisir un produit de cette liste) :
${catalogueDesc}

REGLES ABSOLUES, NON-NEGOCIABLES :
1. L'energie du moteur prime sur TOUT le reste. Jamais d'huile diesel (Delvac, Mobil 1 ESP avec norme C2/C3 specifique) sur un moteur essence, et vice-versa.
2. Une "camionnette" (CTTE / utilitaire leger) suit les regles VOITURE selon son energie -- ce N'EST PAS un camion. Seuls les vrais poids lourds (CAM/TRA) prennent du Delvac.
3. Si tu N'ES PAS SUR a 95%+ de la preconisation constructeur exacte pour ce modele/motorisation/annee, mets confidence = "low" et explique pourquoi -- le systeme renverra alors le client vers un conseiller humain.
4. Pour un diesel >= 2010 equipe FAP/CAT -> Mobil 1 ESP 5W-30 (Low SAPS C2/C3). Pour un diesel ancien sans FAP -> Mobil Super FF (essence-diesel mixte). Confirme via la norme constructeur que tu connais.
5. Pour un essence moderne (post-2015) avec norme constructeur exigeant 5W-30 synthetique -> Mobil 1 ESP 5W-30 si compatible essence (ACEA C2/C3 + API SN/SP).

REPONDS UNIQUEMENT EN JSON VALIDE, sans markdown, sans backticks, sans texte avant ou apres. Format strict :

{
  "product": "<nom EXACT du catalogue>",
  "grade": "<grade EXACT du catalogue>",
  "type": "<ex: 100 % synthetique, Semi-synthetique...>",
  "vidange": "<ex: Jusqu'a 15 000 km>",
  "reason": "<1-2 phrases, raison technique courte>",
  "alternatives": ["<produit alternatif 1>", "<produit alternatif 2>"],
  "specs": "<normes ACEA/API/OEM separees par tirets>",
  "explain": "<2-3 phrases pour le client, vulgarise, expliquant POURQUOI ce produit et la preconisation constructeur sur laquelle tu te bases>",
  "confidence": "high" | "medium" | "low",
  "confidence_reason": "<si low ou medium : explique pourquoi tu n'es pas sur>"
}`;
}

// ============================================================================
// 5) VALIDATION DE LA SORTIE IA (la table deterministe)
// ============================================================================
// C'est la couche critique : meme si Claude hallucine, on bloque ici.

function validateAIResponse(reco, profile) {
  if (!reco || typeof reco !== "object") {
    return { ok: false, reason: "Reponse IA non-JSON ou vide" };
  }
  // 1. Produit doit etre dans le catalogue
  if (!CATALOGUE[reco.product]) {
    return { ok: false, reason: `Produit "${reco.product}" hors catalogue Mobil NC` };
  }
  // 2. Grade doit etre dans la liste autorisee pour ce produit
  const allowedGrades = CATALOGUE[reco.product].grades;
  if (!allowedGrades.includes(reco.grade)) {
    return { ok: false, reason: `Grade "${reco.grade}" invalide pour ${reco.product} (autorises: ${allowedGrades.join(", ")})` };
  }

  // 3. Coherence energie <-> produit (LE GARDE-FOU PRINCIPAL)
  const usages = CATALOGUE[reco.product].usages;
  const interdits = CATALOGUE[reco.product].interdits;

  if (profile.energie === "electrique" && reco.product !== "Pas d'huile moteur") {
    return { ok: false, reason: "Vehicule electrique -> aucune huile moteur" };
  }
  if (profile.energie === "essence" && interdits.some(i => i.includes("essence") || i === "diesel" || i === "voiture_essence")) {
    // Verification fine : un produit "diesel only" est interdit sur essence
    const dieselOnly = usages.every(u => u.includes("diesel") || u.includes("camion") || u.includes("industriel"));
    if (dieselOnly && !usages.some(u => u.includes("essence"))) {
      return { ok: false, reason: `Produit "${reco.product}" est diesel-only, vehicule essence` };
    }
  }
  if (profile.energie === "diesel" && reco.product.startsWith("Mobil Super FF") && profile.annee && profile.annee >= 2012) {
    // Mobil Super FF (ACEA A3/B3) n'est PAS Low SAPS donc destructeur pour FAP.
    // Tolere uniquement diesel ancien sans FAP.
    return { ok: false, reason: "Diesel post-2012 = FAP probable, Super FF (non Low SAPS) interdit" };
  }
  if (profile.isMoto && !usages.some(u => u.startsWith("moto"))) {
    return { ok: false, reason: "Vehicule moto -> produit non-moto recommande" };
  }
  if (profile.isCamion && !usages.some(u => u.includes("camion") || u.includes("industriel"))) {
    return { ok: false, reason: "Vrai camion -> produit non-PL recommande" };
  }
  if (profile.isCamionnette && profile.energie === "essence" && reco.product.startsWith("Delvac")) {
    // C'EST EXACTEMENT LE BUG ORIGINAL : on le bloque ici.
    return { ok: false, reason: "Camionnette essence + Delvac (huile diesel) : INTERDIT" };
  }

  // 4. Champs obligatoires presents
  for (const field of ["type", "vidange", "reason", "specs", "explain"]) {
    if (!reco[field] || typeof reco[field] !== "string") {
      return { ok: false, reason: `Champ "${field}" manquant ou invalide` };
    }
  }
  if (!Array.isArray(reco.alternatives)) {
    reco.alternatives = [];
  }

  // 5. Confiance basse -> on bascule en fallback humain meme si tout est coherent
  if (reco.confidence === "low") {
    return { ok: false, reason: `IA peu confiante : ${reco.confidence_reason || "raison non precisee"}` };
  }

  return { ok: true };
}

// ============================================================================
// 6) FALLBACK HUMAIN (zero risque)
// ============================================================================

function humanFallback(reason) {
  return {
    product: "Recommandation personnalisee requise",
    grade: "—",
    type: "Conseil expert",
    vidange: "—",
    reason: "Pour ce vehicule, nous preferons vous orienter vers un conseiller plutot que de risquer une mauvaise recommandation.",
    alternatives: [],
    specs: "—",
    explain:
      "Notre systeme privilegie la securite de votre moteur : si la moindre incertitude existe sur la preconisation constructeur exacte, nous vous redirigeons vers nos conseillers Mobil NC qui valideront le produit adapte. Contactez-nous avec votre carte grise et votre carnet d'entretien.",
    _meta: { source: "fallback", confidence: "low", reason },
  };
}

// ============================================================================
// 7) HANDLER VERCEL
// ============================================================================

export default async function handler(req, res) {
  // CORS / methode
  if (req.method !== "POST") {
    res.status(405).json({ error: "Methode non autorisee. Utilise POST." });
    return;
  }

  // Cle API obligatoire cote serveur
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY non configuree sur le serveur" });
    return;
  }

  // Validation entree
  const body = req.body;
  const validation = validateInput(body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  // Classification deterministe du vehicule
  const profile = classifyVehicle(body);

  // Court-circuit : electrique pur -> pas d'IA, reponse fixe
  if (profile.energie === "electrique" && !profile.isHybride) {
    res.status(200).json({
      product: "Pas d'huile moteur",
      grade: "—",
      type: "Vehicule electrique",
      vidange: "Selon preconisation constructeur",
      reason: "Vehicule 100 % electrique : pas de moteur thermique a lubrifier.",
      alternatives: ["Liquide de refroidissement specifique", "Mobil ATF 220 (boite auto si applicable)"],
      specs: "—",
      explain:
        "Les vehicules entierement electriques n'ont pas de moteur a combustion. Seuls les fluides de refroidissement et, parfois, une huile de reducteur sont a entretenir selon les preconisations du constructeur.",
      _meta: { source: "deterministic", confidence: "high" },
    });
    return;
  }

  // Court-circuit : energie totalement inconnue + pas de signal modele -> fallback direct
  if (profile.energie === "inconnue") {
    res.status(200).json(humanFallback("Energie du vehicule non identifiable dans le registre NC"));
    return;
  }

  // Appel Claude
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

  let aiReco;
  try {
    const completion = await client.messages.create({
      model,
      max_tokens: 1024,
      temperature: 0, // deterministe au max
      messages: [{ role: "user", content: buildPrompt(body, profile) }],
    });

    const text = completion.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("")
      .trim();

    // L'IA est priee de repondre en JSON pur. Si elle ajoute des backticks, on nettoie.
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    aiReco = JSON.parse(cleaned);
  } catch (err) {
    console.error("[recommend] Erreur Claude/JSON :", err && err.message);
    res.status(200).json(humanFallback("Erreur lors de l'appel IA : " + (err && err.message ? err.message : "inconnue")));
    return;
  }

  // Validation deterministe de la sortie IA
  const validOut = validateAIResponse(aiReco, profile);
  if (!validOut.ok) {
    console.warn("[recommend] Reco IA rejetee :", validOut.reason, "| reco:", JSON.stringify(aiReco));
    res.status(200).json(humanFallback("Validation IA echouee : " + validOut.reason));
    return;
  }

  // OK -> renvoie au client, en stripant les champs internes
  const { confidence, confidence_reason, ...publicReco } = aiReco;
  res.status(200).json({
    ...publicReco,
    _meta: {
      source: "ai",
      confidence: confidence || "medium",
      model,
    },
  });
}
