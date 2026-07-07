const { sendCommand } = require("./rcon");

/**
 * Stockage PERSISTANT sur le SERVEUR MINECRAFT (via RCON, commande /discorddata).
 *
 * - Au demarrage : on charge chaque fichier depuis le serveur dans un cache
 *   memoire (init). Les lectures (readJson) sont donc synchrones et a jour.
 * - A chaque ecriture (writeJson) : on met le cache a jour puis on pousse vers
 *   le serveur en tache de fond (chunke pour contourner la limite de taille
 *   d'une commande RCON, et serialise par fichier pour garder l'ordre).
 * - Securite anti-perte : si un fichier n'a PAS pu etre charge au boot (serveur
 *   injoignable), on NE POUSSE PAS (sinon on ecraserait les donnees serveur avec
 *   un cache vide). Le changement reste en memoire jusqu'au prochain demarrage.
 */

const MARKER = "[DISCORDDATA]";
const CHUNK = 1000; // caracteres base64 max par commande "part"

const cache = {}; // name -> objet JS
const loadedOk = {}; // name -> bool : true si l'etat serveur est connu (push sur)
const pushChain = {}; // name -> Promise : serialise les ecritures d'un meme fichier

function parseResponse(raw) {
  if (!raw) return null;
  const i = raw.indexOf(MARKER);
  if (i < 0) return null;
  return raw.slice(i + MARKER.length).trim();
}

function expectOk(raw, step) {
  const payload = parseResponse(raw);
  if (payload !== "ok") throw new Error(`${step}: reponse=${JSON.stringify(raw)}`);
}

/** Charge un fichier depuis le serveur dans le cache (plusieurs essais). */
async function loadFile(name, attempts = 5) {
  for (let a = 1; a <= attempts; a++) {
    try {
      const payload = parseResponse(await sendCommand(`discorddata get ${name}`));
      if (payload === null) throw new Error("reponse sans " + MARKER);
      if (payload === "empty") {
        cache[name] = {};
        loadedOk[name] = true;
        return;
      }
      if (payload.startsWith("error=")) throw new Error(payload);
      cache[name] = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
      loadedOk[name] = true;
      console.log(`[Storage] ${name} charge depuis le serveur (${Object.keys(cache[name]).length} entrees).`);
      return;
    } catch (e) {
      console.error(`[Storage] chargement ${name} echec (essai ${a}/${attempts}):`, e.message);
      if (a < attempts) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  cache[name] = cache[name] || {};
  loadedOk[name] = false;
  console.error(
    `[Storage] ${name} NON charge : ecritures gardees en memoire seulement ` +
      "(pas de push, pour ne pas ecraser les donnees du serveur)."
  );
}

/** A appeler au demarrage : charge tous les fichiers connus depuis le serveur. */
async function init(names) {
  for (const n of names) await loadFile(n);
}

function readJson(name) {
  return cache[name] || {};
}

function writeJson(name, data) {
  cache[name] = data;
  if (!loadedOk[name]) {
    console.warn(`[Storage] ${name} non synchronise avec le serveur : changement en memoire uniquement.`);
    return;
  }
  const prev = pushChain[name] || Promise.resolve();
  pushChain[name] = prev
    .then(() => pushFile(name))
    .catch((e) => console.error(`[Storage] push ${name} echoue:`, e.message));
}

/** Ecrit le cache d'un fichier sur le serveur : begin -> part* -> commit. */
async function pushFile(name) {
  const b64 = Buffer.from(JSON.stringify(cache[name]), "utf8").toString("base64");
  expectOk(await sendCommand(`discorddata begin ${name}`), "begin");
  for (let i = 0; i < b64.length; i += CHUNK) {
    expectOk(await sendCommand(`discorddata part ${name} ${b64.slice(i, i + CHUNK)}`), "part");
  }
  expectOk(await sendCommand(`discorddata commit ${name}`), "commit");
}

module.exports = { init, readJson, writeJson };
