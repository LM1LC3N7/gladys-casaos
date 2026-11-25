# CasaOS

Gladys lit votre serveur domestique [CasaOS](https://casaos.zimaspace.com/) par son API locale :
la charge du processeur, la mémoire, le disque système, les températures, et les applications
installées depuis le magasin d'applications de CasaOS. Chaque application devient un appareil
Gladys avec des boutons **Démarrer** et **Arrêter**.

Intégration non officielle, sans lien avec IceWhale (l'éditeur de CasaOS et ZimaOS).

> Testé avec CasaOS 0.4.15 en conteneur (l'image `dockurr/casa`), avec une application de test
> installée, démarrée et arrêtée. Jamais testé avec un vrai appareil (une vraie machine CasaOS,
> ses capteurs et ses disques). ZimaOS n'est pas vérifié : son API peut différer.

## Ce que vous obtenez

- **Le serveur** (un appareil) : CPU (%), température du CPU, mémoire (% et Mo utilisés), disque
  système (% utilisé et Go libres), applications en marche et arrêtées, et la température de
  chaque disque physique listé par CasaOS. Une température que CasaOS donne à 0 (pas de capteur,
  une machine virtuelle) reste inconnue, jamais affichée 0 °C.
- **Chaque application** (un appareil par application) : en marche (oui / non), mise à jour
  disponible (oui / non), et les boutons **Démarrer** et **Arrêter**. L'application qui fait
  tourner Gladys elle-même (reconnue à « gladys » dans son identifiant, son titre ou le nom de son
  image) n'est jamais proposée.

Les valeurs sont lues chaque minute par défaut (de 30 s à 1 h), les disques toutes les 5 minutes.

## Configuration

1. **Adresse de CasaOS** : celle avec laquelle vous ouvrez CasaOS, `http://192.168.1.20`
   (ajoutez `:port` s'il n'est pas 80). `https://` seulement derrière un proxy inverse dont le
   certificat vient d'une autorité reconnue ; un certificat auto-signé est refusé. Sans chemin.
2. **Nom d'utilisateur** et **mot de passe** de votre compte CasaOS. Le mot de passe est gardé
   par Gladys dans sa base, jamais réaffiché, et envoyé seulement à CasaOS, à la connexion. En
   `http://` il traverse votre réseau local en clair, comme quand vous vous connectez à la page
   de CasaOS.
3. **Rafraîchissement** : la fréquence de lecture de CasaOS.
4. **Permettre d'arrêter les applications** : désactivé par défaut (voir plus bas).
5. Enregistrez, puis ajoutez les appareils depuis l'onglet **Découverte**.

### Une connexion, puis la session

CasaOS accepte cinq connexions, puis **une connexion par minute, pour tous ses clients** (votre
navigateur compris). L'intégration se connecte une fois, puis renouvelle sa session avec le
jeton de renouvellement que donne CasaOS (sans mot de passe). Elle ne se connecte pas deux
fois en une minute, même après un redémarrage de l'intégration (l'heure de la dernière connexion
est écrite dans `/data` avant l'envoi de la connexion).

Si CasaOS refuse l'utilisateur ou le mot de passe, l'intégration s'arrête et le dit : rien n'est
réessayé tant que vous n'enregistrez pas la configuration ou n'appuyez pas sur **Tester la
connexion**. Le refus est retenu d'un redémarrage à l'autre sous forme d'une marque de 6 bits
(qui ne peut jamais révéler le mot de passe).

## Démarrer et arrêter une application

- **Démarrer** ne demande aucune option.
- **Arrêter** peut couper un service de la maison (une base de données, un broker MQTT, un
  enregistreur de caméras utilisé par Gladys) : c'est **désactivé par défaut**. Cochez
  **Permettre d'arrêter les applications** pour l'utiliser. L'option est vérifiée à l'arrivée de
  l'appui et de nouveau juste avant l'envoi de la commande.
- Ce sont des boutons, jamais un interrupteur : un assistant vocal ou un « tout éteindre » ne les
  atteint pas.

Chaque appui lit d'abord l'application. La commande est refusée, et rien n'est envoyé, quand :

- l'arrêt n'est pas permis (Arrêter seulement) ;
- l'application est celle qui fait tourner Gladys (son identifiant, son titre ou le nom de son
  image contient « gladys ») ;
- l'application n'est plus installée, ou CasaOS ne la montre ni en marche ni arrêtée (en pause,
  en redémarrage) ;
- l'utilisateur ou le mot de passe a été refusé, CasaOS a demandé d'attendre (HTTP 429),
  l'intégration n'est pas connectée, ou la configuration a changé entre-temps ;
- une autre commande de la même application est en cours, ou la précédente est encore en cours
  d'application ;
- le temps restant dans les 5 s qu'attend Gladys est trop court.

Quand l'application est déjà dans l'état demandé, rien n'est envoyé et l'appui réussit.

CasaOS applique une commande en arrière-plan. L'appui ne réussit que lorsqu'une lecture montre
l'application dans l'état demandé ; sinon Gladys reçoit « envoyée, sans confirmation », et
l'application est relue 5 s et 20 s après la commande (l'état publié alors est celui lu). Une
commande n'est jamais envoyée deux fois.

## Dépannage

- **« Connexion à CasaOS dans N s »** : CasaOS accepte une connexion par minute ; l'intégration
  attend.
- **« CasaOS a refusé l'utilisateur ou le mot de passe »** : corrigez-les et enregistrez.
- **« pas une réponse de CasaOS »** : l'adresse mène à un autre serveur web.
- **« CasaOS a demandé d'attendre »** : trop de requêtes ; lectures et commandes sont en pause
  (de 1 min à 6 h, gardée d'un redémarrage à l'autre).
- L'intégration journalise ce qu'elle fait (`LOG_LEVEL=debug` pour plus), jamais un mot de passe
  ni un jeton.

## Limites

- Un serveur CasaOS par intégration. Jusqu'à 100 applications et 16 disques.
- L'état de santé des disques donné par CasaOS n'est pas utilisé : il vaut `true` dès que SMART
  ne donne rien.
- Les applications installées hors du magasin de CasaOS (un simple `docker run`) ne sont pas
  listées comme applications par CasaOS, donc pas ici non plus.
