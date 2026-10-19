import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';
import { setToken } from '../src/api';

afterEach(() => {
  setToken('');
  vi.unstubAllGlobals();
});

it('asks for the access token when the service answers 401', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"no"}', { status: 401 })));
  render(<App />);
  expect(await screen.findByText('Connect to the Backurau service')).toBeInTheDocument();
  const connect = screen.getByRole('button', { name: 'Connect' });
  expect(connect).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Access token'), 'a'.repeat(16));
  expect(connect).toBeEnabled();
});

it('says the backend is not connected instead of showing data', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
  render(<App />);
  expect(await screen.findByText('Backend not connected')).toBeInTheDocument();
  expect(screen.queryByText('Compare')).not.toBeInTheDocument();
});
