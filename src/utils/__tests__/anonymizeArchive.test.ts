import { describe, it, expect, vi } from 'vitest';
import { decompressSync, gzipSync, strToU8, strFromU8 } from 'fflate';
import { parseTar } from '../tarParser';
import { anonymiseDroppedFile, buildAnonymisedArchiveGz, buildArchiveDictionary, deriveAnonymizedArchiveName } from '../anonymizeArchive';
import { buildTar } from '../tarWriter';
import { roomCount } from '../roomCount';

const SALT = 'test-salt';
const USER_RE = /@user-[0-9a-f]{12}:domain-[0-9a-f]{8}\.org/;

describe('deriveAnonymizedArchiveName', () => {
  it('inserts -anonym before the extension and always ends .tar.gz', () => {
    expect(deriveAnonymizedArchiveName('rageshake.tar.gz')).toBe('rageshake-anonym.tar.gz');
    expect(deriveAnonymizedArchiveName('rageshake.tgz')).toBe('rageshake-anonym.tar.gz');
    expect(deriveAnonymizedArchiveName('rageshake.tar')).toBe('rageshake-anonym.tar.gz');
    expect(deriveAnonymizedArchiveName(null)).toBe('archive-anonym.tar.gz');
  });
});

describe('buildAnonymisedArchiveGz', () => {
  it('anonymises text files with cross-file aliases, drops binaries, keeps text names', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 255]);
    const entries = [
      { name: 'console.log.gz', data: gzipSync(strToU8('user @alice:matrix.org joined')) },
      { name: 'details.json', data: strToU8('{"userId":"@alice:matrix.org"}') },
      { name: 'screenshot.png', data: png },
    ];

    const gz = await buildAnonymisedArchiveGz(entries, SALT);
    const tar = parseTar(decompressSync(gz));
    const byName = Object.fromEntries(tar.map((e) => [e.name, e]));

    // Text names unchanged; the image is gone, replaced by a marker.
    expect(Object.keys(byName).sort()).toEqual(['console.log.gz', 'details.json', 'screenshot.png.removed']);

    const logText = strFromU8(decompressSync(byName['console.log.gz'].data));
    const jsonText = strFromU8(byName['details.json'].data);

    expect(logText).not.toContain('@alice:matrix.org');
    expect(logText).toMatch(USER_RE);

    // Cross-file consistency: same alias in both text files.
    const alias = logText.match(USER_RE)![0];
    expect(jsonText).toContain(alias);
    expect(jsonText).not.toContain('@alice:matrix.org');

    // The marker carries none of the original bytes, only the explanatory note.
    expect(strFromU8(byName['screenshot.png.removed'].data)).toMatch(/could not be anonymized/);
  });

  it('drops a mislabelled/corrupt .gz member instead of throwing', async () => {
    const notGz = new Uint8Array([1, 2, 3, 4, 5]); // no gzip header
    const entries = [
      { name: 'a.log', data: strToU8('@alice:matrix.org') },
      { name: 'weird.gz', data: notGz },
    ];
    const tar = parseTar(decompressSync(await buildAnonymisedArchiveGz(entries, SALT)));
    const byName = Object.fromEntries(tar.map((e) => [e.name, e]));
    // Valid text member still anonymised.
    expect(strFromU8(byName['a.log'].data)).not.toContain('@alice:matrix.org');
    // Undecompressable .gz dropped, marker left behind.
    expect(byName['weird.gz']).toBeUndefined();
    expect(strFromU8(byName['weird.gz.removed'].data)).toMatch(/could not be anonymized/);
  });

  it('drops an extensionless binary member (no text corruption, no raw passthrough)', async () => {
    const binary = new Uint8Array([0, 1, 2, 0, 255, 100]); // null bytes → binary
    const entries = [
      { name: 'a.log', data: strToU8('@alice:matrix.org') },
      { name: 'coredump', data: binary }, // extensionless, would otherwise decode as text
    ];
    const tar = parseTar(decompressSync(await buildAnonymisedArchiveGz(entries, SALT)));
    const byName = Object.fromEntries(tar.map((e) => [e.name, e]));
    expect(strFromU8(byName['a.log'].data)).not.toContain('@alice:matrix.org');
    expect(byName['coredump']).toBeUndefined();
    expect(strFromU8(byName['coredump.removed'].data)).toMatch(/could not be anonymized/);
  });

  it('drops a .gz member when decompression throws', async () => {
    // Valid gzip magic (1f 8b) but a truncated/corrupt body → decompressSync throws.
    const corruptGz = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]);
    const entries = [
      { name: 'a.log', data: strToU8('@alice:matrix.org') },
      { name: 'broken.log.gz', data: corruptGz },
    ];
    const tar = parseTar(decompressSync(await buildAnonymisedArchiveGz(entries, SALT)));
    const byName = Object.fromEntries(tar.map((e) => [e.name, e]));
    expect(strFromU8(byName['a.log'].data)).not.toContain('@alice:matrix.org');
    expect(byName['broken.log.gz']).toBeUndefined();
    expect(strFromU8(byName['broken.log.gz.removed'].data)).toMatch(/could not be anonymized/);
  });

  it('keeps an existing .removed marker as-is when re-anonymising', async () => {
    const entries = [
      { name: 'a.log', data: strToU8('@alice:matrix.org') },
      { name: 'screenshot.png.removed', data: strToU8('Removed by shakeview anonymization: …\n') },
    ];
    const tar = parseTar(decompressSync(await buildAnonymisedArchiveGz(entries, SALT)));
    expect(tar.map((e) => e.name).sort()).toEqual(['a.log', 'screenshot.png.removed']);
  });

  it('shortens the marker name rather than overflowing the ustar name field', async () => {
    const longName = `${'x'.repeat(89)}.png`; // 93 chars, no '/' to split on
    const entries = [
      { name: 'a.log', data: strToU8('@alice:matrix.org') },
      { name: longName, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 255]) },
    ];
    const tar = parseTar(decompressSync(await buildAnonymisedArchiveGz(entries, SALT)));
    const marker = tar.find((e) => e.name.endsWith('.removed'));
    expect(marker?.name).toBe(`${longName.slice(0, -'.removed'.length)}.removed`);
    expect(marker!.name.length).toBeLessThanOrEqual(100);
  });

  it('keeps an empty .gz member as an empty file instead of marking it removed', async () => {
    const entries = [
      { name: 'a.log', data: strToU8('@alice:matrix.org') },
      { name: 'empty.log.gz', data: new Uint8Array(0) },
    ];
    const tar = parseTar(decompressSync(await buildAnonymisedArchiveGz(entries, SALT)));
    const byName = Object.fromEntries(tar.map((e) => [e.name, e]));
    expect(byName['empty.log.gz.removed']).toBeUndefined();
    expect(strFromU8(decompressSync(byName['empty.log.gz'].data))).toBe('');
  });

  it('yields to the event loop when the frame budget is exceeded', async () => {
    // Force each maybeYield() over the ~50ms budget so the await/yield path runs.
    let t = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => (t += 100));
    try {
      const dict = await buildArchiveDictionary(
        [
          { name: 'a.log', data: strToU8('@alice:matrix.org') },
          { name: 'b.log', data: strToU8('@bob:matrix.org') },
        ],
        SALT,
      );
      expect(dict.forward['@alice:matrix.org']).toMatch(/^@user-[0-9a-f]{12}:/);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reports progress reaching the total', async () => {
    const entries = [
      { name: 'a.log', data: strToU8('@alice:matrix.org') },
      { name: 'b.log', data: strToU8('@bob:matrix.org') },
    ];
    const calls: Array<[string, number, number]> = [];
    await buildAnonymisedArchiveGz(entries, SALT, (phase, current, total) => calls.push([phase, current, total]));
    // Anonymising phase reaches current === total (2 files).
    expect(calls).toContainEqual(['Anonymising files', 2, 2]);
    // Final compressing phase is emitted.
    expect(calls.some(([phase]) => phase === 'Compressing')).toBe(true);
  });
});

describe('buildArchiveDictionary', () => {
  it('builds one dictionary across text files and ignores binaries', async () => {
    const dict = await buildArchiveDictionary(
      [
        { name: 'a.log.gz', data: gzipSync(strToU8('@alice:matrix.org')) },
        { name: 'b.json', data: strToU8('@bob:matrix.org') },
        { name: 'c.png', data: new Uint8Array([1, 2, 3]) },
      ],
      SALT,
    );
    expect(dict.forward['@alice:matrix.org']).toMatch(USER_RE);
    expect(dict.forward['@bob:matrix.org']).toMatch(USER_RE);
    // same server → shared domain component
    expect(dict.forward['@alice:matrix.org'].split(':')[1]).toBe(
      dict.forward['@bob:matrix.org'].split(':')[1],
    );
  });
});

describe('anonymiseDroppedFile', () => {
  it('repacks an archive and returns the mapping that reverses it', async () => {
    const bytes = gzipSync(buildTar([{ name: 'logs/console.log', data: strToU8('@alice:matrix.org joined') }]));
    const out = await anonymiseDroppedFile('rs.tar.gz', bytes, SALT);

    expect(out.name).toBe('rs-anonym.tar.gz');
    expect(out.isArchive).toBe(true);
    const text = strFromU8(parseTar(decompressSync(out.data as Uint8Array))[0].data);
    const alias = text.match(USER_RE)![0];
    expect(out.dict.reverse[alias]).toBe('@alice:matrix.org');
  });

  it('writes a single log as marked plain text', async () => {
    const out = await anonymiseDroppedFile('console.log.gz', gzipSync(strToU8('@alice:matrix.org joined\n')), SALT);

    expect(out.name).toBe('console-anonym.log');
    expect(out.isArchive).toBe(false);
    expect(out.data).toMatch(/^# \[shakeview-anonymized\]\n@user-[0-9a-f]{12}:domain-[0-9a-f]{8}\.org joined\n$/);
  });

  it('counts the rooms of an archive across its files, and of a single log, as the user header shows them', async () => {
    const older = [
      '2026-01-15T10:00:00.000000Z  INFO AllRooms: Rebuilding room summaries for 50 rooms',
      '2026-01-15T10:00:01.000000Z  INFO joined !room1:example.org',
    ].join('\n');
    const newer = [
      '2026-01-15T11:00:00.000000Z  INFO AllRooms: Rebuilding room summaries for 12 rooms',
      '2026-01-15T11:00:01.000000Z  INFO GET /rooms/%21room2%3Aexample.org/state as @alice:example.org',
    ].join('\n');
    const bytes = gzipSync(buildTar([
      { name: 'logs/console.1.log', data: strToU8(newer) },
      { name: 'logs/console.log', data: strToU8(older) },
    ]));
    expect(roomCount([(await anonymiseDroppedFile('rs.tar.gz', bytes, SALT)).rooms])).toEqual({ listed: 12, seen: 2 });
    expect(roomCount([(await anonymiseDroppedFile('console.log', strToU8(older), SALT)).rooms])).toEqual({ listed: 50, seen: 1 });
  });

  it('refuses a binary single file', async () => {
    await expect(anonymiseDroppedFile('shot.png', new Uint8Array([0x89, 0x50, 0, 0, 255]), SALT))
      .rejects.toThrow(/not a text log/);
  });
});
