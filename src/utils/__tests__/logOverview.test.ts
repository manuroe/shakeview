import { describe, it, expect } from 'vitest';
import { extractTarget, buildLogOverview, type OverviewNode } from '../logOverview';
import { createParsedLogLine } from '../../test/fixtures';

// Raw lines shaped like public/demo/demo.log.
const RUST = '2026-01-15T10:02:02.120000Z ERROR matrix_sdk::http_client::native: boom | crates/matrix-sdk/src/http_client/native.rs:214 | spans: root';
const BRACKET = '2026-01-15T10:00:01.010000Z  INFO [matrix-rust-sdk] Login successful | ClientProxy.swift:1092 | auth';
const NO_TARGET_LINE = '2026-01-15T10:00:00.000000Z hello world with no level';
const WEB = '2026-09-28T15:36:15.417Z I FetchHttpApi: --> GET https://matrix.example.org/_matrix/client/versions';

describe('extractTarget', () => {
  it('extracts a Rust module path', () => {
    expect(extractTarget(RUST)).toBe('matrix_sdk::http_client::native');
  });

  it('extracts a bracket tag', () => {
    expect(extractTarget(BRACKET)).toBe('matrix-rust-sdk');
  });

  it('extracts an Element Web logger prefix', () => {
    expect(extractTarget(WEB)).toBe('FetchHttpApi');
  });

  it('prefers the Rust module path on Element Web crypto-wasm lines', () => {
    expect(extractTarget('2026-09-28T15:36:16.400Z W WARN matrix_sdk_crypto::machine: boom')).toBe('matrix_sdk_crypto::machine');
  });

  it('returns null when neither form is present', () => {
    expect(extractTarget(NO_TARGET_LINE)).toBeNull();
  });

  it('only scans the first physical line', () => {
    const multiline = `${RUST}\nContinuation ERROR fake::target: not this`;
    expect(extractTarget(multiline)).toBe('matrix_sdk::http_client::native');
  });
});

function findNode(node: OverviewNode, segment: string): OverviewNode | undefined {
  return node.children.find((c) => c.segment === segment);
}

describe('buildLogOverview', () => {
  it('nests a Rust target under its "::" segments', () => {
    const tree = buildLogOverview([createParsedLogLine({
      lineNumber: 1,
      level: 'ERROR',
      rawText: RUST,
      filePath: 'crates/matrix-sdk/src/http_client/native.rs',
      sourceLineNumber: 214,
    })]);
    const matrixSdk = findNode(tree, 'matrix_sdk');
    const httpClient = matrixSdk && findNode(matrixSdk, 'http_client');
    const native = httpClient && findNode(httpClient, 'native');
    expect(native?.fullTarget).toBe('matrix_sdk::http_client::native');
    expect(native?.leaves[0].location).toBe('native.rs:214');
  });

  it('rolls errorCount up the subtree', () => {
    const lines = [
      createParsedLogLine({ lineNumber: 1, level: 'ERROR', rawText: RUST }),
      createParsedLogLine({ lineNumber: 2, level: 'ERROR', rawText: RUST }),
      createParsedLogLine({
        lineNumber: 3,
        level: 'WARN',
        rawText: '2026-01-15T10:02:03Z WARN matrix_sdk::send_queue: q | crates/matrix-sdk/src/send_queue.rs:9 |',
      }),
      createParsedLogLine({ lineNumber: 4, level: 'INFO', rawText: BRACKET }),
    ];
    const tree = buildLogOverview(lines);

    // Root aggregates everything below it.
    expect(tree.errorCount).toBe(2);
    expect(tree.warnCount).toBe(1);

    // matrix_sdk subtree sums the two ERROR (http_client) + one WARN (send_queue).
    const matrixSdk = findNode(tree, 'matrix_sdk');
    expect(matrixSdk?.errorCount).toBe(2);
    expect(matrixSdk?.warnCount).toBe(1);

    // The bracket-tag node is a separate top-level node with no errors.
    const bracket = findNode(tree, 'matrix-rust-sdk');
    expect(bracket?.errorCount).toBe(0);
  });

  it('keys a leaf by bare basename when filePath has no slash or source line', () => {
    const tree = buildLogOverview([createParsedLogLine({
      lineNumber: 1,
      level: 'ERROR',
      rawText: RUST,
      filePath: 'native.rs', // no slash, no sourceLineNumber
    })]);
    const native = findNode(findNode(findNode(tree, 'matrix_sdk')!, 'http_client')!, 'native');
    expect(native?.leaves[0].location).toBe('native.rs');
  });
});
