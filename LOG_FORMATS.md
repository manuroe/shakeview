# Supported logs: Element X vs Element Web

Shakeview opens rageshakes from **Element X** (iOS and Android, built on the Rust SDK) and **Element Web**.
Both use the same views, but Element Web logs much less structure, so some features have less to show
or are hidden. This page lists what you get for each.

Try both with the **"Try with demo logs: Mobile · Web"** buttons on the landing page.

## At a glance

| Feature | Element X | Element Web |
|---|---|---|
| Log levels | `TRACE` `DEBUG` `INFO` `WARN` `ERROR` | `D` `I` `W` `E`, shown as `DEBUG` `INFO` `WARN` `ERROR` (no `TRACE`) |
| Timestamps | microseconds | milliseconds |
| Log files | one per hour and per process (`console.…`, `nse.…`, `shareextension.…`) | one per page load (`logs-0000` is the newest, `logs-0001` the one before, …) |
| **By target** view | Rust module path (`matrix_sdk::send_queue`) or `[matrix-rust-sdk]` | logger name (`FetchHttpApi`, `MatrixClientPeg`, `Presence`) or Rust module path for crypto lines |
| **By span** view | yes | hidden: web logs have no spans |
| Source links | GitHub links for `.rs` / `.swift` file references | none: web lines name no source file |
| **HTTP Requests** | method, URL, status, duration, sizes, retries | method, URL, status, duration. No sizes, no retries (see below) |
| Request ids | as logged by the SDK | numbered `1`, `2`, `3`… in time order |
| Focus a request | all lines with that request id | exactly its 2 lines: the request and the response |
| Bandwidth chart | upload / download bytes | empty: sizes are not logged |
| **Sync** view | sliding-sync connections, timeout colours | `/sync` long-polls listed. No connections, no timeout colours |
| Cold start marker | app launch | page load (`Vector starting at …`) |
| Foreground / background band | app becomes active / goes to background | active / **idle** (see below) |
| Background refresh band | iOS | — |
| Crash marker | iOS (next launch), Android (`FATAL EXCEPTION`) | — |
| Sentry reports | iOS, Android | — |
| Details panel (archive) | app, version, linked Rust SDK commit | app, version. No SDK commit: web reports a crypto version instead, shown by the CLI only for now |
| Anonymisation | yes | yes, including `matrix.to` and `app.element.io/#/room/…` links |

## Element Web specifics

**Foreground / background means active / idle.** A web page does not log when its tab is hidden or shown.
The closest signal is presence:
- **foreground** starts when the user moves the mouse, types or focuses the window after being idle (`Presence: online`);
- **background** starts after **3 minutes without input** (`Presence: unavailable`), or when the tab is closed
  (`element-web closing`).

So background on web shows up about 3 minutes after the user actually stopped, and a tab left open in the background
still reads as foreground until those 3 minutes pass. The band label still says "Background"; read it as "idle".

**Closing is not always logged.** `element-web closing` is written as the page unloads and is often lost.
When it is missing, the band stays in its last state until the next page load.

**One file per page load.** Each reload starts a new `logs-NNNN` file, with a cold start near its first lines.
Older files are trimmed when the rageshake grows too big, so the oldest file often has only its last few lines
and no cold start. Open several files together to follow reloads on one timeline.

**HTTP requests carry no id.** Element Web logs each request as a pair of lines:

```
FetchHttpApi: --> GET https://matrix.example.org/_matrix/client/v3/sync?…
FetchHttpApi: <-- GET https://matrix.example.org/_matrix/client/v3/sync?… [879ms 200]
```

Shakeview pairs a response with the oldest pending request to the same URL, and numbers the requests itself.
As a result:
- a **retry is a new request**: nothing links it to the attempt it repeats;
- **request and response sizes are unknown**, so the bandwidth chart stays empty;
- a request with no response line shows as **incomplete**, as on Element X;
- network failures show their error text (`TypeError: NetworkError when attempting to fetch resource.`)
  instead of a status code.

**URL query values are hidden.** Element Web replaces every query value with `xxx` before logging
(`/sync?filter=xxx&timeout=xxx&since=xxx`). That is why the Sync view cannot tell catch-up syncs from long-polls.
