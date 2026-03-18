import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import {
	SQSClient,
	SendMessageCommand,
	ReceiveMessageCommand,
	DeleteMessageCommand,
	ChangeMessageVisibilityCommand,
	MessageSystemAttributeName,
} from "@aws-sdk/client-sqs";

/** Payload sent to extraction queue; worker uses this to extract codes from PDF */
export interface ExtractionJobPayload {
	policy_id: string;
	s3_key: string;
	original_filename: string;
	article_id?: string;
	/** Set by API when enqueueing; worker can use to measure queue delay */
	enqueued_at?: number;
	/** Extraction provider: regex, openai, or gemini */
	provider?: string;
	/** LLM temperature 0-1 */
	temperature?: number;
}

@Injectable()
export class SqsService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(SqsService.name);
	private client: SQSClient | null = null;
	private extractionQueueUrl: string | null = null;
	private extractionUseInMemory = false;
	private enabled = false;
	private awsRegion: string = "";

	/** When SQS is disabled, jobs are pushed here for local processing */
	private readonly localQueue: Array<{ body: string; receiptHandle: string }> = [];

	constructor(private readonly configService: ConfigService) {}

	async onModuleInit() {
		const region = this.configService.get<string>("AWS_REGION");
		const url = this.configService.get<string>("EXTRACTION_QUEUE_URL");

		this.enabled = Boolean(region && url);

		if (!this.enabled) {
			this.logger.warn(
				"SqsService disabled: EXTRACTION_QUEUE_URL or AWS_REGION not set; using local queue"
			);
		}

		if (this.enabled) {
			this.client = new SQSClient({
				region,
				...(this.configService.get("AWS_ACCESS_KEY") && {
					credentials: {
						accessKeyId: this.configService.get<string>("AWS_ACCESS_KEY")!,
						secretAccessKey: this.configService.get<string>("AWS_SECRET_ACCESS_KEY")!,
					},
				}),
			});

			this.awsRegion = region!;
			this.extractionQueueUrl = url!;
			this.logger.log(`SqsService initialized: queue=${url} region=${region}`);
		}

		// Check for in-memory mode
		const useInMemory = this.configService.get<string>("EXTRACTION_USE_IN_MEMORY_QUEUE");
		if (useInMemory === "true" || useInMemory === "1") {
			this.extractionUseInMemory = true;
			this.logger.log("EXTRACTION_USE_IN_MEMORY_QUEUE=true: using in-memory queue");
		}
	}

	async onModuleDestroy() {
		this.client = null;
		this.extractionQueueUrl = null;
	}

	/**
	 * Send extraction job to queue
	 */
	async sendJob(payload: ExtractionJobPayload): Promise<void> {
		const messageBody = JSON.stringify({ type: "extraction_job", ...payload });

		// In-memory mode
		if (this.extractionUseInMemory || !this.enabled) {
			this.localQueue.push({
				body: messageBody,
				receiptHandle: `local-${randomUUID()}`,
			});
			this.logger.log(
				`[QueueSend] policy_id=${payload.policy_id} queue=in-memory timestamp=${new Date().toISOString()}`
			);
			return;
		}

		// SQS mode
		if (this.client && this.extractionQueueUrl) {
			await this.client.send(
				new SendMessageCommand({
					QueueUrl: this.extractionQueueUrl,
					MessageBody: messageBody,
				})
			);
			this.logger.log(
				`[QueueSend] policy_id=${payload.policy_id} queue=extraction timestamp=${new Date().toISOString()}`
			);
		}
	}

	/**
	 * Receive messages from queue (used by worker)
	 */
	async receiveMessages(
		maxMessages = 10,
		waitTimeSeconds = 20,
		visibilityTimeoutSeconds = 300
	): Promise<
		Array<{
			messageId: string;
			body: string;
			receiptHandle: string;
			approximateReceiveCount: number;
		}>
	> {
		if (!this.client || !this.extractionQueueUrl) return [];

		const result = await this.client.send(
			new ReceiveMessageCommand({
				QueueUrl: this.extractionQueueUrl,
				MaxNumberOfMessages: maxMessages,
				WaitTimeSeconds: Math.min(20, Math.max(0, waitTimeSeconds)),
				VisibilityTimeout: visibilityTimeoutSeconds,
				MessageSystemAttributeNames: [MessageSystemAttributeName.ApproximateReceiveCount],
			})
		);

		const messages = result.Messages ?? [];
		return messages
			.filter((m) => Boolean(m.ReceiptHandle && m.Body))
			.map((m) => {
				const count = m.Attributes?.ApproximateReceiveCount
					? parseInt(m.Attributes.ApproximateReceiveCount, 10)
					: 1;
				return {
					messageId: m.MessageId!,
					body: m.Body!,
					receiptHandle: m.ReceiptHandle!,
					approximateReceiveCount: Number.isNaN(count) ? 1 : Math.max(1, count),
				};
			});
	}

	/**
	 * Delete message after successful processing
	 */
	async deleteMessage(receiptHandle: string): Promise<void> {
		if (receiptHandle.startsWith("local-") || receiptHandle.startsWith("direct-")) {
			return;
		}

		if (!this.client || !this.extractionQueueUrl) return;

		await this.client.send(
			new DeleteMessageCommand({
				QueueUrl: this.extractionQueueUrl,
				ReceiptHandle: receiptHandle,
			})
		);
	}

	/**
	 * Set message visibility timeout
	 */
	async setMessageVisibility(
		receiptHandle: string,
		visibilityTimeoutSeconds: number
	): Promise<void> {
		if (receiptHandle.startsWith("local-") || receiptHandle.startsWith("direct-")) {
			return;
		}

		if (!this.client || !this.extractionQueueUrl) return;

		await this.client.send(
			new ChangeMessageVisibilityCommand({
				QueueUrl: this.extractionQueueUrl,
				ReceiptHandle: receiptHandle,
				VisibilityTimeout: Math.min(43200, Math.max(0, visibilityTimeoutSeconds)),
			})
		);
	}

	/**
	 * Receive messages from local queue (for local dev)
	 */
	receiveMessagesFromLocal(
		maxMessages: number
	): Array<{
		messageId: string;
		body: string;
		receiptHandle: string;
		approximateReceiveCount: number;
	}> {
		const out: Array<{
			messageId: string;
			body: string;
			receiptHandle: string;
			approximateReceiveCount: number;
		}> = [];

		for (let i = 0; i < maxMessages && this.localQueue.length > 0; i++) {
			const msg = this.localQueue.shift()!;
			out.push({
				messageId: `local-${i}`,
				body: msg.body,
				receiptHandle: msg.receiptHandle,
				approximateReceiveCount: 1,
			});
		}

		return out;
	}

	isLocalMode(): boolean {
		return !this.enabled;
	}

	isExtractionLocal(): boolean {
		return this.extractionUseInMemory;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	getQueueUrlForLog(): string | null {
		return this.extractionQueueUrl;
	}
}
