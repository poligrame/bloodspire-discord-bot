const { readJson, writeJson } = require("./storage");

const FILE = "tickets.json";

/**
 * Etat persistant des tickets ouverts (survit aux redemarrages via le Volume).
 * { "<channelId>": { type, ownerId, stage: "claude"|"staff", report, createdAt, ... } }
 */
function load() {
  return readJson(FILE);
}

function save(data) {
  writeJson(FILE, data);
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
