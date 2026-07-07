const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "tickets.json");

/**
 * Etat persistant des tickets ouverts.
 * { "<channelId>": { type, ownerId, stage: "claude"|"staff", report, createdAt } }
 */
function load() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
}

function getTicket(channelId) {
  return load()[channelId] || null;
}

function setTicket(channelId, data) {
  const all = load();
  all[channelId] = data;
  save(all);
}

function removeTicket(channelId) {
  const all = load();
  delete all[channelId];
  save(all);
}

/** Tickets ouverts appartenant a un membre (pour eviter le spam). */
function listByOwner(ownerId) {
  const all = load();
  return Object.entries(all)
    .filter(([, t]) => t.ownerId === ownerId)
    .map(([channelId, t]) => ({ channelId, ...t }));
}

module.exports = { getTicket, setTicket, removeTicket, listByOwner };
