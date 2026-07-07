const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "claims.json");

/** { "<discordUserId>": "<pseudoMinecraft>" } */
function load() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(claims) {
  fs.writeFileSync(FILE, JSON.stringify(claims, null, 2), "utf8");
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
