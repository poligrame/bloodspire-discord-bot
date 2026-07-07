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

const { TICKET_TYPES, buildSystemPrompt } = require("./ticketConfig");
const { askClaude, usable: bedrockUsable } = require("./bedrock");
const { getTicket, setTicket, removeTicket, listByOwner } = require("./tickets");

const PANEL_CHANNEL_ID = (process.env.PANEL_CHANNEL_ID || "").trim();
const TICKET_CATEGORY_ID = (process.env.TICKET_CATEGORY_ID || "").trim();
const STAFF_IDS = (process.env.TICKET_STAFF_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const BRAND = 0xc0001a;

// Anti-doublon de traitement d'un meme salon (messages concurrents).
const processing = new Set();

// ── Panneau d'ouverture ─────────────────────────────────────────────────────

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle("🎫 Ouvrir un ticket — BloodSpire")
    .setDescription(
      "Besoin d'aide ? Choisis une catégorie ci-dessous. Un salon privé s'ouvre avec " +
        "**BloodBot**, notre assistant. Il répond aux questions simples et transmet à un " +
        "membre du staff si c'est nécessaire.\n\n" +
        "📋 **Candidature** — postuler au staff\n" +
        "🐛 **Signaler un bug** — un souci technique en jeu\n" +
        "🚨 **Signaler un joueur** — comportement / triche"
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
  const state = loadState();
  if (state.ticketPanelId) {
    const existing = await channel.messages.fetch(state.ticketPanelId).catch(() => null);
    if (existing) return;
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
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("staff_close")
      .setLabel("Fermer le ticket (staff)")
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
    const raw = await askClaude(buildSystemPrompt(ticket.type), conversation);
    const { needsHuman, reply } = parseClaude(raw);

    if (reply) await message.channel.send(reply.slice(0, 1900));

    if (needsHuman) {
      await escalateToStaff(message.channel, ticket, message.client);
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

// ── Escalade : fermeture du ticket Claude -> ouverture d'un ticket staff ─────

async function escalateToStaff(claudeChannel, ticket, client) {
  const guild = claudeChannel.guild;
  const cfg = TICKET_TYPES[ticket.type];

  // Transcription courte pour donner le contexte au staff.
  let transcript = "";
  const fetched = await claudeChannel.messages.fetch({ limit: 30 }).catch(() => null);
  if (fetched) {
    transcript = [...fetched.values()]
      .reverse()
      .filter((m) => m.content && m.content.trim())
      .map((m) => `${m.author.id === client.user.id ? "BloodBot" : m.author.username}: ${m.content}`)
      .join("\n")
      .slice(-3000);
  }

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

  // Claude previent puis ferme son propre salon.
  await claudeChannel.send(
    `🙋 J'ai fait une demande pour un ticket avec le staff. Ils prennent le relais ici 👉 <#${staffChannel.id}>.\n` +
      "Je ferme ce salon, à bientôt !"
  );
  removeTicket(claudeChannel.id);
  setTimeout(() => claudeChannel.delete().catch(() => {}), 8000);
}

function ownerNameFallback(ticket) {
  return ticket.ownerName || "joueur";
}

// ── Boutons du salon Claude ─────────────────────────────────────────────────

async function handleHumanButton(interaction) {
  const ticket = getTicket(interaction.channel.id);
  if (!ticket || ticket.stage !== "claude") {
    await interaction.reply({ content: "Ce ticket n'est plus actif.", ephemeral: true });
    return;
  }
  await interaction.reply({ content: "🙋 Je transmets ta demande au staff…", ephemeral: true });
  await escalateToStaff(interaction.channel, ticket, interaction.client);
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
  const pings = STAFF_IDS.map((id) => `<@&${id}>`).join(" ");
  await interaction.reply({
    content: `🙋 <@${interaction.user.id}> demande la fermeture de ce ticket. ${pings}`,
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
      content: "🔒 Seul un membre du staff peut fermer ce ticket.",
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({ content: "🔒 Ticket fermé par le staff. Fermeture du salon…" });
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
    if (id === "staff_close_request") { await handleStaffCloseRequest(interaction); return true; }
    if (id === "staff_close") { await handleStaffClose(interaction); return true; }
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
