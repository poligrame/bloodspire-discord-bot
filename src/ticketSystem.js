const {
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
} = require("discord.js");

const { TICKET_TYPES, buildSystemPrompt, isCheatBan } = require("./ticketConfig");
const { askClaude, usable: bedrockUsable } = require("./bedrock");
const { getTicket, setTicket, removeTicket, listByOwner } = require("./tickets");
const { sendCommand } = require("./rcon");

const PANEL_CHANNEL_ID = (process.env.PANEL_CHANNEL_ID || "").trim();
const TICKET_CATEGORY_ID = (process.env.TICKET_CATEGORY_ID || "").trim();
const LOG_CHANNEL_ID = (process.env.LOG_CHANNEL_ID || "").trim();
// Salon "demande-de-tickets" : le bot y poste les demandes d'ouverture de ticket
// humain, qu'un admin doit accepter/refuser. Defaut = le salon du panneau.
const REQUEST_CHANNEL_ID = (process.env.REQUEST_CHANNEL_ID || PANEL_CHANNEL_ID || "").trim();
const STAFF_IDS = (process.env.TICKET_STAFF_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const BRAND = 0xc0001a;
const PANEL_TITLE = "🎫 Ouvrir un ticket — BloodSpire";

/** Journalise un evenement dans le salon de logs admin (si configure). */
async function logEvent(client, { title, description, color }) {
  if (!LOG_CHANNEL_ID) return;
  const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setColor(color ?? BRAND)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
  await ch.send({ embeds: [embed] }).catch(() => {});
}

/** Normalise un ID de ban tape par le joueur : enleve #, espaces, minuscule. */
function normalizeBanId(raw) {
  return (raw || "").trim().replace(/^#/, "").replace(/\s+/g, "").toLowerCase();
}

/**
 * Interroge le serveur via RCON `baninfo <code>` et parse la reponse.
 * Format attendu (une ligne) :
 *   [BANINFO] found=true code=... player=... type=... active=true contestable=false category=cheat reason=...
 * @returns {Promise<{available:boolean, found:boolean, player?:string, active?:boolean,
 *   category?:string, contestable?:boolean, reason?:string}>}
 */
async function fetchBanInfo(code) {
  let raw;
  try {
    raw = await sendCommand(`baninfo ${code}`);
  } catch (e) {
    console.error("[Tickets] RCON baninfo echoue:", e.message);
    return { available: false, found: false };
  }
  if (!raw || !raw.includes("[BANINFO]")) {
    // Plugin sans la commande (ancienne version) ou reponse inattendue.
    return { available: false, found: false };
  }
  const line = raw.slice(raw.indexOf("[BANINFO]") + 9).trim();
  const out = { available: true, found: false };
  const reasonIdx = line.indexOf("reason=");
  const head = reasonIdx >= 0 ? line.slice(0, reasonIdx) : line;
  if (reasonIdx >= 0) out.reason = line.slice(reasonIdx + 7).trim();
  for (const tok of head.trim().split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq < 0) continue;
    const k = tok.slice(0, eq);
    const v = tok.slice(eq + 1);
    if (k === "found") out.found = v === "true";
    else if (k === "player") out.player = v;
    else if (k === "active") out.active = v === "true";
    else if (k === "category") out.category = v;
    else if (k === "contestable") out.contestable = v === "true";
  }
  return out;
}

/** Décide si un ban est contestable, en combinant serveur + mots-clefs locaux. */
function banContestable(info) {
  if (info.category === "cheat") return false;
  if (info.contestable === false) return false;
  if (isCheatBan(info.reason)) return false;
  return true;
}

// Anti-doublon de traitement d'un meme salon (messages concurrents).
const processing = new Set();

// ── Panneau d'ouverture ─────────────────────────────────────────────────────

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(PANEL_TITLE)
    .setDescription(
      "Besoin d'aide ? Choisis une catégorie ci-dessous. Un salon privé s'ouvre avec " +
        "**BloodBot**, notre assistant. Il répond aux questions simples et transmet à un " +
        "membre du staff si c'est nécessaire.\n\n" +
        "📋 **Candidature** — postuler au staff\n" +
        "🐛 **Signaler un bug** — un souci technique en jeu\n" +
        "🚨 **Signaler un joueur** — comportement / triche\n" +
        "⛔ **Contester un ban** — avec l'ID du ban + preuves solides"
    )
    .setFooter({ text: "BloodSpire • un seul ticket ouvert par catégorie" });
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    ...Object.entries(TICKET_TYPES).map(([key, cfg]) =>
      new ButtonBuilder()
        .setCustomId(`ticket_open:${key}`)
        .setLabel(cfg.label)
        .setEmoji(cfg.emoji)
        .setStyle(ButtonStyle[cfg.style] || ButtonStyle.Secondary)
    )
  );
}

/** Poste (ou reutilise) le panneau de tickets dans PANEL_CHANNEL_ID. */
async function ensurePanel(client, loadState, saveState) {
  if (!PANEL_CHANNEL_ID) {
    console.warn("[Tickets] PANEL_CHANNEL_ID non defini — panneau non poste.");
    return;
  }
  const channel = await client.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error("[Tickets] PANEL_CHANNEL_ID invalide ou pas un salon texte.");
    return;
  }
  // Railway a un systeme de fichiers ephemere : message-state.json est efface a
  // chaque redemarrage. On ne se fie donc PAS qu'au fichier — on scanne le salon
  // pour retrouver le panneau deja poste (et on supprime les doublons eventuels),
  // sinon le bot reposterait un panneau a chaque redemarrage.
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  let existing = null;
  if (recent) {
    const mine = [...recent.values()]
      .filter(
        (m) =>
          m.author.id === client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0].title === PANEL_TITLE
      )
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    existing = mine.shift() || null;
    for (const dup of mine) await dup.delete().catch(() => {}); // menage des doublons
  }

  if (existing) {
    // Remet les boutons/embed a jour au cas ou le code a change.
    await existing.edit({ embeds: [buildPanelEmbed()], components: [buildPanelRow()] }).catch(() => {});
    saveState({ ticketPanelId: existing.id });
    return;
  }

  const message = await channel.send({
    embeds: [buildPanelEmbed()],
    components: [buildPanelRow()],
  });
  saveState({ ticketPanelId: message.id });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sanitize(name) {
  return (name || "user")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20) || "user";
}

function overwriteType(guild, id) {
  return guild.roles.cache.has(id) ? OverwriteType.Role : OverwriteType.Member;
}

/** Un membre est-il staff (peut fermer un ticket humain) ? */
function isStaff(member) {
  if (!member) return false;
  if (
    member.permissions?.has(PermissionFlagsBits.ManageChannels) ||
    member.permissions?.has(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }
  return STAFF_IDS.some((id) => member.id === id || member.roles?.cache?.has(id));
}

function buildReport(type, answers) {
  const cfg = TICKET_TYPES[type];
  return cfg.questions
    .map((q) => `**${q.label}**\n${(answers[q.id] || "—").trim()}`)
    .join("\n\n");
}

// ── Boutons du salon Claude & du salon staff ────────────────────────────────

function claudeButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_human")
      .setLabel("Parler à un humain")
      .setEmoji("🙋")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ticket_close_resolved")
      .setLabel("Fermer (résolu)")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
  );
}

function staffButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("staff_close_request")
      .setLabel("Demander la fermeture")
      .setEmoji("🙋")
      .setStyle(ButtonStyle.Secondary)
  );
}

function staffConfirmButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("staff_close_confirm")
      .setLabel("Confirmer la fermeture")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
}

// ── Ouverture d'un ticket (modal -> salon Claude) ───────────────────────────

function buildModal(type) {
  const cfg = TICKET_TYPES[type];
  const modal = new ModalBuilder()
    .setCustomId(`ticket_modal:${type}`)
    .setTitle(cfg.modalTitle.slice(0, 45));
  for (const q of cfg.questions) {
    const input = new TextInputBuilder()
      .setCustomId(q.id)
      .setLabel(q.label.slice(0, 45))
      .setStyle(q.style === "Paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(q.required !== false);
    if (q.max) input.setMaxLength(q.max);
    if (q.min) input.setMinLength(q.min);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

async function handleOpenButton(interaction) {
  const type = interaction.customId.split(":")[1];
  if (!TICKET_TYPES[type]) return;

  // Un seul ticket ouvert de ce type par membre.
  const already = listByOwner(interaction.user.id).find((t) => t.type === type);
  if (already) {
    await interaction.reply({
      content: `⚠️ Tu as déjà un ticket **${TICKET_TYPES[type].label}** ouvert : <#${already.channelId}>.`,
      ephemeral: true,
    });
    return;
  }
  await interaction.showModal(buildModal(type));
}

async function handleModalSubmit(interaction) {
  const type = interaction.customId.split(":")[1];
  const cfg = TICKET_TYPES[type];
  if (!cfg) return;

  await interaction.deferReply({ ephemeral: true });

  const already = listByOwner(interaction.user.id).find((t) => t.type === type);
  if (already) {
    await interaction.editReply(`⚠️ Tu as déjà un ticket ouvert : <#${already.channelId}>.`);
    return;
  }

  const answers = {};
  for (const q of cfg.questions) {
    answers[q.id] = interaction.fields.getTextInputValue(q.id);
  }
  const report = buildReport(type, answers);

  // ── Contestation de ban : on vérifie le ban AVANT d'ouvrir quoi que ce soit.
  //    Un ban de triche n'ouvre même pas de ticket.
  let extraContext = null;
  if (type === "ban") {
    const code = normalizeBanId(answers.banId);
    if (!code) {
      await interaction.editReply("❌ Indique l'ID du ban (le code #… affiché en jeu dans le monde des bans).");
      return;
    }
    const info = await fetchBanInfo(code);
    if (!info.available) {
      // RCON injoignable / commande baninfo absente : impossible de CONFIRMER l'ID.
      // On n'ouvre pas de ticket sur un ID non vérifié.
      await interaction.editReply(
        "❌ Impossible de vérifier l'ID du ban pour le moment. Réessaie dans quelques minutes."
      );
      return;
    }
    if (!info.found) {
      // ID inconnu = très probablement une faute de frappe -> on n'ouvre pas.
      await interaction.editReply(
        `❌ Désolé, aucun ban ne correspond à l'ID \`#${code}\` — tu t'es sûrement trompé dans l'ID.\n` +
          "Vérifie le code exact affiché sur ton écran de kick (ou dans le monde des bans) et réessaie."
      );
      return;
    }
    if (!banContestable(info)) {
      await interaction.editReply(
        "⛔ Désolé, ce ban est un **ban pour triche** — il n'est pas contestable. " +
          "Le ticket ne sera pas ouvert."
      );
      return;
    }
    // Ban confirmé et contestable : on ouvre et on donne le motif officiel à Claude.
    extraContext =
      `INFOS DU BAN (ID #${code}) — joueur: ${info.player || "?"}, actif: ${info.active}, ` +
      `motif officiel: « ${info.reason || "non renseigné"} ». Ce ban est contestable : ` +
      "confronte la version du joueur à ce motif et exige des preuves solides.";
  }

  const guild = interaction.guild;
  const ownerId = interaction.user.id;
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
      type: OverwriteType.Member,
    },
    {
      id: ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      type: OverwriteType.Member,
    },
  ];

  let channel;
  try {
    channel = await guild.channels.create({
      name: `${cfg.prefix}-${sanitize(interaction.user.username)}`,
      type: ChannelType.GuildText,
      parent: TICKET_CATEGORY_ID || undefined,
      topic: `Ticket ${type} • assistant • <@${ownerId}>`,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    console.error("[Tickets] Creation du salon echouee:", err);
    await interaction.editReply(
      "❌ Impossible de créer le salon. Vérifie que le bot a la permission **Gérer les salons**."
    );
    return;
  }

  setTicket(channel.id, {
    type,
    ownerId,
    ownerName: interaction.user.username,
    stage: "claude",
    report,
    extraContext,
    createdAt: Date.now(),
  });

  const reportEmbed = new EmbedBuilder()
    .setColor(cfg.color)
    .setTitle(`${cfg.emoji} ${cfg.modalTitle}`)
    .setDescription(report)
    .setFooter({ text: `Ticket de ${interaction.user.tag}` });

  const greeting =
    `👋 Salut <@${ownerId}> ! Je suis **BloodBot**, l'assistant de support de BloodSpire.\n` +
    "Je peux t'aider directement pour les questions simples liées au serveur. Décris ton " +
    "souci ci-dessous et je te réponds.\n" +
    "> 🙋 Besoin d'un membre du staff ? Clique sur **Parler à un humain**.\n" +
    "> ✅ C'est réglé ? Clique sur **Fermer (résolu)**." +
    (bedrockUsable()
      ? ""
      : "\n\n⚠️ *L'IA n'est pas configurée (clé AWS manquante) : utilise le bouton pour joindre un humain.*");

  await channel.send({ embeds: [reportEmbed] });
  await channel.send({ content: greeting, components: [claudeButtons()] });

  await interaction.editReply(`✅ Ton ticket est ouvert : <#${channel.id}>`);
  await logEvent(interaction.client, {
    title: "🎫 Ouverture d'un ticket",
    description: `${cfg.emoji} **${cfg.label}** — <@${ownerId}> → <#${channel.id}>`,
    color: cfg.color,
  });
}

// ── Conversation avec Claude ────────────────────────────────────────────────

/** Reconstruit l'historique pour Claude a partir des messages du salon. */
async function buildConversation(channel, ticket, botId) {
  const fetched = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  const convo = [];
  if (fetched) {
    const chronological = [...fetched.values()].reverse();
    for (const m of chronological) {
      if (!m.content || !m.content.trim()) continue; // ignore embeds / boutons seuls
      const role = m.author.id === botId ? "assistant" : m.author.id === ticket.ownerId ? "user" : null;
      if (!role) continue;
      convo.push({ role, content: m.content.trim() });
    }
  }
  // Le rapport du ticket devient le premier tour "user".
  convo.unshift({ role: "user", content: "[Informations du ticket]\n" + ticket.report });

  // Normalise : commence par user, fusionne les tours consecutifs de meme role.
  const out = [];
  for (const m of convo) {
    if (out.length && out[out.length - 1].role === m.role) {
      out[out.length - 1].content += "\n" + m.content;
    } else {
      out.push({ ...m });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function parseClaude(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      return { needsHuman: !!o.needs_human, reply: String(o.reply || "").trim() };
    }
  } catch {
    /* pas du JSON valide */
  }
  return { needsHuman: false, reply: text.trim() };
}

async function handleTicketMessage(message) {
  const ticket = getTicket(message.channel.id);
  if (!ticket || ticket.stage !== "claude") return;
  if (message.author.bot) return;
  if (message.author.id !== ticket.ownerId) return;
  if (processing.has(message.channel.id)) return;

  if (!bedrockUsable()) {
    await message.channel.send(
      "🤖 L'assistant IA n'est pas configuré pour le moment. Clique sur **Parler à un humain** pour joindre le staff."
    );
    return;
  }

  processing.add(message.channel.id);
  try {
    await message.channel.sendTyping();
    const botId = message.client.user.id;
    const conversation = await buildConversation(message.channel, ticket, botId);
    const raw = await askClaude(buildSystemPrompt(ticket.type, ticket.extraContext), conversation);
    const { needsHuman, reply } = parseClaude(raw);

    if (reply) await message.channel.send(reply.slice(0, 1900));

    if (needsHuman) {
      // On n'ouvre PAS directement : on demande une confirmation admin. Le salon
      // IA reste ouvert tant que la demande n'est pas acceptée.
      await requestHumanTicket(message.channel, getTicket(message.channel.id) || ticket, message.client);
    }
  } catch (err) {
    console.error("[Tickets] Erreur Claude:", err);
    await message.channel.send(
      "❌ Je n'arrive pas à répondre pour le moment. Clique sur **Parler à un humain** pour joindre le staff."
    );
  } finally {
    processing.delete(message.channel.id);
  }
}

// ── Demande d'ouverture d'un ticket humain (confirmation admin requise) ──────

/** Courte transcription du salon IA, pour donner le contexte au staff/admin. */
async function shortTranscript(channel, botId) {
  const fetched = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  if (!fetched) return "";
  return [...fetched.values()]
    .reverse()
    .filter((m) => m.content && m.content.trim())
    .map((m) => `${m.author.id === botId ? "BloodBot" : m.author.username}: ${m.content}`)
    .join("\n")
    .slice(-3000);
}

/**
 * Poste une DEMANDE d'ouverture de ticket humain dans le salon demande-de-tickets.
 * Le salon IA reste ouvert ; un admin doit Accepter (ouvre le ticket humain et
 * ferme le salon IA) ou Refuser (le salon IA continue).
 */
async function requestHumanTicket(claudeChannel, ticket, client, note) {
  if (ticket.requestPending) {
    await claudeChannel.send(
      "🙋 Une demande est déjà en attente de validation par un admin. On continue en attendant leur réponse."
    );
    return;
  }
  const cfg = TICKET_TYPES[ticket.type];
  const reqChannel = REQUEST_CHANNEL_ID
    ? await client.channels.fetch(REQUEST_CHANNEL_ID).catch(() => null)
    : null;
  if (!reqChannel || !reqChannel.isTextBased()) {
    // Aucun salon de demande configuré -> on ouvre directement (repli).
    await openStaffTicket(claudeChannel, ticket, client);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(cfg.color)
    .setTitle(`📥 Demande d'ouverture — ${cfg.emoji} ${cfg.label}`)
    .setDescription((note ? `**Motif :** ${note}\n\n` : "") + ticket.report.slice(0, 3500))
    .addFields(
      { name: "Joueur", value: `<@${ticket.ownerId}>`, inline: true },
      { name: "Salon IA", value: `<#${claudeChannel.id}>`, inline: true }
    )
    .setFooter({ text: "Un admin doit Accepter pour ouvrir le ticket humain." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`req_accept:${claudeChannel.id}`)
      .setLabel("Accepter")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`req_refuse:${claudeChannel.id}`)
      .setLabel("Refuser")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
  );

  const pings = STAFF_IDS.map((id) => `<@&${id}>`).join(" ");
  const msg = await reqChannel.send({ content: pings, embeds: [embed], components: [row] });

  ticket.requestPending = true;
  ticket.requestMsgId = msg.id;
  ticket.requestChannelId = reqChannel.id;
  setTicket(claudeChannel.id, ticket);

  await claudeChannel.send(
    "🙋 J'ai fait une demande d'ouverture de ticket auprès des admins. " +
      "En attendant leur réponse, tu peux continuer à discuter avec moi ici."
  );
}

/** Désactive les boutons d'une demande et reflète le statut dans l'embed. */
async function closeRequestMessage(message, statusText) {
  try {
    const embed = message.embeds[0]
      ? EmbedBuilder.from(message.embeds[0]).setFooter({ text: statusText })
      : null;
    await message.edit({ embeds: embed ? [embed] : message.embeds, components: [] });
  } catch {
    /* message supprimé */
  }
}

// ── Ouverture effective du ticket humain (après acceptation admin) ───────────

async function openStaffTicket(claudeChannel, ticket, client) {
  const guild = claudeChannel.guild;
  const cfg = TICKET_TYPES[ticket.type];

  const transcript = await shortTranscript(claudeChannel, client.user.id);

  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
      type: OverwriteType.Member,
    },
    {
      id: ticket.ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      type: OverwriteType.Member,
    },
    ...STAFF_IDS.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      type: overwriteType(guild, id),
    })),
  ];

  let staffChannel;
  try {
    staffChannel = await guild.channels.create({
      name: `staff-${cfg.prefix}-${sanitize(ownerNameFallback(ticket))}`,
      type: ChannelType.GuildText,
      parent: TICKET_CATEGORY_ID || undefined,
      topic: `Ticket ${ticket.type} • STAFF • <@${ticket.ownerId}>`,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    console.error("[Tickets] Creation du salon staff echouee:", err);
    await claudeChannel.send(
      "❌ Impossible d'ouvrir un ticket staff (permission **Gérer les salons** manquante). " +
        "Ce salon reste ouvert, réessaie plus tard."
    );
    return;
  }

  setTicket(staffChannel.id, {
    type: ticket.type,
    ownerId: ticket.ownerId,
    ownerName: ticket.ownerName,
    stage: "staff",
    report: ticket.report,
    createdAt: Date.now(),
  });

  const staffEmbed = new EmbedBuilder()
    .setColor(cfg.color)
    .setTitle(`${cfg.emoji} ${cfg.modalTitle} — transmis par BloodBot`)
    .setDescription(ticket.report)
    .setFooter({ text: "Seul le staff peut fermer ce ticket." });

  const pings = [`<@${ticket.ownerId}>`, ...STAFF_IDS.map((id) => `<@&${id}>`)].join(" ");
  await staffChannel.send({ content: pings, embeds: [staffEmbed], components: [staffButtons()] });
  if (transcript) {
    await staffChannel.send({
      content: "📝 **Échange avec l'assistant :**\n```\n" + transcript.slice(0, 1900) + "\n```",
    });
  }

  // Demande acceptée : Claude prévient puis ferme son propre salon.
  await claudeChannel.send(
    `✅ Ta demande a été acceptée ! Le staff prend le relais ici 👉 <#${staffChannel.id}>.\n` +
      "Je ferme ce salon, à bientôt !"
  );
  removeTicket(claudeChannel.id);
  setTimeout(() => claudeChannel.delete().catch(() => {}), 8000);

  await logEvent(client, {
    title: "🙋 Escalade vers le staff",
    description: `${cfg.emoji} **${cfg.label}** — <@${ticket.ownerId}> → <#${staffChannel.id}>`,
    color: cfg.color,
  });
}

function ownerNameFallback(ticket) {
  return ticket.ownerName || "joueur";
}

// ── Boutons de la demande (salon demande-de-tickets) ────────────────────────

async function handleRequestAccept(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: "🔒 Réservé au staff.", ephemeral: true });
    return;
  }
  const claudeChannelId = interaction.customId.split(":")[1];
  const ticket = getTicket(claudeChannelId);
  const claudeChannel = await interaction.client.channels.fetch(claudeChannelId).catch(() => null);
  if (!ticket || ticket.stage !== "claude" || !claudeChannel) {
    await closeRequestMessage(interaction.message, "⚠️ Demande expirée (ticket fermé).");
    await interaction.reply({ content: "⚠️ Cette demande n'est plus valide.", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();
  await closeRequestMessage(interaction.message, `✅ Accepté par ${interaction.user.username}`);
  await openStaffTicket(claudeChannel, ticket, interaction.client);
}

async function handleRequestRefuse(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: "🔒 Réservé au staff.", ephemeral: true });
    return;
  }
  const claudeChannelId = interaction.customId.split(":")[1];
  const ticket = getTicket(claudeChannelId);
  await interaction.deferUpdate();
  await closeRequestMessage(interaction.message, `❌ Refusé par ${interaction.user.username}`);
  if (ticket && ticket.stage === "claude") {
    ticket.requestPending = false;
    ticket.requestMsgId = undefined;
    setTicket(claudeChannelId, ticket);
    const claudeChannel = await interaction.client.channels.fetch(claudeChannelId).catch(() => null);
    if (claudeChannel) {
      await claudeChannel.send(
        "❌ Ta demande d'ouverture de ticket a été refusée par le staff pour l'instant. " +
          "Tu peux continuer à discuter avec moi."
      );
    }
  }
}

// ── Boutons du salon Claude ─────────────────────────────────────────────────

async function handleHumanButton(interaction) {
  const ticket = getTicket(interaction.channel.id);
  if (!ticket || ticket.stage !== "claude") {
    await interaction.reply({ content: "Ce ticket n'est plus actif.", ephemeral: true });
    return;
  }
  await interaction.reply({ content: "🙋 Je transmets ta demande aux admins…", ephemeral: true });
  await requestHumanTicket(interaction.channel, ticket, interaction.client, "Le joueur demande un humain.");
}

async function handleResolvedButton(interaction) {
  const ticket = getTicket(interaction.channel.id);
  if (!ticket || ticket.stage !== "claude") {
    await interaction.reply({ content: "Ce ticket n'est plus actif.", ephemeral: true });
    return;
  }
  await interaction.reply({
    content: "✅ Content d'avoir pu t'aider ! Je ferme ce ticket, reviens quand tu veux.",
  });
  const cfg = TICKET_TYPES[ticket.type];
  await logEvent(interaction.client, {
    title: "✅ Fermeture résolue",
    description:
      `${cfg.emoji} **${cfg.label}** — <@${ticket.ownerId}> a résolu et fermé son ticket ` +
      `(sans staff) — <#${interaction.channel.id}>`,
    color: 0x57f287,
  });
  removeTicket(interaction.channel.id);
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

// ── Boutons du salon staff ──────────────────────────────────────────────────

async function handleStaffCloseRequest(interaction) {
  const ticket = getTicket(interaction.channel.id);
  if (!ticket || ticket.stage !== "staff") {
    await interaction.reply({ content: "Ce ticket n'est plus actif.", ephemeral: true });
    return;
  }
  if (interaction.user.id !== ticket.ownerId) {
    await interaction.reply({
      content: "🔒 Seul le joueur à l'origine du ticket peut demander sa fermeture.",
      ephemeral: true,
    });
    return;
  }
  const pings = STAFF_IDS.map((id) => `<@&${id}>`).join(" ");
  await interaction.reply({
    content: `🙋 <@${interaction.user.id}> demande la fermeture de ce ticket. ${pings}\n` +
      "Un membre du staff doit **confirmer la fermeture** ci-dessous.",
    components: [staffConfirmButtons()],
  });
}

async function handleStaffClose(interaction) {
  const ticket = getTicket(interaction.channel.id);
  if (!ticket || ticket.stage !== "staff") {
    await interaction.reply({ content: "Ce ticket n'est plus actif.", ephemeral: true });
    return;
  }
  if (!isStaff(interaction.member)) {
    await interaction.reply({
      content: "🔒 Seul un membre du staff peut confirmer la fermeture de ce ticket.",
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({ content: "🔒 Ticket fermé par le staff. Fermeture du salon…" });
  const cfg = TICKET_TYPES[ticket.type];
  await logEvent(interaction.client, {
    title: "🔒 Fermeture staff",
    description:
      `${cfg.emoji} **${cfg.label}** — fermé par ${interaction.user.username} ` +
      `(<@${interaction.user.id}>), ticket de <@${ticket.ownerId}> — <#${interaction.channel.id}>`,
    color: 0xed4245,
  });
  removeTicket(interaction.channel.id);
  setTimeout(() => interaction.channel.delete().catch(() => {}), 4000);
}

// ── Routage ─────────────────────────────────────────────────────────────────

/** Renvoie true si l'interaction a ete geree (et attendue) par le systeme de tickets. */
async function handleInteraction(interaction) {
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (id.startsWith("ticket_open:")) { await handleOpenButton(interaction); return true; }
    if (id === "ticket_human") { await handleHumanButton(interaction); return true; }
    if (id === "ticket_close_resolved") { await handleResolvedButton(interaction); return true; }
    if (id.startsWith("req_accept:")) { await handleRequestAccept(interaction); return true; }
    if (id.startsWith("req_refuse:")) { await handleRequestRefuse(interaction); return true; }
    if (id === "staff_close_request") { await handleStaffCloseRequest(interaction); return true; }
    if (id === "staff_close_confirm") { await handleStaffClose(interaction); return true; }
  } else if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("ticket_modal:")) { await handleModalSubmit(interaction); return true; }
  }
  return false;
}

/** Branche le systeme de tickets sur un client deja construit. */
function register(client, loadState, saveState) {
  client.on(Events.MessageCreate, (message) => {
    if (!message.guild) return;
    handleTicketMessage(message).catch((e) => console.error("[Tickets] message:", e));
  });
  return { ensurePanel: () => ensurePanel(client, loadState, saveState), handleInteraction };
}

module.exports = { register };
