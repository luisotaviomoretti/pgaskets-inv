import React from 'react';
import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import Receiving from '@/features/inventory/pages/Receiving';
import { renderWithProviders, createFixtures } from '../testUtils';
import { setReceiveError } from '../testServer';

describe('Receiving submit (error)', () => {
  it('shows error toast when API fails', async () => {
    setReceiveError('Validation failed', 422);

    const { vendors, skus, layersBySku } = createFixtures();
    renderWithProviders(
      React.createElement(Receiving as any, {
        vendors,
        skus,
        layersBySku,
        movements: [],
      })
    );

    fireEvent.change(screen.getByLabelText(/vendor/i), { target: { value: 'Acme Supplies' } });
    fireEvent.change(screen.getByLabelText(/^SKU/i), { target: { value: 'SKU-RAW-1' } });
    fireEvent.change(screen.getByLabelText(/^Quantity/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Unit cost/i), { target: { value: '2.50' } });

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm & submit/i }));

    await screen.findByText(/failed to submit receiving/i);
  });
});
