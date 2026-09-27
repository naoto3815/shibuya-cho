// Known before chapter one. Later truths require explicit story:reveal events.
export const INITIAL_FACTS = ['letter', 'company', 'past_case'];
export const STORY_REVISION = 2;
export function migrateStorySave(save) {
  if (!save) return null;
  const facts = new Set([...INITIAL_FACTS, ...save.facts]);
  // The original prototype ended immediately after Hachiko (step 3).
  // Resume those saves at the new Center Gai objective without losing money or sidequests.
  const step = save.step === 3 && !facts.has('fightclub_allies') ? 4 : save.step;
  facts.delete('messengers');
  if ([3, 4, 6].includes(step)) {
    for (const key of ['junior', 'gang', 'hiiragi_whereabouts']) facts.add(key);
  }
  return { ...save, storyRevision: STORY_REVISION, step, facts: [...facts] };
}
