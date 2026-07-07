const { readJson, writeJson } = require("./storage");

const FILE = "claims.json";

/** { "<discordUserId>": "<pseudoMinecraft>" } — persiste sur le Volume Railway. */
function load() {
  return readJson(FILE);
}

function save(claims) {
  writeJson(FILE, claims);
}

function getClaim(discordUserId) {
  return load()[discordUserId] || null;
}

function setClaim(discordUserId, pseudo) {
  const claims = load();
  claims[discordUserId] = pseudo;
  save(claims);
}

function removeClaim(discordUserId) {
  const claims = load();
  delete claims[discordUserId];
  save(claims);
}

module.exports = { getClaim, setClaim, removeClaim };
