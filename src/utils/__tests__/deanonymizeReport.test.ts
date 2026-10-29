import { describe, it, expect } from 'vitest';
import { buildAnonymizationDictionaryFromTexts, applyAnonymization } from '../anonymizeUtils';
import {
  anonymizeText, countRealIdentifiers, countUnresolvedAliases, repointViewerLinks, unanonymizeReport, type DeanonymizeSource,
} from '../deanonymizeReport';

const SALT = 'test-salt';
const APP = 'https://manuroe.github.io/shakeview/';
const EMPTY = { forward: {}, reverse: {} };

describe('unanonymizeReport', () => {
  it('reverses aliases with every mapping at once', async () => {
    const a = await buildAnonymizationDictionaryFromTexts(['@alice:matrix.org'], SALT);
    const b = await buildAnonymizationDictionaryFromTexts(['@bob:example.com'], SALT);
    const report = `${applyAnonymization('@alice:matrix.org', a)} invited ${applyAnonymization('@bob:example.com', b)}.`;

    expect(unanonymizeReport(report, [
      { anonymizedName: 'one-anonym.tar.gz', dict: a, rawUrl: null },
      { anonymizedName: 'two-anonym.log', dict: b, rawUrl: null },
    ])).toBe('@alice:matrix.org invited @bob:example.com.');
  });

  it('returns the report unchanged without mappings', () => {
    expect(unanonymizeReport('@user-0123456789ab:domain-01234567.org', []))
      .toBe('@user-0123456789ab:domain-01234567.org');
  });
});

describe('repointViewerLinks', () => {
  const sources: DeanonymizeSource[] = [
    { anonymizedName: 'one-anonym.tar.gz', dict: EMPTY, rawUrl: 'blob:https://manuroe.github.io/123' },
  ];

  it('points a link into a held archive at its raw copy, keeping file and line', () => {
    const out = repointViewerLinks(
      '[15:25](http://127.0.0.1:7357/#/logs?archive=/cases/c/shakes/one-anonym.tar.gz&file=console.log&line=12)',
      sources, APP,
    );
    const href = out.slice(out.indexOf('(') + 1, -1);
    expect(href.startsWith(`${APP}#/logs?`)).toBe(true);
    const params = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    expect(params.get('archive')).toBe('blob:https://manuroe.github.io/123');
    expect(params.get('file')).toBe('console.log');
    expect(params.get('line')).toBe('12');
  });

  it('leaves links into other archives alone', () => {
    const link = '[x](http://127.0.0.1:7357/#/logs?archive=/cases/c/shakes/unknown-anonym.tar.gz&line=3)';
    expect(repointViewerLinks(link, sources, APP)).toBe(link);
  });
});

describe('countUnresolvedAliases', () => {
  it('counts each alias left once, encoded or not, and ignores real identifiers', () => {
    const alias = '@user-0123456789ab:domain-01234567.org';
    expect(countUnresolvedAliases(`${alias} met ${alias} and @alice:example.org in %21room-0123456789ab%3Adomain-01234567.org`)).toBe(2);
    expect(countUnresolvedAliases('@alice:example.org')).toBe(0);
  });
});

describe('anonymizeText', () => {
  it('anonymises with the salt alone, as the rageshake would, and returns the mapping to read it back', async () => {
    const text = '@alice:matrix.org left !abc:matrix.org';
    const out = await anonymizeText(text, SALT, []);

    const dict = await buildAnonymizationDictionaryFromTexts([text], SALT);
    expect(out.text).toBe(applyAnonymization(text, dict));
    expect(unanonymizeReport(out.text, [{ anonymizedName: '', dict: out.dict, rawUrl: null }])).toBe(text);
  });

  it('leaves aliases already in the text as they are', async () => {
    const alias = '@user-0123456789ab:domain-01234567.org';
    const out = await anonymizeText(`${alias} and @alice:matrix.org`, SALT, []);

    expect(out.text.startsWith(`${alias} and @user-`)).toBe(true);
    expect(Object.keys(out.dict.forward)).not.toContain(alias);
    expect(countRealIdentifiers(out.text)).toBe(0);
  });

  it('leaves aliases as they are even when a loaded rageshake logged them', async () => {
    const alias = '@user-0123456789ab:domain-01234567.org';
    const dict = await buildAnonymizationDictionaryFromTexts([alias], SALT);
    const out = await anonymizeText(alias, SALT, [{ anonymizedName: 'x', dict, rawUrl: null }]);

    expect(out.text).toBe(alias);
  });
});

describe('countRealIdentifiers', () => {
  it('counts Matrix IDs and URL hosts that are not aliases, once each', () => {
    expect(countRealIdentifiers('@alice:example.org, @alice:example.org on https://matrix.example.org/x')).toBe(2);
    expect(countRealIdentifiers('@user-0123456789ab:domain-01234567.org on https://domain-01234567.org/x')).toBe(0);
  });
});
