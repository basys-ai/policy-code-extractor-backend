import { Injectable, OnModuleInit, Logger, HttpException, HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";

export interface ExtractedCodeFromLLM {
	code: string;
	description: string;
}

export interface LLMExtractionResult {
	codes: ExtractedCodeFromLLM[];
	confidence: number;
	provider: "openai" | "gemini";
	model: string;
	tokensUsed?: number;
}

@Injectable()
export class ExecutorService implements OnModuleInit {
	private readonly logger = new Logger(ExecutorService.name);
	private openaiClient: OpenAI | null = null;
	private geminiClient: GoogleGenerativeAI | null = null;
	private enabled = false;
	private provider: "openai" | "gemini" = "openai";
	private model: string = "gpt-4o";

	constructor(private readonly configService: ConfigService) {}

	async onModuleInit() {
		const llmEnabled = this.configService.get<string>("LLM_EXTRACTION_ENABLED");
		this.enabled = llmEnabled === "true" || llmEnabled === "1";

		if (!this.enabled) {
			this.logger.warn("LLM extraction disabled: LLM_EXTRACTION_ENABLED not set");
			return;
		}

		// Initialize OpenAI
		const openaiKey = this.configService.get<string>("OPENAI_API_KEY");
		if (openaiKey) {
			this.openaiClient = new OpenAI({ apiKey: openaiKey });
			this.logger.log("OpenAI client initialized");
		}

		// Initialize Gemini
		const geminiKey = this.configService.get<string>("GEMINI_API_KEY");
		if (geminiKey) {
			this.geminiClient = new GoogleGenerativeAI(geminiKey);
			this.logger.log("Gemini client initialized");
		}

		// Set provider and model from config
		this.provider = (this.configService.get<string>("LLM_EXTRACTION_PROVIDER") as "openai" | "gemini") || "openai";
		this.model = this.configService.get<string>("LLM_EXTRACTION_MODEL") || "gpt-4o";

		if (!this.openaiClient && !this.geminiClient) {
			this.enabled = false;
			this.logger.warn("LLM extraction disabled: No API keys configured");
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Extract ICD-10 codes from PDF text using LLM
	 */
	async extractCodesWithLLM(
		pdfText: string,
		options?: { provider?: "openai" | "gemini"; temperature?: number }
	): Promise<LLMExtractionResult> {
		if (!this.enabled && !options?.provider) {
			throw new HttpException("LLM extraction not enabled", HttpStatus.SERVICE_UNAVAILABLE);
		}

		const temperature = options?.temperature ?? 0;
		const requestProvider = options?.provider || this.provider;

		const systemPrompt = `You are an expert medical coder specializing in ICD-10-CM codes. 
Your task is to extract all ICD-10-CM codes from CMS policy documents.

Rules:
1. Extract ONLY codes from sections that "Support Medical Necessity" 
2. Do NOT include codes from "DO NOT Support Medical Necessity" sections
3. Each code follows the format: Letter + 2 digits + dot + 1-4 digits (e.g., E10.9, E11.3211)
4. Include the full description for each code
5. Return results as a JSON array

Response format:
{
  "codes": [
    {"code": "E10.9", "description": "Type 1 diabetes mellitus without complications"},
    {"code": "E11.21", "description": "Type 2 diabetes mellitus with diabetic nephropathy"}
  ],
  "confidence": 95
}`;

		const userPrompt = `Extract all ICD-10-CM codes that support medical necessity from this policy document:

${pdfText.substring(0, 100000)}`; // Limit to ~100k chars for token limits

		try {
			if (requestProvider === "openai" && this.openaiClient) {
				return await this.extractWithOpenAI(systemPrompt, userPrompt, temperature);
			}
			if (requestProvider === "gemini" && this.geminiClient) {
				return await this.extractWithGemini(systemPrompt, userPrompt, temperature);
			}
			// Fallback to whichever is available when no specific provider requested
			if (this.openaiClient) {
				return await this.extractWithOpenAI(systemPrompt, userPrompt, temperature);
			}
			if (this.geminiClient) {
				return await this.extractWithGemini(systemPrompt, userPrompt, temperature);
			}

			throw new HttpException("No LLM provider available", HttpStatus.SERVICE_UNAVAILABLE);
		} catch (error: any) {
			this.logger.error(`LLM extraction failed: ${error.message}`);
			throw new HttpException(
				`LLM extraction failed: ${error.message}`,
				HttpStatus.INTERNAL_SERVER_ERROR
			);
		}
	}

	private async extractWithOpenAI(
		systemPrompt: string,
		userPrompt: string,
		temperature = 0
	): Promise<LLMExtractionResult> {
		if (!this.openaiClient) {
			throw new Error("OpenAI client not initialized");
		}

		this.logger.log(`Executing OpenAI extraction with model=${this.model} temperature=${temperature}`);

		const completion = await this.openaiClient.chat.completions.create({
			model: this.model,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
			response_format: { type: "json_object" },
			max_tokens: 16000,
			temperature,
		});

		const output = completion.choices[0]?.message?.content || "{}";
		const parsed = this.parseCodesJson(this.cleanJsonOutput(output));

		return {
			codes: parsed.codes || [],
			confidence: parsed.confidence || 80,
			provider: "openai",
			model: this.model,
			tokensUsed: completion.usage?.total_tokens,
		};
	}

	private async extractWithGemini(
		systemPrompt: string,
		userPrompt: string,
		temperature = 0
	): Promise<LLMExtractionResult> {
		if (!this.geminiClient) {
			throw new Error("Gemini client not initialized");
		}

		const geminiModel = this.model.includes("gemini") ? this.model : "gemini-2.0-flash-001";
		this.logger.log(`Executing Gemini extraction with model=${geminiModel} temperature=${temperature}`);

		const genModel = this.geminiClient.getGenerativeModel({
			model: geminiModel,
			systemInstruction: systemPrompt,
		});

		const result = await genModel.generateContent({
			contents: [{ role: "user", parts: [{ text: userPrompt }] }],
			generationConfig: {
				temperature,
				maxOutputTokens: 16000,
				responseMimeType: "application/json",
			},
			safetySettings: [
				{ category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
				{ category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
				{ category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
				{ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
			],
		});

		const output = result.response.text();
		const parsed = this.parseCodesJson(this.cleanJsonOutput(output));

		return {
			codes: parsed.codes || [],
			confidence: parsed.confidence || 80,
			provider: "gemini",
			model: geminiModel,
			tokensUsed: result.response.usageMetadata?.totalTokenCount,
		};
	}

	/**
	 * Parse LLM JSON response; repair truncated JSON when possible so we still use partial codes.
	 */
	private parseCodesJson(raw: string): { codes: ExtractedCodeFromLLM[]; confidence: number } {
		const defaultResult = { codes: [] as ExtractedCodeFromLLM[], confidence: 80 };

		try {
			const parsed = JSON.parse(raw);
			return {
				codes: Array.isArray(parsed.codes) ? parsed.codes : defaultResult.codes,
				confidence: typeof parsed.confidence === "number" ? parsed.confidence : 80,
			};
		} catch (e: any) {
			if (e instanceof SyntaxError && e.message?.includes("JSON")) {
				const repaired = this.repairTruncatedCodesJson(raw);
				if (repaired) {
					this.logger.warn(`Used repaired JSON (partial codes) after parse error: ${e.message}`);
					return repaired;
				}
			}
			throw e;
		}
	}

	/**
	 * Attempt to repair truncated JSON by finding the last complete "codes" entry and closing the structure.
	 * Tries truncating at each "}, (end of object) from the end and parses until valid.
	 */
	private repairTruncatedCodesJson(raw: string): { codes: ExtractedCodeFromLLM[]; confidence: number } | null {
		const arrayStart = raw.indexOf("[", raw.indexOf('"codes"'));
		if (arrayStart === -1) return null;

		const search = '"},';
		let pos = raw.length;
		while (true) {
			pos = raw.lastIndexOf(search, pos - 1);
			if (pos === -1 || pos < arrayStart) break;
			const candidate = raw.substring(0, pos + search.length) + '],"confidence":80}';
			try {
				const parsed = JSON.parse(candidate);
				if (Array.isArray(parsed.codes)) {
					return {
						codes: parsed.codes,
						confidence: typeof parsed.confidence === "number" ? parsed.confidence : 80,
					};
				}
			} catch {
				// try earlier occurrence
			}
		}

		// Try last "} (object end without comma)
		pos = raw.length;
		const search2 = '"}';
		while (true) {
			pos = raw.lastIndexOf(search2, pos - 1);
			if (pos === -1 || pos < arrayStart) break;
			const candidate = raw.substring(0, pos + search2.length) + '],"confidence":80}';
			try {
				const parsed = JSON.parse(candidate);
				if (Array.isArray(parsed.codes) && parsed.codes.length > 0) {
					return {
						codes: parsed.codes,
						confidence: typeof parsed.confidence === "number" ? parsed.confidence : 80,
					};
				}
			} catch {
				// try earlier
			}
		}
		return null;
	}

	/**
	 * Clean markdown code blocks from LLM output
	 */
	private cleanJsonOutput(output: string): string {
		let cleaned = output.trim();

		// Remove opening code fence
		if (cleaned.startsWith("```")) {
			const fenceEnd = cleaned.indexOf("\n", cleaned.indexOf("```"));
			if (fenceEnd > 0) {
				cleaned = cleaned.substring(fenceEnd + 1);
			} else {
				cleaned = cleaned.replace(/^```(?:json)?\s*/i, "");
			}
		}

		// Remove closing code fence
		if (cleaned.endsWith("```")) {
			const lastFence = cleaned.lastIndexOf("```");
			if (lastFence > 0) {
				cleaned = cleaned.substring(0, lastFence).trimEnd();
			}
		}

		return cleaned.trim();
	}
}
