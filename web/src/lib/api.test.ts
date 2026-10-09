import { describe, expect, it } from 'vitest';
import { fakeApi } from '@/test/render';
import { ApiError, get, post } from './api';

describe('api client', () => {
  it('returns JSON and sends JSON bodies', async () => {
    const calls = fakeApi({ 'POST /leads': { body: { id: 5 } } });
    await expect(post('/leads', { name: 'A' })).resolves.toEqual({ id: 5 });
    expect(calls[0].body).toEqual({ name: 'A' });
  });

  it("turns the server's { error } into an ApiError with that message", async () => {
    fakeApi({ 'GET /admin/forms': { status: 409, body: { error: 'Cannot delete - used by a campaign' } } });
    const err = await get('/admin/forms').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: 'Cannot delete - used by a campaign' });
  });
});
