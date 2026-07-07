require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  Events,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require("discord.js");

const { sendCommand } = require("./src/rcon");
const { getClaim, setClaim, removeClaim } = require("./src/claims");
const ticketSystem = require("./src/ticketSystem");

// Garde-fous globaux : une seule promesse rejetee ne doit JAMAIS faire crasher
// (et donc redemarrer en boucle sur Railway) tout le bot. On journalise et on
// continue.
process.on("unhandledRejection", (err) => {
  console.error("[BloodSpire] Promesse rejetee non geree:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[BloodSpire] Exception non capturee:", err);
});

const TITLE_ID = process.env.TITLE_ID || "discord";
const STATE_FILE = path.join(__dirname, "message-state.json");

// Pseudo Minecraft valide : 3 a 16 caracteres, lettres/chiffres/underscore.
const PSEUDO_REGEX = /^[a-zA-Z0-9_]{3,16}$/;

// GuildMessages + MessageContent : necessaires pour que Claude lise les
// messages dans les salons de ticket. MessageContent est un intent PRIVILEGIE
// a activer dans le portail developpeur Discord (onglet Bot).
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let tickets;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Fusionne les cles dans message-state.json sans ecraser les autres. */
function saveState(patch) {
  const merged = { ...loadState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2), "utf8");
}

const CLAIM_TITLE = "🎁 Titre gratuit — Fly au spawn";

function buildClaimEmbed() {
  return new EmbedBuilder()
    .setColor(0xc0001a)
    .setTitle(CLAIM_TITLE)
    .setDescription(
      "Clique sur **Réclamer** et indique ton pseudo Minecraft pour recevoir " +
        "le titre `discord`, qui te donne accès au **fly au spawn**.\n\n" +
        "Tu ne peux réclamer qu'**une seule fois**. Si tu t'es trompé de pseudo, " +
        "clique sur **Annuler** puis réclame à nouveau."
    )
    .setFooter({ text: "BloodSpire" });
}

function buildClaimRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("claim_title")
      .setLabel("Réclamer le titre")
      .setEmoji("🎁")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("cancel_title")
      .setLabel("Annuler")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
  );
}

/** Poste le message de reclamation au demarrage, ou reutilise celui deja poste. */
async function ensureClaimMessage() {
  if (!process.env.CHANNEL_ID) {
    console.warn("[BloodSpire] CHANNEL_ID non defini — message de reclamation non poste.");
    return;
  }
  const channel = await client.channels.fetch(process.env.CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error("[BloodSpire] CHANNEL_ID invalide, inaccessible, ou pas un salon texte.");
    return;
  }

  // FS ephemere de Railway : message-state.json disparait a chaque redemarrage.
  // On scanne donc le salon pour retrouver le message deja poste (et on supprime
  // les doublons), sinon le bot en reposte un a chaque redemarrage.
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent) {
    const mine = [...recent.values()]
      .filter(
        (m) =>
          m.author.id === client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0].title === CLAIM_TITLE
      )
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const keep = mine.shift();
    for (const dup of mine) await dup.delete().catch(() => {});
    if (keep) {
      await keep.edit({ embeds: [buildClaimEmbed()], components: [buildClaimRow()] }).catch(() => {});
      saveState({ messageId: keep.id });
      return;
    }
  }

  const message = await channel.send({
    embeds: [buildClaimEmbed()],
    components: [buildClaimRow()],
  });
  saveState({ messageId: message.id });
}

// Branche le systeme de tickets (messages + panneau).
tickets = ticketSystem.register(client, loadState, saveState);

client.once(Events.ClientReady, async () => {
  console.log(`[BloodSpire] Connecte en tant que ${client.user.tag}`);
  // Chaque etape est isolee : si l'une echoue (salon invalide, permission
  // manquante...), on log et on continue au lieu de crasher le demarrage.
  try {
    await ensureClaimMessage();
  } catch (err) {
    console.error("[BloodSpire] ensureClaimMessage a echoue:", err);
  }
  try {
    await tickets.ensurePanel();
  } catch (err) {
    console.error("[BloodSpire] ensurePanel a echoue:", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Le systeme de tickets traite ses propres interactions en premier.
    if (await tickets.handleInteraction(interaction)) return;

    if (interaction.isButton()) {
      if (interaction.customId === "claim_title") return handleClaimButton(interaction);
      if (interaction.customId === "cancel_title") return handleCancelButton(interaction);
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === "claim_title_modal") return handleClaimModalSubmit(interaction);
    }
  } catch (err) {
    console.error("[BloodSpire] Erreur interaction:", err);
    const payload = { content: "❌ Une erreur interne est survenue. Réessaie plus tard.", ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else if (interaction.isRepliable()) await interaction.reply(payload);
    } catch {
      /* interaction expiree/deja fermee */
    }
  }
});

async function handleClaimButton(interaction) {
  const existing = getClaim(interaction.user.id);
  if (existing) {
    await interaction.reply({
      content: `⚠️ Tu as déjà réclamé ce titre pour **${existing}**. Clique sur ❌ Annuler d'abord si tu veux changer de pseudo.`,
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder().setCustomId("claim_title_modal").setTitle("Réclamer le titre Discord");
  const input = new TextInputBuilder()
    .setCustomId("pseudo")
    .setLabel("Ton pseudo Minecraft exact")
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(16)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleClaimModalSubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });

  // Re-verifie (course possible entre l'ouverture du modal et la soumission)
  if (getClaim(interaction.user.id)) {
    await interaction.editReply("⚠️ Tu as déjà réclamé ce titre entre-temps.");
    return;
  }

  const pseudo = interaction.fields.getTextInputValue("pseudo").trim();
  if (!PSEUDO_REGEX.test(pseudo)) {
    await interaction.editReply(
      "❌ Pseudo invalide : 3 à 16 caractères, lettres/chiffres/underscore uniquement."
    );
    return;
  }

  let response;
  try {
    response = await sendCommand(`titre give ${pseudo} ${TITLE_ID}`);
  } catch (err) {
    console.error("[BloodSpire] Erreur RCON (give):", err);
    await interaction.editReply(
      "❌ Impossible de contacter le serveur Minecraft pour le moment. Réessaie plus tard."
    );
    return;
  }

  if (/introuvable|inconnu/i.test(response)) {
    await interaction.editReply(
      `❌ Le joueur **${pseudo}** est introuvable — il doit avoir rejoint le serveur au moins une fois.`
    );
    return;
  }

  setClaim(interaction.user.id, pseudo);
  await interaction.editReply(`✅ Titre donné à **${pseudo}** ! Le fly au spawn est maintenant débloqué.`);
}

async function handleCancelButton(interaction) {
  const pseudo = getClaim(interaction.user.id);
  if (!pseudo) {
    await interaction.reply({ content: "Tu n'as pas de titre à annuler.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await sendCommand(`titre unassign ${pseudo}`);
  } catch (err) {
    console.error("[BloodSpire] Erreur RCON (unassign):", err);
    await interaction.editReply("❌ Impossible de contacter le serveur Minecraft pour le moment. Réessaie plus tard.");
    return;
  }

  removeClaim(interaction.user.id);
  await interaction.editReply(`❌ Titre retiré de **${pseudo}**. Tu peux en réclamer un nouveau si besoin.`);
}

client.login(process.env.DISCORD_TOKEN);
