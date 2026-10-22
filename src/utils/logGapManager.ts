import type { ParsedLogLine } from '../types/log.types';
import { mergeNumberRanges, type NumberRange } from './rangeUtils';

/**
 * # Gap Expansion Manager
 *
 * Manages gap expansion for virtualized log display, replacing hidden lines with expanded ranges.
 *
 * ## Architecture
 *
 * Instead of cascading expansion logic, this module uses:
 *
 * **Forced Ranges**: Inclusive-exclusive [start, end) index ranges that must be displayed.
 * When a gap is expanded, a new forced range is computed and merged with existing ranges.
 *
 * **Display Items**: Derived from filtered lines + forced ranges.
 * Gaps are recomputed based on displayed neighbors, not expansion state.
 *
 * **Gap Calculation**: Simple neighbor-based logic:
 * - For each displayed line, gap size = next displayed line index - current index - 1
 * - Remaining gap always equals gap size (no subtracting expansion count)
 *
 * ## Gap Expansion Diagram
 *
 * Filtered display (T = shown, . = hidden):
 *
 * Index:   0  1  2  3  4  5  6  7  8  9
 * Line:    T  .  .  T  .  .  .  .  T  .
 *          ▲     gap     ▲     gap     ▲
 *       display         display    display
 *          [start:1, end:3)
 *
 * After expanding +1:
 *        T  T  .  T  .  T  .  .  T  .
 *          ▲     gap(reduced)  ▲  forced
 *
 * ## Expansion Modes
 *
 * - `+10` or `+N`: Expand N lines (capped to available gap)
 * - `all`: Expand entire remaining gap
 * - `next-match`: Expand to next matching line (prefers request boundary if provided)
 * - `prev-match`: Expand to prev matching line (prefers request boundary if provided)
 *
 * ## Helper Functions
 *
 * - `mergeRanges()`: Merge overlapping/adjacent ranges
 * - `normalizeRange()`: Clamp range to valid bounds
 * - `areRangesEqual()`: Reference equality check
 * - `findNextMatch()`: Find next match after anchor
 * - `findPrevMatch()`: Find previous match before anchor
 */

export interface GapInfo {
  readonly gapId: string;
  readonly gapSize: number;
  readonly remainingGap: number;
  readonly isFirst?: boolean;
  readonly isLast?: boolean;
}

export interface DisplayItem {
  readonly type: 'line';
  readonly data: {
    readonly line: ParsedLogLine;
    readonly index: number;
  };
  readonly gapAbove?: GapInfo;
  readonly gapBelow?: GapInfo;
}

export interface FilteredLine {
  readonly line: ParsedLogLine;
  readonly index: number;
}

/**
 * An inclusive-start, exclusive-end index range `[start, end)` that is applied
 * in addition to the current `filteredLines` set.
 *
 * Lines covered by a forced range are eligible to be included in the
 * virtualized display even if those lines don't pass the active search filter,
 * but only when there is at least one filtered/displayed line to anchor the
 * list (i.e. when `filteredLines.length > 0`). When there are no filtered
 * lines, no display items are produced and forced ranges have no effect.
 *
 * Ranges are expanded by the user via gap-expansion controls and merged with
 * {@link mergeRanges} before being applied, so overlapping or adjacent ranges
 * always collapse into the minimum covering set.
 */
export interface ForcedRange extends NumberRange {
  /** Inclusive start index into the raw log-line array. */
  readonly start: number;
  /** Exclusive end index into the raw log-line array. */
  readonly end: number;
}

/**
 * Merges overlapping or adjacent forced ranges.
 * Forced ranges are inclusive-exclusive: [start, end).
 * Delegates to the shared {@link mergeNumberRanges} utility; `ForcedRange`
 * is structurally compatible with `NumberRange`.
 */
function mergeRanges(ranges: ReadonlyArray<ForcedRange>): ForcedRange[] {
  return mergeNumberRanges(ranges);
}

function normalizeRange(range: ForcedRange, totalLines: number): ForcedRange | null {
  const start = Math.max(0, Math.min(range.start, totalLines));
  const end = Math.max(0, Math.min(range.end, totalLines));
  if (end <= start) return null;
  return { start, end };
}

function areRangesEqual(a: ForcedRange[], b: ForcedRange[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end) return false;
  }
  return true;
}

function findNextMatch(anchor: number, gapEnd: number, matchingIndices?: Set<number>): number | null {
  if (!matchingIndices || matchingIndices.size === 0) return null;
  let best: number | null = null;
  matchingIndices.forEach((idx) => {
    if (idx > anchor && idx < gapEnd) {
      if (best === null || idx < best) best = idx;
    }
  });
  return best;
}

function findPrevMatch(anchor: number, gapStart: number, matchingIndices?: Set<number>): number | null {
  if (!matchingIndices || matchingIndices.size === 0) return null;
  let best: number | null = null;
  matchingIndices.forEach((idx) => {
    if (idx < anchor && idx > gapStart) {
      if (best === null || idx > best) best = idx;
    }
  });
  return best;
}

/**
 * Build the ordered list of display items that the virtualized log list will
 * render.
 *
 * Lines that pass the active filter (`filteredLines`) are always included.
 * Additionally, any raw-log-line indices covered by `forcedRanges` are
 * spliced in, allowing expanded gap lines to appear between filter matches.
 * Adjacent expanded lines are merged before insertion so there are no
 * duplicate entries.
 *
 * Each resulting {@link DisplayItem} carries optional `gapAbove`/`gapBelow`
 * metadata so the renderer can show expansion controls between non-adjacent
 * lines.
 *
 * @param filteredLines - Lines that satisfy the current search/log-level filter,
 *   each paired with their absolute index in `rawLogLines`.
 * @param rawLogLines - The full, unfiltered log-line array (used to resolve
 *   forced-range indices to actual line data).
 * @param forcedRanges - User-expanded ranges that must be shown regardless of
 *   the active filter. Ranges use inclusive-start, exclusive-end semantics.
 * @returns Ordered array of display items ready for virtualized rendering.
 */
export function buildDisplayItems(
  filteredLines: FilteredLine[],
  rawLogLines: readonly ParsedLogLine[],
  forcedRanges: ForcedRange[]
): DisplayItem[] {
  const items: DisplayItem[] = [];

  if (filteredLines.length === 0) {
    return items;
  }

  const displayIndicesSet = new Set<number>(filteredLines.map((line) => line.index));
  const mergedForcedRanges = mergeRanges(
    forcedRanges
      .map((range) => normalizeRange(range, rawLogLines.length))
      .filter((range): range is ForcedRange => range !== null)
  );

  mergedForcedRanges.forEach((range) => {
    for (let i = range.start; i < range.end; i++) {
      displayIndicesSet.add(i);
    }
  });

  const displayIndices = Array.from(displayIndicesSet).sort((a, b) => a - b);

  for (const index of displayIndices) {
    items.push({ type: 'line', data: { line: rawLogLines[index], index } });
  }

  // Assign gapAbove/gapBelow based on displayed neighbors
  for (let i = 0; i < items.length; i++) {
    const currentIndex = displayIndices[i];
    const prevIndex = i > 0 ? displayIndices[i - 1] : null;
    const nextIndex = i < items.length - 1 ? displayIndices[i + 1] : null;

    // Gap above
    const aboveGapSize = prevIndex === null ? currentIndex : currentIndex - prevIndex - 1;
    if (aboveGapSize > 0) {
      items[i] = {
        ...items[i],
        gapAbove: {
          gapId: `up-${currentIndex}`,
          gapSize: aboveGapSize,
          remainingGap: aboveGapSize,
          isFirst: prevIndex === null,
        },
      };
    }

    // Gap below
    const belowGapSize =
      nextIndex === null ? rawLogLines.length - 1 - currentIndex : nextIndex - currentIndex - 1;
    if (belowGapSize > 0) {
      items[i] = {
        ...items[i],
        gapBelow: {
          gapId: `down-${currentIndex}`,
          gapSize: belowGapSize,
          remainingGap: belowGapSize,
          isLast: nextIndex === null,
        },
      };
    }
  }

  return items;
}

/**
 * Calculate the updated set of forced ranges that results from the user
 * expanding a gap.
 *
 * The gap is identified by `gapId` (e.g. `"up-42"` or `"down-42"`).
 * The `count` parameter controls how many lines
 * are added to the forced set:
 *
 * - `number` — expand exactly N lines toward the gap interior (capped to
 *   the available gap size).
 * - `"all"` — expand the entire gap.
 * - `"next-match"` / `"prev-match"` — expand to the next/previous search
 *   match within the gap; falls back to full expansion when no match exists.
 *   If a request-boundary line range is provided it is preferred over a
 *   plain search match.
 *
 * Returns the original `currentForcedRanges` reference (no allocation) when
 * the expansion would produce no change, enabling cheap React bail-outs.
 *
 * @param gapId - Identifier of the gap to expand, e.g. `"down-42"`.
 * @param count - How many lines to reveal, or a named expansion mode.
 * @param displayedIndices - Sorted absolute indices currently visible in the list.
 * @param totalLines - Total number of lines in the raw log.
 * @param currentForcedRanges - Existing forced ranges to merge the new range into.
 * @param matchingIndices - (Optional) Set of line indices matching the active search.
 * @param prevRequestLineRange - (Optional) Line range of the request immediately
 *   before the anchor; used by `"prev-match"` mode.
 * @param nextRequestLineRange - (Optional) Line range of the request immediately
 *   after the anchor; used by `"next-match"` mode.
 * @returns The new merged forced-range array, or `currentForcedRanges` unchanged.
 */
export function calculateGapExpansion(
  gapId: string,
  count: number | 'all' | 'next-match' | 'prev-match',
  displayedIndices: number[],
  totalLines: number,
  currentForcedRanges: ForcedRange[],
  matchingIndices?: Set<number>,
  prevRequestLineRange?: { start: number; end: number },
  nextRequestLineRange?: { start: number; end: number }
): ForcedRange[] {
  const isUpGap = gapId.startsWith('up-');
  const isDownGap = gapId.startsWith('down-');

  if (!isUpGap && !isDownGap) {
    return currentForcedRanges;
  }

  const anchorIndex = Number.parseInt(gapId.replace(/^(up|down)-/, ''), 10);
  if (Number.isNaN(anchorIndex)) {
    return currentForcedRanges;
  }

  const anchorPosition = displayedIndices.indexOf(anchorIndex);
  if (anchorPosition === -1) {
    return currentForcedRanges;
  }

  const prevIndex = anchorPosition > 0 ? displayedIndices[anchorPosition - 1] : null;
  const nextIndex =
    anchorPosition < displayedIndices.length - 1 ? displayedIndices[anchorPosition + 1] : null;

  const gapStart = isUpGap ? (prevIndex ?? -1) : anchorIndex;
  const gapEnd = isUpGap ? anchorIndex : (nextIndex ?? totalLines);

  const totalGap = gapEnd - gapStart - 1;
  if (totalGap <= 0) {
    return currentForcedRanges;
  }

  let newRange: ForcedRange | null = null;

  if (count === 'all') {
    newRange = { start: gapStart + 1, end: gapEnd };
  } else if (count === 'next-match') {
    if (isDownGap) {
      const targetFromRequest = nextRequestLineRange?.start ?? null;
      const targetFromMatches = findNextMatch(anchorIndex, gapEnd, matchingIndices);
      const targetLine =
        targetFromRequest !== null && targetFromRequest > anchorIndex && targetFromRequest < gapEnd
          ? targetFromRequest
          : targetFromMatches;

      newRange = targetLine === null
        ? { start: gapStart + 1, end: gapEnd }
        : { start: anchorIndex + 1, end: targetLine + 1 };
    } else {
      newRange = { start: gapStart + 1, end: gapEnd };
    }
  } else if (count === 'prev-match') {
    if (isUpGap) {
      const targetFromRequest = prevRequestLineRange?.end ?? null;
      const targetFromMatches = findPrevMatch(anchorIndex, gapStart, matchingIndices);
      const targetLine =
        targetFromRequest !== null && targetFromRequest < anchorIndex && targetFromRequest > gapStart
          ? targetFromRequest
          : targetFromMatches;

      newRange = targetLine === null
        ? { start: gapStart + 1, end: gapEnd }
        : { start: targetLine, end: anchorIndex };
    } else {
      newRange = { start: gapStart + 1, end: gapEnd };
    }
  } else if (typeof count === 'number') {
    const linesToAdd = Math.min(Math.max(0, count), totalGap);
    if (linesToAdd <= 0) return currentForcedRanges;
    if (isUpGap) {
      newRange = { start: anchorIndex - linesToAdd, end: anchorIndex };
    } else {
      newRange = { start: anchorIndex + 1, end: anchorIndex + 1 + linesToAdd };
    }
  } else {
    newRange = { start: gapStart + 1, end: gapEnd };
  }

  if (!newRange) return currentForcedRanges;

  const normalized = normalizeRange(newRange, totalLines);
  if (!normalized) return currentForcedRanges;

  const merged = mergeRanges([...currentForcedRanges, normalized]);
  return areRangesEqual(merged, currentForcedRanges) ? currentForcedRanges : merged;
}

/**
 * Compute the gap metadata (size, ID, boundary flags) for the gaps immediately
 * above and below a given line index, given the current set of displayed indices.
 *
 * This is the single-line equivalent of the gap annotation performed inside
 * {@link buildDisplayItems}, used when a caller needs gap info for one specific
 * line without rebuilding the full display list.
 *
 * @param lineIndex - Absolute index of the line of interest in the raw log array.
 * @param displayedIndices - Sorted list of all currently displayed line indices.
 * @param totalLines - Total number of lines in the raw log.
 * @returns An object with optional `up` and `down` {@link GapInfo} entries.
 *   A key is absent when there is no gap in that direction.
 */
export function getGapInfoForLine(
  lineIndex: number,
  displayedIndices: number[],
  totalLines: number
): { up?: GapInfo; down?: GapInfo } {
  const currentIndexInDisplay = displayedIndices.indexOf(lineIndex);
  if (currentIndexInDisplay === -1) {
    return {};
  }

  const result: { up?: GapInfo; down?: GapInfo } = {};

  const prevIndex = currentIndexInDisplay > 0 ? displayedIndices[currentIndexInDisplay - 1] : null;
  const nextIndex =
    currentIndexInDisplay < displayedIndices.length - 1
      ? displayedIndices[currentIndexInDisplay + 1]
      : null;

  // Gap above
  const aboveGapSize = prevIndex === null ? lineIndex : lineIndex - prevIndex - 1;
  if (aboveGapSize > 0) {
    result.up = {
      gapId: `up-${lineIndex}`,
      gapSize: aboveGapSize,
      remainingGap: aboveGapSize,
      isFirst: prevIndex === null,
    };
  }

  // Gap below
  const belowGapSize = nextIndex === null ? totalLines - 1 - lineIndex : nextIndex - lineIndex - 1;
  if (belowGapSize > 0) {
    result.down = {
      gapId: `down-${lineIndex}`,
      gapSize: belowGapSize,
      remainingGap: belowGapSize,
      isLast: nextIndex === null,
    };
  }

  return result;
}
