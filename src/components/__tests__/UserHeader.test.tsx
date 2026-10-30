import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { UserHeader } from '../UserHeader';
import { clearMatrixProfiles } from '../../utils/matrixProfile';

const KEYS = 'curve25519:CURVEKEY, ed25519:EDKEY';

describe('UserHeader', () => {
  const originalClipboard = navigator.clipboard;
  afterEach(() => {
    clearMatrixProfiles();
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
    vi.restoreAllMocks();
  });

  it('renders nothing without a user or a device', () => {
    const { container } = render(<UserHeader userId={null} deviceId={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the user's rooms and, apart, the rooms the logs mention", () => {
    render(<UserHeader userId="@bob:example.org" deviceId="BOBPHONE" rooms={{ listed: 317, seen: 42 }} anonymized />);
    // The person on the first line, the device and its rooms on the second.
    expect(screen.getByText('@bob:example.org').parentElement).not.toContainElement(screen.getByText('BOBPHONE'));
    expect(screen.getByText('BOBPHONE').parentElement).toContainElement(screen.getByTitle(/^Rooms the user is in/));
    expect(screen.getByTitle(/^Rooms the user is in/)).toHaveTextContent('317 rooms');
    expect(screen.getByTitle('Distinct rooms these logs mention')).toHaveTextContent('42 in logs');
  });

  it('says the rooms are only those in the logs when the app did not log its room list', () => {
    render(<UserHeader userId="@bob:example.org" deviceId="BOBPHONE" rooms={{ listed: null, seen: 1 }} anonymized />);
    expect(screen.queryByTitle(/^Rooms the user is in/)).not.toBeInTheDocument();
    expect(screen.getByTitle('Distinct rooms these logs mention')).toHaveTextContent('1 room in logs');
  });

  it('is not clickable without device keys', () => {
    render(<UserHeader userId="@bob:example.org" deviceId="BOBPHONE" anonymized />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens the device keys, copies one, and closes on Escape', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<UserHeader userId="@bob:example.org" deviceId="BOBPHONE" deviceKeys={KEYS} anonymized />);

    fireEvent.click(screen.getByRole('button', { name: /@bob:example\.org/ }));
    const panel = screen.getByRole('dialog', { name: 'Device keys' });
    expect(panel).toHaveTextContent('curve25519CURVEKEYIdentity key · sender_key in logs');
    expect(panel).toHaveTextContent('ed25519EDKEYSigning key');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the curve25519 key' }));
    });
    expect(writeText).toHaveBeenCalledWith('CURVEKEY');
    expect(screen.getByRole('button', { name: 'Copy the curve25519 key' })).toHaveAttribute('title', 'Copied');

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
