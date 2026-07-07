const { Rcon } = require("rcon-client");

/**
 * Ouvre une connexion RCON, envoie UNE commande, referme la connexion.
 * Une connexion par commande : plus lent qu'une connexion persistante mais
 * beaucoup plus robuste (pas de connexion "morte" a gerer si le serveur
 * redemarre) — largement suffisant pour un bot a faible volume comme celui-ci.
 */
async function sendCommand(command) {
  const rcon = await Rcon.connect({
    host: process.env.RCON_HOST,
    port: Number(process.env.RCON_PORT),
    password: process.env.RCON_PASSWORD,
    timeout: 5000,
  });

  try {
    const response = await rcon.send(command);
    return response;
  } finally {
    await rcon.end();
  }
}

module.exports = { sendCommand };
