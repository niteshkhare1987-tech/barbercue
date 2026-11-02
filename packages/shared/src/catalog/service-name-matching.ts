// Service-name search for /search: turns what a customer types ("hair cut", "shaving", "champi",
// "facail") into the service-name substrings a salon's own Service rows are matched against.
// Salons name the same treatment differently, so each group below lists only names that mean the
// SAME service. Treatments that are merely related (Facial vs Face Massage vs Face Bleach, Beard
// Trim vs Shave) are deliberately separate groups and never merged — a customer searching one is
// never shown salons that only offer the other.

export interface ServiceNameGroup {
  id: string;
  /** The one name the Service field suggests for every equivalent name in this group. */
  label: string;
  /** Substrings of a real Service.name that count as this service (case-insensitive). */
  match: readonly string[];
  /** Extra ways customers type it (Hinglish, shorthand) — recognised in the query only, never
   * matched against service names, because some are too broad on their own ("cutting"). */
  aliases?: readonly string[];
  /** A service name containing any of these is not this service even when `match` hits. */
  exclude?: readonly string[];
}

export const SERVICE_NAME_GROUPS: readonly ServiceNameGroup[] = [
  {
    id: 'haircut',
    label: 'Haircut',
    match: [
      'haircut', 'hair cut', 'hair cutting', 'haircutting', 'hair trim', 'buzz cut', 'crew cut',
      'skin fade', 'zero fade', 'हेयरकट', 'हेयर कट', 'बाल कटाई',
    ],
    aliases: ['cutting', 'baal katna', 'bal katna', 'baal kataai', 'bal katai', 'baal cutting', 'bal cutting', 'hair kat'],
  },
  {
    id: 'shave',
    label: 'Shave',
    match: ['shave', 'shaving', 'शेव', 'दाढ़ी बनाना'],
    aliases: ['dadhi banana', 'dadi banana', 'daadhi banana', 'dadhi banwana', 'clean shave'],
    exclude: ['head shave', 'head shaving'],
  },
  {
    id: 'beard-trim',
    label: 'Beard Trim',
    match: [
      'beard trim', 'beard trimming', 'beard shape', 'beard shaping', 'beard styling', 'beard style',
      'beard setting', 'beard set', 'beard line', 'दाढ़ी ट्रिम',
    ],
    aliases: ['dadhi trim', 'dadi trim', 'dadhi set', 'dadhi setting', 'dadi setting', 'beard cut'],
  },
  {
    id: 'moustache-trim',
    label: 'Moustache Trim',
    match: ['moustache', 'mustache', 'मूंछ'],
    aliases: ['mooch', 'moonch', 'much trim'],
  },
  {
    id: 'head-massage',
    label: 'Head Massage',
    match: [
      'head massage', 'head massaz', 'head massag', 'head oil massage', 'scalp massage', 'hair oil massage',
      'champi', 'chumpi', 'champee', 'sir ki malish', 'sar ki malish', 'सिर की मालिश', 'चंपी',
    ],
    aliases: ['head malish', 'sir malish', 'sar malish', 'head masaj', 'tel malish'],
  },
  {
    id: 'face-massage',
    label: 'Face Massage',
    match: ['face massage', 'chehre ki malish', 'चेहरे की मालिश'],
    aliases: ['face malish', 'chehra malish'],
  },
  {
    id: 'facial',
    label: 'Facial',
    match: ['facial', 'फेशियल'],
    aliases: ['fecial', 'fesial', 'face facial'],
  },
  {
    id: 'face-bleach',
    label: 'Bleach',
    match: ['bleach', 'ब्लीच'],
    aliases: ['blich'],
  },
  {
    id: 'cleanup',
    label: 'Cleanup',
    match: ['cleanup', 'clean up', 'clean-up'],
  },
  {
    id: 'detan',
    label: 'Detan',
    match: ['detan', 'de-tan', 'de tan', 'd-tan', 'd tan'],
  },
  {
    id: 'hair-color',
    label: 'Hair Colour',
    match: [
      'hair color', 'hair colour', 'hair coloring', 'hair colouring', 'hair dye', 'hair dyeing',
      'global color', 'global colour', 'root touch', 'हेयर कलर',
    ],
    aliases: ['dye', 'baal rangna', 'bal rangna', 'hair kala', 'baal kala', 'hair colur'],
  },
  {
    id: 'hair-spa',
    label: 'Hair Spa',
    match: ['hair spa', 'hairspa', 'nourishment spa', 'हेयर स्पा'],
    aliases: ['spa for hair'],
  },
  {
    id: 'hair-wash',
    label: 'Hair Wash',
    match: ['hair wash', 'hairwash', 'shampoo'],
    aliases: ['baal dhona', 'bal dhona', 'head wash'],
  },
  {
    id: 'threading',
    label: 'Threading',
    match: ['threading', 'थ्रेडिंग'],
    aliases: ['eyebrow threading', 'aibro', 'eye brow', 'bhau'],
  },
  {
    id: 'waxing',
    label: 'Waxing',
    match: ['wax', 'वैक्स'],
    aliases: ['waxing'],
  },
  {
    id: 'manicure',
    label: 'Manicure',
    match: ['manicure', 'मैनीक्योर'],
  },
  {
    id: 'pedicure',
    label: 'Pedicure',
    match: ['pedicure', 'पेडीक्योर'],
  },
  {
    id: 'makeup',
    label: 'Makeup',
    match: ['makeup', 'make up', 'make-up', 'मेकअप'],
  },
  {
    id: 'hair-straightening',
    label: 'Hair Straightening',
    match: ['straightening', 'straighten'],
    aliases: ['straightner', 'straightener'],
  },
  {
    id: 'smoothening',
    label: 'Smoothening',
    match: ['smoothening', 'smoothing'],
  },
  {
    id: 'rebonding',
    label: 'Rebonding',
    match: ['rebonding', 're-bonding', 're bonding'],
  },
  {
    id: 'keratin',
    label: 'Keratin',
    match: ['keratin'],
  },
];

/** Lowercase, Unicode-normalised, punctuation turned into spaces, whitespace collapsed. */
export function normalizeServiceText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

// "facials" → "facial", "haircuts" → "haircut"; "glass", "highlights" stay recognisable because
// only a single trailing "s" after a non-"s" Latin letter is dropped, never "ss".
function singular(word: string): string {
  return word.length > 3 && /[a-rt-z]s$/.test(word) ? word.slice(0, -1) : word;
}

function keyWords(text: string): string[] {
  return normalizeServiceText(text).split(' ').filter(Boolean).map(singular);
}

/** Comparison key: normalised, singular words, no spaces ("Hair Cuts" and "haircut" agree). */
function compactKey(text: string): string {
  return keyWords(text).join('');
}

/** Optimal-string-alignment distance: insertions, deletions, substitutions and adjacent swaps. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

// Per WORD, so a slip inside a word is forgiven but a different word is not ("nail cutting" is
// not "hair cutting"). Three-letter words get none ("wax" must not become "max").
function typoAllowance(length: number): number {
  return length < 4 ? 0 : length < 8 ? 1 : 2;
}

/**
 * Typo distance between a query and a known name, or undefined when too far apart: either the same
 * number of words, each within its own allowance, or (for run-together/split words like "hiarspa")
 * one slip across the whole compact key.
 */
function typoDistance(queryWords: string[], formWords: string[]): number | undefined {
  if (queryWords.length === formWords.length) {
    let total = 0;
    for (let i = 0; i < queryWords.length; i++) {
      const allowance = typoAllowance(formWords[i].length);
      const distance = editDistance(queryWords[i], formWords[i], allowance);
      if (distance > allowance) return undefined;
      total += distance;
    }
    return total;
  }
  const query = queryWords.join('');
  const form = formWords.join('');
  if (form.length < 5) return undefined;
  const distance = editDistance(query, form, 1);
  return distance <= 1 ? distance : undefined;
}

// Containment ("gents haircut" contains "haircut") needs a form long enough not to hit by chance.
const MIN_CONTAINED_FORM_LENGTH = 5;

const GROUP_FORMS = SERVICE_NAME_GROUPS.map((group) => ({
  group,
  keys: [...new Set([...group.match, ...(group.aliases ?? [])].map(compactKey))],
  words: [...group.match, ...(group.aliases ?? [])].map(keyWords),
  // Containment uses real service names only: an alias like "cutting" inside "nail cutting" must
  // not turn a nail search into a haircut search.
  matchKeys: [...new Set(group.match.map(compactKey))],
  excludeKeys: (group.exclude ?? []).map(compactKey),
}));

/**
 * Which service group a customer's search means, or undefined when it is not one we know.
 * 1. exact (after normalising case, punctuation, spacing and plurals);
 * 2. the query contains exactly one group's name ("gents haircut", "beard shave");
 * 3. a small typo of one group's name ("facail", "hair colur", "head massaj").
 */
export function resolveServiceNameGroup(query: string): ServiceNameGroup | undefined {
  const key = compactKey(query);
  if (key.length < 2) return undefined;
  // A search for something a group explicitly is NOT ("head shave" vs Shave) is never that group.
  const candidates = GROUP_FORMS.filter(({ excludeKeys }) => !excludeKeys.some((form) => key.includes(form)));

  const exact = candidates.find(({ keys }) => keys.includes(key));
  if (exact) return exact.group;

  const containing = candidates.filter(({ matchKeys }) =>
    matchKeys.some((form) => form.length >= MIN_CONTAINED_FORM_LENGTH && key.includes(form)),
  );
  // Several different services in one query ("facial cleanup") is ambiguous — no guessing.
  if (containing.length === 1) return containing[0].group;
  if (containing.length > 1) return undefined;

  const queryWords = keyWords(query);
  let best: { group: ServiceNameGroup; distance: number } | undefined;
  for (const { group, words } of candidates) {
    for (const formWords of words) {
      const distance = typoDistance(queryWords, formWords);
      if (distance !== undefined && (!best || distance < best.distance)) best = { group, distance };
    }
  }
  return best?.group;
}

export interface ServiceNameSearch {
  /** A service matches when its name contains any of these (case-insensitive)… */
  match: string[];
  /** …and none of these. */
  exclude: string[];
}

/**
 * The service-name substrings to filter salons by for a customer's search text. A recognised
 * service expands to every equivalent name; anything else falls back to the text as typed (plus its
 * normalised and singular forms) so an unusual service is still found by its own name.
 */
export function expandServiceNameSearch(query: string): ServiceNameSearch {
  const typed = query.trim();
  const normalized = normalizeServiceText(typed);
  const group = resolveServiceNameGroup(typed);
  const fallback = [typed, normalized, normalized.split(' ').map(singular).join(' ')];
  const match = group ? [...group.match, ...fallback] : fallback;
  return {
    match: [...new Set(match.filter((term) => term.length > 0))],
    exclude: [...(group?.exclude ?? [])],
  };
}

/** Pure version of the server-side rule: does a service with this name answer the search? */
export function serviceNameMatches(search: ServiceNameSearch, serviceName: string): boolean {
  const name = serviceName.toLowerCase();
  return (
    search.match.some((term) => name.includes(term.toLowerCase())) &&
    !search.exclude.some((term) => name.includes(term.toLowerCase()))
  );
}

/**
 * Service-field suggestions with equivalent names merged: every name that resolves to the same
 * group ("Haircut", "Gents Haircut", "Hair Cutting") becomes that group's one label, since picking
 * any of them returns the same salons. Other names stay as they are, de-duplicated ignoring case.
 * Keeps first-appearance order.
 */
export function mergeServiceSuggestions(names: readonly string[]): string[] {
  const merged = new Map<string, string>();
  for (const name of names) {
    const group = resolveServiceNameGroup(name);
    const key = group ? `group:${group.id}` : `name:${normalizeServiceText(name)}`;
    if (!merged.has(key)) merged.set(key, group ? group.label : name);
  }
  return [...merged.values()];
}
