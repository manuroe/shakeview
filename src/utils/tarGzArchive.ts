/**
 * Decompress and unpack `.tar.gz` rageshake archive bytes.
 *
 * Shared by the drop-zone (`FileUpload`) and the `?archive=<url>` loader
 * (`useArchiveUrl`) so both reject oversized and empty archives with the same
 * user-facing message.
 */
import { decompressSync } from 'fflate';
import { parseTar } from './tarParser';
import { FileError, formatFileSize } from './errorHandling';
import type { ArchiveEntry } from '../stores/archiveStore';

/**
 * Hard limit on the archive, compressed and decompressed alike: `decompressSync`
 * locks the main thread, so anything larger is refused rather than hanging the
 * tab. Mirrors the gzip path in `fileValidator.ts`.
 *
 * One limit covers both because a rageshake barely expands — its logs are already
 * individually gzipped inside the tar, measured at 1.0–1.1× across a sample of
 * real archives, the largest 19 MB. Only a deliberately crafted payload gets
 * anywhere near this from either side.
 */
export const MAX_TAR_GZ_SIZE = 500 * 1024 * 1024; // 500 MB

/** File names this module unpacks: `.tar.gz` and its `.tgz` short form. */
export const TAR_GZ_NAME = /\.(tar\.gz|tgz)$/i;

/**
 * @throws {FileError} when a compressed archive of `byteLength` is over the limit.
 *
 * Callable before the bytes are in memory — the drop zone checks `File.size` up
 * front so an oversized archive is never read at all.
 */
export function assertArchiveSizeOk(byteLength: number): void {
  if (byteLength > MAX_TAR_GZ_SIZE) {
    throw new FileError(
      `Archive is too large (${formatFileSize(byteLength)}). Maximum supported size is ${formatFileSize(MAX_TAR_GZ_SIZE)}.`
    );
  }
}

/**
 * Refuse an archive that *declares* it expands past the limit, before handing it
 * to `decompressSync`. Capping the compressed size alone leaves a small,
 * highly compressible payload free to expand into an allocation that takes the tab
 * down with it — reachable from a link now that `?archive=<url>` exists.
 *
 * gzip records its uncompressed length in the last four bytes of the stream. That
 * field is modulo 2^32 and describes only the final member of a multi-member
 * stream, so a payload built to wrap it can still under-report; this stops the
 * accidental and the casual case, not a determined one. Bounding the real output
 * needs a streaming inflate that aborts mid-flight.
 *
 * @throws {FileError} when the declared uncompressed size is over the limit.
 */
function assertDeclaredExpansionOk(bytes: Uint8Array): void {
  if (bytes.byteLength < 4) return; // too short to carry a footer; let the inflater complain
  const isize = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 4, 4).getUint32(0, true);
  if (isize > MAX_TAR_GZ_SIZE) {
    throw new FileError(
      `Archive expands to too much data (${formatFileSize(isize)}). Maximum supported size is ${formatFileSize(MAX_TAR_GZ_SIZE)}.`
    );
  }
}

/**
 * @throws {FileError} when the archive is over `MAX_TAR_GZ_SIZE` compressed, says
 *   it expands past it, or holds no files.
 * @throws Whatever `decompressSync`/`parseTar` throw on malformed input — callers
 *   wrap it into a "not a valid .tar.gz" message.
 */
export function parseTarGzArchive(bytes: Uint8Array): readonly ArchiveEntry[] {
  assertArchiveSizeOk(bytes.byteLength);
  assertDeclaredExpansionOk(bytes);
  const entries = parseTar(decompressSync(bytes));
  if (entries.length === 0) {
    throw new FileError('The archive contains no files.');
  }
  return entries;
}
