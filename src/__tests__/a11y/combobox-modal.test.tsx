import React from 'react';
import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import Receiving from '@/features/inventory/pages/Receiving';
import { renderWithProviders, createFixtures } from '../testUtils';

function setupReceiving(extra?: Partial<React.ComponentProps<typeof Receiving>>) {
  const { vendors, skus, layersBySku } = createFixtures();
  renderWithProviders(
    <Receiving
      vendors={vendors}
      skus={skus as any}
      layersBySku={layersBySku as any}
      {...extra}
    />
  );
}

describe('a11y: VendorAutocomplete combobox and confirmation modal', () => {
  it('renders combobox with ARIA roles and supports keyboard nav open', () => {
    setupReceiving();

    const input = screen.getByRole('combobox', { name: /vendor/i });
    expect(input).toBeInTheDocument();

    // Type to trigger suggestions (≥3 chars)
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'acm' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();

    // There should be at least one option
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
  });

  it('opens confirmation modal with role="dialog" and aria-modal', () => {
    setupReceiving();

    // Fill minimal valid form
    fireEvent.change(screen.getByLabelText(/vendor/i), { target: { value: 'Acme Supplies' } });
    fireEvent.change(screen.getByLabelText(/^SKU/i), { target: { value: 'SKU-RAW-1' } });
    fireEvent.change(screen.getByLabelText(/^Quantity/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Unit cost/i), { target: { value: '2.50' } });

    // Approve -> opens modal
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    const dialog = screen.getByRole('dialog', { name: /confirm receiving/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Close via cancel
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog', { name: /confirm receiving/i })).toBeNull();
  });
});
