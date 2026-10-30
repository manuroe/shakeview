import { describe, expect, it } from 'vitest';
import { roomCount, roomsInLog } from '../roomCount';

const line = (rawText: string, timestampUs = 1) => ({ rawText, timestampUs });

describe('roomsInLog', () => {
  it('collects distinct room IDs, plain or percent-encoded, and ignores other IDs', () => {
    const rooms = roomsInLog([
      line('send uri="https://hs/_matrix/client/v3/rooms/!room1:example.org/send"'),
      line('--> GET https://hs/_matrix/client/v3/room_keys/keys/!room1%3Aexample.org/Ab12?version=1'),
      line('url=%21room2%3Aexample.org sender=@alice:example.org event=$ev1:example.org'),
      line('nothing here'),
    ]);
    expect(rooms.seenIds.sort()).toEqual(['!room1:example.org', '!room2:example.org']);
    expect(rooms.lists).toEqual({});
  });

  it("keeps each Element X list's last size", () => {
    const rooms = roomsInLog([
      line('AllRooms: Rebuilding room summaries for 50 rooms', 1),
      line('AllRooms: Rebuilding room summaries for 12 rooms', 2),
      line('StaticAllRooms: Rebuilding room summaries for 40 rooms', 3),
    ]);
    expect(rooms.lists).toEqual({ AllRooms: { count: 12, ts: 2 }, StaticAllRooms: { count: 40, ts: 3 } });
    expect(roomCount([rooms])?.listed).toBe(40);
  });
});

describe('roomCount', () => {
  it("gives each list's newest size and the distinct rooms seen across logs", () => {
    expect(roomCount([
      { seenIds: ['!a:x', '!b:x'], lists: { StaticAllRooms: { count: 40, ts: 2 } } },
      { seenIds: ['!b:x', '!c:x'], lists: { StaticAllRooms: { count: 39, ts: 5 } } },
    ])).toEqual({ listed: 39, seen: 3 });
  });

  it("keeps the unfiltered list's size when a newer log only has a filtered one", () => {
    expect(roomCount([
      { seenIds: [], lists: { StaticAllRooms: { count: 40, ts: 1 } } },
      { seenIds: [], lists: { AllRooms: { count: 12, ts: 5 } } },
    ])?.listed).toBe(40);
  });

  it('has no list size without the Element X line, and is null without any room', () => {
    expect(roomCount([{ seenIds: ['!a:x'], lists: {} }])).toEqual({ listed: null, seen: 1 });
    expect(roomCount([{ seenIds: [], lists: {} }])).toBeNull();
  });
});
