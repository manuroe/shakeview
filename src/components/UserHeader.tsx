import { useRef, useState } from 'react';
import { useMatrixProfile } from '../hooks/useMatrixProfile';
import { useClickOutside } from '../hooks/useClickOutside';
import { plural } from '../utils/crypto/format';
import type { RoomCount } from '../utils/roomCount';
import { CopyIcon } from './icons';
import styles from './UserHeader.module.css';

/** What each device key is for, named as the logs use it. */
const KEY_ROLE: Readonly<Record<string, string>> = {
  curve25519: 'Identity key · sender_key in logs',
  ed25519: 'Signing key',
};

/** `details.json`'s `device_keys` ("curve25519:abc, ed25519:def") as algorithm/key pairs. */
const parseKeys = (deviceKeys: string) => deviceKeys.split(/,\s*/).filter(Boolean).map((k) => {
  const colon = k.indexOf(':');
  return colon < 0 ? { algorithm: 'key', key: k } : { algorithm: k.slice(0, colon), key: k.slice(colon + 1) };
});

/** The rooms the user is in (Element X iOS logs its room list), and the rooms these logs mention. */
function Rooms({ rooms }: { readonly rooms: RoomCount }) {
  return (
    <>
      {rooms.listed !== null && (
        <span className={styles.rooms} title="Rooms the user is in: the app's room list size, last logged">{plural(rooms.listed, 'room')}</span>
      )}
      <span className={`${styles.rooms} ${styles.seen}`} title="Distinct rooms these logs mention">
        {rooms.listed !== null ? `${rooms.seen} in logs` : `${plural(rooms.seen, 'room')} in logs`}
      </span>
    </>
  );
}

/**
 * Whose rageshake this is, centred in a view's header: avatar, display name, user and device IDs,
 * and their rooms. Clicking it shows the device's keys from `details.json`, the curve key being
 * how a sender's logs name this device. Renders nothing without a user or a device.
 */
export function UserHeader({ userId, deviceId, deviceKeys, rooms, anonymized = false }: {
  readonly userId: string | null | undefined;
  readonly deviceId: string | null | undefined;
  /** `details.json`'s `device_keys`, e.g. "curve25519:abc, ed25519:def". */
  readonly deviceKeys?: string | null;
  readonly rooms?: RoomCount | null;
  /** Anonymized logs never ask a homeserver for the profile. */
  readonly anonymized?: boolean;
}) {
  const profile = useMatrixProfile(anonymized ? undefined : userId);
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    setIsOpen(false);
    setCopied(null);
  };
  useClickOutside(ref, close, isOpen);
  if (!userId && !deviceId) return null;

  const keys = parseKeys(deviceKeys ?? '');
  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(key);
    } catch {
      // Clipboard denied (permissions, insecure context): the key stays selectable.
    }
  };
  const identity = (
    <>
      {profile?.avatarHttpUrl && <img src={profile.avatarHttpUrl} alt="" className={styles.avatar} onError={(e) => { e.currentTarget.hidden = true; }} />}
      {/* Line 1 is the person, line 2 this rageshake's device. */}
      <span className={styles.identityText}>
        <span className={styles.line}>
          {profile?.displayName && <span className={styles.displayName}>{profile.displayName}</span>}
          {userId && <span className={styles.ids}>{userId}</span>}
        </span>
        {(deviceId || rooms) && (
          <span className={`${styles.line} ${styles.meta}`}>
            {deviceId && <span className={styles.ids}>{deviceId}</span>}
            {rooms && <Rooms rooms={rooms} />}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div className={`header-center ${styles.center}`}>
      <div className={styles.identity} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        {keys.length > 0 ? (
          <button
            type="button" className={styles.toggle} onClick={() => (isOpen ? close() : setIsOpen(true))}
            aria-expanded={isOpen} aria-haspopup="dialog" title="Show the device keys"
          >{identity}</button>
        ) : identity}
        {isOpen && keys.length > 0 && (
          <div className={styles.keys} role="dialog" aria-label="Device keys">
            <div className={styles.keysTitle}>
              Device keys{deviceId && <code>{deviceId}</code>}
            </div>
            <dl className={styles.keyList}>
              {keys.map(({ algorithm, key }) => (
                <div key={algorithm + key} className={styles.keyRow}>
                  <dt>{algorithm}</dt>
                  <dd>
                    <code>{key}</code>
                    {KEY_ROLE[algorithm] && <span className={styles.keyRole}>{KEY_ROLE[algorithm]}</span>}
                  </dd>
                  <button
                    type="button" className={styles.copy} onClick={() => { void copy(key); }}
                    aria-label={`Copy the ${algorithm} key`} title={copied === key ? 'Copied' : 'Copy'}
                  >
                    {copied === key ? '✓' : <CopyIcon width={14} height={14} />}
                  </button>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
