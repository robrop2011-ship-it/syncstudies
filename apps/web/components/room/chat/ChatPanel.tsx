'use client';

/**
 * Chat, assembled (PLAN.md §3.5, §6.5, §14 Phase 5).
 *
 * This component owns the four things that are not rendering:
 *
 * 1. **Optimistic send.** The message appears the instant it is typed, with a
 *    `clientMsgId` that survives a reconnect. The server's copy replaces it by
 *    that id, and a retry re-uses the same id — which is what makes the retry
 *    idempotent all the way down to the unique index on `messages`.
 * 2. **Failure that keeps the text.** A refused or timed-out send stays in the
 *    list as a failed row with Retry and Discard. Losing what somebody typed
 *    because a socket blinked is the worst outcome available here.
 * 3. **History.** One page at a time, cursor-paginated, with the request
 *    de-duplicated: the scroll handler fires many times per gesture and must
 *    not turn one scroll into six fetches.
 * 4. **Deletes.** Own always, others' with `chat.delete.any`. The room hears
 *    about it over the socket, including this client — there is no local
 *    shortcut, so what the author sees is what everyone sees.
 */
import { useCallback, useRef, useState } from 'react';
import { clientId, type MessageView } from '@syncstudy/shared';
import { toast } from 'sonner';
import { ChatComposer } from '@/components/room/chat/ChatComposer';
import { ChatList } from '@/components/room/chat/ChatList';
import { ReportDialog } from '@/components/room/chat/ReportDialog';
import { ackWithTimeout, NO_SOCKET } from '@/components/room/socket-ack';
import { api, messageOf } from '@/lib/api';
import type { MessagePageResponse } from '@/app/api/rooms/[room]/messages/route';
import { useSocket } from '@/lib/socket/provider';
import {
  useChatHistory,
  useConnection,
  useMessages,
  useMyPermissions,
  useParticipants,
  useRoomMeta,
  useRoomStoreApi,
  type ChatMessage,
} from '@/lib/stores/room-store';
import { useSyncController, usePlayheadRef } from '@/lib/sync/useSyncController';
import { MessageSquare } from 'lucide-react';

export function ChatPanel({ youId }: { youId: string }) {
  const socket = useSocket();
  const room = useRoomMeta();
  const me = useMyPermissions();
  const messages = useMessages();
  const history = useChatHistory();
  const connection = useConnection();
  const controller = useSyncController();
  const playheadRef = usePlayheadRef();

  const participants = useParticipants();
  // The store HANDLE, not a selection of it: these are writes, and subscribing
  // to the whole store here would re-render the panel on every presence patch.
  const storeApi = useRoomStoreApi();
  const [reporting, setReporting] = useState<ChatMessage | null>(null);
  /** Guards against the scroll handler firing a second fetch mid-flight. */
  const loadingRef = useRef(false);

  const connected = connection.status === 'connected';
  const canSend = me?.canSendChat ?? false;
  const you = participants.find((participant) => participant.id === youId);

  const send = useCallback(
    async (body: string, existingClientId?: string) => {
      const clientMsgId = existingClientId ?? clientId();
      const optimistic: ChatMessage = {
        // Never confusable with a server id: uuids are hex, and this is not.
        // The row is replaced by `clientMsgId` the moment the broadcast lands.
        id: `local:${clientMsgId}`,
        roomId: room?.id ?? '',
        author: {
          id: youId,
          handle: you?.handle ?? '',
          displayName: you?.displayName ?? 'You',
          avatarUrl: you?.avatarUrl ?? null,
        },
        clientMsgId,
        body,
        kind: 'user',
        replyToId: null,
        videoTs: null,
        createdAt: Date.now(),
        deletedAt: null,
        delivery: 'sending',
      };
      storeApi.getState().addOptimisticMessage(optimistic);

      if (socket === null) {
        storeApi.getState().markMessageFailed(clientMsgId);
        return;
      }

      const ack = await ackWithTimeout<MessageView>((done) =>
        socket.emit('chat:send', { clientMsgId, body }, done),
      );

      if (ack.ok) {
        // The broadcast normally lands first and has already replaced the
        // optimistic row. Folding the ack in as well costs one no-op merge and
        // covers the case where it did not — an `io.to()` fan-out that lost a
        // frame must not leave the author's own message stuck on "sending".
        if (ack.data !== undefined) storeApi.getState().receiveMessages([ack.data]);
        return;
      }

      storeApi.getState().markMessageFailed(clientMsgId);
      // Rate limits and slow mode are expected refusals with useful text; a
      // toast is the right weight for them, because the row itself only says
      // "not sent".
      toast.error(ack.message);
    },
    [room?.id, socket, storeApi, you, youId],
  );

  const loadOlder = useCallback(() => {
    if (loadingRef.current || !history.hasMore || history.cursor === null) return;
    if (room === null) return;

    loadingRef.current = true;
    storeApi.getState().setHistoryLoading(true);
    const cursor = history.cursor;

    void api
      .get<MessagePageResponse>(
        `/api/rooms/${encodeURIComponent(room.id)}/messages?before=${encodeURIComponent(cursor)}`,
      )
      .then((page) => {
        storeApi.getState().prependHistory(page.messages, page.hasMore);
      })
      .catch((error: unknown) => {
        storeApi.getState().setHistoryError(messageOf(error));
      })
      .finally(() => {
        loadingRef.current = false;
      });
  }, [history.cursor, history.hasMore, room, storeApi]);

  const remove = useCallback(
    (messageId: string) => {
      if (socket === null) {
        toast.error(NO_SOCKET.message);
        return;
      }
      void ackWithTimeout((done) => socket.emit('chat:delete', { messageId }, done)).then((ack) => {
        // No local tombstone on success: the server broadcasts `chat:deleted` to
        // the whole room and this client is in it. One source, one moment.
        if (!ack.ok) toast.error(ack.message);
      });
    },
    [socket],
  );

  const seek = useCallback(
    (seconds: number) => {
      void controller?.seek(seconds);
    },
    [controller],
  );

  const retry = useCallback(
    (message: ChatMessage) => {
      if (message.clientMsgId === null) return;
      void send(message.body, message.clientMsgId);
    },
    [send],
  );

  const discard = useCallback(
    (message: ChatMessage) => {
      if (message.clientMsgId === null) return;
      storeApi.getState().removeMessage(message.clientMsgId);
    },
    [storeApi],
  );

  const disabledReason = ((): string | null => {
    if (!connected) return 'Reconnecting — messages will send once you are back.';
    if (me === null) return null;
    if (!canSend) return 'The host has locked chat for this room.';
    return null;
  })();

  if (messages.length === 0 && !history.loading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EmptyChat canSend={canSend} />
        <ChatComposer
          disabled={!connected || !canSend}
          disabledReason={disabledReason}
          playheadSec={controller === null ? null : () => playheadRef.current}
          onSend={(body) => void send(body)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatList
        messages={messages}
        history={history}
        youId={youId}
        canDeleteAny={me?.canDeleteAnyMessage ?? false}
        onSeek={controller === null || !(me?.canControlVideo ?? false) ? null : seek}
        onLoadOlder={loadOlder}
        onDelete={remove}
        onReport={setReporting}
        onRetry={retry}
        onDiscard={discard}
      />

      <ChatComposer
        disabled={!connected || !canSend}
        disabledReason={disabledReason}
        playheadSec={controller === null ? null : () => playheadRef.current}
        onSend={(body) => void send(body)}
      />

      <ReportDialog
        message={reporting}
        roomId={room?.id ?? null}
        onClose={() => setReporting(null)}
        onDone={(note) => toast.success(note)}
      />
    </div>
  );
}

/**
 * The empty state names the two things chat can do that are not obvious:
 * timestamps seek the room, and history survives a reload.
 */
function EmptyChat({ canSend }: { canSend: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-strong text-tertiary">
        <MessageSquare size={16} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-13 font-medium text-primary">No messages yet</p>
        <p className="text-13 text-secondary">
          {canSend
            ? 'Type a timestamp like @41:12 and anyone can click it to take the room there.'
            : 'The host has locked chat for this room.'}
        </p>
      </div>
    </div>
  );
}
