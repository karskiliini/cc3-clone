import { describe, expect, it } from 'vitest';
import { elevationLabel } from '@/ui/elevationReadout';

describe('elevation readout', () => {
  it('shows ground height, and what stands on it or is dug into it', () => {
    expect(elevationLabel(12.44, 0)).toBe('12.4 m');
    expect(elevationLabel(12.44, 0.1)).toBe('12.4 m');
    expect(elevationLabel(3, 6)).toBe('3.0 m +6.0');
    expect(elevationLabel(3, -1.2)).toBe('3.0 m -1.2');
  });
});
