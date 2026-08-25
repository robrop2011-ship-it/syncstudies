/**
 * The web tier's view of the transcript.
 *
 * The row → view mapping itself lives in `@syncstudy/db` so the realtime service
 * and this app cannot drift apart on what a deleted message looks like. All this
 * file adds is the half the two callers genuinely differ on: resolving
 * `avatar_key` against the asset domain, which only the web app is configured
 * with (§11.8).
 */
import { toMessageView as mapMessage, type MessageRow } from '@syncstudy/db';
import type { MessageView } from '@syncstudy/shared';
import { avatarUrlFor } from '@/lib/server/views';

export { MESSAGE_SELECT } from '@syncstudy/db';
export type { MessageRow };

export function toMessageView(row: MessageRow): MessageView {
  return mapMessage(row, avatarUrlFor);
}
