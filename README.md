# Bot Discord BloodSpire

Poste un message avec 2 boutons dans un salon Discord :

- **🎁 Réclamer le titre** : demande le pseudo Minecraft, puis exécute
  `titre give <pseudo> discord` sur le serveur via RCON. Un membre Discord
  ne peut réclamer qu'une seule fois (bloqué tant qu'il n'a pas annulé).
- **❌ Annuler** : exécute `titre unassign <pseudo>` et libère le membre pour
  qu'il puisse réclamer à nouveau (utile s'il s'est trompé de pseudo).

Le bot gère aussi un **système de tickets complet** (voir plus bas).

## Système de tickets (Candidature / Bug / Joueur)

Dans le salon `PANEL_CHANNEL_ID`, le bot poste un panneau avec 4 boutons :

- **📋 Candidature** — postuler au staff
- **🐛 Signaler un bug**
- **🚨 Signaler un joueur**
- **⛔ Contester un ban** — demande l'ID du ban (#…) + preuves solides

Chaque bouton ouvre un **formulaire** (5 questions adaptées au type) puis crée un
**salon privé** visible uniquement par le joueur et le bot. Un rapport formaté y
est posté et **BloodBot** (Claude Sonnet 4.5 via AWS Bedrock) accueille le joueur.

### Comment ça marche

1. **Salon IA (`stage: claude`)** — visible par le joueur + le bot uniquement.
   Claude répond aux questions **simples liées au serveur**. Il connaît son rôle
   (assistant BloodSpire) et **refuse tout sujet hors-serveur**.
2. **Demande d'ouverture d'un ticket humain (confirmation admin)** — si le joueur
   clique sur **🙋 Parler à un humain**, ou si Claude juge qu'un humain est
   nécessaire : le bot poste une **demande** dans le salon `REQUEST_CHANNEL_ID`
   (« demande-de-tickets ») avec deux boutons **✅ Accepter / ❌ Refuser**
   (réservés au staff). **Le salon IA reste ouvert** : Claude continue à discuter
   avec le joueur tant que la demande n'est pas acceptée.
3. **Accepté** → le bot crée le **salon staff** (visible par le joueur + les
   rôles `TICKET_STAFF_IDS`), y recopie le rapport + l'échange, et **ferme le
   salon IA**. **Refusé** → le salon IA continue normalement.
4. **Salon staff (`stage: staff`)** — le joueur peut **demander la fermeture**,
   mais **seul le staff peut fermer** réellement.
5. **Résolution sans humain** — le joueur peut cliquer sur **✅ Fermer (résolu)**
   dans le salon IA : Claude dit au revoir et ferme le salon, sans staff.

### ⛔ Contestation de ban

Le type **Contester un ban** demande l'**ID du ban** (le code `#…` affiché en jeu
dans le monde des bans) + des preuves. Le bot interroge le serveur par RCON
(`baninfo <id>`) :

- **Ban de triche** (fly, xray, killaura…) → **refusé d'entrée**, le ticket ne
  s'ouvre même pas.
- **ID introuvable** → le ticket ne s'ouvre pas non plus.
- **Ban contestable** → le ticket s'ouvre, Claude connaît le **motif officiel**
  du ban, confronte la version du joueur, exige des preuves solides, et n'escalade
  vers un humain que si l'innocence devient crédible.

> Nécessite la commande `/baninfo` côté plugin (voir le dépôt du plugin). Sans
> elle, le bot ne peut pas vérifier le motif et laissera Claude gérer + escalader.

### Configuration IA (obligatoire pour que Claude réponde)

Renseigne dans `.env` **une seule** des deux options :

```env
# Option 1 (la plus simple) : une clé API Bedrock (jeton Bearer)
AWS_BEARER_TOKEN_BEDROCK=ta-cle-api-bedrock

# Option 2 : clés IAM classiques (laisse le Bearer vide)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Commun :
BEDROCK_REGION=us-east-1
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

Sans clé AWS, les tickets fonctionnent toujours : le bot invite simplement le
joueur à cliquer sur **Parler à un humain**.

### Salon de logs admin (optionnel)

Définis `LOG_CHANNEL_ID` sur un salon visible du staff uniquement : le bot y
journalise chaque **ouverture**, **escalade** et **fermeture** de ticket.

### ⚠️ Railway : système de fichiers éphémère

Sur Railway, les fichiers locaux (`claims.json`, `tickets.json`,
`message-state.json`) sont **effacés à chaque redéploiement**. Le panneau et le
message de réclamation sont malgré tout **idempotents** (le bot rescanne le salon
au démarrage et ne reposte pas de doublon). En revanche, pour conserver les
réclamations de titre et les tickets en cours entre deux redémarrages, monte un
**Volume Railway** sur le dossier de l'app.

### ⚠️ Intent Discord requis

Pour que Claude **lise les messages** dans les salons de ticket, active l'intent
privilégié **MESSAGE CONTENT INTENT** :
Discord Developer Portal → ton appli → **Bot** → active *Message Content Intent*.
Le bot a aussi besoin de la permission **Gérer les salons** (créer/supprimer les
tickets) et **Gérer les rôles**/permissions sur la catégorie des tickets.

La structure (dossier `src/`) reste prévue pour ajouter d'autres fonctionnalités
plus tard sans tout réécrire.

## Comment ça parle au serveur Minecraft

Le bot n'a pas besoin d'un plugin spécial côté serveur : il se connecte en
**RCON** (protocole de console à distance déjà intégré à Paper/Spigot) et
exécute exactement les mêmes commandes qu'un admin taperait dans la console.
Le titre `discord` doit déjà exister en jeu (`/titre create` ou `/titre add`),
ce qui est déjà fait chez toi.

---

## 1. Préparer le serveur Minecraft (activer RCON)

Dans `server.properties` (à la racine du serveur Paper) :

```properties
enable-rcon=true
rcon.port=25575
rcon.password=CHOISIS_UN_MOT_DE_PASSE_LONG_ET_ALEATOIRE
broadcast-rcon-to-ops=false
```

Puis **redémarre le serveur Minecraft** pour que ça prenne effet.

⚠️ Important :
- Le port RCON (25575) doit être **ouvert dans le pare-feu** de la machine qui
  héberge le serveur Minecraft, mais uniquement accessible depuis l'endroit où
  tournera le bot (n'ouvre pas RCON à tout Internet sans réfléchir — si ton
  hébergeur le permet, restreins l'accès par IP à celle de ton bot).
- Ne partage JAMAIS le mot de passe RCON.

## 2. Créer l'application Discord

1. Va sur https://discord.com/developers/applications → **New Application**.
2. Onglet **Bot** → **Reset Token** → copie le token (tu ne le reverras plus).
3. Toujours dans **Bot**, aucune "Privileged Gateway Intent" n'est nécessaire
   pour ce bot (il n'écoute pas les messages, juste les boutons).
4. Onglet **OAuth2 → URL Generator** :
   - Scopes : `bot`, `applications.commands`
   - Permissions du bot : `Send Messages`, `Embed Links`, `Read Message History`
   - Copie l'URL générée en bas, ouvre-la dans ton navigateur et invite le bot
     sur ton serveur Discord.

## 3. Configurer le bot

```bash
cd discord-bot
cp .env.example .env
```

Remplis `.env` :

```env
DISCORD_TOKEN=le_token_copie_a_l_etape_2
CHANNEL_ID=id_du_salon_ou_poster_le_message
RCON_HOST=IP_ou_domaine_du_serveur_minecraft
RCON_PORT=25575
RCON_PASSWORD=le_mot_de_passe_defini_dans_server.properties
TITLE_ID=discord
```

Pour récupérer `CHANNEL_ID` : Discord → Paramètres utilisateur → Avancés →
active **Mode développeur**, puis clic droit sur le salon → **Copier
l'identifiant du salon**.

## 4. Lancer le bot (test en local)

```bash
npm install
npm start
```

Si tout est bon : `[BloodSpire] Connecté en tant que TonBot#1234` s'affiche,
et le message avec les 2 boutons apparaît dans le salon configuré.

---

## 5. Héberger le bot gratuitement (24/7)

Un bot Discord doit tourner **en continu** (connexion websocket permanente à
Discord) — contrairement à un site web, il ne peut pas "se réveiller à la
demande". Ça élimine les hébergements gratuits qui mettent le service en
veille après inactivité (Render free web service, Glitch, Replit gratuit).

**Option recommandée si tu as déjà un accès SSH/terminal à la machine qui
fait tourner ton serveur Minecraft** : installe le bot directement dessus.
C'est 100% gratuit (aucun hébergement supplémentaire), `RCON_HOST` devient
`127.0.0.1`, et il n'y a aucun souci de pare-feu à gérer. Utilise `pm2` pour
le garder en vie :

```bash
npm install -g pm2
cd discord-bot
pm2 start index.js --name bloodspire-bot
pm2 save
pm2 startup   # affiche une commande a executer pour demarrer pm2 au boot
```

**Si tu veux un hébergement séparé, gratuit, sans y toucher toi-même** :

| Hébergeur | Gratuit ? | Remarque |
|---|---|---|
| **Railway** (railway.app) | Crédit d'essai gratuit (~5$), pas gratuit à vie | Le plus simple : connecte ton repo GitHub, il détecte `package.json` et déploie tout seul. Une fois le crédit épuisé, il faut ajouter une carte ou basculer ailleurs. |
| **Oracle Cloud Free Tier** (oracle.com/cloud/free) | Gratuit à vie ("Always Free") | Un vrai petit VPS (jusqu'à 4 OCPU / 24 Go RAM ARM) largement suffisant pour ce bot. Demande une carte bancaire à l'inscription (non débitée si tu restes dans le tier gratuit) et un peu plus de configuration (SSH + Node + pm2, comme à l'étape "sur la même machine" ci-dessus). |
| **Fly.io** (fly.io) | Petit quota gratuit mensuel | Déploiement via Docker/CLI (`fly launch`), reste généralement dans le quota gratuit pour un bot aussi léger que celui-ci. |

Les politiques de gratuité de ces plateformes changent régulièrement — vérifie
la page tarifs du jour avant de choisir. Si ton serveur Minecraft tourne déjà
sur une machine que tu contrôles, c'est de loin l'option la plus simple et la
plus durable.

### Déployer sur Railway (le plus rapide à tester)

1. Pousse ce dossier `discord-bot/` sur un repo GitHub (ou tout le projet).
2. Sur railway.app → **New Project** → **Deploy from GitHub repo**.
3. Dans les **Variables** du service Railway, ajoute exactement les mêmes clés
   que dans `.env` (`DISCORD_TOKEN`, `CHANNEL_ID`, `RCON_HOST`, `RCON_PORT`,
   `RCON_PASSWORD`, `TITLE_ID`).
4. Railway détecte `package.json` et lance `npm start` automatiquement.
5. Vérifie les **Logs** du service : tu dois voir `[BloodSpire] Connecté...`.

⚠️ Si ton serveur Minecraft est chez toi (pas sur un vrai serveur/VPS avec IP
publique), Railway ne pourra pas atteindre `RCON_HOST` sauf si tu ouvres et
rediriges le port RCON sur ta box/routeur (redirection de port vers ta
machine) — dans ce cas, l'option "sur la même machine" est bien plus simple.
