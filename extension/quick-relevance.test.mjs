import test from 'node:test';
import assert from 'node:assert/strict';
import { conciseQuickQuery, quickApiQuery, matchesQuickSubject, quickSubjectTerms } from './quick-relevance.mjs';

test('a long conversational paragraph can start with its named lead topic without weakening cache matching', () => {
  const request = 'Je m’intéresse aux Conversos, tous ces Juifs qui se sont convertis apparemment en Espagne. ' + 'Je veux comprendre leur histoire et leurs traditions. '.repeat(8);
  assert.equal(conciseQuickQuery(request), null);
  assert.equal(quickApiQuery(request), 'Conversos');
  assert.equal(matchesQuickSubject({ title: 'Conversos' }, request), false);
  assert.equal(quickApiQuery(request + ' sans fiction'), null);
  assert.equal(quickApiQuery('Mayas, Olmèques, Aztèques'), 'Mayas, Olmèques, Aztèques');
});

test('conversational requests retain subjects and exclusions without lossy truncation', () => {
  assert.equal(conciseQuickQuery('Je suis intéressé par les conversos, toutes les histoires de Juifs et de familles juives qui se sont converties tout en continuant de pratiquer leur religion, ainsi que toutes les histoires qui gravitent autour de ça. Les Juifs cryptiques, ou je ne sais trop quoi, en Turquie, en Espagne, partout dans le monde, tout ça.'), 'conversos');
  assert.equal(conciseQuickQuery('Mayas, Olmèques, Aztèques'), 'Mayas, Olmèques, Aztèques');
  assert.equal(conciseQuickQuery('Conversos, toutes les histoires sans fiction'), 'Conversos, toutes les histoires sans fiction');
  assert.equal(conciseQuickQuery("J’aimerais savoir plein de choses sur les Mayas et plein de choses apparentées."), 'Mayas');
  assert.deepEqual(quickSubjectTerms("J’aimerais savoir plein de choses sur les Mayas et plein de choses apparentées."), ['maya']);
  assert.equal(conciseQuickQuery('Je voudrais quelque chose sur les Açores, sans croisières'), 'Açores, sans croisières');
  assert.deepEqual(quickSubjectTerms('Je voudrais quelque chose sur les Açores, sans croisières'), ['azore']);
  assert.equal(conciseQuickQuery('long request '.repeat(50)), null);
});

test('fast results need subject evidence per video, not generic words, channel names or substrings', () => {
  const request = "J'AIMERAIS SAVOIR PLEIN DE CHOSES SUR LES MAYAS ET PLEIN DE CHOSES APPARENTÉES.";
  assert.equal(matchesQuickSubject({ title: 'The Maya civilization' }, request), true);
  assert.equal(matchesQuickSubject({ title: 'Mayan archaeology' }, request), true);
  assert.equal(matchesQuickSubject({ title: 'Les cités des Mayas' }, request), true);
  assert.equal(matchesQuickSubject({ title: 'Thugs Corner a Rickshaw Driver', channel: 'Maya history' }, request), false);
  assert.equal(matchesQuickSubject({ title: 'Mayascope action movie' }, request), false);
  assert.equal(matchesQuickSubject({ title: 'Machu volcano', description: 'Peru' }, 'Machu Picchu'), false);
  assert.equal(matchesQuickSubject({ title: 'Machu Picchu archaeology' }, 'Machu Picchu'), true);
  assert.equal(matchesQuickSubject({ title: 'Anything about history' }, 'I want something interesting'), false);
});
