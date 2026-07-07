# Bot Discord BloodSpire

Poste un message avec 2 boutons dans un salon Discord :

- **🎁 Réclamer le titre** : demande le pseudo Minecraft, puis exécute
  `titre give <pseudo> discord` sur le serveur via RCON. Un membre Discord
  ne peut réclamer qu'une seule fois (bloqué tant qu'il n'a pas annulé).
- **❌ Annuler** : exécute `titre unassign <pseudo>` et libère le membre pour
  qu'il puisse réclamer à nouveau (utile s'il s'est trompé de pseudo).

Le bot ne fait que ça pour l'instant — la structure (dossier `src/`) est
prévue pour ajouter d'autres fonctionnalités plus tard sans tout réécrire.

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
