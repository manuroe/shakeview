import { useRef, useState } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import styles from './AnalyticsFilterDropdown.module.css';

export interface AnalyticsOption {
  readonly key: string;
  readonly label: string;
  /** One line under the label: what the value means. */
  readonly hint: string;
  readonly count: number;
}

interface AnalyticsFilterDropdownProps {
  readonly options: readonly AnalyticsOption[];
  /** Sessions shown with no value picked. */
  readonly anyCount: number;
  /** null: any. */
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  /** Where the values come from, under the list. */
  readonly note: string;
}

/** Single-select of /decryption sessions by whether UTD analytics received their UTDs; looks like OutcomeFilterDropdown. */
export function AnalyticsFilterDropdown({ options, anyCount, value, onChange, note }: AnalyticsFilterDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setIsOpen(false), isOpen);
  const pick = (next: string | null) => {
    onChange(next);
    setIsOpen(false);
  };
  const rows = [{ key: 'any', label: 'Any', hint: '', count: anyCount }, ...options];
  return (
    <div className={styles.container} ref={ref}>
      <button className={styles.button} onClick={() => setIsOpen((o) => !o)} title="Filter sessions by whether UTD analytics received their UTDs"
        aria-expanded={isOpen} aria-haspopup="dialog">
        Analytics: {options.find((o) => o.key === value)?.label ?? 'Any'}
      </button>
      {isOpen && (
        <div className={styles.dropdown} role="radiogroup" aria-label="Analytics">
          {rows.map((o) => (
            <label key={o.key} className={styles.option}>
              <input type="radio" name="analytics" value={o.key} checked={(value ?? 'any') === o.key} onChange={() => pick(o.key === 'any' ? null : o.key)} />
              <span className={styles.text}>
                <span>{o.label}</span>
                {o.hint && <span className={styles.hint}>{o.hint}</span>}
              </span>
              <span className={styles.count}>{o.count}</span>
            </label>
          ))}
          <div className={styles.divider} />
          <div className={styles.note}>{note}</div>
        </div>
      )}
    </div>
  );
}
