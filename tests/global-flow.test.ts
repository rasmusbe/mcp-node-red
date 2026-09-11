import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowsConflictError, type NodeRedClient } from '../src/client.js';
import type { NodeRedItem } from '../src/schemas.js';
import { modifyFlows } from '../src/tools/global-flow.js';

describe('modifyFlows', () => {
  let mockClient: NodeRedClient;

  const append = (item: NodeRedItem) => (flows: NodeRedItem[]) => [...flows, item];
  const newNode: NodeRedItem = { id: 'cfg1', type: 'mqtt-broker' };

  beforeEach(() => {
    mockClient = {
      getFlows: vi.fn(),
      setFlows: vi.fn(),
    } as unknown as NodeRedClient;
  });

  it('should write the mutated list under the rev it was read at', async () => {
    vi.mocked(mockClient.getFlows).mockResolvedValue({
      rev: 'rev1',
      flows: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }],
    });
    vi.mocked(mockClient.setFlows).mockResolvedValue({ rev: 'rev2' });

    const result = await modifyFlows(mockClient, append(newNode));

    expect(result).toEqual({ rev: 'rev2' });
    expect(mockClient.setFlows).toHaveBeenCalledWith(
      [{ id: 'tab1', type: 'tab', label: 'Flow 1' }, newNode],
      'rev1'
    );
  });

  it('should re-read and re-apply once after a conflict', async () => {
    vi.mocked(mockClient.getFlows)
      .mockResolvedValueOnce({ rev: 'rev1', flows: [] })
      .mockResolvedValueOnce({
        rev: 'rev2',
        flows: [{ id: 'tab1', type: 'tab', label: 'Added by the editor' }],
      });
    vi.mocked(mockClient.setFlows)
      .mockRejectedValueOnce(new FlowsConflictError('version mismatch'))
      .mockResolvedValueOnce({ rev: 'rev3' });

    const result = await modifyFlows(mockClient, append(newNode));

    expect(result).toEqual({ rev: 'rev3' });
    expect(mockClient.getFlows).toHaveBeenCalledTimes(2);
    // The retry writes what the second read returned, not the list the first attempt built.
    expect(mockClient.setFlows).toHaveBeenNthCalledWith(
      2,
      [{ id: 'tab1', type: 'tab', label: 'Added by the editor' }, newNode],
      'rev2'
    );
  });

  it('should report a second conflict instead of overwriting', async () => {
    vi.mocked(mockClient.getFlows).mockResolvedValue({ rev: 'rev1', flows: [] });
    vi.mocked(mockClient.setFlows).mockRejectedValue(new FlowsConflictError('version mismatch'));

    await expect(modifyFlows(mockClient, append(newNode))).rejects.toThrow(
      'deployed from elsewhere twice'
    );
    expect(mockClient.setFlows).toHaveBeenCalledTimes(2);
  });

  it('should not retry an error from mutate', async () => {
    vi.mocked(mockClient.getFlows).mockResolvedValue({ rev: 'rev1', flows: [] });

    await expect(
      modifyFlows(mockClient, () => {
        throw new Error('Node with id "cfg1" not found');
      })
    ).rejects.toThrow('Node with id "cfg1" not found');

    expect(mockClient.getFlows).toHaveBeenCalledTimes(1);
    expect(mockClient.setFlows).not.toHaveBeenCalled();
  });

  it('should not retry a write that failed for another reason', async () => {
    vi.mocked(mockClient.getFlows).mockResolvedValue({ rev: 'rev1', flows: [] });
    vi.mocked(mockClient.setFlows).mockRejectedValue(new Error('Failed to set flows: 500'));

    await expect(modifyFlows(mockClient, append(newNode))).rejects.toThrow(
      'Failed to set flows: 500'
    );
    expect(mockClient.setFlows).toHaveBeenCalledTimes(1);
  });
});
