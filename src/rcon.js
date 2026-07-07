const { Rcon } = require("rcon-client");

/**
 * Ouvre une connexion RCON, envoie UNE commande, referme la connexion.
 * Une connexion par commande : plus lent qu'une connexion persistante mais
 * beaucoup plus robuste (pas de connexion "morte" a gerer si le serveur
 * redemarre) — largement suffisant pour un bot a faible volume comme celui-ci.
 *
 * On attache un handler 'error' AVANT de se connecter : sinon une erreur
 * socket asynchrone (ECONNRESET quand le serveur ferme la connexion — typique
 * d'un mauvais mot de passe RCON) remonte en "unhandledException" au lieu
 * d'etre rejetee proprement dans le try/catch de l'appelant.
 */
async function sendCommand(command) {
  const rcon = new Rcon({
    host: process.env.RCON_HOST,
    port: Number(process.env.RCON_PORT),
    password: process.env.RCON_PASSWORD,
    timeout: 5000,
  });

  // Avale les erreurs socket : elles sont deja propagees via le rejet de
  // connect()/send() ci-dessous. Sans ce listener, elles crashent le process.
  rcon.on("error", () => {});

  try {
    await rcon.connect();
    return await rcon.send(command);
  } finally {
    try {
      await rcon.end();
    } catch {
      /* deja ferme */
    }
  }
}

/**
 * Diagnostic RCON : tente une commande inoffensive et traduit l'erreur brute
 * en verdict lisible. Lance au demarrage pour savoir tout de suite ce qui bloque.
 * @returns {Promise<{ok:boolean, verdict:string, detail:string, hint?:string}>}
 */
async function testConnection() {
  const host = (process.env.RCON_HOST || "").trim();
  const port = Number(process.env.RCON_PORT);
  if (!host || !Number.isInteger(port) || port <= 0) {
    return {
      ok: false,
      verdict: "config",
      detail: "RCON_HOST ou RCON_PORT manquant/invalide",
      hint: "Verifie les variables RCON_HOST et RCON_PORT.",
    };
  }
  if (!process.env.RCON_PASSWORD) {
    return {
      ok: false,
      verdict: "config",
      detail: "RCON_PASSWORD vide",
      hint: "Definis un mot de passe RCON (server.properties ET variable Railway).",
    };
  }

  try {
    const res = await sendCommand("list"); // commande vanilla inoffensive
    return { ok: true, verdict: "ok", detail: String(res).slice(0, 200) };
  } catch (e) {
    const blob = `${e.code || ""} ${e.message || ""}`;
    let verdict = "unknown";
    let hint = e.message || "erreur inconnue";
    if (/Authentication failed/i.test(blob)) {
      verdict = "auth";
      hint = "Mot de passe RCON incorrect : RCON_PASSWORD (Railway) doit etre IDENTIQUE a rcon.password (server.properties), et le serveur redemarre apres changement.";
    } else if (/Connection closed|ECONNRESET/i.test(blob)) {
      verdict = "closed";
      hint = "Le serveur ferme la connexion sans faire l'echange RCON : ce port n'est probablement PAS le RCON (tu vises le proxy/port de jeu de l'hebergeur), ou RCON n'est pas expose publiquement. Demande a ton hebergeur l'IP + le port RCON exacts.";
    } else if (/ECONNREFUSED/i.test(blob)) {
      verdict = "refused";
      hint = "Rien n'ecoute sur ce port : enable-rcon=false, mauvais port, ou RCON non demarre.";
    } else if (/ETIMEDOUT|Timeout/i.test(blob)) {
      verdict = "timeout";
      hint = "Un pare-feu bloque le port RCON (aucune reponse). Autorise le port cote hebergeur.";
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(blob)) {
      verdict = "dns";
      hint = "RCON_HOST introuvable : mauvais domaine/IP.";
    }
    return { ok: false, verdict, detail: e.message || String(e), hint };
  }
}

module.exports = { sendCommand, testConnection };
