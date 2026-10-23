/**
 * File validation utilities for text and gzip files
 */

import {
  FileError,
  formatFileSize,
  validationSuccess,
  validationFailure,
  type ValidationResult,
} from './errorHandling';

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const WARN_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const GZIP_MAGIC_NUMBER_0 = 0x1f;
const GZIP_MAGIC_NUMBER_1 = 0x8b;

/**
 * Detects BOM (Byte Order Mark) and returns encoding, or undefined if none found
 */
function detectBOM(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8-bom';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16-le';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16-be';
  }
  return undefined;
}

/**
 * Strips BOM from bytes and returns the remainder
 */
function stripBOM(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.slice(3); // UTF-8 BOM
  }
  if (bytes.length >= 2 && (bytes[0] === 0xff || bytes[0] === 0xfe)) {
    return bytes.slice(2); // UTF-16 BOM
  }
  return bytes;
}

/**
 * Validates UTF-8 encoding with strict or lenient mode
 */
function validateUTF8(bytes: Uint8Array, strict: boolean = true): { valid: boolean; error?: Error } {
  try {
    new TextDecoder('utf-8', { fatal: strict }).decode(bytes);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error as Error };
  }
}

/**
 * Detects null bytes (strong indicator of binary data)
 */
function hasNullBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x00) {
      return true;
    }
  }
  return false;
}

/**
 * Validates gzip file header (magic number check)
 */
export function isValidGzipHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_NUMBER_0 && bytes[1] === GZIP_MAGIC_NUMBER_1;
}

/**
 * Validates that a byte sequence is valid text (UTF-8 or ISO-8859-1 as fallback)
 */
export function isValidTextContent(bytes: Uint8Array): ValidationResult {
  const warnings: FileError[] = [];
  const errors: FileError[] = [];

  // Check for null bytes (strong binary indicator)
  if (hasNullBytes(bytes)) {
    errors.push(new FileError('File appears to be binary, not a text log file', 'error'));
    return validationFailure(errors, warnings);
  }

  // Detect BOM
  const bomEncoding = detectBOM(bytes);
  const bytesToValidate = stripBOM(bytes);

  // Strict UTF-8 validation
  const utf8Validation = validateUTF8(bytesToValidate, true);
  if (utf8Validation.valid) {
    return validationSuccess(warnings, { encoding: bomEncoding || 'utf-8' });
  }

  // Lenient UTF-8 validation (allows invalid sequences)
  const lenientValidation = validateUTF8(bytesToValidate, false);
  if (lenientValidation.valid) {
    warnings.push(
      new FileError('File has some encoding issues but will be processed', 'warning')
    );
    return validationSuccess(warnings, { encoding: bomEncoding || 'utf-8' });
  }

  // Try ISO-8859-1 as fallback
  try {
    // ISO-8859-1 can decode any byte sequence (0x00-0xFF all valid)
    new TextDecoder('iso-8859-1').decode(bytesToValidate);
    warnings.push(
      new FileError('File uses non-standard encoding (will be converted)', 'warning')
    );
    return validationSuccess(warnings, { encoding: 'iso-8859-1' });
  } catch {
    // ISO-8859-1 decodes every possible byte value (0x00–0xFF), so this
    // branch should never execute in practice. If it somehow does, surface the
    // failure as a user-visible error rather than silently swallowing it.
    errors.push(
      new FileError('File encoding is not supported', 'error')
    );
    return validationFailure(errors, warnings);
  }
}

/**
 * Decodes bytes using detected encoding with fallback
 */
export function decodeTextBytes(bytes: Uint8Array, encoding?: string): string {
  // Strip BOM
  const bytesToDecode = stripBOM(bytes);

  if (encoding === 'iso-8859-1') {
    return new TextDecoder('iso-8859-1').decode(bytesToDecode);
  }

  // Default to UTF-8 with lenient mode to avoid decode errors
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytesToDecode);
  } catch {
    // Fallback to lenient UTF-8
    return new TextDecoder('utf-8', { fatal: false }).decode(bytesToDecode);
  }
}

/**
 * Validates plain text file content
 */
export async function validateTextFile(file: File): Promise<ValidationResult> {
  const warnings: FileError[] = [];
  const errors: FileError[] = [];

  // Check file size
  if (file.size === 0) {
    return validationSuccess(warnings, { encoding: 'utf-8' }); // Empty files are ok
  }

  if (file.size > MAX_FILE_SIZE) {
    errors.push(
      new FileError(`File too large (${formatFileSize(file.size)}). Maximum is 500MB`, 'error')
    );
    return validationFailure(errors, warnings);
  }

  if (file.size > WARN_FILE_SIZE) {
    warnings.push(
      new FileError(`Large file (${formatFileSize(file.size)}). This may take a moment`, 'warning')
    );
  }

  // Read first 1KB to validate encoding
  const headerBlob = file.slice(0, 1024);
  const headerBuffer = await readBlob(headerBlob);
  const headerUint8 = new Uint8Array(headerBuffer);

  const contentValidation = isValidTextContent(headerUint8);
  
  // Combine warnings from size check and content validation
  return {
    ...contentValidation,
    warnings: [...warnings, ...contentValidation.warnings],
  };
}

/**
 * Validates gzip file: checks magic number and samples decompressed content
 */
export async function validateGzipFile(
  file: File,
  decompressSync: (data: Uint8Array) => Uint8Array
): Promise<ValidationResult> {
  const warnings: FileError[] = [];
  const errors: FileError[] = [];

  // Check file size
  if (file.size === 0) {
    errors.push(new FileError('File is empty', 'error'));
    return validationFailure(errors, warnings);
  }

  if (file.size > MAX_FILE_SIZE) {
    errors.push(
      new FileError(`File too large (${formatFileSize(file.size)}). Maximum is 500MB`, 'error')
    );
    return validationFailure(errors, warnings);
  }

  if (file.size > WARN_FILE_SIZE) {
    warnings.push(
      new FileError(`Large file (${formatFileSize(file.size)}). This may take a moment`, 'warning')
    );
  }

  // Read entire gzip file to check header and decompress
  const fileBuffer = await readBlob(file);
  const compressedUint8 = new Uint8Array(fileBuffer);

  // Validate gzip header (magic number)
  if (!isValidGzipHeader(compressedUint8)) {
    errors.push(new FileError('Not a valid gzip file', 'error'));
    return validationFailure(errors, warnings);
  }

  // Try to decompress
  let decompressedUint8: Uint8Array;
  try {
    decompressedUint8 = decompressSync(compressedUint8);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    errors.push(new FileError(`Failed to decompress file: ${message}`, 'error'));
    return validationFailure(errors, warnings);
  }

  // Validate decompressed content (sample first 1KB)
  const sampleSize = Math.min(1024, decompressedUint8.length);
  const sample = decompressedUint8.slice(0, sampleSize);
  const contentValidation = isValidTextContent(sample);

  // Combine warnings from size check and content validation
  return {
    ...contentValidation,
    warnings: [...warnings, ...contentValidation.warnings],
  };
}

/**
 * Read a blob (a dropped file) as an ArrayBuffer through FileReader: unlike
 * `Blob.arrayBuffer()`, jsdom implements it, so callers stay testable.
 *
 * @example new Uint8Array(await readBlob(file))
 */
export function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
      } else {
        reject(new Error('Failed to read blob as ArrayBuffer'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Fetch a URL's body as bytes, throwing on an HTTP error so callers report it
 * rather than parse an error page: archives and demo logs are fetched this way.
 *
 * @example const bytes = await fetchBytes('http://127.0.0.1:7357/case/shake.tar.gz');
 */
export async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
