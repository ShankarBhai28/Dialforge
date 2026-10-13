// Right column: dialpad (call any number) and the agent's call log.
import { useState, type FormEvent } from 'react';
import { ChevronDown, Delete, Grid3x3, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useController } from './AgentProvider';
import { CallLog } from './CallLog';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const KEYPAD_KEY = 'df-keypad-open';

function readKeypad() {
  try {
    return localStorage.getItem(KEYPAD_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Number + Call on one line; the keypad folds away to give the call log room. */
function Dialpad() {
  const { controller } = useController();
  const [number, setNumber] = useState('');
  const [keypad, setKeypad] = useState(readKeypad);
  function toggleKeypad() {
    setKeypad(!keypad);
    try {
      localStorage.setItem(KEYPAD_KEY, keypad ? '0' : '1');
    } catch {
      /* private mode */
    }
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const n = number.trim();
    if (!n) return;
    void controller.callLead(null, n);
    setNumber('');
  }
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="flex gap-1.5">
        <Input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="Enter number"
          aria-label="Number to dial"
          inputMode="tel"
          className="text-base font-semibold tracking-wider"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={keypad ? 'Hide keypad' : 'Show keypad'}
          aria-expanded={keypad}
          title={keypad ? 'Hide keypad' : 'Show keypad'}
          onClick={toggleKeypad}
        >
          {keypad ? <ChevronDown /> : <Grid3x3 />}
        </Button>
      </div>
      {keypad && (
        <div className="grid grid-cols-3 gap-1.5">
          {KEYS.map((k) => (
            <Button
              key={k}
              type="button"
              variant="outline"
              className="h-9 text-base"
              onClick={() => setNumber((v) => v + k)}
            >
              {k}
            </Button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        {keypad && (
          <Button
            type="button"
            variant="outline"
            aria-label="Backspace"
            onClick={() => setNumber((v) => v.slice(0, -1))}
          >
            <Delete />
          </Button>
        )}
        <Button type="submit" className={cn('flex-1 bg-status-available hover:bg-status-available/90')}>
          <Phone /> Call
        </Button>
      </div>
    </form>
  );
}

export function SidePanel() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Dialpad />
      <div className="border-t" />
      <CallLog />
    </div>
  );
}
