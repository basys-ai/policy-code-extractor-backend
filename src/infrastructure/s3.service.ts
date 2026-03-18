import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

@Injectable()
export class S3Service implements OnModuleInit {
	private readonly logger = new Logger(S3Service.name);
	private client: S3Client | null = null;
	private bucketName: string | null = null;
	private enabled = false;

	constructor(private readonly configService: ConfigService) {}

	async onModuleInit() {
		const region = this.configService.get<string>("AWS_REGION");
		const bucket = this.configService.get<string>("S3_BUCKET_NAME");

		this.enabled = Boolean(region && bucket);

		if (!this.enabled) {
			this.logger.warn(
				"S3Service disabled: S3_BUCKET_NAME or AWS_REGION not set; PDFs will be stored locally"
			);
			return;
		}

		this.client = new S3Client({
			region,
			...(this.configService.get("AWS_ACCESS_KEY") && {
				credentials: {
					accessKeyId: this.configService.get<string>("AWS_ACCESS_KEY")!,
					secretAccessKey: this.configService.get<string>("AWS_SECRET_ACCESS_KEY")!,
				},
			}),
		});

		this.bucketName = bucket!;
		this.logger.log(`S3Service initialized: bucket=${bucket} region=${region}`);
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Upload a PDF to S3
	 * @param key - S3 object key (e.g., "policies/uuid.pdf")
	 * @param buffer - PDF file buffer
	 * @param metadata - Optional metadata
	 */
	async uploadPdf(
		key: string,
		buffer: Buffer,
		metadata?: Record<string, string>
	): Promise<string> {
		if (!this.enabled || !this.client || !this.bucketName) {
			this.logger.warn("S3 not enabled, skipping upload");
			return `local://${key}`;
		}

		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucketName,
				Key: key,
				Body: buffer,
				ContentType: "application/pdf",
				Metadata: metadata,
			})
		);

		const s3Url = `s3://${this.bucketName}/${key}`;
		this.logger.log(`Uploaded PDF to S3: ${s3Url}`);
		return s3Url;
	}

	/**
	 * Download a PDF from S3
	 * @param key - S3 object key
	 */
	async downloadPdf(key: string): Promise<Buffer> {
		if (!this.enabled || !this.client || !this.bucketName) {
			throw new Error("S3 not enabled");
		}

		const response = await this.client.send(
			new GetObjectCommand({
				Bucket: this.bucketName,
				Key: key,
			})
		);

		if (!response.Body) {
			throw new Error(`No body in S3 response for key: ${key}`);
		}

		// Convert stream to buffer
		const stream = response.Body as Readable;
		const chunks: Buffer[] = [];
		for await (const chunk of stream) {
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}

	/**
	 * Delete a PDF from S3
	 * @param key - S3 object key
	 */
	async deletePdf(key: string): Promise<void> {
		if (!this.enabled || !this.client || !this.bucketName) {
			return;
		}

		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucketName,
				Key: key,
			})
		);

		this.logger.log(`Deleted PDF from S3: ${key}`);
	}

	/**
	 * Check if a PDF exists in S3
	 * @param key - S3 object key
	 */
	async exists(key: string): Promise<boolean> {
		if (!this.enabled || !this.client || !this.bucketName) {
			return false;
		}

		try {
			await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucketName,
					Key: key,
				})
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Generate S3 key for a policy PDF
	 */
	generatePdfKey(policyId: string, originalFilename: string): string {
		const sanitizedFilename = originalFilename.replace(/[^a-zA-Z0-9.-]/g, "_");
		return `policies/${policyId}/${sanitizedFilename}`;
	}
}
