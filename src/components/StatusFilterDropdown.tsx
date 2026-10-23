import { useRef, useState, useCallback } from 'react';
import { useLogStore } from '../stores/logStore';
import { useURLParams } from '../hooks/useURLParams';
import { useClickOutside } from '../hooks/useClickOutside';
import { INCOMPLETE_STATUS_KEY, CLIENT_ERROR_STATUS_KEY } from '../utils/statusCodeUtils';
import { getHttpStatusColor } from '../utils/httpStatusColors';
import { toggleFilterKey } from '../utils/filterSelection';
import styles from './StatusFilterDropdown.module.css';

interface StatusFilterDropdownProps {
  /** Available status codes to show in the dropdown */
  availableStatusCodes: string[];
}

/**
 * Multi-select dropdown for filtering requests by HTTP status code.
 * Reads statusCodeFilter from store (derived from URL), writes to URL via useURLParams.
 */
export function StatusFilterDropdown({ availableStatusCodes }: StatusFilterDropdownProps) {
  const { statusCodeFilter } = useLogStore();
  const { setStatusFilter } = useURLParams();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useClickOutside(dropdownRef, () => setIsOpen(false), isOpen);

  /** Toggle a status code in the filter */
  const toggleStatusCode = useCallback((code: string) => {
    setStatusFilter(toggleFilterKey(statusCodeFilter, availableStatusCodes, code));
  }, [statusCodeFilter, availableStatusCodes, setStatusFilter]);

  /** Select all status codes (reset filter) */
  const selectAll = useCallback(() => {
    setStatusFilter(null);
  }, [setStatusFilter]);

  /** Check if a status code is enabled */
  const isEnabled = (code: string) => {
    return statusCodeFilter === null || statusCodeFilter.has(code);
  };

  /** Get color for status code */
  const getStatusColor = (code: string) => {
    if (code === CLIENT_ERROR_STATUS_KEY) return 'var(--http-client-error)';
    return getHttpStatusColor(code === INCOMPLETE_STATUS_KEY ? 'incomplete' : code);
  };

  /** Get label for the dropdown button */
  const buttonLabel = statusCodeFilter === null
    ? 'All Status'
    : statusCodeFilter.size === 1
      ? Array.from(statusCodeFilter)[0]
      : `${statusCodeFilter.size} selected`;

  return (
    <div className={styles.container} ref={dropdownRef}>
      <button
        className={styles.button}
        onClick={() => setIsOpen(!isOpen)}
        title="Filter by status code"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-controls="status-filter-dropdown"
      >
        {buttonLabel}
      </button>
      {isOpen && (
        <div className={styles.dropdown} id="status-filter-dropdown">
          <button
            className={styles.selectAll}
            onClick={selectAll}
          >
            Select All
          </button>
          <div className={styles.divider} />
          {availableStatusCodes.map((code) => (
            <label key={code} className={styles.option}>
              <input
                type="checkbox"
                checked={isEnabled(code)}
                onChange={() => toggleStatusCode(code)}
              />
              <span className={styles.statusCodeLabel} style={{ color: getStatusColor(code) }}>
                {code}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
