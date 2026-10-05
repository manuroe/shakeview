# Agent Context: Shakeview

## Project Overview
A web application for visualizing and analyzing rageshake logs. It also ships a **browser extension** that enhances [rageshake](https://github.com/matrix-org/rageshake) listing pages with parsed summary cards and an "Open in Visualizer" button.

## Audience & Scope
This document is a lightweight guide for contributors and automated agents. It focuses on stable concepts and boundaries, not implementation details.

## Tech Stack (High-Level)
- Vite + React + TypeScript
- React Router (hash-based)
- Zustand state management
- CSS Modules with Design Tokens ([src/styles/foundation.css](src/styles/foundation.css))
- Virtualized rendering for large datasets
- ESLint enforcing camelCase naming

## Repository Layout (Intent-Oriented)
- Entry + routing: [src/main.tsx](src/main.tsx), [src/App.tsx](src/App.tsx)
- Views: [src/views](src/views)
- Components: [src/components](src/components)
- Styles: [src/styles](src/styles) (foundation tokens), shared modules in [src/components](src/components) (Button, Card, Table, Form, Dropdown)
- State: [src/stores](src/stores)
- Domain utilities: [src/utils](src/utils)
- Types: [src/types](src/types)
- Tests: [src/__tests__](src/__tests__), [src/components/__tests__](src/components/__tests__), [src/views/__tests__](src/views/__tests__), [src/utils/__tests__](src/utils/__tests__)
- Browser extension source: [extension/](extension/) (manifest, content script, background, viewer)
- Extension build output: [extension-dist/](extension-dist/) (Chrome/Edge), [extension-dist-firefox/](extension-dist-firefox/) (Firefox)

## Core Principles
- Precompute expensive parsing once; filtering should be cheap.
- Keep domain logic in stores/utils, UI-specific logic in views/components.
- Prefer predictable, immutable updates for state (e.g., replace sets/arrays to trigger updates).
- Shareable URLs: global time filters should sync to query parameters.
- Efficiency first: fast loading, instant search, dark mode, sensible defaults.
- After parsing, most UI and filtering logic is log-agnostic; Matrix-specific behavior is mainly in some views.

## Useful Commands
- Start dev server: `npm start`
- Build: `npm run build`
- Preview build: `npm run preview`
- Lint: `npm run lint`
- Unit tests: `npm test -- --run` (exits after completion; omit `-- --run` for watch mode)
- Performance benchmarks: `npm run bench`
  - Runs `.perf.test.ts` suites in Node runtime and reports results through CodSpeed in CI
- Build extension (Chrome/Edge): `npm run build:extension` → `extension-dist/`
- Build extension (Firefox): `npm run build:extension:firefox` → `extension-dist-firefox/`

## AI Working Folder (`agent-workspace/`)

A git-ignored sandbox for all transient AI-generated files. **Never use `/tmp/` or paths outside the workspace.**

- Use for planning notes, PR script outputs, commit messages, and PR descriptions
- **Write files** using file tools — never shell workarounds (`echo >>`, heredoc, etc.)
- **Overwriting**: always replace entire files; never partial `replace_string_in_file` edits on files like `pr-body.md`
- **Commit messages**: write to `agent-workspace/commit-msg.txt` and use `git commit -F agent-workspace/commit-msg.txt`
- **PR descriptions**: write to `agent-workspace/pr-body.md` and use `gh pr create --body-file agent-workspace/pr-body.md`
- **Never store source code** or files meant to be reviewed here

Do **not** commit on the first iteration. Write the code, show the user what changed, and wait for feedback. Only commit once the user confirms the direction is correct — or explicitly asks you to commit.

## First-Pass Handoff (for Agents)

After implementing a requested change, stop and hand the result to the user before doing the full code-quality pass.

- Default workflow: implement the change, do only the narrowest sanity check needed to avoid an obviously broken handoff, then ask whether the user is happy with the result.
- Do **not** automatically run the full build, lint, coverage, benchmark, or broad test suite immediately after implementation.
- Do **not** add follow-up work like wider refactors, extra tests, demo-log updates, screenshot considerations, or documentation polish until the user confirms the implementation direction or explicitly asks for the quality pass.
- If a validation step is needed before user feedback, keep it targeted to the touched code and state why that check is necessary.
- Once the user confirms the direction, complete the remaining quality work needed for the requested end state.

## Pre-Commit Checklist (for Agents)

This checklist is for commit/PR readiness, not for the initial implementation handoff.

Before committing **any** code change (new feature, bug fix, PR comment fix, refactor, etc.), always run the following commands and resolve all errors before proceeding:

```sh
npm run build   # must produce no errors
npm run lint    # must produce no warnings or errors
npm test -- --run --coverage  # coverage thresholds must pass
```

Do not commit if any of these steps fail. Fix the issue first, then re-run the full checklist before committing.

**Manual review** — before committing, scan the diff against each pillar in [Code Quality Standards](#code-quality-standards) and verify all apply.

## Creating PRs (for Agents)

When asked to commit and create a PR, follow `.github/skills/create-pr/SKILL.md` (also available as `/create-pr` in Copilot). Core steps:
1. Pass the Pre-Commit Checklist above before each commit.
2. Analyze `git diff` and group changes into logical commits.
3. Create a branch (`feat/`, `fix/`, etc.) and commit each group with a conventional commit message: `type(scope): description`.
4. Write PR description to `agent-workspace/pr-body.md`.
5. **Self-review** — load `.github/skills/self-review/SKILL.md` (`/self-review`) and resolve all findings before pushing.
6. Push and run `gh pr create --body-file agent-workspace/pr-body.md`.

## PR Review Workflow (for Agents)

When prompted **"Review PR comments"**, follow `.github/skills/fix-review-comments/SKILL.md` (also available as `/fix-review-comments` in Copilot). Core steps:
1. Run `npm run pr:comments` → read `agent-workspace/pr-comments-for-agent.md`.
2. Create a to-do list and address each comment (fix or reject).
3. Run the [Pre-Commit Checklist](#pre-commit-checklist-for-agents) before each commit.
4. Fill `agent-workspace/pr-replies-template.json` with one reply per comment.
5. Send replies with `npm run pr:reply:batch`.

## Browser Extension

The extension lives in [extension/](extension/) and is built separately from the main web app. It is **not yet published** on the Chrome Web Store or Firefox Add-ons — installation is manual only (see [README.md](README.md)). Chrome/Edge and Firefox require separate builds due to manifest format differences.

## Architecture
1. Parse log text into structured records once.
2. Store parsed results and filters centrally in Zustand. Global filters (time range) are shared across views; each view applies its own view-specific filters on top.
3. Views render filtered results; large lists are virtualized.
4. UI state (expanded rows, open log viewers) is kept in the store for consistent behavior across views.

## Code Quality Standards

Every change must uphold these pillars — apply them when writing, not just at review time.

**Clean**: `eslint-disable` requires an inline justification. Warnings are errors in this repo.

**Well Documented**: Every exported symbol gets a JSDoc explaining *why* it exists, not just what it does. Non-obvious decisions need an inline comment. Utils in `src/utils/` need at least one `@example`.

**Composable**: Domain logic in `src/utils/` or `src/stores/` only — never inside component render or handlers. Components never call `useStore.setState()` directly; always use a named store action.

**Easy to Test**: Every new pure function (`src/utils/__tests__/`) and hook (`src/hooks/__tests__/`) gets a unit test asserting on concrete output. Mock only external boundaries (network, store, router).

**No Duplication**: Search before writing. If the same block appears in two or more places, extract it immediately (utility function, shared hook, or store action).

**AI-Generated Code — extra watch-outs** (run the `/self-review` skill before any PR to check all of these):
1. All domain type properties must be `readonly`; shared empty constants return fresh objects, not mutable singletons.
2. All literals that duplicate layout values or colors must be named constants or CSS custom properties — never hard-code pixel sums.
3. Every `setTimeout`/`addEventListener` in a `useEffect` needs a cleanup `return`.
4. Symbol-only buttons need `aria-label`; `role="menu"` requires full arrow-key + Escape keyboard handling.
5. `pointer-events: none` on a container is inherited — add `pointer-events: auto` on any interactive child.
6. Floating Promises: prefix unhandled `.then(...).catch(...)` chains with `void`; wrap clipboard/storage calls in `try/catch`.
7. Test mocks that overwrite globals need a matching `afterEach` restore — `vi.restoreAllMocks()` does **not** restore property assignments.
8. Test fixtures must mirror real parser output: set `isoTimestamp`, `displayTime`, and `message` to non-default values.
9. Close/open callbacks must use functional state updates to avoid clobbering a concurrent open.
10. Before writing a new helper or regex, search the codebase — see "No Duplication" above.

## Performance Regression Detection
CI runs benchmark suites via CodSpeed and publishes performance tracking/results on codspeed.io and GitHub checks.

**Local Development**: Run `npm run bench` to execute the same benchmark suites locally (timing output only).

## Demo Log File

Two hand-crafted demo logs are served as static assets and loaded by the **"Try with demo logs: Mobile · Web"** buttons on the landing page, letting users explore the app without a real log file:
- [`public/demo/demo.log`](public/demo/demo.log) — Element X (mobile, Rust SDK tracing format).
- [`public/demo/demo-web.log`](public/demo/demo-web.log) — Element Web (`<ISO> <D|I|W|E> <message>`, `FetchHttpApi` requests, presence lifecycle, a reload).

**When adding a new feature**, extend the demo log(s) of the platform(s) it applies to so the feature is visible and exercisable in the demo. The log must remain a valid, parseable rageshake log that exercises all existing app capabilities as well as the new one.

## Demo Screenshots

Screenshots in [`public/demo/screenshot-*.png`](public/demo/) are **generated and committed automatically by CI** ([.github/workflows/screenshots.yml](.github/workflows/screenshots.yml)) using a headless Chromium on Ubuntu, then compressed with pngquant for a consistent, OS-independent result.

**Do not regenerate screenshots locally.** Push your changes and let CI update them. If you need to verify what the screenshots will look like, run the dev server and inspect the UI manually.

## Contribution Guidelines
- Use camelCase for identifiers (lint enforced).
- Prefer additive changes over refactors unless necessary.
- Every new feature must be represented in [`public/demo/demo.log`](public/demo/demo.log) and/or [`public/demo/demo-web.log`](public/demo/demo-web.log).
- Always pass the [Pre-Commit Checklist](#pre-commit-checklist-for-agents) (`npm run build`, `npm run lint`, `npm test -- --run --coverage`) before committing.

## Reference Files (Entry Points)
- Routing: [docs/APP_ROUTING.md](docs/APP_ROUTING.md)
- Store: [src/stores/logStore.ts](src/stores/logStore.ts)
- URL params: [src/hooks/useURLParams.ts](src/hooks/useURLParams.ts)
- Parser: [src/utils/logParser.ts](src/utils/logParser.ts)
- Time utilities: [src/utils/timeUtils.ts](src/utils/timeUtils.ts)
- Log views: [src/views](src/views)
- Demo logs: [public/demo/demo.log](public/demo/demo.log), [public/demo/demo-web.log](public/demo/demo-web.log)
- Extension manifest: [extension/manifest.json](extension/manifest.json)
- Extension build config: [vite.config.extension.ts](vite.config.extension.ts)

