import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordingPlayer, clock } from './RecordingPlayer';

/** Sets what the browser would report on the <audio> element, then fires the event. */
function audioEvent(el: HTMLAudioElement, type: string, props: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { value: v, configurable: true });
  act(() => void fireEvent(el, new Event(type)));
}
const noSeekable = { length: 0, end: () => 0 };

describe('RecordingPlayer', () => {
  it('the elapsed time runs and the length shows; speed cycles 1x / 1.5x / 2x', async () => {
    render(<RecordingPlayer src="/r/1" label="Recording of call 1" autoPlay={false} />);
    const a = screen.getByLabelText('Recording of call 1') as HTMLAudioElement;
    expect(a).toHaveAttribute('src', '/r/1');
    audioEvent(a, 'loadedmetadata', { duration: 75, seekable: noSeekable });
    expect(screen.getByLabelText('Length')).toHaveTextContent('1:15');
    audioEvent(a, 'play');
    audioEvent(a, 'timeupdate', { currentTime: 3.4 });
    expect(screen.getByLabelText('Elapsed')).toHaveTextContent('0:03');
    audioEvent(a, 'timeupdate', { currentTime: 61 });
    expect(screen.getByLabelText('Elapsed')).toHaveTextContent('1:01');
    expect(screen.getByLabelText('Position')).toHaveValue('61');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Speed 1x' }));
    expect(a.playbackRate).toBe(1.5);
    await userEvent.click(screen.getByRole('button', { name: 'Speed 1.5x' }));
    await userEvent.click(screen.getByRole('button', { name: 'Speed 2x' }));
    expect(a.playbackRate).toBe(1);
  });

  it("the browser can't tell the length: the downloaded part, else the server's talk time", () => {
    render(<RecordingPlayer src="/r/2" label="Recording of call 2" seconds={42} autoPlay={false} />);
    const a = screen.getByLabelText('Recording of call 2') as HTMLAudioElement;
    audioEvent(a, 'loadedmetadata', { duration: Infinity, seekable: noSeekable });
    expect(screen.getByLabelText('Length')).toHaveTextContent('0:42');
    audioEvent(a, 'progress', { seekable: { length: 1, end: () => 40.2 } });
    expect(screen.getByLabelText('Length')).toHaveTextContent('0:40');
  });

  it('a removed recording says so instead of sitting at 0:00', () => {
    render(<RecordingPlayer src="/r/3" label="Recording of call 3" autoPlay={false} />);
    audioEvent(screen.getByLabelText('Recording of call 3') as HTMLAudioElement, 'error');
    expect(screen.getByText(/couldn't play this recording/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
  });

  it('clock', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(75.9)).toBe('1:15');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(NaN)).toBe('0:00');
  });
});
