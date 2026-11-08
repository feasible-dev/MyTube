# MyTube

Des recherches de videos a partir de ce que vous avez envie de regarder : votre
sujet, des sujets connexes et des decouvertes inattendues. Historique, favoris et
preferences restent sur votre ordinateur, dans chaque navigateur.

**Objectif : installer une extension, ajouter sa propre cle YouTube et utiliser
MyTube. La version actuelle est encore une version de developpement : elle exige
aussi Node.js et un connecteur local en marche. Ce n'est pas encore un installateur
en un clic.** Le guide ci-dessous distingue ce que vous pouvez preparer vous-meme
et ce qui doit etre prepare par la personne qui distribue MyTube.

## 1. Creer votre cle YouTube personnelle

Vous avez besoin d'un compte Google. La cle sert a rechercher des videos publiques ;
elle n'autorise pas l'acces a vos abonnements prives.

1. Ouvrez [Google Cloud Console](https://console.cloud.google.com/).
2. Dans le selecteur de projet en haut, choisissez **Nouveau projet / New project**.
   Donnez-lui un nom, par exemple **MyTube personnel**, puis creez-le.
3. Selectionnez ce projet. Ouvrez **API et services > Bibliotheque / APIs & Services > Library**.
4. Recherchez **YouTube Data API v3**, ouvrez sa fiche et cliquez **Activer / Enable**.
5. Ouvrez **API et services > Identifiants / Credentials**.
6. Cliquez **Creer des identifiants > Cle API / Create credentials > API key**.
   Choisissez une cle API standard, pas un compte de service ni un client OAuth.
7. Ouvrez les parametres de cette cle. Dans **Restrictions relatives aux API / API restrictions**,
   choisissez **Restreindre la cle / Restrict key**, puis **YouTube Data API v3**, et enregistrez.
   Si Google propose cette restriction pendant la creation, appliquez-la directement.
8. Pour **Restrictions relatives aux applications / Application restrictions**, les
   restrictions de sites Web ne conviennent pas au connecteur Node local. Une
   restriction par IP est possible si votre IP publique est fixe ; sinon, laissez
   cette rubrique sur **Aucune / None**, en gardant la restriction a YouTube ci-dessus.
9. Gardez la cle pour l'etape 3. **Ne la partagez pas dans une conversation, une issue
   GitHub ou une capture d'ecran.** Chacun utilise sa propre cle.

Les noms de menus peuvent varier selon la langue de Google Cloud. Procedure verifiee
avec la [documentation YouTube](https://developers.google.com/youtube/data/guides/authentication)
et la [gestion des cles Google](https://docs.cloud.google.com/docs/authentication/api-keys).
Consultez **YouTube Data API v3 > Quotas** dans votre projet pour vos limites reelles :
un clic dans MyTube peut effectuer plusieurs appels, et une cle ne donne pas un
nombre garanti de recherches MyTube. Ne creez pas plusieurs projets pour contourner
une limite.

## 2. Recuperer et preparer MyTube (Windows, Chrome)

Chrome sur Windows est le parcours teste. Brave et les autres navigateurs ne sont
pas encore garantis ; Firefox reste une previsualisation locale.

- Installez [Node.js](https://nodejs.org/) version 22 ou plus recente.
- Sur la page GitHub du projet, utilisez **Code > Download ZIP**, puis extrayez-le
  dans un dossier prive et stable, par exemple `C:\dev\projects\myTube`.
- Ouvrez PowerShell dans ce dossier et lancez :

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run extension:build
```

La recherche normale fonctionne sans fichier OAuth Google. Les abonnements
YouTube restent facultatifs et demandent leur propre configuration.

## 3. Coller votre cle une seule fois

Dans **votre propre terminal Windows**, dans le dossier MyTube :

```powershell
npm.cmd run key:setup
```

Une fenetre Windows MyTube ouvre un champ masque. Collez la cle, puis cliquez
**Encrypt and save**. Windows la chiffre avec DPAPI pour votre compte et conserve
le fichier dans `%LOCALAPPDATA%\MyTube\Credentials\youtube-key.dpapi`, hors du depot.
La cle ne passe pas par le navigateur ou ChatGPT. Elle est dechiffree en memoire
par le connecteur uniquement pour joindre Google. Aucun mot de passe supplementaire.

Une fois le connecteur lance, le meme dialogue est accessible dans les settings :
**YouTube key ? Windows protection**. Ce bouton ouvre la fenetre; seul le message
**Saved with Windows protection** dans celle-ci confirme l'enregistrement.

Si vous aviez deja un fichier `.secrets`, il n'est pas modifie ni efface : la cle
Windows prend priorite. Apres verification d'une recherche, vous pouvez supprimer
vous-meme l'ancienne copie en clair. Une variable `MYTUBE_YOUTUBE_API_KEY` explicite
reste prioritaire pour le developpement. Les mises a jour conservent la cle chiffree.
Un logiciel malveillant execute sous votre compte peut encore y acceder.
[Details du stockage Windows](WINDOWS-KEY-STORAGE.md).

## 4. Charger l'extension et demarrer le connecteur

1. Ouvrez `chrome://extensions` et activez **Mode developpeur**.
2. Cliquez **Charger l'extension non empaquetee** et choisissez le sous-dossier
   `dist\brave` de MyTube. Ce nom historique correspond bien au package Chrome.
3. Copiez l'**ID public** affiche sur la fiche MyTube (32 lettres). Ce n'est pas une cle.
4. Dans PowerShell, remplacez le texte entre guillemets par cet ID, puis lancez :

```powershell
$env:MYTUBE_EXTENSION_ID = 'COLLEZ_ICI_LES_32_LETTRES_DE_L_ID'
npm.cmd run connector
```

Gardez ce terminal ouvert. La variable d'ID vaut pour ce terminal ; si vous en
ouvrez un nouveau, repetez les deux commandes. Le connecteur accepte uniquement
cet ID d'extension, pas tous les sites ni toutes les extensions.

## 5. Faire une premiere recherche

- Ouvrez MyTube depuis son icone dans Chrome et cliquez **New search**.
- Completez la connexion **ChatGPT** si elle est demandee. Un compte avec acces au
  flux utilise par MyTube est necessaire ; la cle YouTube ne remplace pas cette connexion.
- Decrivez ce que vous cherchez et cliquez **Find videos**. Si une clarification
  apparait, cliquez sur une proposition ou ecrivez une reponse puis **Continue**.
- Les videos apparaissent progressivement. **Save for later** garde un lien dans
  MyTube, sans telecharger le fichier video ; **Hide** masque une video.

**For you** propose des videos de vos recherches passees. **Last search** retrouve
les trois colonnes. **Past searches** conserve vos demandes lorsque Remember est
active. Les metadonnees video expirent apres 30 jours ; vos demandes restent jusqu'a
leur effacement. Les navigateurs ont des historiques separes, sans SQLite partage.

**Subscriptions** est facultatif et necessite une configuration OAuth Google
supplementaire et votre consentement YouTube. Une cle API seule ne donne pas acces
aux abonnements. Ne bloquez pas votre premiere recherche sur cette fonctionnalite.

## Utilisation suivante, mises a jour et depannage

- **Utilisation suivante :** demarrez le connecteur si necessaire, puis ouvrez MyTube.
  Ne lancez pas un deuxieme connecteur si le premier tourne deja.
- **Mise a jour :** gardez le meme dossier et l'installation existante. La cle Windows reste dans votre profil.
  Relancez l'installation des dependances et le build, puis **Recharger** sur la
  fiche MyTube de `chrome://extensions`, fermez l'ancien onglet et rouvrez MyTube.
  Si le connecteur a change, arretez-le avec Ctrl+C puis relancez-le. Une reconnexion
  ChatGPT peut etre necessaire. Ne supprimez pas l'extension pour la mettre a jour :
  sa suppression peut effacer ses donnees.
- **Port deja utilise :** arretez l'ancien terminal du connecteur avec Ctrl+C.
  Si vous ne le trouvez pas, demandez a un agent d'identifier le processus qui
  ecoute sur `127.0.0.1:43817`. Ne terminez pas tous les processus Node.
- **Versions incompatibles / `/interpret` absent :** redemarrez le connecteur mis a jour.
- **Images bloquees par CSP :** rechargez l'extension elle-meme, puis rouvrez son onglet.
  Effacez les anciennes erreurs ; si elles reviennent, transmettez leur message sans cle.
- **Acces refuse au connecteur :** verifiez l'ID de l'extension et la variable ci-dessus.
- **Erreur de cle :** verifiez l'activation de YouTube Data API v3 et ses restrictions,
  puis rouvrez `npm.cmd run key:setup`. Ne transmettez jamais la cle.
- **Quota epuise :** consultez les quotas Google du projet. Le repli Web peut etre
  disponible, mais ni un volume ni un delai de resultats ne sont garantis.

## Pour les developpeurs et les agents

Lisez [AGENTS.md](AGENTS.md) avant toute intervention. Les notes des anciennes
versions ne remplacent pas le fonctionnement courant decrit ici et dans le code.
Voir aussi [les versions](CHANGELOG.md), [la securite](SECURITY.md),
[le connecteur](connector/README.md) et [le setup prive](LOCAL-SETUP.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm.cmd test` | Build the current extension and run product checks without historical demo data |
| `npm.cmd run test:all` | Build both packages and the historical demo; run product, experiment and legacy checks |
| `npm.cmd run check:extension` | Rebuild and run the focused extension/UI checks |
| `npm.cmd run test:connector` | Connector, discovery and authentication-window checks |
| `npm.cmd run release:check` | Check the explicit publication allowlist and common credential patterns |
| `npm.cmd run extension:build` | Build without claiming tests passed |
| `npm.cmd run connector` | Start the local connector; Ctrl+C stops it and attempts sign-out |

Verification writes counts, scope and artifact hashes to `results/extension-build.json`. Test failures, skipped checks or changed artifacts prevent a pass. Offline success is not evidence of live recommendation quality, billing or browser compatibility. Tests use synthetic inputs and local loopback fixtures; they do not sign into provider accounts or consume provider quotas.

Product checks include shared bundle/newline tests and build-and-package checks
in a clean directory without Google configuration or historical datasets. The
verification runner is itself tested with an unavailable historical demo to
ensure the product scope remains independent. Historical inline-HTML CSP checks
remain in the full and focused extension suites.

Historical catalog ranking, angle caps and replacement-slot behavior live in
`poc/legacy-model.test.mjs`, alongside the legacy UI suite in the full and
focused extension checks. They are excluded from `npm test`; the current
column selection and filtering remain covered by product tests.

Keep test responsibilities distinct: component tests cover rendering, escaping
and export formats; UI tests cover wiring, progressive updates and persistence
across reopening. Storage and connector tests cover invalid inputs, migrations,
authentication and late responses. Add a regression for a distinct failure,
not another copy of the same assertions at every layer. Do not remove tests
just to reach a smaller count, or treat offline checks as latency measurements.

## Layout

| Path | Role |
| --- | --- |
| `poc/` | Shared UI source, isolated controls/renderers, search lifecycle, ranking/filtering, storage and historical demo build |
| `extension/` | Browser adapter, YouTube client, discovery, authentication window and packaging |
| `connector/` | Loopback server and memory-only ChatGPT session |
| `spikes/` | Feasibility experiments; some validated protocol utilities are still reused by the connector |
| `scripts/` | Reproducible verification workflow |
| `dist/` | Generated unpacked packages; edit source files instead |
| `results/` | Sanitized experiment and verification evidence |
| `.private/` | Ignored registration metadata and private experiment artifacts; never publish |

`package.json` is the release-version source for both the preview and extension manifests. Keep its version synchronized with the lockfile, for example with `npm.cmd version <version> --no-git-tag-version --ignore-scripts`, then rebuild and verify. Documentation-only housekeeping does not require a release bump.

## Current constraints

- Discovery is progressive. Column targets, provider retrieval limits and visible page sizes are separate. Scrolling reveals additional results already received; it does not guarantee new provider searches. Result counts and latency depend on providers and filters.
- DIRECT relevance and exploratory diversity depend on the web-search task and local selection. Public oEmbed confirms the title/channel, not semantic relevance or quality.
- Synthetic-production filtering uses explicit metadata disclosures. It does not analyze video, voice or publishing cadence, and cannot reliably exclude undisclosed AI-generated content.
- Search requests and received candidates are archived locally in IndexedDB when Remember is enabled, without a rolling search-count limit. Provider metadata expires after 30 days; request text remains until deleted. The small eight-topic working cache is not the full archive. Preferences and channel bans persist independently. ChatGPT credentials remain in connector memory; restarting it may require login again.
- Set MYTUBE_EXTENSION_ID to the installed extension ID. Google OAuth is optional for subscriptions. This is not yet a general installer.

See [extension usage](extension/README.md), [connector operation](connector/README.md), [security](SECURITY.md), and [release history](CHANGELOG.md). Experimental code remains under spikes/ because some protocol utilities are still used by the connector.
