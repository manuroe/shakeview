import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileUpload } from '../components/FileUpload';
import { parseLogFile } from '../utils/logParser';
import { useLogStore } from '../stores/logStore';
import { wrapError } from '../utils/errorHandling';
import type { AppError } from '../utils/errorHandling';
import ErrorDisplay from '../components/ErrorDisplay';
import uploadStyles from '../components/FileUpload.module.css';
import { EXTENSION_FILE_URL_PARAM, EXTENSION_FILE_NAME_PARAM } from '../hooks/useExtensionFile';

export function LandingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const loadMergedLogParserResults = useLogStore((state) => state.loadMergedLogParserResults);
  const [demoError, setDemoError] = useState<AppError | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);

  // When opened by the extension, show a loading screen immediately so the
  // user never sees the upload UI while useExtensionFile fetches the log.
  const extensionFileUrl = searchParams.get(EXTENSION_FILE_URL_PARAM);
  let extensionFileNameFromUrl: string | undefined;
  if (extensionFileUrl) {
    try {
      const parsedUrl = new URL(extensionFileUrl);
      const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
      extensionFileNameFromUrl = pathSegments[pathSegments.length - 1];
    } catch {
      // Fall back to simple split if URL parsing fails.
      extensionFileNameFromUrl = extensionFileUrl.split('/').pop() ?? undefined;
    }
  }
  const extensionFileName =
    searchParams.get(EXTENSION_FILE_NAME_PARAM) ??
    extensionFileNameFromUrl ??
    'log file';

  // Only show the loading screen when we are actually inside the extension
  // context and the sendMessage API is available. Without that guard, a stale
  // or manually crafted extensionFileUrl param would leave the user stuck on
  // the loading screen with no way to upload a file.
  const isExtensionContext =
    typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;

  if (extensionFileUrl && isExtensionContext) {
    return (
      <div className={uploadStyles.dropZone}>
        <div className={uploadStyles.dropZoneContent}>
          <p>Loading {extensionFileName}…</p>
        </div>
      </div>
    );
  }

  const prNumber = import.meta.env.VITE_PR_NUMBER;
  const githubUrl = prNumber
    ? `https://github.com/manuroe/shakeview/pull/${prNumber}`
    : 'https://github.com/manuroe/shakeview';

  const handleLoadDemo = async (fileName: 'demo.log' | 'demo-web.log') => {
    setDemoError(null);
    setDemoLoading(true);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}demo/${fileName}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const content = await response.text();
      const result = parseLogFile(content);
      loadMergedLogParserResults([{ name: fileName, result }]);
      void navigate('/summary');
    } catch (error) {
      setDemoError(wrapError(error, 'Failed to load demo. Please try again.'));
    } finally {
      setDemoLoading(false);
    }
  };

  return (
    <>
      <FileUpload />
      <ErrorDisplay
        error={demoError}
        onDismiss={() => setDemoError(null)}
        className={uploadStyles.dropZoneError}
      />
      <div className={uploadStyles.dropZoneFooter}>
        Try with demo logs:{' '}
        <button type="button" onClick={() => { void handleLoadDemo('demo.log'); }} disabled={demoLoading} aria-label="Try with mobile demo logs">
          Mobile
        </button>
        {' · '}
        <button type="button" onClick={() => { void handleLoadDemo('demo-web.log'); }} disabled={demoLoading} aria-label="Try with web demo logs">
          Web
        </button>
        {' · '}
        <a href={githubUrl} target="_blank" rel="noopener noreferrer">
          View on GitHub
        </a>
      </div>
    </>
  );
}
