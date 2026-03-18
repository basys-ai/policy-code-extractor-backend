import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SqsService, ExtractionJobPayload } from "../infrastructure/sqs.service";
import { S3Service } from "../infrastructure/s3.service";
import { ExtractorService } from "../codes/extractor.service";
import { CodesService } from "../codes/codes.service";
import { PoliciesService } from "../policies/policies.service";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_VISIBILITY_TIMEOUT_SEC = 300;

@Injectable()
export class ExtractionWorker implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(ExtractionWorker.name);
	private enabled = false;
	private running = false;
	private readonly maxConcurrency: number;
	private readonly pollIntervalMs: number;
	private readonly visibilityTimeoutSec: number;
	private inFlight = 0;

	constructor(
		private readonly configService: ConfigService,
		private readonly sqsService: SqsService,
		private readonly s3Service: S3Service,
		private readonly extractorService: ExtractorService,
		private readonly codesService: CodesService,
		private readonly policiesService: PoliciesService
	) {
		this.maxConcurrency = parseInt(
			this.configService.get<string>("EXTRACTION_WORKER_CONCURRENCY") || String(DEFAULT_MAX_CONCURRENCY),
			10
		);
		this.pollIntervalMs = parseInt(
			this.configService.get<string>("EXTRACTION_WORKER_POLL_INTERVAL_MS") || String(DEFAULT_POLL_INTERVAL_MS),
			10
		);
		this.visibilityTimeoutSec = parseInt(
			this.configService.get<string>("EXTRACTION_VISIBILITY_TIMEOUT_SEC") || String(DEFAULT_VISIBILITY_TIMEOUT_SEC),
			10
		);
	}

	async onModuleInit() {
		const sqsEnabled = this.sqsService.isEnabled();
		const localMode = this.sqsService.isLocalMode();
		const extractionLocal = this.sqsService.isExtractionLocal();

		this.enabled = sqsEnabled || localMode || extractionLocal;

		if (!this.enabled) {
			this.logger.warn("ExtractionWorker disabled: SQS not configured");
			return;
		}

		this.logger.log(
			`ExtractionWorker started: concurrency=${this.maxConcurrency} poll=${this.pollIntervalMs}ms mode=${extractionLocal || localMode ? "in-memory" : "sqs"}`
		);

		this.running = true;
		this.pollLoop();
	}

	async onModuleDestroy() {
		this.running = false;
	}

	/**
	 * Direct execution - bypass SQS for immediate processing
	 */
	async executeDirect(payload: ExtractionJobPayload): Promise<void> {
		if (!this.enabled) return;
		await this.processJob(payload, "direct");
	}

	/**
	 * Main poll loop
	 */
	private async pollLoop(): Promise<void> {
		while (this.running) {
			try {
				// Wait if at capacity
				if (this.inFlight >= this.maxConcurrency) {
					await this.sleep(this.pollIntervalMs);
					continue;
				}

				let messages: Array<{
					body: string;
					receiptHandle: string;
					approximateReceiveCount: number;
				}>;

				// Get messages from queue
				if (this.sqsService.isLocalMode() || this.sqsService.isExtractionLocal()) {
					messages = this.sqsService.receiveMessagesFromLocal(
						this.maxConcurrency - this.inFlight
					);
					if (messages.length === 0) {
						await this.sleep(this.pollIntervalMs);
						continue;
					}
				} else {
					const maxToReceive = Math.min(10, this.maxConcurrency - this.inFlight);
					messages = await this.sqsService.receiveMessages(
						maxToReceive,
						20,
						this.visibilityTimeoutSec
					);

					if (messages.length === 0) {
						await this.sleep(this.pollIntervalMs);
						continue;
					}
				}

				// Process messages concurrently
				for (const msg of messages) {
					if (this.inFlight >= this.maxConcurrency) break;

					this.inFlight++;
					this.processMessage(msg.body, msg.receiptHandle)
						.catch((err) =>
							this.logger.error(`ExtractionWorker processMessage error: ${err?.message}`)
						)
						.finally(() => {
							this.inFlight--;
						});
				}
			} catch (err: any) {
				this.logger.error(`ExtractionWorker poll error: ${err?.message}`);
				await this.sleep(this.pollIntervalMs);
			}
		}
	}

	/**
	 * Process a single message from the queue
	 */
	private async processMessage(body: string, receiptHandle: string): Promise<void> {
		let parsed: { type?: string };
		try {
			parsed = JSON.parse(body);
		} catch (e) {
			this.logger.error(`Invalid job JSON: ${(e as Error).message}`);
			await this.sqsService.deleteMessage(receiptHandle);
			return;
		}

		if (parsed.type !== "extraction_job") {
			return;
		}

		const payload = parsed as ExtractionJobPayload;
		await this.processJob(payload, receiptHandle);
	}

	/**
	 * Process extraction job
	 */
	private async processJob(
		payload: ExtractionJobPayload,
		receiptHandle: string
	): Promise<void> {
		const { policy_id, s3_key, original_filename } = payload;
		this.logger.log(`[ExtractionStart] policy_id=${policy_id} filename=${original_filename}`);

		const startTime = Date.now();

		try {
			// Download PDF from S3 (or use local buffer for direct execution)
			let pdfBuffer: Buffer;

			if (this.s3Service.isEnabled() && s3_key) {
				pdfBuffer = await this.s3Service.downloadPdf(s3_key);
			} else {
				// For local mode, the buffer should be passed differently
				// This is a fallback - in practice, direct execution handles this
				throw new Error("S3 not configured and no local buffer available");
			}

			// Extract codes from PDF (pass provider/temperature from job if present)
			const extractionResult = await this.extractorService.extractFromPDF(pdfBuffer, {
				provider: payload.provider,
				temperature: payload.temperature,
			});

			// Save codes to database
			const codes = await this.codesService.createMany(
				extractionResult.codes.map((code) => ({
					...code,
					policyId: policy_id,
				}))
			);

			// Update policy with extraction results
			await this.policiesService.updateExtractionComplete(policy_id, {
				codesCount: codes.length,
				extractionMethod: extractionResult.extractionMethod,
				confidence: extractionResult.confidence,
			});

			const duration = Date.now() - startTime;
			this.logger.log(
				`[ExtractionComplete] policy_id=${policy_id} codes=${codes.length} method=${extractionResult.extractionMethod} confidence=${extractionResult.confidence}% duration=${duration}ms`
			);

			// Delete message from queue
			if (receiptHandle !== "direct") {
				await this.sqsService.deleteMessage(receiptHandle);
			}
		} catch (error: any) {
			const duration = Date.now() - startTime;
			this.logger.error(
				`[ExtractionFailed] policy_id=${policy_id} error="${error.message}" duration=${duration}ms`
			);

			// Update policy with error
			await this.policiesService.updateExtractionFailed(policy_id, error.message);

			// Delete message (don't retry for now - could add DLQ logic)
			if (receiptHandle !== "direct") {
				await this.sqsService.deleteMessage(receiptHandle);
			}
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
