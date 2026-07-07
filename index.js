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

const TITLE_ID = process.env.TITLE_ID || "discord";
const STATE_FILE = path.join(__dirname, "message-state.json");

// Pseudo Minecraft valide : 3 a 16 caracteres, lettres/chiffres/underscore.
const PSEUDO_REGEX = /^[a-zA-Z0-9_]{3,16}$/;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function buildClaimEmbed() {
  return new EmbedBuilder()
    .setColor(0xc0001a)
    .setTitle("🎁 Titre gratuit — Fly au spawn")
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
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    console.error("[BloodSpire] CHANNEL_ID invalide ou pas un salon texte.");
    return;
  }

  const state = loadState();
  if (state.messageId) {
    try {
      const existing = await channel.messages.fetch(state.messageId);
      if (existing) return; // deja poste, on ne double pas
    } catch {
      // message supprime manuellement -> on en repostera un nouveau
    }
  }

  const message = await channel.send({
    embeds: [buildClaimEmbed()],
    components: [buildClaimRow()],
  });
  saveState({ messageId: message.id });
}

client.once(Events.ClientReady, async () => {
  console.log(`[BloodSpire] Connecte en tant que ${client.user.tag}`);
  await ensureClaimMessage();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === "claim_title") return handleClaimButton(interaction);
      if (interaction.customId === "cancel_title") return handleCancelButton(interaction);
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === "claim_title_modal") return handleClaimModalSubmit(interaction);
    }
  } catch (err) {
    console.error("[BloodSpire] Erreur interaction:", err);
    const payload = { content: "❌ Une erreur interne est survenue. Réessaie plus tard.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
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
