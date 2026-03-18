import { Injectable, Inject, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

export interface ICD10Code {
	id: string;
	code: string;
	description: string;
	category: string;
	policyId: string;
	createdAt: Date;
}

export interface CreateCodeDto {
	code: string;
	description: string;
	category: string;
	policyId: string;
}

@Injectable()
export class CodesService {
	private readonly logger = new Logger(CodesService.name);

	constructor(@Inject("DATABASE_POOL") private readonly pool: Pool) {}

	async createMany(codes: CreateCodeDto[]): Promise<ICD10Code[]> {
		if (codes.length === 0) return [];

		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");

			const createdCodes: ICD10Code[] = [];

			for (const code of codes) {
				const id = uuidv4();
				const result = await client.query(
					`INSERT INTO icd10_codes (id, code, description, category, policy_id, created_at)
					 VALUES ($1, $2, $3, $4, $5, NOW())
					 RETURNING *`,
					[id, code.code, code.description, code.category, code.policyId]
				);

				createdCodes.push(this.mapRow(result.rows[0]));
			}

			await client.query("COMMIT");
			this.logger.log(`Created ${createdCodes.length} codes`);
			return createdCodes;
		} catch (error: any) {
			await client.query("ROLLBACK");
			this.logger.error(`Failed to create codes: ${error.message}`);
			throw error;
		} finally {
			client.release();
		}
	}

	async findByPolicyId(policyId: string): Promise<ICD10Code[]> {
		const result = await this.pool.query(
			`SELECT * FROM icd10_codes WHERE policy_id = $1 ORDER BY code`,
			[policyId]
		);
		return result.rows.map(this.mapRow);
	}

	async search(
		query?: string,
		policyId?: string,
		category?: string
	): Promise<ICD10Code[]> {
		let sql = "SELECT * FROM icd10_codes WHERE 1=1";
		const params: any[] = [];
		let paramIndex = 1;

		if (query) {
			sql += ` AND (code ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
			params.push(`%${query}%`);
			paramIndex++;
		}

		if (policyId) {
			sql += ` AND policy_id = $${paramIndex}`;
			params.push(policyId);
			paramIndex++;
		}

		if (category) {
			sql += ` AND code LIKE $${paramIndex}`;
			params.push(`${category}%`);
			paramIndex++;
		}

		sql += " ORDER BY code LIMIT 500";

		const result = await this.pool.query(sql, params);
		return result.rows.map(this.mapRow);
	}

	async deleteByPolicyId(policyId: string): Promise<void> {
		await this.pool.query("DELETE FROM icd10_codes WHERE policy_id = $1", [
			policyId,
		]);
	}

	private mapRow(row: any): ICD10Code {
		return {
			id: row.id,
			code: row.code,
			description: row.description,
			category: row.category,
			policyId: row.policy_id,
			createdAt: row.created_at,
		};
	}
}
