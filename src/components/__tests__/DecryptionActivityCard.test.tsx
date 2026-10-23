import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DecryptionActivityCard } from '../DecryptionActivityCard';
import { parseLogFile } from '../../utils/logParser';
import { RECEIVER_LOG, RECEIVER_LATE_LINES } from '../../utils/crypto/__tests__/fixtures';

vi.mock('../BaseActivityChart', () => ({
  // The tooltip of every non-empty bucket, to check its rows.
  BaseActivityChart: (p: { categories: string[]; buckets: { total: number }[]; renderTooltipContent: (b: unknown) => React.ReactNode }) => (
    <>
      <div data-testid="chart">{p.categories.join(',')}</div>
      {p.buckets.filter((b) => b.total > 0).map((b, i) => <div key={i} data-testid="tooltip">{p.renderTooltipContent(b)}</div>)}
    </>
  ),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const lines = parseLogFile(`${RECEIVER_LOG}\n${RECEIVER_LATE_LINES}`).rawLogLines;
/** A timeline handles $ev1 while UTD: never decrypted, so analytics receive it as a UTD. */
const HANDLED = '2026-09-08T06:55:23.000000Z TRACE matrix_sdk_ui::timeline::event_handler: Handling remote event | crates/matrix-sdk-ui/src/timeline/event_handler.rs:653 | spans: handle_event{event_id="$ev1" position=End { origin: Sync }}';

describe('DecryptionActivityCard', () => {
  it('charts keys and UTDs apart, then UTDs per reason and late decryptions per mechanism', () => {
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={lines} filteredLogLines={lines} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /^New megolm keys/ })).toHaveTextContent('New megolm keys: 1');
    expect(screen.getByRole('heading', { name: /^UTDs/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('chart').map((c) => c.textContent)).toEqual([
      'room_key,room_key_late,forwarded,bundle,backup,outbound', 'reported,not_reported,unknown',
    ]);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Still failing (1)', 'Sessions', 'Events', 'Reported ⓘ', 'Late decryptions (1)', 'Sessions', 'Events', 'Reported ⓘ', 'Median delay',
    ]);
    fireEvent.click(screen.getAllByRole('button', { name: 'What Reported counts' })[0]);
    expect(screen.getByRole('dialog', { name: 'What Reported counts' })).toHaveTextContent(/still not decrypted 4 s after the app first tried to show it.*Worked out from the logs with the same rules as Element Web and Element X/);
    expect(screen.getByRole('row', { name: /MissingMegolmSession/ })).toHaveTextContent('MissingMegolmSession110');
    expect(screen.getByRole('row', { name: /late_key/ })).toHaveTextContent('late_key11020.0s');
  });

  it('the Reported ⓘ links the decryption page on the same time window', () => {
    render(<MemoryRouter initialEntries={['/summary?start=2026-09-08T06:55:00Z&end=2026-09-08T07:00:00Z']}><DecryptionActivityCard rawLogLines={lines} filteredLogLines={lines} /></MemoryRouter>);
    fireEvent.click(screen.getAllByRole('button', { name: 'What Reported counts' })[0]);
    expect(within(screen.getByRole('dialog', { name: 'What Reported counts' })).getByRole('link', { name: 'decryption page' }))
      .toHaveAttribute('href', '/decryption?start=2026-09-08T06%3A55%3A00Z&end=2026-09-08T07%3A00%3A00Z');
  });

  it('opens /decryption on a row from any of its counts; zero is not a link', () => {
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={lines} filteredLogLines={lines} /></MemoryRouter>);
    const row = within(screen.getByRole('row', { name: /MissingMegolmSession/ }));
    expect(row.getAllByRole('button')).toHaveLength(2); // sessions, events; reported is 0
    fireEvent.click(row.getAllByRole('button')[0]);
    expect(mockNavigate).toHaveBeenLastCalledWith('/decryption?outcome=utd%3Amissing_key');
    fireEvent.click(within(screen.getAllByRole('columnheader')[4]).getByRole('button', { name: '1' }));
    expect(mockNavigate).toHaveBeenLastCalledWith('/decryption?outcome=late%3Alate_key');
  });

  it('hides the UTD table when every UTD resolved', () => {
    const lateOnly = lines.slice(3); // RECEIVER_LATE_LINES only: one UTD, then its key
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={lateOnly} filteredLogLines={lateOnly} /></MemoryRouter>);
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.queryByText(/Still failing/)).toBeNull();
  });

  it('hides the late decryptions table when nothing resolved', () => {
    const windowLines = lines.slice(0, 3); // RECEIVER_LOG only: one unresolved UTD
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={lines} filteredLogLines={windowLines} /></MemoryRouter>);
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.queryByText(/Late decryptions/)).toBeNull();
  });

  it('opens /decryption on the same time window', () => {
    render(<MemoryRouter initialEntries={['/summary?start=2026-09-08T06:55:00Z&end=2026-09-08T06:56:00Z&filter=x']}><DecryptionActivityCard rawLogLines={lines} filteredLogLines={lines} /></MemoryRouter>);
    fireEvent.click(within(screen.getAllByRole('columnheader')[0]).getByRole('button'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/decryption?outcome=utd%3Amissing_key&start=2026-09-08T06%3A55%3A00Z&end=2026-09-08T06%3A56%3A00Z');
  });

  it('counts only the UTDs of the time window', () => {
    const windowLines = lines.slice(0, 3); // RECEIVER_LOG only: one UTD, at 06:55:22
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={lines} filteredLogLines={windowLines} /></MemoryRouter>);
    expect(screen.getAllByRole('columnheader')[0]).toHaveTextContent('Still failing (1)');
  });

  it('tooltips list only the non-zero analytics categories, each with how its UTDs ended', () => {
    const handled = parseLogFile(`${RECEIVER_LOG}\n${HANDLED}\n${RECEIVER_LATE_LINES}`).rawLogLines;
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={handled} filteredLogLines={handled} /></MemoryRouter>);
    expect(screen.getAllByTestId('tooltip').map((t) => t.textContent)).toEqual([
      'm.room_key (late)1Total1',
      'Reported1Still failing 1Total1',
      'Not reported1late_key 1Total1',
    ]);
  });

  it('says so when the window has no key and no UTD', () => {
    const quiet = parseLogFile('2026-09-08T06:55:10.000000Z  INFO matrix_sdk::sync: hello | crates/x.rs:1').rawLogLines;
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={quiet} filteredLogLines={quiet} /></MemoryRouter>);
    expect(screen.getByText('No new megolm keys')).toBeInTheDocument();
    expect(screen.getByText('No UTD')).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).toBeNull();
  });

  it('charts a key without a UTD on the keys chart only', () => {
    const keyOnly = parseLogFile(RECEIVER_LATE_LINES.split('\n')[1]).rawLogLines;
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={keyOnly} filteredLogLines={keyOnly} /></MemoryRouter>);
    expect(screen.getAllByTestId('chart')).toHaveLength(1);
    expect(screen.getByText('No UTD')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says in the title how many UTDs analytics received, linked to /decryption', () => {
    const handled = parseLogFile(`${RECEIVER_LOG}\n${HANDLED}\n${RECEIVER_LATE_LINES}`).rawLogLines;
    render(<MemoryRouter initialEntries={['/summary?start=2026-09-08T06:55:00Z']}><DecryptionActivityCard rawLogLines={handled} filteredLogLines={handled} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /^UTDs/ })).toHaveTextContent(/^UTDs: 1 reported$/);
    fireEvent.click(screen.getByRole('button', { name: 'Open the UTDs reported to analytics' }));
    expect(mockNavigate).toHaveBeenLastCalledWith('/decryption?analytics=reported&start=2026-09-08T06%3A55%3A00Z');
  });

  it('links a reported count to the reported UTDs of its row', () => {
    const handled = parseLogFile(`${RECEIVER_LOG}\n${HANDLED}\n${RECEIVER_LATE_LINES}`).rawLogLines;
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={handled} filteredLogLines={handled} /></MemoryRouter>);
    const row = within(screen.getByRole('row', { name: /MissingMegolmSession/ }));
    expect(row.getAllByRole('cell').map((c) => c.textContent)).toEqual(['MissingMegolmSession', '1', '1', '1']);
    fireEvent.click(row.getAllByRole('button')[2]);
    expect(mockNavigate).toHaveBeenLastCalledWith('/decryption?outcome=utd%3Amissing_key&analytics=reported');
  });

  it('keeps the title bare when nothing is reported', () => {
    render(<MemoryRouter><DecryptionActivityCard rawLogLines={lines} filteredLogLines={lines} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /^UTDs/ })).toHaveTextContent(/^UTDs$/);
    expect(screen.queryByRole('button', { name: 'Open the UTDs reported to analytics' })).toBeNull();
  });
});
