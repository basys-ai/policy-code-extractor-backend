import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { SqsService } from "./sqs.service";
import { S3Service } from "./s3.service";

@Module({
	imports: [ConfigModule],
	providers: [SqsService, S3Service],
	exports: [SqsService, S3Service],
})
export class InfrastructureModule {}
