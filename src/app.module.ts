import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { DatabaseModule } from "./database/database.module";
import { InfrastructureModule } from "./infrastructure/infrastructure.module";
import { ExecutorModule } from "./executor/executor.module";
import { CodesModule } from "./codes/codes.module";
import { PoliciesModule } from "./policies/policies.module";
import { WorkerModule } from "./worker/worker.module";

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			envFilePath: [".env"],
		}),
		DatabaseModule,
		InfrastructureModule,
		ExecutorModule,
		CodesModule,
		PoliciesModule,
		WorkerModule,
	],
	controllers: [AppController],
	providers: [AppService],
})
export class AppModule {}
