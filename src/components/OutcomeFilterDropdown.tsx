import { useRef, useState } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import { toggleFilterKey } from '../utils/filterSelection';
import styles from './OutcomeFilterDropdown.module.css';

export interface OutcomeOption {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly count: number;
  readonly color: string;
}

interface OutcomeFilterDropdownProps {
  readonly options: readonly OutcomeOption[];
  /** Every outcome, listed or not: unticking one from All keeps those another filter hides. */
  readonly allOptions: readonly Omit<OutcomeOption, 'count'>[];
  /** null: everything shown. */
  readonly selected: ReadonlySet<string> | null;
  readonly onChange: (selected: ReadonlySet<string> | null) => void;
}

/** Multi-select of /decryption session outcomes, grouped; same behaviour as StatusFilterDropdown, plus a double click selecting only one outcome. */
export function OutcomeFilterDropdown({ options, allOptions, selected, onChange }: OutcomeFilterDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setIsOpen(false), isOpen);

  const allKeys = allOptions.map((o) => o.key);
  // `Decryption: All`, `Decryption: late_key`, `Decryption: late_key + 1`, `Decryption: All − Key received`: what is filtered, at a glance.
  const picked = allOptions.filter((o) => selected?.has(o.key));
  const dropped = allOptions.filter((o) => !selected?.has(o.key));
  const [shown, rest] = dropped.length < picked.length ? [`All − ${dropped[0]?.label}`, dropped.length - 1] : [picked[0]?.label ?? '?', picked.length - 1];
  const label = `Decryption: ${selected === null ? 'All' : `${shown}${rest > 0 ? ` + ${rest}` : ''}`}`;
  const groups = [...new Set(options.map((o) => o.group))];

  return (
    <div className={styles.container} ref={ref}>
      <button className={styles.button} onClick={() => setIsOpen((o) => !o)} title="Filter sessions by outcome" aria-expanded={isOpen} aria-haspopup="dialog">
        {label}
      </button>
      {isOpen && (
        <div className={styles.dropdown}>
          <button className={styles.selectAll} onClick={() => onChange(null)}>Select All</button>
          {groups.map((g) => (
            <div key={g}>
              <div className={styles.divider} />
              <div className={styles.group}>{g}</div>
              {options.filter((o) => o.group === g).map((o) => (
                // Its two clicks tick and untick first, then the double click keeps this outcome alone.
                <label key={o.key} className={`${styles.option} ${o.count === 0 ? styles.empty : ''}`} onDoubleClick={() => onChange(new Set([o.key]))}>
                  <input type="checkbox" checked={selected === null || selected.has(o.key)} onChange={() => onChange(toggleFilterKey(selected, allKeys, o.key))} />
                  <span className={styles.label} style={{ color: o.color }}>{o.label}</span>
                  <span className={styles.count}>{o.count}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
