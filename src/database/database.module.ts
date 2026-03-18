import { Module, Global } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";

const DATABASE_POOL = "DATABASE_POOL";

const databasePoolFactory = {
	provide: DATABASE_POOL,
	inject: [ConfigService],
	useFactory: (configService: ConfigService) => {
		// Support DATABASE_URL or individual variables
		const databaseUrl = configService.get<string>("DATABASE_URL");

		if (databaseUrl) {
			return new Pool({
				connectionString: databaseUrl,
				max: 20,
				idleTimeoutMillis: 30000,
				connectionTimeoutMillis: 2000,
			});
		}

		return new Pool({
			host: configService.get<string>("DB_HOST", "localhost"),
			port: configService.get<number>("DB_PORT", 5432),
			database: configService.get<string>("DB_NAME", "policy_extractor"),
			user: configService.get<string>("DB_USER", "postgres"),
			password: configService.get<string>("DB_PASSWORD", ""),
			max: 20,
			idleTimeoutMillis: 30000,
			connectionTimeoutMillis: 2000,
		});
	},
};

@Global()
@Module({
	providers: [databasePoolFactory],
	exports: [DATABASE_POOL],
})
export class DatabaseModule {}
