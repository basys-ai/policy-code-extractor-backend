import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ExecutorService } from "./executor.service";

@Module({
	imports: [ConfigModule],
	providers: [ExecutorService],
	exports: [ExecutorService],
})
export class ExecutorModule {}
