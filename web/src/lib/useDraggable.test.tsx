import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { clampToWindow, useDraggable } from './useDraggable';

const KEY = 'test.panel.pos';

function Panel() {
  const { attach, style, handleProps, moved, reset } = useDraggable<HTMLDivElement>(KEY);
  return (
    <div ref={attach} style={style} data-testid="panel">
      <div {...handleProps} data-testid="handle">
        Move me
        <button type="button" onClick={reset}>
          inner button
        </button>
      </div>
      {moved && <span>moved</span>}
    </div>
  );
}

// jsdom has no layout: the panel is 300 x 200, starting at (700, 500) in a 1024 x 768 window.
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 700,
    top: 500,
    width: 300,
    height: 200,
    right: 1000,
    bottom: 700,
    x: 700,
    y: 500,
    toJSON: () => ({}),
  } as DOMRect);
});
afterEach(() => vi.restoreAllMocks());

const drag = (from: [number, number], to: [number, number]) => {
  const h = screen.getByTestId('handle');
  fireEvent.pointerDown(h, { button: 0, clientX: from[0], clientY: from[1], pointerId: 1 });
  fireEvent.pointerMove(h, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(h, { clientX: to[0], clientY: to[1], pointerId: 1 });
};

describe('draggable panel', () => {
  it('stays in its CSS corner until dragged, then moves with the pointer and is remembered', () => {
    render(<Panel />);
    expect(screen.getByTestId('panel').style.left).toBe('');
    drag([720, 510], [420, 210]); // 300 left, 300 up
    expect(screen.getByTestId('panel').style.left).toBe('400px');
    expect(screen.getByTestId('panel').style.top).toBe('200px');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ x: 400, y: 200 });
    expect(screen.getByText('moved')).toBeInTheDocument();
  });

  it('opens where it was left, and double-click puts it back', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 50, y: 60 }));
    render(<Panel />);
    expect(screen.getByTestId('panel').style.left).toBe('50px');
    fireEvent.doubleClick(screen.getByTestId('handle'));
    expect(screen.getByTestId('panel').style.left).toBe('');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("can't be dragged out of the window", () => {
    render(<Panel />);
    drag([720, 510], [5000, -5000]);
    // 1024 - 300 - 8 = 716 wide, top margin 8
    expect(screen.getByTestId('panel').style.left).toBe('716px');
    expect(screen.getByTestId('panel').style.top).toBe('8px');
    expect(clampToWindow({ x: -50, y: 900 }, 300, 200)).toEqual({ x: 8, y: 560 });
  });

  it('a button inside the bar still works and does not start a drag', () => {
    render(<Panel />);
    const btn = screen.getByRole('button', { name: 'inner button' });
    fireEvent.pointerDown(btn, { button: 0, clientX: 720, clientY: 510, pointerId: 1 });
    fireEvent.pointerMove(screen.getByTestId('handle'), { clientX: 100, clientY: 100, pointerId: 1 });
    expect(screen.getByTestId('panel').style.left).toBe('');
  });
});
