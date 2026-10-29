import { useId } from 'react';
import { useAnonSaltStore } from '../stores/anonSaltStore';
import styles from './SaltField.module.css';

/** The app-wide anonymisation salt: edit it, regenerate it, and what it is for. */
export function SaltField() {
  const { salt, setSalt, resetSalt } = useAnonSaltStore();
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>Salt</label>
      <input
        id={id}
        type="text"
        className={styles.input}
        value={salt}
        onChange={(e) => setSalt(e.target.value)}
        placeholder="salt"
        aria-label="Anonymisation salt"
        spellCheck={false}
        autoComplete="off"
      />
      <button className={styles.reset} onClick={resetSalt}>
        Regenerate
      </button>
      <p className={styles.warning}>
        Use the same salt across installs to get matching aliases. Empty = reproducible
        but guessable.
      </p>
    </div>
  );
}
