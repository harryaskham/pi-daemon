import { X } from "../icons";
import type { PendingSteeringMessage } from "../dashboard-live-session";

export interface SteeringQueueProps {
  messages: PendingSteeringMessage[];
  onCancel(queueId: string): void;
}

function steeringStateLabel(message: PendingSteeringMessage): string {
  if (message.state === "pending") {
    return message.errorCode === undefined
      ? "Waiting for the next steering point"
      : `Delivery rejected (${message.errorCode}) · waiting for the next steering point`;
  }
  if (message.state === "delivering") return "Delivering at the steering point";
  if (message.state === "delivered") return "Accepted by Pi · waiting to be consumed";
  return "Delivery outcome unknown · do not resend";
}

/**
 * Authenticated, browser-private view of the bounded FIFO steering queue.
 * Message content is never copied into logs, capabilities, or durable browser
 * storage; only this already-authorized session pane renders its bounded preview.
 */
export function SteeringQueue({ messages, onCancel }: SteeringQueueProps) {
  if (messages.length === 0) return null;
  return (
    <section className="steering-queue" aria-label="Pending steering messages">
      <header>
        <strong>Steering queue</strong>
        <span>{messages.length} pending · FIFO</span>
      </header>
      <ol>
        {messages.map((message, index) => (
          <li key={message.queueId} data-state={message.state}>
            <div>
              <p>{message.preview}{message.truncated ? "…" : ""}</p>
              <small>{steeringStateLabel(message)}</small>
            </div>
            {message.state === "pending" ? (
              <button
                type="button"
                aria-label={`Cancel queued steering message ${index + 1}`}
                onClick={() => onCancel(message.queueId)}
              >
                <X size={12} /> Cancel
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
