/**
 * Definition des types de tickets + questions du modal + prompt systeme Claude.
 * 5 questions max par type (limite Discord : 5 champs par modal).
 */

const TICKET_TYPES = {
  candidature: {
    label: "Candidature",
    emoji: "📋",
    color: 0x5865f2,
    style: "Primary",
    prefix: "cand",
    modalTitle: "Candidature Staff",
    questions: [
      { id: "pseudo", label: "Ton pseudo Minecraft", style: "Short", max: 16 },
      { id: "age", label: "Ton âge", style: "Short", max: 3 },
      { id: "poste", label: "Poste visé (modo, helper, builder…)", style: "Short", max: 100 },
      { id: "motivation", label: "Pourquoi rejoindre le staff ?", style: "Paragraph", max: 900 },
      { id: "dispo", label: "Expérience + disponibilités (h/sem)", style: "Paragraph", max: 900 },
    ],
    role:
      "Ce ticket est une CANDIDATURE au staff. Tu peux répondre aux questions sur les " +
      "prérequis et reformuler/clarifier la candidature, mais la décision finale " +
      "revient TOUJOURS à un humain. Escalade (needs_human=true) dès que le joueur a " +
      "fini de présenter sa candidature ou demande une réponse sur son admission.",
  },
  bug: {
    label: "Signaler un bug",
    emoji: "🐛",
    color: 0xe67e22,
    style: "Secondary",
    prefix: "bug",
    modalTitle: "Signalement de bug",
    questions: [
      { id: "pseudo", label: "Ton pseudo Minecraft", style: "Short", max: 16 },
      { id: "zone", label: "Fonctionnalité / zone concernée", style: "Short", max: 100 },
      { id: "description", label: "Décris le bug", style: "Paragraph", max: 900 },
      { id: "repro", label: "Étapes pour le reproduire", style: "Paragraph", max: 900 },
      { id: "gravite", label: "Gravité — est-ce exploitable ?", style: "Short", max: 200 },
    ],
    role:
      "Ce ticket est un SIGNALEMENT DE BUG. Pour un simple malentendu ou une mauvaise " +
      "utilisation d'une commande, explique la bonne manière de faire (pas besoin " +
      "d'humain). Pour un vrai bug — surtout s'il est exploitable, duplique des objets, " +
      "ou casse l'économie — rassemble les détails puis escalade vers le staff.",
  },
  player: {
    label: "Signaler un joueur",
    emoji: "🚨",
    color: 0xed4245,
    style: "Danger",
    prefix: "report",
    modalTitle: "Signalement de joueur",
    questions: [
      { id: "pseudo", label: "Ton pseudo Minecraft", style: "Short", max: 16 },
      { id: "cible", label: "Pseudo du joueur signalé", style: "Short", max: 16 },
      { id: "regle", label: "Règle enfreinte", style: "Short", max: 150 },
      { id: "description", label: "Décris ce qui s'est passé", style: "Paragraph", max: 900 },
      { id: "preuves", label: "Preuves (lien screenshot / vidéo)", style: "Paragraph", max: 500 },
    ],
    role:
      "Ce ticket est un SIGNALEMENT DE JOUEUR. Toute sanction relève d'un humain. " +
      "Ton rôle : vérifier que le signalement est complet (joueur visé, règle, faits, " +
      "preuves), demander poliment ce qui manque, puis escalader vers le staff. " +
      "N'annonce JAMAIS de sanction toi-même.",
  },
};

/** Construit le prompt systeme de Claude pour un type de ticket donne. */
function buildSystemPrompt(type) {
  const cfg = TICKET_TYPES[type];
  const roleLine = cfg ? cfg.role : "Ce ticket est une demande de support générale.";
  return (
    "Tu es « BloodBot », l'assistant de support officiel du serveur Minecraft BloodSpire " +
    "(IP : play.bloodspire.one). Tu discutes dans un salon de ticket privé avec un joueur.\n\n" +
    "TON RÔLE :\n" +
    "- Aider UNIQUEMENT sur des sujets liés au serveur BloodSpire : bugs en jeu, commandes " +
    "et fonctionnalités du serveur, shop/économie, teams, titres, événements, signalements, " +
    "candidatures staff.\n" +
    "- Tu es courtois, concis, tu tutoies le joueur et tu réponds dans SA langue.\n\n" +
    "RÈGLES STRICTES :\n" +
    "- Tu ne réponds JAMAIS à autre chose que le problème du joueur sur le serveur. Si on te " +
    "demande un sujet hors-serveur (aide aux devoirs, code, culture générale, autre jeu, etc.), " +
    "tu refuses poliment et tu recentres la conversation sur BloodSpire.\n" +
    "- Tu ne promets jamais de remboursement, de déban, de sanction ou de récompense : ce sont " +
    "des décisions humaines.\n" +
    "- Tu escalades vers un humain (needs_human=true) quand : le joueur demande un humain, une " +
    "action du staff est nécessaire (sanction, validation, remboursement, décision), un bug grave " +
    "ou exploitable, ou quand tu ne peux pas résoudre toi-même.\n\n" +
    "CONTEXTE DE CE TICKET :\n" +
    roleLine +
    "\n\n" +
    "FORMAT DE RÉPONSE OBLIGATOIRE :\n" +
    "Réponds UNIQUEMENT par un objet JSON compact, sans aucun texte autour, exactement de la forme :\n" +
    '{"needs_human": <true|false>, "reply": "<ton message au joueur>"}\n' +
    "Le champ \"reply\" contient ce que le joueur va lire. Quand needs_human vaut true, écris dans " +
    "\"reply\" une phrase qui prévient le joueur que tu transmets sa demande à un membre du staff."
  );
}

module.exports = { TICKET_TYPES, buildSystemPrompt };
