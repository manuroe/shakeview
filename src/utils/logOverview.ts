import type { ParsedLogLine } from '../types/log.types';
import { WEB_LEVEL_PREFIX_RE } from './logMessageUtils';

/**
 * Builds the data model behind the `/triaged` tree: log lines grouped by
 * their `target` (Rust module path / logger tag) into a nested tree, with
 * error/warn counts aggregated over each subtree.
 *
 * `target` is not part of `ParsedLogLine`, so it is extracted lazily here
 * from `rawText` rather than in the hot parser loop.
 */

// Target sits between the log level and the first ": " (Rust module path) or
// inside "[...]" (bracket tag, e.g. Swift FFI / android). Two forms in the wild:
//   ERROR matrix_sdk::http_client: Error while sending request ...
//   INFO [matrix-rust-sdk] Login successful ...
const RUST_TARGET_RE = /(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+([a-z_][\w:]*?):\s/;
const BRACKET_TARGET_RE = /(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+\[([^\]]+)\]/;
// Element Web: single-letter level, then a logger prefix ending in ": ".
//   2026-09-28T15:36:15.377Z I FetchHttpApi: --> GET …
const WEB_TARGET_RE = new RegExp(`${WEB_LEVEL_PREFIX_RE.source}\\s*([A-Za-z_][\\w.]*):\\s`);

const NO_TARGET = '(no target)';

/** Delimiter between Rust module-path segments, e.g. `matrix_sdk::http_client`. */
const TARGET_SEPARATOR = '::';

/**
 * Extract the log target from a raw log line. Returns null when neither form
 * is present (callers bucket these under a synthetic "(no target)" node).
 *
 * @example
 * extractTarget('… ERROR matrix_sdk::http_client: boom');  // 'matrix_sdk::http_client'
 * extractTarget('… INFO [matrix-rust-sdk] hello');          // 'matrix-rust-sdk'
 * extractTarget('2026-09-28T15:36:15.377Z I FetchHttpApi: --> GET …'); // 'FetchHttpApi'
 * extractTarget('… plain line, no target');                 // null
 */
export function extractTarget(rawText: string): string | null {
  // Only the first physical line carries the level+target prefix; bound the
  // regex to it so multi-line entries don't scan their whole (large) body.
  const nl = rawText.indexOf('\n');
  const firstLine = nl === -1 ? rawText : rawText.slice(0, nl);

  const rust = firstLine.match(RUST_TARGET_RE);
  if (rust) return rust[1];

  const bracket = firstLine.match(BRACKET_TARGET_RE);
  if (bracket) return bracket[1];

  const web = firstLine.match(WEB_TARGET_RE);
  if (web) return web[2];

  return null;
}

/**
 * A log location directly under a target node, holding every occurrence that
 * maps to it. Exists so the tree can drill from a target down to the exact
 * source site. See `location` for how the key is derived.
 */
export interface OverviewLeaf {
  /**
   * Leaf key derived from the source file: `basename:line` when the line
   * number is known ("native.rs:214"), the bare `basename` when only a path
   * is present ("native.rs"), or the target when the line carries no path.
   */
  readonly location: string;
  readonly occurrences: readonly ParsedLogLine[];
  readonly errorCount: number;
  readonly warnCount: number;
}

/**
 * A node in the target tree. Branch nodes are target path segments; each node
 * carries its direct `leaves` and subtree-aggregated counts so a reader can
 * spot the noisy area without opening it.
 */
export interface OverviewNode {
  /** This level's target segment, e.g. "http_client". Empty at the root. */
  readonly segment: string;
  /** Full dotted/colon path to this node, e.g. "matrix_sdk::http_client". */
  readonly fullTarget: string;
  readonly children: readonly OverviewNode[];
  /** Log locations directly under this target. */
  readonly leaves: readonly OverviewLeaf[];
  /** Aggregated over this node's whole subtree. */
  readonly errorCount: number;
  readonly warnCount: number;
}

// Mutable builder mirrors of the public (readonly) shapes. Children/leaves are
// keyed by Map for O(1) grouping; the public tree is materialized once at the
// end by `finalize`, which also rolls the counts up in the same pass.
interface BuildLeaf {
  location: string;
  occurrences: ParsedLogLine[];
  errorCount: number;
  warnCount: number;
}
interface BuildNode {
  segment: string;
  fullTarget: string;
  children: Map<string, BuildNode>;
  leaves: Map<string, BuildLeaf>;
}

function makeBuildNode(segment: string, fullTarget: string): BuildNode {
  return { segment, fullTarget, children: new Map(), leaves: new Map() };
}

function leafKeyFor(line: ParsedLogLine, target: string): string {
  if (line.filePath) {
    // Basename only — the full path is redundant with the target and long.
    // lastIndexOf('/') === -1 (no slash) → slice(0) returns the whole string.
    const base = line.filePath.slice(line.filePath.lastIndexOf('/') + 1);
    return line.sourceLineNumber !== undefined ? `${base}:${line.sourceLineNumber}` : base;
  }
  return target;
}

/** Materialize a build node into the public shape, rolling counts up bottom-up. */
function finalize(node: BuildNode): OverviewNode {
  const children = [...node.children.values()].map(finalize);
  const leaves = [...node.leaves.values()];
  let errorCount = 0;
  let warnCount = 0;
  for (const leaf of leaves) {
    errorCount += leaf.errorCount;
    warnCount += leaf.warnCount;
  }
  for (const child of children) {
    errorCount += child.errorCount;
    warnCount += child.warnCount;
  }
  return { segment: node.segment, fullTarget: node.fullTarget, children, leaves, errorCount, warnCount };
}

/**
 * Group log lines by target into a nested tree (target split on "::"), each
 * leaf holding its occurrences and every node caching subtree error/warn
 * counts. Node/leaf grouping is O(1) per line via Maps.
 *
 * @example
 * const root = buildLogOverview(rawLogLines);
 * root.children[0].fullTarget;   // e.g. 'matrix_sdk'
 * root.errorCount;               // total ERRORs across the whole tree
 */
export function buildLogOverview(rawLogLines: readonly ParsedLogLine[]): OverviewNode {
  const root = makeBuildNode('', '');

  for (const line of rawLogLines) {
    const target = extractTarget(line.rawText) ?? NO_TARGET;
    const segments = target.split(TARGET_SEPARATOR);

    let node = root;
    let fullTarget = '';
    for (const seg of segments) {
      fullTarget = fullTarget ? `${fullTarget}${TARGET_SEPARATOR}${seg}` : seg;
      let child = node.children.get(seg);
      if (!child) {
        child = makeBuildNode(seg, fullTarget);
        node.children.set(seg, child);
      }
      node = child;
    }

    const key = leafKeyFor(line, target);
    let leaf = node.leaves.get(key);
    if (!leaf) {
      leaf = { location: key, occurrences: [], errorCount: 0, warnCount: 0 };
      node.leaves.set(key, leaf);
    }
    leaf.occurrences.push(line);
    if (line.level === 'ERROR') leaf.errorCount++;
    else if (line.level === 'WARN') leaf.warnCount++;
  }

  return finalize(root);
}
