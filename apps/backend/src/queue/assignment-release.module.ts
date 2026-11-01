import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { QueueAssignmentReleaseService } from './queue-assignment-release.service';
import { QueueAutoAssignTrigger } from './queue-auto-assign.trigger';
import { ServiceCompletedHook } from './service-completed.hook';

/**
 * The dependency-light seam for "a barber or chair stopped being available": the allocator trigger
 * and the assignment-release service, with no import of the queue engine. QueueModule, the staff
 * and the salon-setup modules all import this one module, so the trigger stays a single shared
 * instance and none of them needs a circular dependency on QueueModule. ServiceCompletedHook is the
 * same kind of seam for inventory's service-usage deduction.
 */
@Module({
  imports: [RealtimeModule],
  providers: [
    QueueAutoAssignTrigger,
    QueueAssignmentReleaseService,
    ServiceCompletedHook,
  ],
  exports: [
    QueueAutoAssignTrigger,
    QueueAssignmentReleaseService,
    ServiceCompletedHook,
  ],
})
export class AssignmentReleaseModule {}
