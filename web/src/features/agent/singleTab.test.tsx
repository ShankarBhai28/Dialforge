import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { configureSingleTab, useSingleTab } from './singleTab';

// An in-memory BroadcastChannel: every channel hears the others, not itself.
type Msg = { t: 'who' | 'here' | 'take'; id: string };
function bus() {
  const chans = new Set<{ onmessage: ((e: { data: Msg }) => void) | null }>();
  return () => {
    const ch = {
      onmessage: null as ((e: { data: Msg }) => void) | null,
      postMessage(m: Msg) {
        for (const other of chans) if (other !== ch) queueMicrotask(() => other.onmessage?.({ data: m }));
      },
      close() {
        chans.delete(ch);
      },
    };
    chans.add(ch);
    return ch;
  };
}

function Tab({ name }: { name: string }) {
  const { state, takeOver } = useSingleTab();
  return (
    <div>
      <span>
        {name}: {state}
      </span>
      <button onClick={takeOver}>use {name}</button>
    </div>
  );
}

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('one agent tab', () => {
  afterEach(() => configureSingleTab({ enabled: false }));

  it('the first tab works; a second waits; "Use here" moves the work over', async () => {
    configureSingleTab({ enabled: true, channel: bus(), checkMs: 20 });
    render(<Tab name="A" />);
    expect(screen.getByText('A: checking')).toBeInTheDocument();
    await wait(40);
    expect(screen.getByText('A: active')).toBeInTheDocument();

    render(<Tab name="B" />);
    await wait(40);
    expect(screen.getByText('B: blocked')).toBeInTheDocument();
    expect(screen.getByText('A: active')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'use B' }));
    await wait(10);
    expect(screen.getByText('B: active')).toBeInTheDocument();
    expect(screen.getByText('A: blocked')).toBeInTheDocument();
  });
});
