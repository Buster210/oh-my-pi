/**
 * Transport-agnostic collab socket interface.
 *
 * Both the WebSocket relay path and the local UDS daemon path implement this
 * interface so host.ts and guest.ts stay transport-unaware.
 */
import type { CollabFrame, RelayControlMessage } from "./protocol";

export interface ICollabSocket {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	/** Fires for each received frame. fromPeer=0 for UDS (single guest). */
	onFrame?: (frame: CollabFrame, fromPeer: number) => void;
	/** Fires for relay control messages (peer-left). UDS path never fires this. */
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires once per terminal close. willReconnect=true for transient drops. */
	onClose?: (reason: string, willReconnect: boolean) => void;

	/** True when the socket is connected and ready to send. */
	readonly isOpen: boolean;

	/** Initiate connection. */
	connect(): void;
	/** Send a frame. For UDS host, targetPeer is ignored (single guest). */
	send(frame: CollabFrame, targetPeer?: number): void;
	/** Intentional close: suppresses reconnect. */
	close(): void;
}
