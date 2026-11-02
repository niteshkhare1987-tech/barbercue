import {
  expandServiceNameSearch,
  normalizeServiceText,
  resolveServiceNameGroup,
  serviceNameMatches,
} from '../catalog/service-name-matching';

const matches = (query: string, serviceName: string) =>
  serviceNameMatches(expandServiceNameSearch(query), serviceName);

describe('service name search', () => {
  it('normalises case, punctuation and spacing', () => {
    expect(normalizeServiceText('  Hair-Cut / Beard ')).toBe('hair cut beard');
  });

  // The owner's examples table: each search finds every equivalent name salons actually use.
  it.each([
    ['Haircut', ['Hair Cut', 'Hair Cutting', 'Gents Haircut', 'Hair Trim', 'Kids Haircut']],
    ['Shave', ['Shaving', 'Clean Shave', 'Beard Shave', 'Premium/Luxury Shave']],
    ['Head Massage', ['Head Massaz', 'Champi', 'Scalp Massage', 'Head Oil Massage']],
    ['Beard Trim', ['Beard Trimming', 'Beard Shape', 'Beard Shape/Line-up']],
    ['Facial', ['Face Facial', 'Glow Facial', 'Facial Treatment']],
    ['Hair Color', ['Hair Colour', 'Hair Coloring', 'Hair Dye', 'Global Colour']],
    ['Hair Spa', ['Hair Spa Treatment', 'Hair Nourishment Spa']],
  ])('"%s" matches its equivalent service names', (query, names) => {
    for (const name of names) expect([name, matches(query, name)]).toEqual([name, true]);
  });

  it.each([
    ['hair cut', 'haircut'],
    ['HAIRCUTS', 'haircut'],
    ['hair-cut', 'haircut'],
    ['gents haircut', 'haircut'],
    ['cutting', 'haircut'],
    ['baal katna', 'haircut'],
    ['shaving', 'shave'],
    ['dadhi banana', 'shave'],
    ['beard shave', 'shave'],
    ['champi', 'head-massage'],
    ['sir ki malish', 'head-massage'],
    ['facials', 'facial'],
    ['facail', 'facial'],
    ['fesial', 'facial'],
    ['hair colur', 'hair-color'],
    ['hair dye', 'hair-color'],
    ['hiar spa', 'hair-spa'],
    ['haed masage', 'head-massage'],
    ['beard triming', 'beard-trim'],
    ['फेशियल', 'facial'],
  ])('recognises "%s" as %s (synonyms, plurals, typos, Hinglish, Hindi)', (query, groupId) => {
    expect(resolveServiceNameGroup(query)?.id).toBe(groupId);
  });

  // Related but different treatments stay apart.
  it.each([
    ['Facial', 'Face Massage'],
    ['Facial', 'Face Bleach'],
    ['Facial', 'Fruit Cleanup'],
    ['Face Massage', 'Gold Facial'],
    ['Head Massage', 'Face Massage'],
    ['Head Massage', 'Full Body Massage'],
    ['Beard Trim', 'Clean Shave'],
    ['Shave', 'Beard Trim'],
    ['Shave', 'Head Shave'],
    ['Haircut', 'Hair Spa'],
    ['Haircut', 'Moustache Trim'],
    ['Hair Color', 'Beard Colour'],
    ['Hair Spa', 'Hair Wash'],
  ])('"%s" does not match "%s"', (query, name) => {
    expect(matches(query, name)).toBe(false);
  });

  it('does not let a broad alias capture another service ("nail cutting" is not a haircut)', () => {
    expect(resolveServiceNameGroup('nail cutting')).toBeUndefined();
    expect(matches('nail cutting', 'Gents Haircut')).toBe(false);
  });

  it('a search for an excluded variant is still found by its own name', () => {
    expect(resolveServiceNameGroup('head shave')).toBeUndefined();
    expect(matches('head shave', 'Head Shave')).toBe(true);
  });

  it('never guesses between two services in one query', () => {
    expect(resolveServiceNameGroup('facial cleanup')).toBeUndefined();
  });

  it('gives short words no typo allowance', () => {
    expect(resolveServiceNameGroup('max')).toBeUndefined();
    expect(matches('wax', 'Full Arms Waxing')).toBe(true);
  });

  it('falls back to the typed text for a service it does not know', () => {
    expect(resolveServiceNameGroup('Saree Draping')).toBeUndefined();
    expect(expandServiceNameSearch('Saree Draping').match).toContain('Saree Draping');
    expect(matches('Saree Draping', 'Saree Draping')).toBe(true);
    expect(matches('Saree Draping', 'Bridal Makeup')).toBe(false);
  });
});
