import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe, Logger } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import * as dotenv from "dotenv";
import { json, urlencoded } from "express";

dotenv.config();

async function bootstrap() {
	const logger = new Logger("Bootstrap");

	const app = await NestFactory.create(AppModule, {
		cors: {
			origin:
				process.env.CORS_ORIGINS?.split(",").map((origin) => origin.trim()) ||
				"http://localhost:3000",
			credentials: true,
			methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
			allowedHeaders: ["Content-Type", "Authorization"],
		},
	});

	// Increase body size limit for large PDFs (50MB)
	app.use(json({ limit: "50mb" }));
	app.use(urlencoded({ extended: true, limit: "50mb" }));

	app.useGlobalPipes(new ValidationPipe());

	// Swagger configuration
	const config = new DocumentBuilder()
		.setTitle("Policy Code Extractor API")
		.setDescription("API for extracting ICD-10 codes from CMS policy documents")
		.setVersion("1.0")
		.addTag("policies", "Policy document management")
		.addTag("codes", "ICD-10 code operations")
		.build();

	const document = SwaggerModule.createDocument(app, config);
	SwaggerModule.setup("api/docs", app, document);

	const port = process.env.PORT || 3001;
	const server = await app.listen(port);

	// Increase server timeout for large PDF processing
	server.timeout = 300000; // 5 minutes
	server.keepAliveTimeout = 305000;

	logger.log(`Policy Code Extractor Backend running on: http://localhost:${port}`);
	logger.log(`Swagger docs available at: http://localhost:${port}/api/docs`);
	logger.log(`Environment: ${process.env.NODE_ENV || "development"}`);
}
bootstrap();
