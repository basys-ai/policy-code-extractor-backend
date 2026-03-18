import { Module, forwardRef } from "@nestjs/common";
import { PoliciesController } from "./policies.controller";
import { PoliciesService } from "./policies.service";
import { ExportService } from "./export.service";
import { CodesModule } from "../codes/codes.module";
import { InfrastructureModule } from "../infrastructure/infrastructure.module";

@Module({
	imports: [forwardRef(() => CodesModule), InfrastructureModule],
	controllers: [PoliciesController],
	providers: [PoliciesService, ExportService],
	exports: [PoliciesService],
})
export class PoliciesModule {}
