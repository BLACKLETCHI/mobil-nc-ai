/**
 * /api/vehicle-image
 *
 * Proxy serveur pour Imagin.studio.
 *
 * Pourquoi : quand le navigateur appelle directement cdn.imagin.studio, certains
 * bloqueurs de pub (uBlock, Brave, AdBlock Plus) tuent silencieusement la requete
 * parce que le domaine ressemble a un CDN tiers. En passant par notre propre
 * domaine Vercel, la requete devient indetectable.
 *
 * Utilisation cote client :
 *   <img src="/api/vehicle-image?make=ford&modelFamily=fiesta&modelYear=2013&angle=23" />
 *
 * Mise en cache : on demande au navigateur ET au CDN Vercel de garder l'image
 * 24h pour eviter de re-taper Imagin a chaque chargement de page.
 */

export default async function handler(req, res) {
  // Seul GET autorise (c'est juste un proxy d'image)
  if (req.method !== "GET") {
    res.status(405).json({ error: "Methode non autorisee" });
    return;
  }

  // On reprend tous les parametres de la query et on les forward a Imagin.
  // On force juste customer=img (mode demo) -- quand on aura une vraie cle,
  // on la mettra dans process.env.IMAGIN_CUSTOMER_KEY.
  const params = new URLSearchParams();
  params.set("customer", process.env.IMAGIN_CUSTOMER_KEY || "img");

  // Whitelist des params qu'on accepte (securite : pas d'injection de params arbitraires)
  const ALLOWED = ["make", "modelFamily", "modelYear", "angle", "paintDescription", "bodySize", "trim"];
  for (const key of ALLOWED) {
    const val = req.query[key];
    if (val && typeof val === "string" && val.length < 100) {
      params.set(key, val);
    }
  }

  // Defauts raisonnables
  if (!params.has("angle")) params.set("angle", "23");

  const imaginUrl = "https://cdn.imagin.studio/getimage?" + params.toString();

  try {
    const upstream = await fetch(imaginUrl, {
      // User-Agent classique pour eviter d'etre filtre cote Imagin
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MobilNC/1.0; +https://mobil-nc-ai.vercel.app)",
        "Accept": "image/png,image/*",
      },
    });

    if (!upstream.ok) {
      // 404, 403, 5xx -> on renvoie une 404 propre cote client
      console.warn("[vehicle-image] Imagin a renvoye HTTP", upstream.status, "pour", imaginUrl);
      res.status(404).json({ error: "Image non disponible" });
      return;
    }

    // Recuperer le binaire et le streamer au client
    const contentType = upstream.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await upstream.arrayBuffer());

    // Cache agressif : 24h navigateur, 7 jours sur CDN Vercel (les photos auto ne changent pas)
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400");
    res.setHeader("Content-Length", String(buf.length));
    res.status(200).send(buf);
  } catch (err) {
    console.error("[vehicle-image] Erreur fetch Imagin :", err && err.message);
    res.status(502).json({ error: "Erreur upstream" });
  }
}
