import { useRef, useState, type ReactNode } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';
import styles from './InfoPopover.module.css';

/** An ⓘ button opening an explanation on click; `label` names both. `alignEnd` opens it leftwards, for icons near the right edge. */
export function InfoPopover({ label, alignEnd = false, children }: { label: string; alignEnd?: boolean; children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useClickOutside(ref, () => setIsOpen(false), isOpen);
  return (
    <span className={styles.help} ref={ref}>
      <button
        type="button" className={styles.helpButton} onClick={() => setIsOpen((o) => !o)}
        aria-label={label} aria-expanded={isOpen} aria-haspopup="dialog"
      >ⓘ</button>
      {isOpen && <div className={`${styles.helpPanel} ${alignEnd ? styles.alignEnd : ''}`} role="dialog" aria-label={label}>{children}</div>}
    </span>
  );
}

/** A titled part of an InfoPopover, so a longer explanation reads as short sections rather than one block. */
export function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}
