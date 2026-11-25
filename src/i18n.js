// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. The connection status and the answers of the
// test button are { en, fr }; the errors of a command are English (one
// language per message, like the core's; they are logged).
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const wait = (ms) =>
  ms >= 120_000
    ? { en: `${Math.round(ms / 60_000)} min`, fr: `${Math.round(ms / 60_000)} min` }
    : { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
const both = (en, fr) => ({ en, fr });

/** Why CasaOS failed, in a few words (never a token, never a password). */
export function reasonOf(err) {
  switch (err?.kind) {
    case 'network':
      return both(`no connection (${err.message})`, `pas de connexion (${err.message})`);
    case 'timeout':
      return both('no answer in time', 'pas de réponse à temps');
    case 'tls':
      return both('certificate refused', 'certificat refusé');
    case 'size':
      return both('answer too large', 'réponse trop grande');
    case 'format':
      return both('not an answer of CasaOS', 'pas une réponse de CasaOS');
    case 'redirect':
      return both('redirection (wrong address?)', 'redirection (mauvaise adresse ?)');
    case 'http':
      return both(`HTTP ${err.status}`, `HTTP ${err.status}`);
    case 'login':
      return both(`login not accepted (${err.message})`, `connexion non acceptée (${err.message})`);
    default:
      return both('error', 'erreur');
  }
}

export const T = {
  status: {
    addressEmpty: both(
      'Type the address of CasaOS in the configuration (e.g. http://192.168.1.20).',
      "Saisissez l'adresse de CasaOS dans la configuration (ex. http://192.168.1.20).",
    ),
    addressInvalid: both(
      'The address of CasaOS is not valid: http://<IP or name>[:port], without a path.',
      "L'adresse de CasaOS n'est pas valide : http://<IP ou nom>[:port], sans chemin.",
    ),
    addressCredentials: both(
      'Put no user name nor password in the address: use the fields below it.',
      "Ne mettez ni utilisateur ni mot de passe dans l'adresse : utilisez les champs dessous.",
    ),
    credentials: {
      missing: both(
        'Type the user name and the password of a CasaOS account.',
        "Saisissez l'utilisateur et le mot de passe d'un compte CasaOS.",
      ),
      username: both(
        'A password without a user name: type the user name too.',
        "Un mot de passe sans nom d'utilisateur : saisissez aussi l'utilisateur.",
      ),
      password: both('Type the password of the account.', 'Saisissez le mot de passe du compte.'),
      invalid: both(
        'The user name or the password holds a control character or is too long.',
        "L'utilisateur ou le mot de passe contient un caractère de contrôle ou est trop long.",
      ),
    },
    refused: both(
      'CasaOS refused the user name or the password: correct them and save (nothing is tried again until then).',
      "CasaOS a refusé l'utilisateur ou le mot de passe : corrigez-les et enregistrez (rien n'est réessayé d'ici là).",
    ),
    configUnread: (ms) =>
      both(
        `The configuration could not be read from Gladys: next try in ${wait(ms).en}.`,
        `La configuration n'a pas pu être lue depuis Gladys : nouvel essai dans ${wait(ms).fr}.`,
      ),
    dataUnreadable: both(
      'The state file of the integration (/data) cannot be read: tried again every 10 s.',
      "Le fichier d'état de l'intégration (/data) est illisible : relu toutes les 10 s.",
    ),
    connecting: both('Connecting to CasaOS...', 'Connexion à CasaOS...'),
    paused: (ms) =>
      both(
        `CasaOS asked to wait (too many requests): next try in ${wait(ms).en}.`,
        `CasaOS a demandé d'attendre (trop de requêtes) : nouvel essai dans ${wait(ms).fr}.`,
      ),
    loginWait: (ms) =>
      both(
        `Login to CasaOS in ${wait(ms).en} (CasaOS accepts one login a minute).`,
        `Connexion à CasaOS dans ${wait(ms).fr} (CasaOS accepte une connexion par minute).`,
      ),
    failed: (err, ms) => {
      const r = reasonOf(err);
      return both(
        `CasaOS does not answer: ${r.en}. Next try in ${wait(ms).en}.`,
        `CasaOS ne répond pas : ${r.fr}. Nouvel essai dans ${wait(ms).fr}.`,
      );
    },
    ok: ({ running, stopped, partial }) => {
      const en = `Connected to CasaOS: ${running} app(s) running, ${stopped} stopped.`;
      const fr = `Connecté à CasaOS : ${running} application(s) en marche, ${stopped} arrêtée(s).`;
      if (partial === 'apps') {
        return both(
          `${en.replace(/: .*/, '')}; the apps could not be read this time.`,
          `${fr.replace(/ : .*/, '')} ; les applications n'ont pas pu être lues cette fois.`,
        );
      }
      if (partial === 'system') {
        return both(
          `${en} The system values could not be read this time.`,
          `${fr} Les valeurs du système n'ont pas pu être lues cette fois.`,
        );
      }
      return both(en, fr);
    },
  },
  test: {
    ok: (apps) =>
      both(
        `CasaOS answers: ${apps} app(s) offered in the Discovery tab.`,
        `CasaOS répond : ${apps} application(s) proposée(s) dans l'onglet Découverte.`,
      ),
    recent: (apps) =>
      both(
        `CasaOS answered at the last read: ${apps} app(s) offered (no new read before the interval).`,
        `CasaOS a répondu à la dernière lecture : ${apps} application(s) proposée(s) (pas de nouvelle lecture avant l'intervalle).`,
      ),
  },
  errors: {
    unknownFeature: 'Unknown device or feature: pick one of this integration',
    invalidValue: 'Invalid value: a press (1) expected',
    stopDisabled:
      'Stopping apps is off: allow it first in the configuration of the integration ("Allow stopping apps"). Nothing sent',
    notConnected: 'CasaOS is not connected (see the status of the integration). Nothing sent',
    refused: 'CasaOS refused the user name or the password. Nothing sent',
    paused: 'CasaOS asked to wait (too many requests). Nothing sent',
    busy: 'A command for this app is still running. Nothing sent',
    stopping: 'The previous command of this app is still being applied by CasaOS. Nothing sent',
    unknownApp: 'This app is not installed on CasaOS (any more). Nothing sent',
    gladys: 'The app running Gladys is never started nor stopped from Gladys. Nothing sent',
    unknownState: (status) =>
      `The app is neither running nor stopped (${status}): try again later. Nothing sent`,
    notRead: (reason) => `The app could not be read (${reason}). Nothing sent`,
    tooLate: 'No time left to send the command within the delay of Gladys. Nothing sent',
    configChanged: 'The configuration changed meanwhile. Nothing sent',
    rejected: (reason) => `CasaOS refused the command (${reason}). Nothing done`,
    notSent: (reason) => `The command could not be sent (${reason}). Nothing sent`,
    unconfirmed:
      'Sent to CasaOS, without confirmation yet: the state of the app follows (read again in 5 and 20 s)',
    testTooLong: 'No answer within 25 s: see the status of the integration',
    dataUnreadable: 'The state file of the integration (/data) cannot be read. Nothing sent',
  },
};
