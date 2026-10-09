import { describe, expect, it, vi } from 'vitest';
import { sendFileEditorEvent } from '../lib/fileEditorSend.js';
import type { PatchWs } from '../api/ws.js';

// Todoist: "question answers for chats on the Mac go to Hetzner and are lost" —
// the server routes a permission answer by its chatId, so a file tab's
// Approve/Deny must name the tab's chat.
describe('sendFileEditorEvent', () => {
  it("stamps the tab's chatId on a permission response", () => {
    const send = vi.fn();
    sendFileEditorEvent({ send } as unknown as PatchWs, 'c-mac', {
      type: 'chat.permission_response',
      requestId: 'req-fe-1',
      approve: true,
      decision: 'approve',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        chatId: 'c-mac',
        requestId: 'req-fe-1',
      }),
    );
  });
});
