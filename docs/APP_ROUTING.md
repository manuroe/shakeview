# Routing Architecture

This document describes the routing architecture: **URL as single source of truth**. Components read from URL and write to URL directly. Store becomes derived state.

---

## Routes & Parameters Matrix

| Route | Page | `start` | `end` | `scale` | `status` | `filter` | `request_id` | `timeout` |
|-------|------|:-------:|:-----:|:-------:|:--------:|:--------:|:------------:|:---------:|
| `/` | LandingPage | - | - | - | - | - | - | - |
| `/summary` | SummaryView | ✓ | ✓ | - | - | - | - | - |
| `/logs` | LogsView | ✓ | ✓ | - | - | ✓ | - | - |
| `/http_requests` | HttpRequestsView | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - |
| `/http_requests/sync` | SyncView | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ |
| `/decryption` | DecryptionView | ✓ | ✓ | - | - | - | - | - |

**Legend**: ✓ = used, - = not used

`/decryption` also reads its list filters `q` (id search), `outcome` (comma-separated outcome
keys), `analytics` and the selected `session`, and a repeatable `archive` link (see
[Opening several archives on /decryption](#opening-several-archives-on-decryption)).

**Notes**:
- `filter`: Live text filter, synced to store via URL. Same behavior on `/logs` and `/http_requests`.
- `status`: HTTP status code filter. Applied via [RequestTable](../src/components/RequestTable.tsx).
- `request_id`: Auto-expands the specified request row.
- SyncView disables URI filter (`showUriFilter={false}`).

## URL Parameters

| Parameter | Type | Purpose | Default |
|-----------|------|---------|---------|
| `start` | ISO datetime or keyword | Start of time filter | `null` (show all) |
| `end` | ISO datetime or keyword | End of time filter | `null` (show all) |
| `scale` | Integer | Timeline zoom (ms per pixel) | `10` (omit from URL) |
| `status` | Comma-separated codes | HTTP status filter | `null` (show all, omit from URL) |
| `filter` | URL-encoded string | URI substring filter | `null` (no filter, omit from URL) |
| `request_id` | URL-encoded string | Auto-select request | `null` |
| `timeout` | Integer | Highlight sync requests exceeding timeout (ms) | `null` (no timeout highlighting) |
| `line` | `N` or `A-B` | Highlight a line or an inclusive range of them on `/logs`, scrolled to the first | `null` (no highlight) |
| `archive` | URL of a `.tar.gz` | Fetch and open that archive, then redirect to `/logs` | `null` |
| `file` | Name of one analyzable log inside the archive | Open just that log; `line` then counts within it | `null` (all analyzable logs, merged) |

### Opening an archive from a URL

`archive=<url>` ([useArchiveUrl.ts](../src/hooks/useArchiveUrl.ts)) makes a log line
linkable: the recipient does not have to drop the file in first. The URL must be same-origin
or CORS-readable — a static server pointed at a folder of rageshakes is the intended source.
Only `archive` is dropped from the URL once loaded, so `file`, `line`, `filter`, `start` and
`end` survive a refresh but the fetch does not repeat.

Add `file=<entry>` (matched on full path or basename) and only that log is opened, with `line`
counted inside it — which is how the `rageshake` CLI prints line numbers. This is the fast
path: measured on a real 19 MB, 56-log archive, **335 ms against 2480 ms** for the merged
alternative, since decompressing and parsing every log is ~95% of the work. A `file=` that
names no analyzable log in the archive fails to the landing page rather than falling back to
the merged view, because `line` would then point at an unrelated line.

Without `file=`, every analyzable entry is opened as one merged timeline (the archive
listing's "open all") — for exploring an archive rather than pointing at a line. A second link
into the archive still in memory re-opens from the store with no new download; one into an
archive since replaced by a hand-dropped file re-fetches, since `file` would otherwise resolve
against the wrong rageshake.

### Opening several archives on /decryption

`/#/decryption?archive=<a>&archive=<b>…` is how a shakedown report links a paired decryption view. The first
archive opens like any `archive=` link (merged, or one log with `file=`) and becomes the loaded
logs; every further archive is added as a device on `/decryption` — typically the sender's rageshake.
All `archive` params are then dropped and the view stays on `/decryption`, so a reload lands on the
landing page like every other view. `&session=<megolm session id>` preselects a session.

### Time Filter Formats

The `start` and `end` parameters accept:

- **Full ISO datetime**: `2025-01-01T12:00:00.000Z`
- **Keywords**: `start` (first log), `end` (last log)
- **Shortcuts**: `last-min`, `last-5-min`, `last-10-min`, `last-hour`, `last-day`

## Navigation Behavior

### Browser History

Users can use browser back/forward buttons to navigate through:
- Different views (e.g., `/http_requests` → `/logs` → back to `/http_requests`)
- Previous parameter states (e.g., filter change → back restores previous filter)

This works naturally with URL-as-source-of-truth: each URL change creates a history entry.

### Cross-View Navigation (Burger Menu)

When navigating between views via the burger menu, only `start` and `end` params are preserved. View-specific params (`scale`, `status`, `filter`, `request_id`) are cleared.

**Rationale**: Time range is a global filter users want to keep. Other params are view-specific and don't make sense across views (e.g., `status=500` filter on `/logs` which has no HTTP status).

### No Data Redirect & Restore

When the app has no log data loaded (page refresh, direct link, cleared data):

1. **Redirect**: App redirects to `/` (LandingPage) from any other route
2. **Store route**: The full URL (path + params) is saved to `lastRoute` in store
3. **Restore**: After user loads log data, app navigates to `lastRoute` with all params intact

**Example flow**:
```
User shares: /http_requests?filter=sync&status=500
↓
Recipient opens link (no data)
↓
Redirect to / (lastRoute = "/http_requests?filter=sync&status=500")
↓
User uploads log file
↓
Navigate to /http_requests?filter=sync&status=500
```

This enables **shareable debugging URLs** — recipients see the exact same filtered view.

---

## Architecture

```
┌─────────────┐           ┌─────────────┐
│    URL      │──────────►│   Store     │
│  (params)   │  1 effect │ (derived)   │
└─────────────┘           └─────────────┘
       ▲                        │
       │                        ▼
       └──────── Components ────┘
                (read store,
                 write URL)
```

**Data flow**: URL is the source of truth. Components read state from store, write changes to URL. A single effect in [App.tsx](../src/App.tsx) syncs URL → Store.

---

## Design Decisions

1. **request_id is reactive**: Clearing `request_id` from URL deselects the request. URL is always the source of truth.

2. **Omit default values from URL**: Cleaner URLs. Defaults:
   - `start`/`end`: omit when `null` (show all)
   - `scale`: omit when `10` (default zoom)
   - `status`: omit when `null` (show all codes)
   - `filter`: omit when `null` or empty

3. **filter behavior is consistent**: `/logs` and `/http_requests` both use `filter` param the same way — live filtering synced to store.

---

## Related Files

- [App.tsx](../src/App.tsx) — Main routing and URL → Store sync
- [useURLParams.ts](../src/hooks/useURLParams.ts) — URL parameter read/write hook
- [logStore.ts](../src/stores/logStore.ts) — Application state store
- [timeUtils.ts](../src/utils/timeUtils.ts) — Time format conversion
