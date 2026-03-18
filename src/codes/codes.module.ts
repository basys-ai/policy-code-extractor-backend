import { Module } from "@nestjs/common";
import { CodesController } from "./codes.controller";
import { CodesService } from "./codes.service";
import { ExtractorService } from "./extractor.service";
import { ExecutorModule } from "../executor/executor.module";

@Module({
	imports: [ExecutorModule],
	controllers: [CodesController],
	providers: [CodesService, ExtractorService],
	exports: [CodesService, ExtractorService],
})
export class CodesModule {}
