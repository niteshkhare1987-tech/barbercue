import { Injectable, Logger } from '@nestjs/common';

export interface ServiceCompletedEvent {
  salonId: string;
  queueEntryId: string;
  sessionId: string;
  /** Who pressed "Complete service" (owner, barber or delegated admin). */
  actorUserId: string;
}
export type ServiceCompletedHandler = (
  event: ServiceCompletedEvent,
) => Promise<void>;

/**
 * Dependency-free seam (like QueueAutoAssignTrigger) for "a service was completed": inventory
 * registers its automatic, salon-approved product deduction here without the queue engine importing
 * inventory. Fire-and-forget — a handler error is logged and never fails the completion itself.
 */
@Injectable()
export class ServiceCompletedHook {
  private readonly logger = new Logger(ServiceCompletedHook.name);
  private readonly handlers: ServiceCompletedHandler[] = [];

  register(handler: ServiceCompletedHandler): void {
    this.handlers.push(handler);
  }

  notify(event: ServiceCompletedEvent): void {
    for (const handler of this.handlers) {
      void handler(event).catch((err: unknown) =>
        this.logger.warn(
          `Service-completed handler failed for queue entry ${event.queueEntryId}: ${err instanceof Error ? err.message : 'unknown error'}`,
        ),
      );
    }
  }
}
