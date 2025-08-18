import React from 'react';
import { describe, it, expect } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import Receiving from '@/features/inventory/pages/Receiving';
import { renderWithProviders, createFixtures } from '../testUtils';

function setup() {
  const { vendors, skus, layersBySku } = createFixtures();
  renderWithProviders(
    React.createElement(Receiving as any, {
      vendors,
      skus,
      layersBySku,
      movements: [],
    })
  );
}

describe('Receiving submit (success)', () => {
  it('submits and shows success toast, closes modal', async () => {
    setup();

    fireEvent.change(screen.getByLabelText(/vendor/i), { target: { value: 'Acme Supplies' } });
    fireEvent.change(screen.getByLabelText(/^SKU/i), { target: { value: 'SKU-RAW-1' } });
    fireEvent.change(screen.getByLabelText(/^Quantity/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Unit cost/i), { target: { value: '2.50' } });

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    const dialog = screen.getByRole('dialog', { name: /confirm receiving/i });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /confirm & submit/i }));

    await screen.findByText(/successfully approved/i);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /confirm receiving/i })).toBeNull();
    });
  });
});
