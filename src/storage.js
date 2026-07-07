const fs = require("fs");
const path = require("path");

/**
 * Dossier de donnees PERSISTANT du bot.
 *
 * Sur Railway le systeme de fichiers est ephemere : tout est efface a chaque
 * redemarrage/redeploiement. Pour garder les claims de titre et l'etat des
 * tickets, on ecrit dans un DOSSIER MONTE SUR UN VOLUME RAILWAY.
 *
 *   - En prod (Railway) : ajouter un Volume monte sur /data, puis definir la
 *     variable DATA_DIR=/data. Les fichiers survivent alors aux redeploiements.
 *   - En local : par defaut ./data a la racine du bot (cree automatiquement).
 */
const DATA_DIR = (process.env.DATA_DIR || path.join(__dirname, "..", "data")).trim();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error("[Storage] Impossible de creer DATA_DIR:", DATA_DIR, e.message);
}

/** Chemin absolu d'un fichier de donnees dans le dossier persistant. */
function dataFile(name) {
  return path.join(DATA_DIR, name);
}

/** Lecture JSON tolerante (objet vide si absent/corrompu). */
function readJson(name) {
  const file = dataFile(name);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Ecriture JSON atomique (tmp + rename) pour ne jamais corrompre le fichier. */
function writeJson(name, data) {
  const file = dataFile(name);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

module.exports = { DATA_DIR, dataFile, readJson, writeJson };
