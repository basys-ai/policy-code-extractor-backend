import { Injectable, Inject, Logger, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { CodesService, ICD10Code } from "../codes/codes.service";
import { ExtractorService } from "../codes/extractor.service";
import { S3Service } from "../infrastructure/s3.service";
import { SqsService } from "../infrastructure/sqs.service";

export interface Policy {
	id: string;
	articleId: string;
	title: string;
	effectiveDate: string;
	codesCount: number;
	status: "pending" | "processing" | "completed" | "failed";
	extractionMethod?: string;
	confidence?: number;
	errorMessage?: string;
	s3Key?: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface PolicyWithCodes extends Policy {
	codes: ICD10Code[];
}

@Injectable()
export class PoliciesService {
	private readonly logger = new Logger(PoliciesService.name);

	constructor(
		@Inject("DATABASE_POOL") private readonly pool: Pool,
		private readonly codesService: CodesService,
		private readonly extractorService: ExtractorService,
		private readonly s3Service: S3Service,
		private readonly sqsService: SqsService
	) {}

	/**
	 * Process uploaded PDF - either sync or async based on configuration
	 */
	async processUpload(
		fileBuffer: Buffer,
		originalFilename: string,
		asyncMode = false,
		options?: { provider?: string; temperature?: number }
	): Promise<{ policy: Policy; codes?: ICD10Code[] }> {
		this.logger.log(`Processing uploaded PDF: ${originalFilename} (async=${asyncMode})`);

		// Create policy record
		const policyId = uuidv4();

		// Upload to S3 if enabled
		let s3Key: string | undefined;
		if (this.s3Service.isEnabled()) {
			s3Key = this.s3Service.generatePdfKey(policyId, originalFilename);
			await this.s3Service.uploadPdf(s3Key, fileBuffer, {
				originalFilename,
				policyId,
			});
		}

		// Extract basic metadata synchronously
		const metadata = await this.extractMetadata(fileBuffer);

		// Create policy in pending/processing state
		const policy = await this.create({
			id: policyId,
			articleId: metadata.articleId,
			title: metadata.title,
			effectiveDate: metadata.effectiveDate,
			status: asyncMode ? "pending" : "processing",
			s3Key,
		});

		if (asyncMode && (this.sqsService.isEnabled() || this.sqsService.isExtractionLocal())) {
			// Queue job for async processing
			await this.sqsService.sendJob({
				policy_id: policyId,
				s3_key: s3Key || "",
				original_filename: originalFilename,
				article_id: metadata.articleId,
				enqueued_at: Date.now(),
				provider: options?.provider,
				temperature: options?.temperature,
			});

			return { policy };
		}

		// Synchronous extraction
		try {
			const extractionResult = await this.extractorService.extractFromPDF(
				fileBuffer,
				options
			);

			// Create code records
			const codes = await this.codesService.createMany(
				extractionResult.codes.map((code) => ({
					...code,
					policyId: policy.id,
				}))
			);

			// Update policy with results
			await this.updateExtractionComplete(policy.id, {
				codesCount: codes.length,
				extractionMethod: extractionResult.extractionMethod,
				confidence: extractionResult.confidence,
			});

			policy.codesCount = codes.length;
			policy.status = "completed";
			policy.extractionMethod = extractionResult.extractionMethod;
			policy.confidence = extractionResult.confidence;

			this.logger.log(
				`Created policy ${policy.articleId} with ${codes.length} codes (${extractionResult.extractionMethod})`
			);

			return { policy, codes };
		} catch (error: any) {
			await this.updateExtractionFailed(policy.id, error.message);
			throw error;
		}
	}

	/**
	 * Extract just metadata from PDF (fast operation for async mode)
	 */
	private async extractMetadata(buffer: Buffer): Promise<{
		articleId: string;
		title: string;
		effectiveDate: string;
	}> {
		const pdfParse = require("pdf-parse");
		const data = await pdfParse(buffer);
		const text = data.text;

		const articleIdMatch = text.match(/Article\s*(?:ID)?\s*[:\s]*([A-Z]\d{5})/i);
		const titleMatch = text.match(/Article\s*Title\s*[:\s]*(.+?)(?:\n|Article\s*Type)/i);
		const dateMatch = text.match(/Effective\s*Date\s*[:\s]*(\d{2}\/\d{2}\/\d{4})/i);

		let effectiveDate = new Date().toISOString().split("T")[0];
		if (dateMatch) {
			const [month, day, year] = dateMatch[1].split("/");
			effectiveDate = `${year}-${month}-${day}`;
		}

		return {
			articleId: articleIdMatch ? articleIdMatch[1] : "Unknown",
			title: titleMatch ? titleMatch[1].trim() : "Policy Document",
			effectiveDate,
		};
	}

	async create(data: {
		id?: string;
		articleId: string;
		title: string;
		effectiveDate: string;
		status?: string;
		s3Key?: string;
	}): Promise<Policy> {
		const id = data.id || uuidv4();
		const result = await this.pool.query(
			`INSERT INTO policies (id, article_id, title, effective_date, codes_count, status, s3_key, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 0, $5, $6, NOW(), NOW())
			 RETURNING *`,
			[id, data.articleId, data.title, data.effectiveDate, data.status || "pending", data.s3Key || null]
		);

		return this.mapRow(result.rows[0]);
	}

	async findAll(): Promise<Policy[]> {
		const result = await this.pool.query(
			"SELECT * FROM policies ORDER BY created_at DESC"
		);
		return result.rows.map(this.mapRow);
	}

	async findById(id: string): Promise<Policy | null> {
		const result = await this.pool.query("SELECT * FROM policies WHERE id = $1", [
			id,
		]);
		return result.rows[0] ? this.mapRow(result.rows[0]) : null;
	}

	async findByIdWithCodes(id: string): Promise<PolicyWithCodes> {
		const policy = await this.findById(id);
		if (!policy) {
			throw new NotFoundException(`Policy with ID ${id} not found`);
		}

		const codes = await this.codesService.findByPolicyId(id);

		return {
			...policy,
			codes,
		};
	}

	async updateExtractionComplete(
		id: string,
		data: {
			codesCount: number;
			extractionMethod: string;
			confidence: number;
		}
	): Promise<void> {
		await this.pool.query(
			`UPDATE policies 
			 SET codes_count = $1, status = 'completed', extraction_method = $2, confidence = $3, updated_at = NOW()
			 WHERE id = $4`,
			[data.codesCount, data.extractionMethod, data.confidence, id]
		);
	}

	async updateExtractionFailed(id: string, errorMessage: string): Promise<void> {
		await this.pool.query(
			`UPDATE policies 
			 SET status = 'failed', error_message = $1, updated_at = NOW()
			 WHERE id = $2`,
			[errorMessage, id]
		);
	}

	async delete(id: string): Promise<void> {
		const policy = await this.findById(id);
		if (!policy) {
			throw new NotFoundException(`Policy with ID ${id} not found`);
		}

		// Delete codes first
		await this.codesService.deleteByPolicyId(id);

		// Delete from S3 if exists
		if (policy.s3Key && this.s3Service.isEnabled()) {
			await this.s3Service.deletePdf(policy.s3Key);
		}

		// Delete policy
		await this.pool.query("DELETE FROM policies WHERE id = $1", [id]);

		this.logger.log(`Deleted policy ${id}`);
	}

	private mapRow(row: any): Policy {
		return {
			id: row.id,
			articleId: row.article_id,
			title: row.title,
			effectiveDate: row.effective_date,
			codesCount: row.codes_count,
			status: row.status,
			extractionMethod: row.extraction_method,
			confidence: row.confidence,
			errorMessage: row.error_message,
			s3Key: row.s3_key,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}
}
