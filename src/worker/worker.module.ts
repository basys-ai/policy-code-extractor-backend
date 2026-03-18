import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/infrastructure.module";
import { CodesModule } from "../codes/codes.module";
import { PoliciesModule } from "../policies/policies.module";
import { ExtractionWorker } from "./extraction.worker";

/**
 * Worker module: polls SQS for PDF extraction jobs, extracts codes, updates DB.
 * Supports both SQS and in-memory queue (local dev).
 */
@Module({
	imports: [InfrastructureModule, CodesModule, PoliciesModule],
	providers: [ExtractionWorker],
	exports: [ExtractionWorker],
})
export class WorkerModule {}
