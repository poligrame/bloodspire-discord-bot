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

module.exports = { sendCommand };
