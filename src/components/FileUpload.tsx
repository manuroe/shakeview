import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { decompressSync } from 'fflate';
import { parseLogFile } from '../utils/logParser';
import { useLogStore } from '../stores/logStore';
import { useArchiveStore } from '../stores/archiveStore';
import { assertArchiveSizeOk, parseTarGzArchive } from '../utils/tarGzArchive';
import {
  validateTextFile,
  validateGzipFile,
  decodeTextBytes,
} from '../utils/fileValidator';
import { wrapError, FileError, type AppError } from '../utils/errorHandling';
import ErrorDisplay from './ErrorDisplay';
import styles from './FileUpload.module.css';

function isTarGzFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.tar.gz');
}

function isGzipFile(file: File): boolean {
  // .tar.gz files are handled separately — exclude them from single-file gzip path
  if (isTarGzFile(file)) return false;
  // Prefer MIME type when provided, but fall back to filename extension for robustness
  if (file.type === 'application/gzip' || file.type === 'application/x-gzip') {
    return true;
  }

  const fileName = file.name.toLowerCase();
  return fileName.endsWith('.gz') || fileName.endsWith('.log.gz');
}

export function FileUpload() {
  const navigate = useNavigate();
  const loadMergedLogParserResults = useLogStore((state) => state.loadMergedLogParserResults);
  const lastRoute = useLogStore((state) => state.lastRoute);
  const loadArchive = useArchiveStore((state) => state.loadArchive);
  const [validationError, setValidationError] = useState<AppError | null>(null);
  const [validationWarnings, setValidationWarnings] = useState<AppError[]>([]);

  // Helper functions defined before use
  const readFileAsText = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result;
        if (typeof result === 'string') {
          resolve(result);
        } else {
          reject(new Error('Failed to read file as text'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file, 'UTF-8');
    });
  }, []);

  const readFileAsArrayBuffer = useCallback((file: File): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result;
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          reject(new Error('Failed to read file as ArrayBuffer'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }, []);

  const handleTarGzFile = useCallback(
    async (file: File) => {
      try {
        // Checked before reading, so an oversized archive never enters memory.
        assertArchiveSizeOk(file.size);
        const buffer = await readFileAsArrayBuffer(file);
        loadArchive(file.name, parseTarGzArchive(new Uint8Array(buffer)));
        void navigate('/archive');
      } catch (error) {
        const appError = wrapError(error, 'Failed to open archive. Make sure it is a valid .tar.gz file.');
        setValidationError(appError);
      }
    },
    [loadArchive, navigate, readFileAsArrayBuffer]
  );

  const handleFile = useCallback(
    async (file: File) => {
      setValidationError(null);
      setValidationWarnings([]);

      if (isTarGzFile(file)) {
        await handleTarGzFile(file);
        return;
      }

      try {
        let logContent: string;
        let warnings: AppError[] = [];

        if (isGzipFile(file)) {
          // Validate gzip file
          const gzipValidation = await validateGzipFile(file, decompressSync);
          if (!gzipValidation.isValid) {
            // Set first error, or generic message if none
            setValidationError(gzipValidation.errors[0] || new FileError('Invalid gzip file'));
            return;
          }
          warnings = gzipValidation.warnings;

          // Decompress
          const fileBuffer = await readFileAsArrayBuffer(file);
          const compressedUint8 = new Uint8Array(fileBuffer);
          const decompressedUint8 = decompressSync(compressedUint8);
          logContent = decodeTextBytes(decompressedUint8, gzipValidation.metadata?.encoding as string);
        } else {
          // Validate plain text file
          const textValidation = await validateTextFile(file);
          if (!textValidation.isValid) {
            // Set first error, or generic message if none
            setValidationError(textValidation.errors[0] || new FileError('Invalid text file'));
            return;
          }
          warnings = textValidation.warnings;

          // Read as text
          logContent = await readFileAsText(file);
        }

        // Show warnings if any
        if (warnings.length > 0) {
          setValidationWarnings(warnings);
        }

        // Parse once and derive both sync-specific and all HTTP requests
        const result = parseLogFile(logContent);

        // Load via the merged path (single entry) so loadedEntryNames + logFileName
        // are set together and stay accurate.
        loadMergedLogParserResults([{ name: file.name, result }]);
        const targetRoute = lastRoute && lastRoute !== '/' ? lastRoute : '/summary';
        void navigate(targetRoute);
      } catch (error) {
        // Error handler: log error for debugging (allowed in error handlers)
        console.error('Error processing file:', error);
        const appError = wrapError(error, 'Error processing file. Please try again.');
        setValidationError(appError);
      }
    },
    [loadMergedLogParserResults, navigate, lastRoute, readFileAsText, readFileAsArrayBuffer, handleTarGzFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.classList.remove(styles.dragover);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        void handleFile(files[0]);
      }
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.classList.add(styles.dragover);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.currentTarget.classList.remove(styles.dragover);
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        void handleFile(e.target.files[0]);
      }
    },
    [handleFile]
  );


  const handleClick = useCallback(() => {
    document.getElementById('file-input')?.click();
  }, []);

  return (
    <div
      id="drop-zone"
      className={styles.dropZone}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <div className={styles.dropZoneContent} onClick={handleClick}>
        <svg className={styles.dropIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <h2>Drop Rageshake Here</h2>
        <p>or click to browse</p>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
          Supports .log, .log.gz or .tar.gz archive files
        </p>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
          All log data is processed locally in your browser. No server interaction
        </p>
        {validationError && (
          <ErrorDisplay
            error={validationError}
            onDismiss={() => setValidationError(null)}
            className={styles.dropZoneError}
          />
        )}
        {validationWarnings.length > 0 && !validationError && (
          <div style={{ marginTop: '10px' }}>
            {validationWarnings.map((warning, idx) => (
              <ErrorDisplay
                key={idx}
                error={warning}
                onDismiss={() => setValidationWarnings(prev => prev.filter((_, i) => i !== idx))}
              />
            ))}
          </div>
        )}
        <input
          type="file"
          id="file-input"
          accept=".log,.txt,.log.gz,.gz,.tar.gz"
          onChange={handleFileInput}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  );
}
