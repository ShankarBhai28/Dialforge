import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// findBy*/waitFor wait up to 5 s (default 1 s): under a full parallel run on
// a busy machine, a screen can take longer than 1 s to fetch and render.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
